const { getBrandConnection } = require('../config/database');
const { Brand } = require('../models/master');
const ExcelJS = require('exceljs');

// ─── helpers ────────────────────────────────────────────────────────────────

const getBrandSeq = async (brandId) => {
  const brand = await Brand.findByPk(brandId);
  if (!brand) throw new Error('Brand not found');
  return getBrandConnection(brand.db_name);
};

const withBypass = async (seq, queryFn) => {
  return seq.transaction(async (t) => {
    await seq.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
    return queryFn(t);
  });
};

// Normalize narration to a stable lookup key:
// uppercase, trim, collapse runs of whitespace to a single space.
const normalizeNarration = (desc) =>
  (desc || '').trim().toUpperCase().replace(/\s+/g, ' ');

// Extract stable payee identity keys from a bank narration.
// Mirrors extract_payee_keys() in classify.py — must stay in sync.
const PHONE_RE = /(?<!\d)([6-9]\d{9})(?!\d)/;
const VPA_RE = /([A-Za-z0-9.\-]+@[A-Za-z]+)/;
const normKey = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().replace(/\s+/g, ' ');

// FLO slash-format NEFT/RTGS + IMPS-FROM payee extraction (Task 2.5a).
// A "junk token" is dropped from payee candidates: it is pure-numeric or
// contains any digit (an account number, or a bank-code+digits blob like
// "UTIB0001234"), or is an exact 4-letter bank/IFSC code (e.g. UTIB, HDFC).
// Shared by the IMPS-FROM tokenizer and the slash-NEFT/RTGS field filter below.
// Mirrors _is_junk_token() in classify.py — must stay in sync.
const BANKCODE_RE = /^[A-Z]{4}$/;
const isJunkToken = (t) => /\d/.test(t) || BANKCODE_RE.test(t);

// FLO slash format: (NEFT|RTGS)/<ref>/[<BANKCODE>/]<PAYEE>[/<BANK>/<num>].
// Drop the ref field, then drop any remaining field that is itself a single
// junk token (numeric / bank-code) -- multi-word fields are never dropped
// wholesale, so an alphanumeric abbreviation inside a real payee name (e.g.
// "P2P" in "NDX P2P PRIVATE LIMITED LENDER") is preserved. The remaining
// field with the most alphabetic characters is the payee. Never derive a
// key from the numeric reference itself.
const slashNeftPayee = (u) => {
  const m = u.match(/^(?:NEFT|RTGS)\/(.+)/);
  if (!m) return null;
  let parts = m[1].split('/').map((p) => p.trim()).filter((p) => p);
  if (!parts.length) return null;
  parts = parts.slice(1); // drop the ref field
  const candidates = parts.filter((p) => p.includes(' ') || !isJunkToken(p));
  if (!candidates.length) return null;
  const alphaCount = (t) => (t.match(/[A-Za-z]/g) || []).length;
  const best = candidates.reduce((a, b) => (alphaCount(b) > alphaCount(a) ? b : a));
  return normKey(best);
};

// IMPS <ref> FROM <PAYEE>: tokenize the trailing text on whitespace, drop
// junk tokens (numeric / bank-code), and only report a payee if something
// with an actual letter survives (never an all-numeric key, which would
// otherwise leak the account number into neft_name).
const impsFromPayee = (u) => {
  const m = u.match(/\bIMPS\s+\d+\s+FROM\s+(.+)/);
  if (!m) return null;
  const survivors = m[1].split(/\s+/).filter((t) => t && !isJunkToken(t));
  if (!survivors.length) return null;
  const joined = survivors.join(' ');
  if (!/[A-Za-z]/.test(joined)) return null;
  return normKey(joined);
};

// ── Dash/slash narration rails (ICICI, Kotak, NACH) ─────────────────────────
// Mirrors the same-named helpers in classify.py — these MUST stay in sync, because this
// file WRITES the keys that classify.py READS. When they disagreed, every correction was
// stored under a key the classifier never looked up: 598 learned Urban Plant entries
// matched 0 of 261 rows on the 2026-06 statement.
const GENERIC_BIZ_WORDS = new Set([
  'enterprises', 'enterprise', 'services', 'service', 'foods', 'food', 'traders', 'trader',
  'private', 'limited', 'pvt', 'ltd', 'llp', 'and', 'co', 'company', 'the', 'industries',
  'industry', 'products', 'product', 'solutions', 'solution', 'india', 'indian', 'inc',
  'corporation', 'corp', 'logistics', 'logistic', 'technologies', 'technology', 'global',
  'retail', 'online', 'store', 'sons', 'son', 'bros', 'brothers', 'group', 'international',
  'intl', 'trading', 'exports', 'imports', 'distributors', 'distributor', 'agencies',
  'agency', 'marketing', 'sales', 'a/c', 'ac',
]);
const PLACEHOLDER_WORDS = new Set(['bank', 'account', 'accounts', 'ac', 'a', 'self', 'other', 'misc']);
// Bare IFSC/bank prefixes — see the matching note on _BANK_PREFIXES in classify.py.
// A bank code that slips through is the one kind of bad key that COLLIDES, so the closed
// set of Indian bank prefixes is rejected by name. MUST stay in sync with classify.py.
const BANK_PREFIXES = new Set([
  'hdfc', 'icic', 'sbin', 'utib', 'axis', 'kkbk', 'punb', 'barb', 'ubin', 'ioba',
  'cnrb', 'idib', 'yesb', 'indb', 'ratn', 'deut', 'citi', 'hsbc', 'scbl', 'idfb',
  'fdrl', 'karb', 'tmbl', 'jaka', 'mahb', 'orbc', 'ucba', 'psib', 'cbin', 'ibkl',
  'bkid', 'aubl', 'esfb', 'usfb', 'jsfb', 'fino', 'pytm', 'airp', 'kvbl', 'svcb',
]);
const NOISE_KEY_WORDS = new Set(['NEFT', 'RTGS', 'IMPS', 'UPI', 'TO', 'FROM', 'DR', 'CR', 'BANK']);

// Every word is filler: a generic business suffix, a placeholder, or a repeated-letter
// stub ('x','xx'). "UPI/Bank Account XX/<ref>/Gaurav may" must not key on the placeholder,
// or every unrelated payee sharing it collapses onto one ledger.
const isPlaceholder = (nm) => {
  const words = String(nm || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  return words.every((w) =>
    GENERIC_BIZ_WORDS.has(w) || PLACEHOLDER_WORDS.has(w) || new Set(w).size === 1);
};

const usableKey = (nm) => {
  if (!nm || nm.length < 3) return false;
  if (/^\d+$/.test(nm.replace(/ /g, ''))) return false;
  if (NOISE_KEY_WORDS.has(nm.toUpperCase())) return false;
  return !isPlaceholder(nm);
};

const alphaCount = (t) => (t.match(/[A-Za-z]/g) || []).length;

// Richest-in-letters non-junk field. Used where the payee is not at a fixed position.
const fieldsByAlpha = (fields) => fields
  .map((f) => (f || '').trim()).filter(Boolean)
  .filter((f) => f.includes(' ') || !isJunkToken(f))
  .sort((a, b) => alphaCount(b) - alphaCount(a));

// First non-junk field in POSITIONAL order — for rails where the payee precedes the bank
// (UPI/<PAYEE>/<BANK>/…, MMT/IMPS/<ref>/<utr>/<PAYEE>/<BANK>). Only digit-bearing fields
// count as junk here, so a genuinely short payee ('AZAD') survives; a bare 4-letter code
// followed by a long digit run is an IFSC prefix ('…/UBIN/708815530180/…') and is skipped.
const firstAlphaField = (fields) => {
  const clean = fields.map((f) => (f || '').trim());
  let bankFallback = null;
  for (let i = 0; i < clean.length; i += 1) {
    const f = clean[i];
    if (!f) continue;
    if (!(f.includes(' ') || !/\d/.test(f))) continue;
    if (!/[A-Za-z]/.test(f)) continue;
    if (isPlaceholder(normKey(f))) continue;
    // A known bank prefix LOSES to a real payee that follows it ("…/HDFC/SOMEBODY" →
    // 'somebody'), but when it is the ONLY thing in the payee slot the transfer really is
    // to that bank ("INF/NEFT/<ref>/HDFC0000044/HDFC" = own-account transfer). Remember it
    // and use it only if nothing better turns up.
    if (BANK_PREFIXES.has(normKey(f))) { if (!bankFallback) bankFallback = f; continue; }
    const nxt = clean[i + 1] || '';
    if (BANKCODE_RE.test(f.toUpperCase()) && /^\d{6,}$/.test(nxt)) continue;
    return f;
  }
  return bankFallback;
};

// ICICI: NEFT-<REF>-<PAYEE>-<digits>-<digits>
const dashNeftPayee = (u) => {
  const m = u.match(/^(?:NEFT|RTGS)-[A-Z0-9]+-(.+)$/);
  if (!m) return null;
  const best = fieldsByAlpha(m[1].split('-'));
  return best.length ? normKey(best[0]) : null;
};

// Kotak: 'NEFT <REF> <PAYEE...>'
const spaceNeftPayee = (u) => {
  const m = u.match(/^(?:NEFT|RTGS)\s+(.+)$/);
  if (!m) return null;
  const joined = m[1].split(/\s+/).filter((t) => t && !isJunkToken(t)).join(' ');
  if (!/[A-Za-z]/.test(joined)) return null;
  return normKey(joined);
};

// Slash rails where the payee is the first non-junk field after the prefix.
const slashRailPayee = (u) => {
  const m = u.match(/^(?:MMT\/IMPS|INF\/(?:NEFT|RTGS|IMPS|INFT)|BIL\/ONL|UPI)\/(.+)$/);
  if (!m) return null;
  const best = firstAlphaField(m[1].split('/'));
  return best ? normKey(best) : null;
};

// NACH-<n>-<DR|CR>-<SPONSOR>-<COUNTERPARTY>. The sponsor is the collecting aggregator;
// the counterparty is the last field. Banks often concatenate a per-instalment mandate ref
// onto it (STRATEGICFT6FWSD8 / STRATEGICFT3UYYAU), which would yield a new key every month
// — emit nothing there and let the side rule's substring token handle those rows.
const nachCounterparty = (u) => {
  const m = u.match(/^NACH-\d+-(?:DR|CR)-(.+)$/);
  if (!m) return null;
  const fields = m[1].split('-').map((f) => f.trim()).filter(Boolean);
  for (let i = fields.length - 1; i >= 0; i -= 1) {
    const f = fields[i];
    if (!/[A-Za-z]/.test(f)) continue;
    if (!f.includes(' ') && f.length > 12) return null;
    return normKey(f);
  }
  return null;
};

// Kotak plain-language rail: 'FUNDS TRANSFER TO|FROM <PAYEE>'
const fundsTransferPayee = (u) => {
  const m = u.match(/\bFUNDS\s+TRANSFER\s+(?:TO|FROM)\s+(.+)$/);
  if (!m) return null;
  const joined = m[1].split(/\s+/).filter((t) => t && !isJunkToken(t)).join(' ');
  if (!/[A-Za-z]/.test(joined)) return null;
  return normKey(joined);
};

const extractPayeeKeys = (narration) => {
  if (!narration) return {};
  const raw = String(narration).trim();
  const u = raw.toUpperCase();
  const keys = { exact: u.replace(/\s+/g, ' ') };
  const mPh = raw.match(PHONE_RE);
  if (mPh) keys.phone = mPh[1];
  if (u.includes('UPI')) {
    const mVpa = raw.match(VPA_RE);
    if (mVpa) keys.vpa = mVpa[1].toLowerCase();
    const mName = u.match(/\s*UPI-(.+?)-/);
    if (mName) {
      const nm = normKey(mName[1]);
      if (nm && !/^\d+$/.test(nm)) keys.name = nm;
    }
  }
  const mNeft = u.match(/(?:NEFT|RTGS)\s+(?:DR|CR)-[A-Z0-9]+-(.+?)-(?:NETBANK|NB[ ,]|NB$)/);
  if (mNeft) {
    const nm = normKey(mNeft[1]);
    if (nm) keys.neft_name = nm;
  }
  if (!keys.neft_name) {
    // FLO slash-NEFT/RTGS + IMPS-FROM (Task 2.5a)
    const nm = slashNeftPayee(u) || impsFromPayee(u);
    if (nm) keys.neft_name = nm;
  }
  // Dash/slash rails (ICICI, Kotak, NACH). Tried only after the patterns above, so no
  // brand that already produces keys can change behaviour.
  if (!keys.neft_name) {
    const nm = dashNeftPayee(u) || spaceNeftPayee(u);
    if (nm && usableKey(nm)) keys.neft_name = nm;
  }
  if (!keys.name) {
    const nm = nachCounterparty(u) || slashRailPayee(u) || fundsTransferPayee(u);
    if (nm && usableKey(nm)) keys.name = nm;
  }
  // Final guard: never store an identity key that cannot identify anyone.
  for (const sec of ['name', 'neft_name']) {
    if (keys[sec] && !usableKey(keys[sec])) delete keys[sec];
  }
  return keys;
};

// ─── GET /api/bank-reco/corrections/:brandId ────────────────────────────────
// Returns all stored corrections for a brand.

const getCorrections = async (req, res) => {
  const { brandId } = req.params;
  try {
    const seq = await getBrandSeq(brandId);
    const rows = await withBypass(seq, async (t) => {
      const [result] = await seq.query(
        `SELECT narration_raw, narration_key, correct_ledger, correct_type, source, updated_at
         FROM bank_reco_corrections
         WHERE brand_id = $1
         ORDER BY updated_at DESC`,
        { bind: [brandId], transaction: t }
      );
      return result;
    });
    res.json({ corrections: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── POST /api/bank-reco/corrections/:brandId ───────────────────────────────
// Upsert one or more corrections from the inline web UI.
// Body: { corrections: [{description, correct_ledger, correct_type, job_id?}] }
// Also updates bank_reco_results for the given job if job_id is provided.

const saveCorrections = async (req, res) => {
  const { brandId } = req.params;
  const { corrections = [], job_id } = req.body;

  if (!Array.isArray(corrections) || corrections.length === 0) {
    return res.status(400).json({ error: 'corrections array is required' });
  }

  try {
    const seq = await getBrandSeq(brandId);
    let saved = 0;
    let dbUpdated = 0;

    await withBypass(seq, async (t) => {
      for (const c of corrections) {
        const { description, correct_ledger, correct_type } = c;
        if (!description || !correct_ledger) continue;

        const key = normalizeNarration(description);

        // Upsert into corrections store
        await seq.query(
          `INSERT INTO bank_reco_corrections
             (brand_id, narration_raw, narration_key, correct_ledger, correct_type, source, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'ui', NOW())
           ON CONFLICT (brand_id, narration_key)
           DO UPDATE SET
             correct_ledger = EXCLUDED.correct_ledger,
             correct_type   = EXCLUDED.correct_type,
             source         = 'ui',
             narration_raw  = EXCLUDED.narration_raw,
             updated_at     = NOW()`,
          { bind: [brandId, description, key, correct_ledger, correct_type || null], transaction: t }
        );
        saved++;

        // Also write identity keys to payee directory so future UPI/NEFT rows
        // with the same phone/VPA are auto-resolved without needing exact narration match
        const payeeKeys = extractPayeeKeys(description);
        for (const [keyType, keyValue] of Object.entries(payeeKeys)) {
          if (keyType === 'exact') continue; // already in bank_reco_corrections
          await seq.query(
            `INSERT INTO bank_payee_directory
               (brand_id, key_type, key_value, ledger, txn_type, source, updated_at)
             VALUES ($1, $2, $3, $4, $5, 'correction', NOW())
             ON CONFLICT (brand_id, key_type, key_value)
             DO UPDATE SET
               ledger     = EXCLUDED.ledger,
               txn_type   = EXCLUDED.txn_type,
               source     = 'correction',
               updated_at = NOW()`,
            { bind: [brandId, keyType, keyValue, correct_ledger, correct_type || null], transaction: t }
          );
        }

        // Back-fill bank_reco_results for this job if provided
        if (job_id) {
          const [updateResult] = await seq.query(
            `UPDATE bank_reco_results
             SET ledger_name = $1, txn_type = COALESCE($2, txn_type), confidence = 'High'
             WHERE brand_id = $3
               AND job_id   = $4
               AND description = $5`,
            { bind: [correct_ledger, correct_type || null, brandId, job_id, description], transaction: t }
          );
          dbUpdated += updateResult?.rowCount || 0;
        }
      }
    });

    res.json({ saved, db_rows_updated: dbUpdated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── POST /api/bank-reco/corrections/:brandId/upload-excel ──────────────────
// Parse a corrected output Excel and extract rows where "CHANGES" column is
// non-empty. "Ledger Name" = accountant's correct answer; "Description" = key.
// Also accepts job_id in the body to back-fill bank_reco_results.

const uploadCorrectionsExcel = async (req, res) => {
  const { brandId } = req.params;
  const { job_id } = req.body || {};

  if (!req.file && (!req.files || req.files.length === 0)) {
    return res.status(400).json({ error: 'Excel file is required' });
  }

  const fileBuffer = req.file
    ? req.file.buffer
    : req.files[0].buffer;

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer);

    // Find the sheet that looks like bank statement output
    let ws = workbook.getWorksheet('Bank Statement')
          || workbook.getWorksheet(1);

    if (!ws) return res.status(400).json({ error: 'Could not find Bank Statement sheet in Excel' });

    // Read header row to find column indices
    const headerRow = ws.getRow(1).values; // 1-indexed, index 0 is undefined
    const colIndex = {};
    headerRow.forEach((cell, i) => {
      const name = (cell || '').toString().trim().toLowerCase();
      if (name === 'description')  colIndex.description  = i;
      if (name === 'ledger name')  colIndex.ledgerName   = i;
      if (name === 'type')         colIndex.txnType      = i;
      if (name === 'changes')      colIndex.changes      = i;
    });

    if (!colIndex.description || !colIndex.ledgerName || !colIndex.changes) {
      return res.status(400).json({
        error: 'Excel must have columns: Description, Ledger Name, Changes'
      });
    }

    // Collect corrected rows (CHANGES column non-empty = accountant changed it)
    const corrections = [];
    ws.eachRow((row, rowNum) => {
      if (rowNum === 1) return; // skip header
      const changesVal = row.getCell(colIndex.changes).text?.trim();
      if (!changesVal) return;

      const description   = row.getCell(colIndex.description).text?.trim();
      const correct_ledger = row.getCell(colIndex.ledgerName).text?.trim();
      const correct_type  = colIndex.txnType
        ? row.getCell(colIndex.txnType).text?.trim()
        : null;

      if (description && correct_ledger) {
        corrections.push({ description, correct_ledger, correct_type });
      }
    });

    if (corrections.length === 0) {
      return res.json({ saved: 0, message: 'No corrections found (CHANGES column empty for all rows)' });
    }

    const seq = await getBrandSeq(brandId);
    let saved = 0;
    let dbUpdated = 0;

    await withBypass(seq, async (t) => {
      for (const c of corrections) {
        const key = normalizeNarration(c.description);

        await seq.query(
          `INSERT INTO bank_reco_corrections
             (brand_id, narration_raw, narration_key, correct_ledger, correct_type, source, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'excel', NOW())
           ON CONFLICT (brand_id, narration_key)
           DO UPDATE SET
             correct_ledger = EXCLUDED.correct_ledger,
             correct_type   = EXCLUDED.correct_type,
             source         = 'excel',
             narration_raw  = EXCLUDED.narration_raw,
             updated_at     = NOW()`,
          { bind: [brandId, c.description, key, c.correct_ledger, c.correct_type || null], transaction: t }
        );
        saved++;

        if (job_id) {
          const [updateResult] = await seq.query(
            `UPDATE bank_reco_results
             SET ledger_name = $1, txn_type = COALESCE($2, txn_type), confidence = 'High'
             WHERE brand_id  = $3
               AND job_id    = $4
               AND description = $5`,
            { bind: [c.correct_ledger, c.correct_type || null, brandId, job_id, c.description], transaction: t }
          );
          dbUpdated += updateResult?.rowCount || 0;
        }
      }
    });

    res.json({ saved, db_rows_updated: dbUpdated, total_rows_scanned: ws.rowCount - 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── POST /api/bank-reco/corrections/:brandId/upload-output ─────────────────
// Accepts a standard classify.py output Excel (no CHANGES column needed).
// Imports all High confidence rows as corrections into bank_reco_corrections.
// Handles: rich-text cells, merged title rows, multi-sheet workbooks, fuzzy headers.

const uploadOutputExcel = async (req, res) => {
  const { brandId } = req.params;

  if (!req.file && (!req.files || req.files.length === 0)) {
    return res.status(400).json({ error: 'Excel file is required' });
  }
  const fileBuffer = req.file ? req.file.buffer : req.files[0].buffer;

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer);

    // Extract text from any cell value — handles plain string, rich text objects, numbers
    const cellText = (val) => {
      if (!val) return '';
      if (typeof val === 'string') return val.trim();
      if (typeof val === 'object' && Array.isArray(val.richText)) {
        return val.richText.map(r => r.text || '').join('').trim();
      }
      return String(val).trim();
    };

    const toImport = [];
    let skipped = 0;

    console.log(`[UPLOAD-OUTPUT] brandId=${brandId} fileSize=${fileBuffer.length} sheets=${workbook.worksheets.length}`);

    for (const ws of workbook.worksheets) {
      // Fuzzy header detection — try row 1, fall back to row 2 if row 1 is a merged title
      const scanHeaderRow = (rowNum) => {
        const colIndex = {};
        ws.getRow(rowNum).values.forEach((cell, i) => {
          const name = cellText(cell).toLowerCase();
          if (!name) return;
          if (!colIndex.description &&
              (name.includes('description') || name.includes('narration') ||
               name.includes('particulars') || name.includes('transaction detail') ||
               name === 'details' || name === 'remarks' || name === 'cheque details')) {
            colIndex.description = i;
          }
          // Ledger columns, by PRECEDENCE rather than first-match.
          //
          // An accountant-audited workbook has TWO ledger columns: the agent's answer
          // ("Ledger Name") and the accountant's fix ("Correct Ledger Name"). Binding to
          // whichever appears first scans left-to-right and picks the agent's own answer
          // — so importing an audited file taught the system its own mistakes and
          // reinforced them. The correction column always wins.
          const looksLedger = name.includes('ledger') || name.includes('tally') ||
              name.includes('chart of account') || name.includes('gl account') ||
              name === 'account name' || name === 'account' || name === 'gl';
          const looksCorrection = /correct|revised|final|actual|change/.test(name);
          if (looksLedger && looksCorrection) {
            colIndex.correctedLedger = i;           // highest precedence
          } else if (looksLedger && !colIndex.ledgerName) {
            colIndex.ledgerName = i;                // the predicted value
          }
          // Amounts — required to know which SIDE a correction applies to. Without them
          // a two-sided vendor rule (Receipt vs Payment) can never be derived.
          if (!colIndex.debit &&
              (name === 'debit' || name.includes('withdrawal') || name.includes('dr amount') ||
               name.includes('debit amt'))) {
            colIndex.debit = i;
          }
          if (!colIndex.credit &&
              (name === 'credit' || name.includes('deposit') || name.includes('cr amount') ||
               name.includes('credit amt'))) {
            colIndex.credit = i;
          }
          if (!colIndex.txnType &&
              (name === 'type' || name.includes('txn type') || name.includes('transaction type') ||
               name.includes('vch type') || name.includes('voucher type') ||
               name === 'dr/cr' || name === 'dr / cr')) {
            colIndex.txnType = i;
          }
          if (!colIndex.confidence &&
              (name === 'confidence' || name.includes('confidence') || name === 'score')) {
            colIndex.confidence = i;
          }
        });
        return colIndex;
      };

      let headerRowNum = 1;
      let colIndex = scanHeaderRow(1);

      // If row 1 has no useful headers (merged title row), try row 2
      if (!colIndex.description && !colIndex.ledgerName && !colIndex.correctedLedger) {
        colIndex = scanHeaderRow(2);
        if (colIndex.description || colIndex.ledgerName || colIndex.correctedLedger) headerRowNum = 2;
      }

      const allHeaders = ws.getRow(headerRowNum).values.map(c => cellText(c)).filter(Boolean);
      console.log(`[UPLOAD-OUTPUT] sheet="${ws.name}" headerRow=${headerRowNum} headers=${JSON.stringify(allHeaders)} colIndex=`, colIndex);

      // The ledger we LEARN from is the correction column when present, else the single
      // ledger column (a file with no correction column is accountant-prepared already).
      const learnCol = colIndex.correctedLedger || colIndex.ledgerName;
      if (!colIndex.description || !learnCol) {
        console.log(`[UPLOAD-OUTPUT] skipping "${ws.name}" — no narration+ledger match in headers`);
        continue;
      }
      if (colIndex.correctedLedger) {
        console.log(`[UPLOAD-OUTPUT] learning from correction column ${colIndex.correctedLedger}` +
          (colIndex.ledgerName ? ` (predicted column ${colIndex.ledgerName} kept for comparison)` : ''));
      }

      ws.eachRow((row, rowNum) => {
        if (rowNum <= headerRowNum) return;
        // A confidence filter only makes sense for a RAW agent output. Once an accountant
        // has added a correction column, every row they touched is authoritative
        // regardless of what the agent's confidence said — in fact the Low rows are the
        // most valuable ones to learn from.
        if (!colIndex.correctedLedger) {
          const conf = colIndex.confidence
            ? cellText(row.getCell(colIndex.confidence).value)
            : 'High'; // no confidence column → accountant-prepared file, import all rows
          if (conf && conf !== 'High') { skipped++; return; }
        }

        const description    = cellText(row.getCell(colIndex.description).value);
        const correct_ledger = cellText(row.getCell(learnCol).value);
        const correct_type   = colIndex.txnType
          ? cellText(row.getCell(colIndex.txnType).value)
          : null;
        if (!description || !correct_ledger) return;

        const num = (idx) => {
          if (!idx) return 0;
          const v = row.getCell(idx).value;
          const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
          return Number.isFinite(n) ? n : 0;
        };
        const debit  = num(colIndex.debit);
        const credit = num(colIndex.credit);
        // side drives two-sided vendor rules; 'agreed' distinguishes a confirmation
        // (agent was already right) from a genuine correction.
        const side = credit > 0 ? 'credit' : (debit > 0 ? 'debit' : null);
        const predicted = colIndex.ledgerName && colIndex.correctedLedger
          ? cellText(row.getCell(colIndex.ledgerName).value)
          : null;
        toImport.push({
          description, correct_ledger, correct_type, debit, credit, side,
          agreed: predicted != null ? predicted === correct_ledger : null,
        });
      });
    }

    console.log(`[UPLOAD-OUTPUT] collected toImport=${toImport.length} skipped=${skipped}`);

    if (toImport.length === 0) {
      const sheetNames = workbook.worksheets.map(w => w.name).join(', ');
      return res.status(400).json({
        error: `No High confidence rows found. Sheets in file: [${sheetNames}]. Make sure you are uploading the classified output Excel (Download Excel button), not the raw bank statement.`
      });
    }

    const seq = await getBrandSeq(brandId);
    let saved = 0;

    await withBypass(seq, async (t) => {
      for (const { description, correct_ledger, correct_type } of toImport) {
        const key = normalizeNarration(description);
        await seq.query(
          `INSERT INTO bank_reco_corrections
             (brand_id, narration_raw, narration_key, correct_ledger, correct_type, source, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'output_upload', NOW())
           ON CONFLICT (brand_id, narration_key)
           DO UPDATE SET
             correct_ledger = EXCLUDED.correct_ledger,
             correct_type   = EXCLUDED.correct_type,
             source         = 'output_upload',
             narration_raw  = EXCLUDED.narration_raw,
             updated_at     = NOW()`,
          { bind: [brandId, description, key, correct_ledger, correct_type || null], transaction: t }
        );
        saved++;

        // Extract payee identity keys and write to bank_payee_directory
        const payeeKeys = extractPayeeKeys(description);
        for (const [keyType, keyValue] of Object.entries(payeeKeys)) {
          if (keyType === 'exact') continue;
          await seq.query(
            `INSERT INTO bank_payee_directory
               (brand_id, key_type, key_value, ledger, txn_type, source, updated_at)
             VALUES ($1, $2, $3, $4, $5, 'output_upload', NOW())
             ON CONFLICT (brand_id, key_type, key_value)
             DO UPDATE SET
               ledger     = EXCLUDED.ledger,
               txn_type   = EXCLUDED.txn_type,
               source     = 'output_upload',
               updated_at = NOW()`,
            { bind: [brandId, keyType, keyValue, correct_ledger, correct_type || null], transaction: t }
          );
        }
      }
    });

    // Learn two-sided vendor rules from this batch. Best-effort: a derivation hiccup must
    // never fail an import the accountant just did.
    let sideRules = { created: 0, suggested: 0 };
    try {
      const sideBrand = await Brand.findByPk(brandId);
      sideRules = await deriveSideRules(brandId, seq, toImport, sideBrand && sideBrand.name);
    } catch (e) {
      console.warn('[SIDE-RULES] derivation skipped:', e.message);
    }

    res.json({
      saved, skipped, sideRules,
      message: `${saved} corrections imported from output Excel`
        + (sideRules.created || sideRules.suggested
          ? ` · ${sideRules.created} side rule(s) learned, ${sideRules.suggested} suggested`
          : ''),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── Utility: load correction map for a brand (used by recoController) ──────
// Returns keyed JSON matching classify.py's DIRECTORY_SECTIONS format:
// { exact:{…}, phone:{…}, vpa:{…}, neft_name:{…}, name:{…} }

const EMPTY_DIRECTORY = () => ({ exact: {}, phone: {}, vpa: {}, neft_name: {}, name: {} });

const loadCorrectionMap = async (brandId, seq) => {
  try {
    const dir = EMPTY_DIRECTORY();

    await withBypass(seq, async (t) => {
      // 1. exact corrections from bank_reco_corrections
      const [corrRows] = await seq.query(
        `SELECT narration_key, correct_ledger, correct_type
         FROM bank_reco_corrections
         WHERE brand_id = $1`,
        { bind: [brandId], transaction: t }
      );
      corrRows.forEach(r => {
        dir.exact[r.narration_key] = { ledger: r.correct_ledger, type: r.correct_type };
      });

      // 2. phone/vpa/neft_name/name keys from bank_payee_directory
      const [dirRows] = await seq.query(
        `SELECT key_type, key_value, ledger, txn_type
         FROM bank_payee_directory
         WHERE brand_id = $1`,
        { bind: [brandId], transaction: t }
      );
      dirRows.forEach(r => {
        const section = r.key_type; // 'phone'|'vpa'|'neft_name'|'name'|'exact'
        if (dir[section] !== undefined) {
          dir[section][r.key_value] = { ledger: r.ledger, type: r.txn_type };
        }
      });
    });

    return dir;
  } catch {
    return EMPTY_DIRECTORY(); // fail open — never block classification
  }
};

// ─── Side rules: per-brand, side-dependent vendor → ledger mapping ──────────
//
// One vendor can need two ledgers: the credit-side ledger when money arrives (a Receipt)
// and the debit-side ledger when money goes out (a Payment). bank_payee_directory stores
// exactly one ledger per key, so it structurally cannot express that — which is why these
// rules previously lived in hand-edited JSON files on disk.
//
// The table is additive and self-creating. A brand with no rows behaves exactly as before.

const ensureSideRulesTable = async (seq, t) => {
  await seq.query(`
    CREATE TABLE IF NOT EXISTS bank_side_rules (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_id      uuid NOT NULL,
      tokens        text[] NOT NULL,
      credit_ledger text NOT NULL,
      debit_ledger  text NOT NULL,
      fixed_type    text,
      tier          text NOT NULL DEFAULT 'primary',
      priority      int  NOT NULL DEFAULT 100,
      status        text NOT NULL DEFAULT 'active',
      source        text NOT NULL DEFAULT 'manual',
      evidence      jsonb,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    )`, { transaction: t });
  await seq.query(
    `CREATE INDEX IF NOT EXISTS bank_side_rules_brand_idx ON bank_side_rules (brand_id, status)`,
    { transaction: t });
};

/**
 * Load a brand's ACTIVE side rules in match order, shaped exactly like the JSON files
 * classify.py already consumes ({tokens, credit, debit, type, fallback}).
 *
 * Order is `priority ASC, longest-token DESC`: the more specific token wins without
 * anyone hand-maintaining list order, so a 'STRATEGIC' rule beats a bare 'RAZORPAY' on a
 * NACH mandate that merely passes through Razorpay.
 *
 * Returns [] on any failure — the caller then falls back to the checked-in JSON, so a
 * brand can never end up worse off than before this table existed.
 */
const loadSideRules = async (brandId, seq) => {
  try {
    let out = [];
    await withBypass(seq, async (t) => {
      await ensureSideRulesTable(seq, t);
      const [rows] = await seq.query(
        `SELECT tokens, credit_ledger, debit_ledger, fixed_type, tier, priority
           FROM bank_side_rules
          WHERE brand_id = $1 AND status = 'active'`,
        { bind: [brandId], transaction: t });
      const longest = (r) => Math.max(0, ...(r.tokens || []).map((x) => String(x).length));
      out = rows
        .sort((a, b) => (a.priority - b.priority) || (longest(b) - longest(a)))
        .map((r) => ({
          tokens: r.tokens,
          credit: r.credit_ledger,
          debit: r.debit_ledger,
          ...(r.fixed_type ? { type: r.fixed_type } : {}),
          ...(r.tier === 'fallback' ? { fallback: true } : {}),
        }));
    });
    return out;
  } catch (err) {
    console.warn('[SIDE-RULES] load failed, falling back to seed JSON:', err.message);
    return [];
  }
};

/**
 * Derive side rules from a batch of accountant-confirmed rows.
 *
 * A vendor becomes a side rule when its payee key appears with a DIFFERENT majority
 * ledger on each side of the statement. Requiring >= 2 rows per side stops one odd refund
 * from minting a rule that then governs a whole month.
 *
 * Confident and unclaimed  -> status 'active'   (source 'learned')
 * Thin evidence, or it contradicts an existing seed/manual rule -> status 'suggested'
 * (an accountant confirms those in one click; nothing silently overrides a human).
 */
// Brands allowed to have a LEARNED side rule go live on its own. Everyone else still gets
// the rule derived, but as 'suggested' — an accountant confirms it before it can affect a
// run. Side rules are a powerful override (they sit above the payee directory), so a brand
// that has never opted in must not silently acquire one from a routine corrections upload.
// Override with BANK_SIDE_RULE_BRANDS="Brand A,Brand B"; set to "*" to allow every brand.
const SIDE_RULE_AUTO_BRANDS = (process.env.BANK_SIDE_RULE_BRANDS || 'Urban Plant,M Brands')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const sideRulesAutoAllowed = (brandName) =>
  SIDE_RULE_AUTO_BRANDS.includes('*') ||
  SIDE_RULE_AUTO_BRANDS.includes(String(brandName || '').trim().toLowerCase());

const deriveSideRules = async (brandId, seq, rows, brandName = '') => {
  const bySideKey = new Map();   // payeeKey -> {credit: Map<ledger,n>, debit: Map<ledger,n>}
  for (const r of rows) {
    if (!r.side || !r.correct_ledger) continue;
    const keys = extractPayeeKeys(r.description);
    const kv = keys.name || keys.neft_name;
    if (!kv) continue;
    if (!bySideKey.has(kv)) bySideKey.set(kv, { credit: new Map(), debit: new Map() });
    const bucket = bySideKey.get(kv)[r.side];
    bucket.set(r.correct_ledger, (bucket.get(r.correct_ledger) || 0) + 1);
  }

  const top = (mp) => [...mp.entries()].sort((a, b) => b[1] - a[1])[0];
  let created = 0; let suggested = 0;

  await withBypass(seq, async (t) => {
    await ensureSideRulesTable(seq, t);
    for (const [kv, sides] of bySideKey) {
      if (!sides.credit.size || !sides.debit.size) continue;      // only ever seen one way
      const [cLed, cN] = top(sides.credit);
      const [dLed, dN] = top(sides.debit);
      if (cLed === dLed) continue;                                // not side-dependent
      const token = kv.toUpperCase();

      const [existing] = await seq.query(
        `SELECT id, source FROM bank_side_rules WHERE brand_id = $1 AND $2 = ANY(tokens)`,
        { bind: [brandId, token], transaction: t });
      // Never silently overwrite a human-authored or seeded rule.
      if (existing.length && existing[0].source !== 'learned') continue;

      const confident = cN >= 2 && dN >= 2;
      const status = (confident && !existing.length && sideRulesAutoAllowed(brandName))
        ? 'active' : 'suggested';
      await seq.query(
        `INSERT INTO bank_side_rules
           (brand_id, tokens, credit_ledger, debit_ledger, tier, priority, status, source, evidence)
         VALUES ($1, ARRAY[$2], $3, $4, 'primary', 100, $5, 'learned', $6::jsonb)`,
        { bind: [brandId, token, cLed, dLed, status,
                 JSON.stringify({ credit_rows: cN, debit_rows: dN, key: kv })],
          transaction: t });
      if (status === 'active') created++; else suggested++;
    }
  });

  if (created || suggested) {
    console.log(`[SIDE-RULES] derived ${created} active + ${suggested} suggested rule(s) ` +
      `for brand ${brandId}`);
  }
  return { created, suggested };
};

// ─── Utility: bulk-upsert a seeded directory JSON into bank_payee_directory ──
// Called by the seed endpoint. directoryJson is the keyed JSON from seed_payee_directory.py.

const seedPayeeDirectory = async (brandId, seq, directoryJson) => {
  let inserted = 0;
  let updated = 0;

  await withBypass(seq, async (t) => {
    for (const [keyType, entries] of Object.entries(directoryJson)) {
      for (const [keyValue, payload] of Object.entries(entries)) {
        const [, meta] = await seq.query(
          `INSERT INTO bank_payee_directory
             (brand_id, key_type, key_value, ledger, txn_type, source, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'seed', NOW())
           ON CONFLICT (brand_id, key_type, key_value)
           DO UPDATE SET
             ledger     = EXCLUDED.ledger,
             txn_type   = EXCLUDED.txn_type,
             source     = 'seed',
             updated_at = NOW()
           RETURNING (xmax = 0) AS is_insert`,
          { bind: [brandId, keyType, keyValue, payload.ledger, payload.type || null], transaction: t }
        );
        if (meta?.rows?.[0]?.is_insert) inserted++; else updated++;
      }
    }
  });

  return { inserted, updated };
};

module.exports = {
  getCorrections,
  saveCorrections,
  uploadCorrectionsExcel,
  uploadOutputExcel,
  loadCorrectionMap,
  loadSideRules,
  deriveSideRules,
  seedPayeeDirectory,
  normalizeNarration,
  extractPayeeKeys,
};
