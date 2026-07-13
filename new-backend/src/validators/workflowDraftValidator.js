// Validates an LLM-drafted workflow `sheets` structure before it is ever handed
// back to the frontend or (later) executed. The execution engine's formula
// evaluators (workflowController.js: evaluateFormula / evaluateFormulaWithHelpers)
// run formula strings through `new Function(...)`, so any LLM-authored formula
// must be constrained to a known-safe token grammar before it can reach that code.

const COLUMN_TYPES     = ['source', 'computed', 'excel', 'master_lookup', 'master_validate'];
const FILTER_OPERATORS = ['equals', 'not_equals', 'contains', 'not_contains', 'gt', 'lt', 'is_empty', 'is_not_empty'];
const MASTER_TYPES     = ['sku', 'ledger'];
const MERGE_TYPES      = ['join', 'stack', 'column_combine'];
const AGGREGATIONS     = ['sum', 'avg', 'count', 'min', 'max', 'first', 'last', 'concat'];
const FORMULA_FUNCTIONS = ['IF', 'SUMIF', 'SUMIFS', 'COUNTIF', 'COUNTIFS', 'AVERAGEIF', 'VLOOKUP', 'MAXIF', 'MINIF'];

// Anything left over after stripping {refs}/"refs" and known function names must
// only be made of these characters (numbers, operators, punctuation, whitespace).
const SAFE_REMAINDER_RE = /^[0-9+\-*/().,\s<>=!&|]*$/;
const FORBIDDEN_SUBSTRINGS = [
  ';', '`', '=>', '${', '[', ']',
  'require', 'process', 'constructor', 'function', 'import', 'while', 'global', 'this'
];

function fail(errors, path, message) {
  errors.push({ path, message });
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// Extracts {Label} column-ref tokens and "Label" quoted tokens from a formula,
// replacing each with a neutral numeric literal so the remainder can be
// grammar-checked in isolation. {Label} is always a column reference. "Label"
// is a column reference only for "excel" formulas (whole-column range args);
// for "computed" formulas it's a string literal used in IF comparisons.
function extractTokensAndStrip(formula) {
  const tokens = [];
  const quoted = [];
  let stripped = formula.replace(/\{([^}]*)\}/g, (_, ref) => { tokens.push(ref); return '0'; });
  stripped = stripped.replace(/"([^"]*)"/g, (_, ref) => { quoted.push(ref); return '0'; });
  return { tokens, quoted, stripped };
}

function validateFormulaGrammar(formula, availableTokens, errors, path, colType) {
  if (!isNonEmptyString(formula)) {
    fail(errors, path, 'Formula must be a non-empty string');
    return;
  }
  for (const bad of FORBIDDEN_SUBSTRINGS) {
    if (formula.includes(bad)) {
      fail(errors, path, `Formula contains disallowed token "${bad}"`);
      return;
    }
  }

  const { tokens, quoted, stripped } = extractTokensAndStrip(formula);

  for (const token of tokens) {
    if (!availableTokens.has(token)) {
      fail(errors, path, `Formula references unknown column "${token}"`);
    }
  }

  // Quoted strings are whole-column references in "excel" formulas, but plain
  // string literals (e.g. IF({State} == "Delhi", ...)) in "computed" formulas.
  if (colType === 'excel') {
    for (const token of quoted) {
      if (!availableTokens.has(token)) {
        fail(errors, path, `Formula references unknown column "${token}"`);
      }
    }
  }

  // Remove known function names (word-boundary, case-insensitive) before the character check.
  const withoutFunctions = stripped.replace(
    new RegExp(`\\b(${FORMULA_FUNCTIONS.join('|')})\\b`, 'gi'),
    ''
  );

  if (!SAFE_REMAINDER_RE.test(withoutFunctions)) {
    fail(errors, path, 'Formula contains characters or identifiers outside the allowed grammar (columns, numbers, operators, and IF/SUMIF-style functions only)');
  }
}

// Returns the real extracted column list for a given fileInput + raw sheet name,
// as produced by extractAllSheetsFromBuffer / the extract-columns endpoint: [{name, columns}].
function getRawColumns(fileSheetsMap, fileInputId, rawSheetName) {
  const fallbackFileId = Object.keys(fileSheetsMap || {})[0];
  const sheetsForFile = (fileSheetsMap && fileSheetsMap[fileInputId]) || (fileSheetsMap && fileSheetsMap[fallbackFileId]) || [];
  if (!sheetsForFile.length) return [];
  if (!rawSheetName) return sheetsForFile[0].columns || [];
  const match = sheetsForFile.find(s => s.name === rawSheetName);
  return match ? (match.columns || []) : (sheetsForFile[0].columns || []);
}

function validateMergeSheet(sheet, idx, sheetNames, fileSheetsMap, errors) {
  const path = `sheets[${idx}]`;
  const mc = sheet.mergeConfig || {};
  if (!MERGE_TYPES.includes(mc.mergeType)) {
    fail(errors, `${path}.mergeConfig.mergeType`, `mergeType must be one of ${MERGE_TYPES.join(', ')}`);
  }
  const sources = Array.isArray(mc.sources) ? mc.sources : [];
  if (sources.length < 2) {
    fail(errors, `${path}.mergeConfig.sources`, 'A merge sheet needs at least 2 sources');
  }

  const allRawSheetNames = new Set();
  Object.values(fileSheetsMap || {}).forEach(sheetsForFile => (sheetsForFile || []).forEach(s => allRawSheetNames.add(s.name)));

  const sourceLabelSets = [];
  sources.forEach((src, sIdx) => {
    const sPath = `${path}.mergeConfig.sources[${sIdx}]`;
    if (!['raw', 'output'].includes(src.type)) {
      fail(errors, `${sPath}.type`, 'source.type must be "raw" or "output"');
    }
    let available = [];
    if (src.type === 'raw') {
      if (!allRawSheetNames.has(src.sheetName)) {
        fail(errors, `${sPath}.sheetName`, `Unknown raw sheet name "${src.sheetName}"`);
      }
      Object.values(fileSheetsMap || {}).forEach(sheetsForFile => {
        const match = (sheetsForFile || []).find(s => s.name === src.sheetName);
        if (match) available = match.columns || [];
      });
    } else {
      const priorNames = sheetNames.slice(0, idx);
      if (!priorNames.includes(src.sheetName)) {
        fail(errors, `${sPath}.sheetName`, `Merge source references a workflow sheet "${src.sheetName}" that isn't defined earlier`);
      }
    }
    (src.columns || []).forEach(col => {
      if (available.length && !available.includes(col)) {
        fail(errors, `${sPath}.columns`, `Column "${col}" is not available on source "${src.sheetName}"`);
      }
    });
    if (mc.mergeType === 'join') {
      const key = mc.commonJoinKey || src.joinKey;
      if (!isNonEmptyString(key)) {
        fail(errors, `${sPath}.joinKey`, 'Join merges require a join key on every source');
      } else if (available.length && !available.includes(key)) {
        fail(errors, `${sPath}.joinKey`, `Join key "${key}" is not available on source "${src.sheetName}"`);
      }
    }
    sourceLabelSets.push(src.columns || []);
  });

  return Array.from(new Set(sourceLabelSets.flat()));
}

function validateNormalSheet(sheet, idx, sheets, fileSheetsMap, masterSchema, errors) {
  const path = `sheets[${idx}]`;

  let baseAvailable;
  if (sheet.sourceType === 'prev_sheet') {
    if (!isNonEmptyString(sheet.prevSheetName)) {
      fail(errors, `${path}.prevSheetName`, 'sourceType "prev_sheet" requires prevSheetName');
      baseAvailable = [];
    } else {
      const prevIdx = sheets.slice(0, idx).findIndex(s => s.name === sheet.prevSheetName);
      if (prevIdx === -1) {
        fail(errors, `${path}.prevSheetName`, `No earlier sheet named "${sheet.prevSheetName}"`);
        baseAvailable = [];
      } else {
        baseAvailable = sheet.__prevLabelSets[prevIdx] || [];
      }
    }
  } else {
    baseAvailable = getRawColumns(fileSheetsMap, sheet.fileInputId, sheet.rawSheetName);
  }

  const crossSheetTokens = [];
  for (let j = 0; j < idx; j++) {
    (sheet.__prevLabelSets[j] || []).forEach(label => crossSheetTokens.push(`${sheets[j].name}.${label}`));
  }

  const ownDeclaredLabels = [];
  const availableTokens = new Set([...baseAvailable, ...crossSheetTokens]);

  const orderedColumns = [...(sheet.columns || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (!orderedColumns.length) {
    fail(errors, `${path}.columns`, 'Sheet must declare at least one column');
  }

  for (const col of orderedColumns) {
    const cPath = `${path}.columns[${col.id ?? col.label ?? '?'}]`;
    if (!COLUMN_TYPES.includes(col.type)) {
      fail(errors, `${cPath}.type`, `Unknown column type "${col.type}"`);
      continue;
    }
    if (!isNonEmptyString(col.label)) {
      fail(errors, `${cPath}.label`, 'Column label is required');
      continue;
    }

    switch (col.type) {
      case 'source':
        if (!isNonEmptyString(col.key)) {
          fail(errors, `${cPath}.key`, 'source column requires key');
        } else if (baseAvailable.length && !baseAvailable.includes(col.key)) {
          fail(errors, `${cPath}.key`, `Source column "${col.key}" does not exist on this sheet's input`);
        }
        break;
      case 'computed':
      case 'excel':
        validateFormulaGrammar(col.formula, availableTokens, errors, `${cPath}.formula`, col.type);
        break;
      case 'master_lookup':
      case 'master_validate': {
        if (!MASTER_TYPES.includes(col.masterType)) {
          fail(errors, `${cPath}.masterType`, `masterType must be one of ${MASTER_TYPES.join(', ')}`);
        }
        if (!isNonEmptyString(col.lookupColumn) || !availableTokens.has(col.lookupColumn)) {
          fail(errors, `${cPath}.lookupColumn`, `lookupColumn "${col.lookupColumn}" is not an available column on this sheet`);
        }
        const knownFields = masterSchema && masterSchema[col.masterType];
        if (!isNonEmptyString(col.matchField)) {
          fail(errors, `${cPath}.matchField`, 'matchField is required');
        } else if (Array.isArray(knownFields) && knownFields.length && !knownFields.includes(col.matchField)) {
          fail(errors, `${cPath}.matchField`, `matchField "${col.matchField}" was not found in the ${col.masterType} master schema`);
        }
        if (col.type === 'master_lookup' && !isNonEmptyString(col.returnField)) {
          fail(errors, `${cPath}.returnField`, 'returnField is required');
        }
        break;
      }
    }

    ownDeclaredLabels.push(col.label);
    availableTokens.add(col.label);
  }

  (sheet.filters || []).forEach((f, fIdx) => {
    const fPath = `${path}.filters[${fIdx}]`;
    if (!FILTER_OPERATORS.includes(f.operator)) {
      fail(errors, `${fPath}.operator`, `Filter operator must be one of ${FILTER_OPERATORS.join(', ')}`);
    }
    if (!isNonEmptyString(f.column) || (baseAvailable.length && !baseAvailable.includes(f.column))) {
      fail(errors, `${fPath}.column`, `Filter column "${f.column}" is not available on this sheet's input`);
    }
  });

  if (sheet.groupBy?.enabled) {
    const gPath = `${path}.groupBy`;
    (sheet.groupBy.columns || []).forEach(c => {
      if (!ownDeclaredLabels.includes(c)) fail(errors, `${gPath}.columns`, `Group-by column "${c}" is not declared on this sheet`);
    });
    Object.entries(sheet.groupBy.aggregations || {}).forEach(([col, method]) => {
      if (!ownDeclaredLabels.includes(col)) fail(errors, `${gPath}.aggregations`, `Aggregation references unknown column "${col}"`);
      if (!AGGREGATIONS.includes(method)) fail(errors, `${gPath}.aggregations`, `Aggregation method "${method}" for "${col}" must be one of ${AGGREGATIONS.join(', ')}`);
    });
  }

  return ownDeclaredLabels;
}

/**
 * @param {object} draft - candidate { name, description, fileInputs, sheets }
 * @param {object} ctx
 * @param {object} ctx.fileSheetsMap - { [fileInputId]: [{name, columns}] }, from extract-columns
 * @param {object} [ctx.masterSchema] - { sku: [fieldNames], ledger: [fieldNames] }
 * @returns {{ valid: boolean, errors: Array<{path:string, message:string}> }}
 */
function validateWorkflowDraft(draft, ctx = {}) {
  const errors = [];
  const fileSheetsMap = ctx.fileSheetsMap || {};
  const masterSchema  = ctx.masterSchema || {};

  if (!draft || typeof draft !== 'object') {
    return { valid: false, errors: [{ path: 'draft', message: 'Draft must be an object' }] };
  }
  if (!isNonEmptyString(draft.name)) fail(errors, 'name', 'Workflow name is required');
  if (!Array.isArray(draft.sheets) || draft.sheets.length === 0) {
    fail(errors, 'sheets', 'At least one sheet is required');
    return { valid: false, errors };
  }

  const sheets = draft.sheets;
  const sheetNames = sheets.map(s => s.name);
  const labelSets = [];

  sheets.forEach((sheet, idx) => {
    if (!isNonEmptyString(sheet.name)) fail(errors, `sheets[${idx}].name`, 'Sheet name is required');

    if (sheet.type === 'merge') {
      labelSets[idx] = validateMergeSheet(sheet, idx, sheetNames, fileSheetsMap, errors);
    } else {
      sheet.__prevLabelSets = labelSets; // read-only lookup helper, not persisted
      labelSets[idx] = validateNormalSheet(sheet, idx, sheets, fileSheetsMap, masterSchema, errors);
      delete sheet.__prevLabelSets;
    }
  });

  return { valid: errors.length === 0, errors };
}

module.exports = { validateWorkflowDraft };
