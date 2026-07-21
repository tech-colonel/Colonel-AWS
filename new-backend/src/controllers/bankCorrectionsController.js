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
const PHONE_RE = /(?<!\d)(\d{10})(?!\d)/;
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
          if (!colIndex.ledgerName &&
              (name.includes('ledger') || name.includes('tally') ||
               name.includes('chart of account') || name.includes('gl account') ||
               name === 'account name' || name === 'account' || name === 'gl')) {
            colIndex.ledgerName = i;
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
      if (!colIndex.description && !colIndex.ledgerName) {
        colIndex = scanHeaderRow(2);
        if (colIndex.description || colIndex.ledgerName) headerRowNum = 2;
      }

      const allHeaders = ws.getRow(headerRowNum).values.map(c => cellText(c)).filter(Boolean);
      console.log(`[UPLOAD-OUTPUT] sheet="${ws.name}" headerRow=${headerRowNum} headers=${JSON.stringify(allHeaders)} colIndex=`, colIndex);

      if (!colIndex.description || !colIndex.ledgerName) {
        console.log(`[UPLOAD-OUTPUT] skipping "${ws.name}" — no narration+ledger match in headers`);
        continue;
      }

      ws.eachRow((row, rowNum) => {
        if (rowNum <= headerRowNum) return;
        const conf = colIndex.confidence
          ? cellText(row.getCell(colIndex.confidence).value)
          : 'High'; // no confidence column → accountant-prepared file, import all rows
        if (conf && conf !== 'High') { skipped++; return; }

        const description    = cellText(row.getCell(colIndex.description).value);
        const correct_ledger = cellText(row.getCell(colIndex.ledgerName).value);
        const correct_type   = colIndex.txnType
          ? cellText(row.getCell(colIndex.txnType).value)
          : null;
        if (!description || !correct_ledger) return;
        toImport.push({ description, correct_ledger, correct_type });
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

    res.json({ saved, skipped, message: `${saved} corrections imported from output Excel` });
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
  seedPayeeDirectory,
  normalizeNarration,
  extractPayeeKeys,
};
