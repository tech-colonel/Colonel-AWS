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

const uploadOutputExcel = async (req, res) => {
  const { brandId } = req.params;

  if (!req.file && (!req.files || req.files.length === 0)) {
    return res.status(400).json({ error: 'Excel file is required' });
  }
  const fileBuffer = req.file ? req.file.buffer : req.files[0].buffer;

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer);

    // Collect High-confidence rows across all sheets that look like bank output.
    // This handles both single-sheet and multi-sheet output Excel files.
    const toImport = [];
    let skipped = 0;

    console.log(`[UPLOAD-OUTPUT] brandId=${brandId} fileSize=${fileBuffer.length} sheets=${workbook.worksheets.length}`);

    // Helper: extract text from any cell value (handles plain string, rich text objects, numbers)
    const cellText = (val) => {
      if (!val) return '';
      if (typeof val === 'string') return val.trim();
      if (typeof val === 'object' && Array.isArray(val.richText)) {
        return val.richText.map(r => r.text || '').join('').trim();
      }
      return String(val).trim();
    };

    for (const ws of workbook.worksheets) {
      // Scan row 1 first; if it looks like a merged title (all [object Object] / empty), try row 2
      const scanHeaderRow = (rowNum) => {
        const colIndex = {};
        ws.getRow(rowNum).values.forEach((cell, i) => {
          const name = cellText(cell).toLowerCase();
          if (!name) return;
          // Narration / description — any column whose name contains these keywords
          if (!colIndex.description &&
              (name.includes('description') || name.includes('narration') ||
               name.includes('particulars') || name.includes('transaction detail') ||
               name === 'details' || name === 'remarks')) {
            colIndex.description = i;
          }
          // Ledger — any column whose name contains "ledger" or "tally" (e.g. "Ledger name as per tally")
          if (!colIndex.ledgerName &&
              (name.includes('ledger') || name.includes('tally') ||
               name === 'account name' || name === 'account')) {
            colIndex.ledgerName = i;
          }
          // Type (optional)
          if (!colIndex.txnType &&
              (name === 'type' || name.includes('txn type') || name.includes('transaction type') ||
               name.includes('vch type') || name.includes('predicted_type'))) {
            colIndex.txnType = i;
          }
          // Confidence (optional)
          if (name === 'confidence') colIndex.confidence = i;
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
        if (rowNum <= headerRowNum) return; // skip header row(s)
        const conf = colIndex.confidence
          ? row.getCell(colIndex.confidence).text?.trim()
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
      }
    });

    res.json({ saved, skipped, message: `${saved} corrections imported from output Excel` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── Utility: load correction map for a brand (used by recoController) ──────
// Returns { narration_key → { ledger, type } } for all stored corrections.

const loadCorrectionMap = async (brandId, seq) => {
  try {
    const rows = await withBypass(seq, async (t) => {
      const [result] = await seq.query(
        `SELECT narration_key, correct_ledger, correct_type
         FROM bank_reco_corrections
         WHERE brand_id = $1`,
        { bind: [brandId], transaction: t }
      );
      return result;
    });
    const map = {};
    rows.forEach(r => {
      map[r.narration_key] = { ledger: r.correct_ledger, type: r.correct_type };
    });
    return map;
  } catch {
    return {}; // fail open — never block classification
  }
};

module.exports = {
  getCorrections,
  saveCorrections,
  uploadCorrectionsExcel,
  uploadOutputExcel,
  loadCorrectionMap,
  normalizeNarration,
};
