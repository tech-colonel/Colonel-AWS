'use strict';

// Pure workflow computation, lifted verbatim out of workflowController.js.
//
// It lives on its own so it can be require()d from a worker thread. Building a
// workflow's workbook is heavy — the shopify-koparo workflow produces a 136 MB
// xlsx from 7 chained sheets — and every bit of it is synchronous. Run on the
// main thread it holds the event loop for minutes, which is what took
// agent.accountant down repeatedly on 2026-08-21: one user's export froze the
// site for everyone.
//
// Nothing here touches the database, express, or multer. That is the point: a
// worker can load this module without opening a DB connection. Keep it that way —
// anything needing IO belongs in the controller, which passes the data in.

const XLSX = require('xlsx');
const { createMissingMasterTracker } = require('../utils/missingMasterTracker');
const { GST_STATE_CODES, GST_STATE_ABBR } = require('../utils/gstStateCodes');

// ─── Scalar formula helpers (row-local: text + GST state) ─────────────────────
// Injected into BOTH evaluators so `computed` (Math) and `excel` formulas can
// call them. Every one is a pure function of its arguments — no row or table
// state — so a single frozen table is shared across every evaluation.
//
//   LEFT/RIGHT/MID/LEN/TRIM/UPPER/LOWER/CONCAT  — Excel-style text functions
//   VALUE/ROUND/ABS                             — string→number + rounding
//   GSTCODE/GSTSTATE/GSTABBR/SAMESTATE          — GST jurisdiction, backed by
//                                                 utils/gstStateCodes.js
//
// GSTSTATE("09ABCDE1234F1Z5") → "Uttar Pradesh"; it also accepts a bare 2-digit
// code and canonicalises a messy state name to the standard spelling.
// GSTABBR("09ABCDE1234F1Z5") → "UP"  (2-letter code for Tally voucher/ledger names).
// SAMESTATE(sellerGstin, "Uttar Pradesh") → true  (intra-state → CGST + SGST).

const _s = v => String(v === null || v === undefined ? '' : v);
const _num = v => { const n = parseFloat(_s(v).replace(/,/g, '')); return isNaN(n) ? null : n; };
const _normState = s => _s(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');

const _NORM_STATE_TO_CODE = Object.entries(GST_STATE_CODES).reduce((m, [code, name]) => {
  m[_normState(name)] = code;
  return m;
}, {});

// GSTIN / bare code / state name  →  canonical 2-digit GST state code ('' if unknown)
function _gstCode(v) {
  const s = _s(v).trim();
  if (!s) return '';
  const digits = s.match(/^\s*(\d{1,2})/); // a GSTIN starts with 2 digits; a bare code is 1–2
  if (digits) {
    const code = digits[1].padStart(2, '0');
    return GST_STATE_CODES[code] ? code : '';
  }
  return _NORM_STATE_TO_CODE[_normState(s)] || '';
}

const SCALAR_HELPERS = {
  LEFT:  (s, n = 1) => _s(s).slice(0, Math.max(0, Math.trunc(+n) || 0)),
  RIGHT: (s, n = 1) => { const k = Math.max(0, Math.trunc(+n) || 0); return k ? _s(s).slice(-k) : ''; },
  MID:   (s, start, len) => {
    const i = Math.max(0, (Math.trunc(+start) || 1) - 1);            // Excel MID is 1-indexed
    return _s(s).slice(i, i + Math.max(0, Math.trunc(+len) || 0));
  },
  LEN:    s => _s(s).length,
  TRIM:   s => _s(s).trim(),
  UPPER:  s => _s(s).toUpperCase(),
  LOWER:  s => _s(s).toLowerCase(),
  CONCAT: (...parts) => parts.map(_s).join(''),
  VALUE:  v => { const n = _num(v); return n === null ? '' : n; },
  ROUND:  (x, d = 0) => {
    const n = _num(x);
    if (n === null) return '';
    const f = Math.pow(10, Math.trunc(+d) || 0);
    return Math.round((n + Number.EPSILON) * f) / f;
  },
  ABS: x => { const n = _num(x); return n === null ? '' : Math.abs(n); },
  GSTCODE:   v => _gstCode(v),
  GSTSTATE:  v => { const c = _gstCode(v); return c ? GST_STATE_CODES[c] : ''; },
  GSTABBR:   v => { const c = _gstCode(v); return c ? (GST_STATE_ABBR[c] || '') : ''; },
  SAMESTATE: (a, b) => { const x = _gstCode(a), y = _gstCode(b); return !!x && !!y && x === y; },
};

const SCALAR_HELPER_NAMES = Object.keys(SCALAR_HELPERS);
const SCALAR_HELPER_FNS = SCALAR_HELPER_NAMES.map(k => SCALAR_HELPERS[k]);

// ─── Formula Evaluator ────────────────────────────────────────────────────────

function evaluateFormula(formula, scope) {
  try {
    let expr = formula.replace(/\{([^}]+)\}/g, (_, colRef) => {
      const val = scope[colRef];
      if (val === null || val === undefined || val === '') return '0';
      const num = parseFloat(String(val).replace(/,/g, ''));
      if (!isNaN(num)) return String(num);
      return `"${String(val).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    });

    expr = expr.replace(
      /\bIF\s*\(([^,()]+(?:\([^()]*\)[^,()]*)*)\s*,\s*([^,()]+(?:\([^()]*\)[^,()]*)*)\s*,\s*([^()]+(?:\([^()]*\)[^()]*)*)\)/gi,
      '(($1) ? ($2) : ($3))'
    );

    // eslint-disable-next-line no-new-func
    const result = new Function(
      ...SCALAR_HELPER_NAMES,
      '"use strict"; return (' + expr + ');'
    )(...SCALAR_HELPER_FNS);
    if (result === null || result === undefined || (typeof result === 'number' && isNaN(result))) return '';
    return result;
  } catch {
    return '';
  }
}

// ─── Excel Formula Evaluator (cross-row: SUMIF, VLOOKUP, etc.) ───────────────

function evaluateFormulaWithHelpers(formula, rowScope, allRows, helperCache) {
  try {
    // Replace {ColumnName} with current row values
    let expr = formula.replace(/\{([^}]+)\}/g, (_, colRef) => {
      const val = rowScope[colRef];
      if (val === null || val === undefined || val === '') return '0';
      const num = parseFloat(String(val).replace(/,/g, ''));
      if (!isNaN(num)) return String(num);
      return `"${String(val).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    });

    // IF() → ternary (word-boundary \b prevents matching SUMIF / COUNTIF)
    expr = expr.replace(
      /\bIF\s*\(([^,()]+(?:\([^()]*\)[^,()]*)*)\s*,\s*([^,()]+(?:\([^()]*\)[^,()]*)*)\s*,\s*([^()]+(?:\([^()]*\)[^()]*)*)\)/gi,
      '(($1) ? ($2) : ($3))'
    );

    const toNum = v => {
      const n = parseFloat(String(v === null || v === undefined ? '' : v).replace(/,/g, ''));
      return isNaN(n) ? null : n;
    };
    const cmp = v => String(v === null || v === undefined ? '' : v).trim().toLowerCase();

    /* ── injected helpers — column args are plain column-name strings ────────────
       The column-name arguments (e.g. SUMIF("SKU", {SKU}, "Net")) are string
       literals in the formula, identical for every row of a column. So each
       helper builds a grouped index ONCE per (column, call-signature) and reads
       it in O(1) per row, instead of rescanning `allRows` on every call — that
       is what turns a formula column from O(rows²) into O(rows).

       `helperCache` is created fresh per column by the caller, so an index never
       outlives the column whose values get written back into `allRows`. With no
       cache (external callers) a local one is used: correct, just no reuse.     */
    const cache = helperCache || new Map();
    const index = (key, build) => {
      if (!cache.has(key)) cache.set(key, build());
      return cache.get(key);
    };
    // query-side composite key for the *IFS helpers, aligned 1:1 with `cols`
    const condKey = (cols, pairs) => cols.map((_, j) => cmp(pairs[j * 2 + 1])).join('\x00');

    const SUMIF = (rangeCol, criteria, sumCol) => {
      const m = index('sumif\x00' + rangeCol + '\x00' + sumCol, () => {
        const mm = new Map();
        for (const r of allRows) {
          const n = toNum(r[sumCol]);
          if (n === null) continue;
          const k = cmp(r[rangeCol]);
          mm.set(k, (mm.has(k) ? mm.get(k) : 0) + n);
        }
        return mm;
      });
      const k = cmp(criteria);
      return m.has(k) ? m.get(k) : 0;
    };

    const SUMIFS = (sumCol, ...pairs) => {
      const cols = [];
      for (let i = 0; i + 1 < pairs.length; i += 2) cols.push(String(pairs[i]));
      const m = index('sumifs\x00' + sumCol + '\x00' + cols.join('\x00'), () => {
        const mm = new Map();
        for (const r of allRows) {
          const n = toNum(r[sumCol]);
          if (n === null) continue;
          const k = cols.map(c => cmp(r[c])).join('\x00');
          mm.set(k, (mm.has(k) ? mm.get(k) : 0) + n);
        }
        return mm;
      });
      const k = condKey(cols, pairs);
      return m.has(k) ? m.get(k) : 0;
    };

    const COUNTIF = (rangeCol, criteria) => {
      const m = index('countif\x00' + rangeCol, () => {
        const mm = new Map();
        for (const r of allRows) {
          const k = cmp(r[rangeCol]);
          mm.set(k, (mm.has(k) ? mm.get(k) : 0) + 1);
        }
        return mm;
      });
      const k = cmp(criteria);
      return m.has(k) ? m.get(k) : 0;
    };

    const COUNTIFS = (...pairs) => {
      const cols = [];
      for (let i = 0; i + 1 < pairs.length; i += 2) cols.push(String(pairs[i]));
      const m = index('countifs\x00' + cols.join('\x00'), () => {
        const mm = new Map();
        for (const r of allRows) {
          const k = cols.map(c => cmp(r[c])).join('\x00');
          mm.set(k, (mm.has(k) ? mm.get(k) : 0) + 1);
        }
        return mm;
      });
      const k = condKey(cols, pairs);
      return m.has(k) ? m.get(k) : 0;
    };

    const AVERAGEIF = (rangeCol, criteria, avgCol) => {
      const m = index('avgif\x00' + rangeCol + '\x00' + avgCol, () => {
        const mm = new Map();
        for (const r of allRows) {
          const x = toNum(r[avgCol]);
          if (x === null) continue;
          const k = cmp(r[rangeCol]);
          const e = mm.get(k);
          if (e) { e.sum += x; e.n += 1; } else mm.set(k, { sum: x, n: 1 });
        }
        return mm;
      });
      const e = m.get(cmp(criteria));
      return e && e.n ? e.sum / e.n : '';
    };

    const VLOOKUP = (lookupVal, lookupCol, returnCol) => {
      const m = index('vlookup\x00' + lookupCol + '\x00' + returnCol, () => {
        const mm = new Map();
        for (const r of allRows) {
          const k = cmp(r[lookupCol]);
          if (!mm.has(k)) mm.set(k, r[returnCol] ?? ''); // first match wins, mirrors Array.find
        }
        return mm;
      });
      const k = cmp(lookupVal);
      return m.has(k) ? m.get(k) : '';
    };

    const MAXIF = (rangeCol, criteria, maxCol) => {
      const m = index('maxif\x00' + rangeCol + '\x00' + maxCol, () => {
        const mm = new Map();
        for (const r of allRows) {
          const x = toNum(r[maxCol]);
          if (x === null) continue;
          const k = cmp(r[rangeCol]);
          mm.set(k, mm.has(k) ? Math.max(mm.get(k), x) : x);
        }
        return mm;
      });
      const k = cmp(criteria);
      return m.has(k) ? m.get(k) : '';
    };

    const MINIF = (rangeCol, criteria, minCol) => {
      const m = index('minif\x00' + rangeCol + '\x00' + minCol, () => {
        const mm = new Map();
        for (const r of allRows) {
          const x = toNum(r[minCol]);
          if (x === null) continue;
          const k = cmp(r[rangeCol]);
          mm.set(k, mm.has(k) ? Math.min(mm.get(k), x) : x);
        }
        return mm;
      });
      const k = cmp(criteria);
      return m.has(k) ? m.get(k) : '';
    };

    // eslint-disable-next-line no-new-func
    const result = new Function(
      'SUMIF', 'SUMIFS', 'COUNTIF', 'COUNTIFS', 'AVERAGEIF', 'VLOOKUP', 'MAXIF', 'MINIF',
      ...SCALAR_HELPER_NAMES,
      '"use strict"; return (' + expr + ');'
    )(SUMIF, SUMIFS, COUNTIF, COUNTIFS, AVERAGEIF, VLOOKUP, MAXIF, MINIF, ...SCALAR_HELPER_FNS);

    if (result === null || result === undefined || (typeof result === 'number' && isNaN(result))) return '';
    return result;
  } catch {
    return '';
  }
}

// ─── Row Filters ──────────────────────────────────────────────────────────────

function testFilter(row, filter) {
  const rawVal = row[filter.column];
  const cellStr = String(rawVal === null || rawVal === undefined ? '' : rawVal).trim();
  const filterVal = String(filter.value || '').trim();

  switch (filter.operator) {
    case 'equals':
      return cellStr.toLowerCase() === filterVal.toLowerCase();
    case 'not_equals':
      return cellStr.toLowerCase() !== filterVal.toLowerCase();
    case 'contains':
      return cellStr.toLowerCase().includes(filterVal.toLowerCase());
    case 'not_contains':
      return !cellStr.toLowerCase().includes(filterVal.toLowerCase());
    case 'gt': {
      const n = parseFloat(cellStr.replace(/,/g, ''));
      const nf = parseFloat(filterVal.replace(/,/g, ''));
      return !isNaN(n) && !isNaN(nf) && n > nf;
    }
    case 'lt': {
      const n = parseFloat(cellStr.replace(/,/g, ''));
      const nf = parseFloat(filterVal.replace(/,/g, ''));
      return !isNaN(n) && !isNaN(nf) && n < nf;
    }
    case 'is_empty':
      return cellStr === '';
    case 'is_not_empty':
      return cellStr !== '';
    default:
      return true;
  }
}

function applyFilters(rows, filters) {
  if (!filters || filters.length === 0) return rows;
  return rows.filter(row => filters.every(f => testFilter(row, f)));
}

// ─── Master Field Resolver ─────────────────────────────────────────────────────
// Matches a field name against an object key using: exact match first, then
// case-insensitive + collapsed-whitespace/underscore/dash fallback.
// This handles "salesPortalSku" matching "Sales Portal SKU" and vice versa.

function findMasterField(obj, fieldName) {
  if (!fieldName) return undefined;
  if (fieldName in obj) return obj[fieldName];
  const norm = fieldName.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const key = Object.keys(obj).find(k => k.trim().toLowerCase().replace(/[\s_-]+/g, '') === norm);
  return key !== undefined ? obj[key] : undefined;
}

// ─── Master Data Lookup ───────────────────────────────────────────────────────

// A normalized-key → first-matching-entry map for one (masterType, keyField).
// Built once and memoized on `cache` (a Map, one per workflow run) so per-row
// resolves are O(1) instead of a linear scan of the whole master list per row.
function buildMasterIndex(masterData, masterType, keyField) {
  const master = masterType === 'sku'
    ? (masterData.sku_master || [])
    : (masterData.ledger_master || []);
  const map = new Map();
  for (const entry of master) {
    const entryVal = String(findMasterField(entry, keyField) ?? '').trim().toLowerCase();
    if (!map.has(entryVal)) map.set(entryVal, entry); // first wins, mirrors Array.find
  }
  return map;
}

function getMasterIndex(masterData, masterType, keyField, cache) {
  if (!cache) return buildMasterIndex(masterData, masterType, keyField);
  const cacheKey = `${masterType}\x00${keyField}`;
  if (!cache.has(cacheKey)) cache.set(cacheKey, buildMasterIndex(masterData, masterType, keyField));
  return cache.get(cacheKey);
}

function resolveMasterLookup(col, row, masterData, missingTracker, masterCache) {
  const { masterType, lookupColumn, matchField, returnField } = col;
  const rawLookupValue = String(row[lookupColumn] || '').trim();
  const lookupValue = rawLookupValue.toLowerCase();
  if (!lookupValue) return '';

  const keyField = masterType === 'sku' ? (matchField || 'salesPortalSku') : (matchField || '');
  const match = getMasterIndex(masterData, masterType, keyField, masterCache).get(lookupValue);

  if (!match) {
    if (missingTracker) missingTracker.track({ masterType, matchField: keyField, value: rawLookupValue });
    return '';
  }
  const val = findMasterField(match, returnField);
  return val !== undefined ? val : '';
}

// ─── Master Data Validate ─────────────────────────────────────────────────────

function resolveMasterValidate(col, row, masterData, missingTracker, masterCache) {
  const { masterType, lookupColumn, matchField, matchLabel = 'Matched', noMatchLabel = 'Not Matched' } = col;
  const rawLookupValue = String(row[lookupColumn] || '').trim();
  const lookupValue = rawLookupValue.toLowerCase();
  if (!lookupValue) return noMatchLabel;

  const keyField = masterType === 'sku' ? (matchField || 'salesPortalSku') : (matchField || '');
  const found = getMasterIndex(masterData, masterType, keyField, masterCache).has(lookupValue);

  if (!found) {
    if (missingTracker) missingTracker.track({ masterType, matchField: keyField, value: rawLookupValue });
    return noMatchLabel;
  }
  return matchLabel;
}

// ─── File Header Extraction (all sheets) ─────────────────────────────────────

function extractAllSheetsFromBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: false });
  return workbook.SheetNames.map(sheetName => {
    const ws   = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    let columns = [];
    for (const row of rows) {
      const headers = row.map(h => String(h || '').trim()).filter(h => h !== '');
      if (headers.length > 0) { columns = headers; break; }
    }
    return { name: sheetName, columns };
  });
}

// ─── Group By / Aggregation ───────────────────────────────────────────────────

function aggregate(values, method) {
  const nums = values
    .map(v => parseFloat(String(v === null || v === undefined ? '' : v).replace(/,/g, '')))
    .filter(n => !isNaN(n));
  switch (method) {
    case 'sum':    return nums.reduce((a, b) => a + b, 0);
    case 'avg':    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : '';
    case 'count':  return values.length;
    case 'min':    return nums.length ? Math.min(...nums) : '';
    case 'max':    return nums.length ? Math.max(...nums) : '';
    case 'first':  return values[0] ?? '';
    case 'last':   return values[values.length - 1] ?? '';
    case 'concat': return values.filter(v => v !== '' && v !== null && v !== undefined).join(', ');
    default:       return values[0] ?? '';
  }
}

function applyGroupBy(outputRows, groupByConfig) {
  if (!groupByConfig?.enabled || !groupByConfig.columns?.length || !outputRows.length) return outputRows;

  const groupColumns  = groupByConfig.columns;
  const aggregations  = groupByConfig.aggregations || {};
  const allColLabels  = Object.keys(outputRows[0]);
  const nonGroupLabels = allColLabels.filter(l => !groupColumns.includes(l));

  const groupMap = new Map();
  for (const row of outputRows) {
    const key = groupColumns.map(c => String(row[c] ?? '')).join('\x00');
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(row);
  }

  return Array.from(groupMap.values()).map(groupRows => {
    const result = {};
    for (const col of groupColumns)    result[col] = groupRows[0][col];
    for (const col of nonGroupLabels)  result[col] = aggregate(groupRows.map(r => r[col]), aggregations[col] || 'sum');
    return result;
  });
}

// ─── Merge Sheet Apply ────────────────────────────────────────────────────────

function applyMerge(mergeConfig, rawSheetMap, sheetResults, wfSheets) {
  const { mergeType = 'join', sources = [] } = mergeConfig;
  const cmp = v => String(v === null || v === undefined ? '' : v).trim().toLowerCase();

  function getSourceRows(source) {
    if (source.type === 'raw') return rawSheetMap[source.sheetName] || [];
    const idx = wfSheets.findIndex(s => s.name === source.sheetName);
    return idx >= 0 && sheetResults[idx] ? sheetResults[idx] : [];
  }

  function pickCols(row, selectedCols) {
    if (!selectedCols || selectedCols.length === 0) return { ...row };
    const out = {};
    selectedCols.forEach(col => { out[col] = row[col] ?? ''; });
    return out;
  }

  if (mergeType === 'stack') {
    const result = [];
    for (const src of sources) {
      getSourceRows(src).forEach(row => result.push(pickCols(row, src.columns)));
    }
    return result;
  }

  if (mergeType === 'column_combine') {
    const [srcA, srcB] = sources;
    if (!srcA || !srcB) return [];
    const rowsA = getSourceRows(srcA);
    const rowsB = getSourceRows(srcB);
    const maxLen = Math.max(rowsA.length, rowsB.length);
    return Array.from({ length: maxLen }, (_, i) => ({
      ...pickCols(rowsA[i] || {}, srcA.columns),
      ...pickCols(rowsB[i] || {}, srcB.columns),
    }));
  }

  // join — N-source sequential left join using a common key column
  const commonKey = mergeConfig.commonJoinKey;
  if (commonKey) {
    if (sources.length === 0) return [];
    // Seed result with source A's selected columns, always keeping the join key
    let resultRows = getSourceRows(sources[0]).map(row => {
      const picked = pickCols(row, sources[0].columns);
      if (!(commonKey in picked)) picked[commonKey] = row[commonKey] ?? '';
      return picked;
    });
    // Join each subsequent source onto the running result
    for (let i = 1; i < sources.length; i++) {
      const src = sources[i];
      const rightRows = getSourceRows(src);
      const rightMap = new Map();
      for (const row of rightRows) {
        const k = cmp(row[commonKey]);
        if (!rightMap.has(k)) rightMap.set(k, row);
      }
      resultRows = resultRows.map(leftRow => ({
        ...leftRow,
        ...pickCols(rightMap.get(cmp(leftRow[commonKey])) || {}, src.columns),
      }));
    }
    return resultRows;
  }

  // Legacy: 2-source join with per-source joinKey (backward compat)
  const [srcA, srcB] = sources;
  if (!srcA || !srcB) return [];
  const rowsA = getSourceRows(srcA);
  const rowsB = getSourceRows(srcB);
  const bMap  = new Map();
  for (const row of rowsB) {
    const key = cmp(row[srcB.joinKey]);
    if (!bMap.has(key)) bMap.set(key, row);
  }
  return rowsA.map(rowA => ({
    ...pickCols(rowA, srcA.columns),
    ...pickCols(bMap.get(cmp(rowA[srcA.joinKey])) || {}, srcB.columns),
  }));
}

// ─── Formula Reference Sheet ──────────────────────────────────────────────────

function buildFormulaReferenceSheet(sheets) {
  const rows = [['Sheet', 'Column / Info', 'Type', 'Formula / Details']];

  for (const sheet of sheets) {
    if (sheet.type === 'merge') {
      const mc = sheet.mergeConfig || {};
      rows.push([sheet.name, '— Merge Sheet —', mc.mergeType || 'join',
        `Sources: ${(mc.sources || []).map(s => `${s.sheetName} [${s.type}]`).join(' + ')}`]);
      (mc.sources || []).forEach((src, i) => {
        const lbl = ['Source A', 'Source B', 'Source C'][i] || `Source ${i + 1}`;
        rows.push([
          sheet.name, lbl, `${src.type} → ${src.sheetName}`,
          `Columns: ${(src.columns || []).join(', ')}${mc.mergeType === 'join' && src.joinKey ? ` | Join key: ${src.joinKey}` : ''}`
        ]);
      });
      continue;
    }

    const orderedCols = [...(sheet.columns || [])].sort((a, b) => a.order - b.order);
    if (sheet.rawSheetName) rows.push([sheet.name, '— Source Sheet —', 'Input', sheet.rawSheetName]);

    for (const col of orderedCols) {
      let typeLabel, details;
      switch (col.type) {
        case 'source':        typeLabel = col.fillDown ? 'Source (fill down blanks)' : 'Source';
          details = col.key || col.label; break;
        case 'computed':      typeLabel = 'Math Formula';             details = col.formula || ''; break;
        case 'excel':         typeLabel = 'Excel Formula (cross-row)'; details = col.formula || ''; break;
        case 'master_lookup': typeLabel = 'Master Lookup';
          details = `Match column "${col.lookupColumn}" in ${col.masterType || 'sku'} master → return field "${col.returnField}"`; break;
        case 'master_validate': typeLabel = 'Master Validate';
          details = `Check "${col.lookupColumn}" exists in ${col.masterType || 'ledger'} master field "${col.matchField}" → "${col.matchLabel || 'Matched'}" / "${col.noMatchLabel || 'Not Matched'}"`; break;
        default:              typeLabel = col.type || ''; details = col.formula || '';
      }
      rows.push([sheet.name || '', col.label || '', typeLabel, details]);
    }

    if (sheet.groupBy?.enabled && sheet.groupBy?.columns?.length) {
      const aggStr = Object.entries(sheet.groupBy.aggregations || {}).map(([c, m]) => `${c}:${m}`).join(', ');
      rows.push([sheet.name || '', '— Group By —', 'Aggregation',
        `Group by: ${sheet.groupBy.columns.join(', ')}${aggStr ? ' | Aggregations: ' + aggStr : ''}`]);
    }
  }

  return XLSX.utils.aoa_to_sheet(rows);
}

// ─── Multi-Sheet Workflow Apply ───────────────────────────────────────────────

// fileBufferOrMap: Buffer (legacy / single-file) OR { [fileInputId]: Buffer } (multi-file)
// Pull every {token} out of a sheet's computed/excel formulas.
function collectFormulaTokens(sheet, into) {
  for (const col of (sheet.columns || [])) {
    if (col.type !== 'computed' && col.type !== 'excel') continue;
    const re = /\{([^}]+)\}/g;
    let m;
    while ((m = re.exec(col.formula || ''))) into.add(m[1]);
  }
  return into;
}

function applyMultiSheetWorkflow(sheets, fileBufferOrMap, masterData = {}, fileInputs = []) {
  const missingTracker = createMissingMasterTracker();
  // One (masterType, keyField) → normalized-key map cache for the whole run.
  const masterCache = new Map();

  // Every {SheetName.Label} token anywhere in the workflow. A sheet's pre-grouped
  // rows are kept in `sheetResults` only to answer such cross-references from a
  // LATER sheet; if no formula names a sheet, its intermediate rows are dropped
  // once written instead of held to the end of a (possibly 100 MB+) run.
  const allTokens = sheets.reduce((set, s) => collectFormulaTokens(s, set), new Set());
  const isSheetReferenced = (name) => {
    const prefix = `${name}.`;
    for (const t of allTokens) if (t.startsWith(prefix)) return true;
    return false;
  };

  const normalizeRow = (row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      out[String(k).trim()] = v;
    }
    return out;
  };

  const buildRSM = (buf) => {
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true, raw: false });
    const rsm = {};
    for (const sn of wb.SheetNames) {
      rsm[sn] = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: '' }).map(normalizeRow);
    }
    return rsm;
  };

  // Build per-file rawSheetMaps keyed by fileInputId
  // ArrayBuffer.isView catches Uint8Array as well as Buffer. Without it, a workbook
  // that arrived as a plain Uint8Array — which is exactly what structured clone hands
  // a worker thread — fell through to the map branch below and got walked as if every
  // BYTE INDEX were a separate uploaded file. The result was an empty workbook,
  // produced slowly and reported as success. Fail loudly or handle it; never that.
  const fileRSMs = {};
  if (Buffer.isBuffer(fileBufferOrMap) || ArrayBuffer.isView(fileBufferOrMap)) {
    fileRSMs['file_0'] = buildRSM(fileBufferOrMap);
  } else {
    for (const [fid, buf] of Object.entries(fileBufferOrMap)) {
      fileRSMs[fid] = buildRSM(buf);
    }
  }

  const defaultFileId = fileInputs[0]?.id || 'file_0';
  const getFileRSM = (fid) =>
    fileRSMs[fid] || fileRSMs[defaultFileId] || fileRSMs['file_0'] || Object.values(fileRSMs)[0] || {};


  const outBook      = XLSX.utils.book_new();
  const sheetResults = []; // sheetResults[i] = allRowsData (pre-grouped, row-aligned) for {Sheet.Col} cross-refs
  const sheetOutputs = []; // sheetOutputs[i] = this sheet's actual written rows (post-groupBy) for prev_sheet sourcing

  for (let sheetIdx = 0; sheetIdx < sheets.length; sheetIdx++) {
    const wfSheet       = sheets[sheetIdx];
    const safeSheetName = (wfSheet.name || `Sheet${sheetIdx + 1}`)
      .replace(/[:\\/?*[\]]/g, '').slice(0, 31);

    // Resolve which file this sheet reads from
    const sheetFileId = wfSheet.fileInputId || defaultFileId;
    const rawSheetMap = getFileRSM(sheetFileId);
    const sheetDefaultRows = Object.values(rawSheetMap)[0] || [];

    // ── Merge sheet ───────────────────────────────────────────────────────────
    if (wfSheet.type === 'merge') {
      const mergeRows = applyMerge(wfSheet.mergeConfig || {}, rawSheetMap, sheetOutputs, sheets);
      sheetResults.push(isSheetReferenced(wfSheet.name) ? mergeRows : null);
      sheetOutputs.push(mergeRows);
      XLSX.utils.book_append_sheet(
        outBook,
        XLSX.utils.json_to_sheet(mergeRows.length ? mergeRows : [{}]),
        safeSheetName
      );
      continue;
    }

    // ── Normal sheet ──────────────────────────────────────────────────────────
    // Source rows: from a previous sheet's output OR from a raw input sheet
    let sourceRows;
    if (wfSheet.sourceType === 'prev_sheet' && wfSheet.prevSheetName) {
      const prevIdx = sheets.slice(0, sheetIdx).findIndex(s => s.name === wfSheet.prevSheetName);
      sourceRows = prevIdx >= 0 && sheetOutputs[prevIdx] ? sheetOutputs[prevIdx] : sheetDefaultRows;
    } else {
      sourceRows = rawSheetMap[wfSheet.rawSheetName] || sheetDefaultRows;
    }
    const rawRows     = applyFilters(sourceRows, wfSheet.filters || []);
    const orderedCols = [...(wfSheet.columns || [])].sort((a, b) => a.order - b.order);

    // Which earlier sheets does THIS sheet actually reference via {SheetName.Label}
    // tokens? Seeding every prior sheet's every column into every row is
    // O(sheets² × rows) and almost always dead weight — seed only the named ones.
    const myTokens = collectFormulaTokens(wfSheet, new Set());
    const neededPrevIdx = [];
    for (let prevIdx = 0; prevIdx < sheetIdx; prevIdx++) {
      const prefix = `${sheets[prevIdx].name}.`;
      for (const tok of myTokens) {
        if (tok.startsWith(prefix)) { neededPrevIdx.push(prevIdx); break; }
      }
    }

    // Pass 1: seed source + master + cross-sheet refs for ALL rows
    // fillDownState carries each fillDown-flagged source column's last
    // non-blank value across rows, in the same top-to-bottom order rows land
    // in the sheet — mirrors how exports like Shopify's leave a field (e.g.
    // Shipping Province Name) set only on an order's first line-item row.
    const fillDownState = {};
    const allRowsData = rawRows.map((rawRow, rowIdx) => {
      const row = {};
      for (const prevIdx of neededPrevIdx) {
        const prevSheet   = sheets[prevIdx];
        const prevRowData = sheetResults[prevIdx]?.[rowIdx] || {};
        for (const [label, value] of Object.entries(prevRowData)) {
          row[`${prevSheet.name}.${label}`] = value;
        }
      }
      for (const col of orderedCols) {
        if (col.type === 'source') {
          let val = rawRow[col.key] !== undefined ? rawRow[col.key] : '';
          if (col.fillDown) {
            if (val === '' || val === null || val === undefined) {
              val = fillDownState[col.key] !== undefined ? fillDownState[col.key] : '';
            } else {
              fillDownState[col.key] = val;
            }
          }
          row[col.label] = val;
        } else if (col.type === 'master_lookup') {
          row[col.label] = resolveMasterLookup(col, rawRow, masterData, missingTracker, masterCache);
        } else if (col.type === 'master_validate') {
          row[col.label] = resolveMasterValidate(col, rawRow, masterData, missingTracker, masterCache);
        }
      }
      return row;
    });

    // Pass 2: evaluate derived columns across ALL rows before moving to next col.
    // helperCache is per-column: SUMIF/VLOOKUP/… indexes must not outlive the
    // column, since this column's values are written back into allRowsData below
    // and a later column may aggregate over them.
    for (const col of orderedCols) {
      if (col.type !== 'computed' && col.type !== 'excel') continue;
      const helperCache = col.type === 'excel' ? new Map() : null;
      const vals = allRowsData.map(rowScope =>
        col.type === 'excel'
          ? evaluateFormulaWithHelpers(col.formula || '', rowScope, allRowsData, helperCache)
          : evaluateFormula(col.formula || '', rowScope)
      );
      vals.forEach((v, i) => { allRowsData[i][col.label] = v; });
    }

    const outputRows = allRowsData.map(row => {
      const out = {};
      for (const col of orderedCols) out[col.label] = row[col.label] ?? '';
      return out;
    });

    sheetResults.push(isSheetReferenced(wfSheet.name) ? allRowsData : null); // pre-grouped, kept only if a later sheet cross-refs it

    const finalRows = applyGroupBy(outputRows, wfSheet.groupBy);
    sheetOutputs.push(finalRows); // this sheet's actual output rows, for downstream prev_sheet sourcing
    XLSX.utils.book_append_sheet(outBook, XLSX.utils.json_to_sheet(finalRows), safeSheetName);
  }

  XLSX.utils.book_append_sheet(outBook, buildFormulaReferenceSheet(sheets), 'Formula Reference');
  // compression: DEFLATE the xlsx parts instead of storing them — a big workflow
  // output drops from ~130 MB to a fraction of that, cutting the buffer transfer
  // back to the parent thread and the disk write with it.
  const buffer = XLSX.write(outBook, { type: 'buffer', bookType: 'xlsx', compression: true });
  return { buffer, missingMasterValues: missingTracker.list() };
}

function applyLegacyWorkflow(columns, fileBuffer) {
  return applyMultiSheetWorkflow(
    [{ id: 'default', name: 'Output', filters: [], columns }],
    fileBuffer,
    {}
  );
}


module.exports = {
  SCALAR_HELPERS,
  evaluateFormula,
  evaluateFormulaWithHelpers,
  testFilter,
  applyFilters,
  findMasterField,
  resolveMasterLookup,
  resolveMasterValidate,
  extractAllSheetsFromBuffer,
  aggregate,
  applyGroupBy,
  applyMerge,
  buildFormulaReferenceSheet,
  applyMultiSheetWorkflow,
  applyLegacyWorkflow,
};
