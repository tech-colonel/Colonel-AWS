const axios = require('axios');
const FormData = require('form-data');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');

const PYTHON_RECO_URL = process.env.PYTHON_RECO_URL || 'http://localhost:8765';

// ── Production-safe paths — override via env vars on any deployment server ──
// classify.py lives at new-backend/scripts/ (same copy as Colonel Full/Extra/)
const CLASSIFIER_PATH = process.env.BANK_CLASSIFIER_PATH
  || path.resolve(__dirname, '../../scripts/classify.py');
const RECO_TEMP_DIR   = process.env.RECO_TEMP_DIR   || path.join(os.tmpdir(), 'colonel-reco-temp');
const RECO_OUTPUT_DIR = process.env.RECO_OUTPUT_DIR
  || path.resolve(__dirname, '../../output/reco');
const LEDGER_MASTER_DIR = process.env.LEDGER_MASTER_DIR
  || path.resolve(__dirname, '../../output/ledgers');

// ── Concurrency cap — prevents OOM when many users submit large files at once ──
let _activeRecoJobs = 0;
const MAX_CONCURRENT_RECO = parseInt(process.env.MAX_CONCURRENT_RECO || '8', 10);

const { loadCorrectionMap, normalizeNarration } = require('./bankCorrectionsController');

// ── DB helpers (imported lazily to avoid circular deps) ──────────────────────

/**
 * Parse "DD-MM-YYYY HH:MM:SS" or "DD-MM-YYYY" to ISO "YYYY-MM-DD HH:MM:SS".
 * PostgreSQL TIMESTAMP columns reject DD-MM-YYYY format.
 */
const parseIndianDate = (dateStr) => {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (!s || ['nan', 'nat', 'none', 'null', 'n/a', '-'].includes(s.toLowerCase())) return null;

  // DD-MM-YYYY or DD-MM-YYYY HH:MM:SS
  const m1 = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})(.*)?$/);
  if (m1) {
    const [, day, month, year, rest] = m1;
    const time = rest ? rest.trim() : '00:00:00';
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${time}`;
  }

  // DD/MM/YYYY
  const m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m2) return `${m2[3]}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}`;

  // DD/MM/YY — 2-digit year (e.g. 14/05/26 → 2026-05-14)
  const m3 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m3) {
    const year = parseInt(m3[3], 10) + 2000;
    return `${year}-${m3[2].padStart(2, '0')}-${m3[1].padStart(2, '0')}`;
  }

  // YYYY-MM-DD (already ISO)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // Anything else (e.g. "INR 7884656.7", "Opening Balance") → null
  return null;
};

/**
 * Compute SHA-256 of one or more file buffers concatenated.
 * Used as the idempotency key for a reco run.
 */
const hashFiles = (...buffers) => {
  const h = crypto.createHash('sha256');
  for (const buf of buffers) if (buf) h.update(buf);
  return h.digest('hex');
};

/**
 * Check if an identical run already exists in the brand DB.
 * Returns the existing job row or null.
 * Must run inside a transaction so SET LOCAL actually bypasses RLS.
 */
const findExistingJob = async (sequelize, brandId, agentType, month, year, fileHash) => {
  try {
    let result = null;
    await sequelize.transaction(async (t) => {
      await sequelize.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
      const [rows] = await sequelize.query(
        `SELECT id, output_file_id, total_rows, matched_rows, unmatched_rows
         FROM reco_jobs
         WHERE brand_id = $1 AND agent_type = $2
           AND month IS NOT DISTINCT FROM $3
           AND year  IS NOT DISTINCT FROM $4
           AND file_hash = $5
         LIMIT 1`,
        { bind: [brandId, agentType, month || null, year || null, fileHash], transaction: t }
      );
      result = rows[0] || null;
    });
    return result;
  } catch { return null; }
};

/**
 * Update output_file_id on an existing job so the new Excel can be downloaded.
 * Used when same files are re-run (duplicate) — no need to re-save rows, just point to new file.
 */
const updateOutputFileId = async (sequelize, jobId, newOutputFileId) => {
  try {
    await sequelize.transaction(async (t) => {
      await sequelize.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
      await sequelize.query(
        `UPDATE reco_jobs SET output_file_id = $1, updated_at = NOW() WHERE id = $2`,
        { bind: [newOutputFileId, jobId], transaction: t }
      );
    });
  } catch (err) {
    console.error('[RECO-DB] updateOutputFileId error:', err.message);
  }
};

/**
 * Delete a reco_job by id (cascade removes result rows).
 * Used when an existing job has total_rows = 0 (failed previous save).
 */
const deleteJob = async (sequelize, jobId) => {
  try {
    await sequelize.transaction(async (t) => {
      await sequelize.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
      await sequelize.query(`DELETE FROM reco_jobs WHERE id = $1`, { bind: [jobId], transaction: t });
    });
  } catch (err) {
    console.error('[RECO-DB] deleteJob error:', err.message);
    throw err;
  }
};

/**
 * Save a completed reco job + its row-level results inside a single transaction.
 * Sets app.bypass_rls so inserts are never blocked by RLS policies.
 * Returns the created job id or null on failure.
 */
const saveRecoJob = async (sequelize, { brandId, agentType, month, year, fileHash,
  outputFileId, totalRows, matchedRows, unmatchedRows, createdBy }) => {
  try {
    let jobId;
    await sequelize.transaction(async (t) => {
      await sequelize.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
      const [rows] = await sequelize.query(
        `INSERT INTO reco_jobs
           (brand_id, agent_type, month, year, file_hash, status,
            total_rows, matched_rows, unmatched_rows, output_file_id, created_by)
         VALUES ($1,$2,$3,$4,$5,'completed',$6,$7,$8,$9,$10)
         RETURNING id`,
        { bind: [brandId, agentType, month || null, year || null, fileHash,
            totalRows, matchedRows, unmatchedRows, outputFileId, createdBy || null],
          transaction: t }
      );
      jobId = rows[0]?.id;
    });
    return jobId;
  } catch (err) {
    console.error('[RECO-DB] saveRecoJob error:', err.message);
    return null;
  }
};

/**
 * Bulk-insert ALL bank_reco_results rows (High + Medium + Low) for a completed job.
 * Stores actual confidence so analytics shows the full picture.
 * ON CONFLICT DO UPDATE refreshes ledger/confidence when classifier improves on re-run.
 * Auto-matching (Layer 0 corrections) only uses rows that were promoted to High —
 * either by the classifier or by accountant correction via the UI.
 */
const saveBankRecoResults = async (sequelize, jobId, brandId, rows) => {
  if (!rows || rows.length === 0) return;
  let saved = 0;
  try {
    await sequelize.transaction(async (t) => {
      await sequelize.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
      for (const r of rows) {
        const conf = r.confidence || 'Low';
        await sequelize.query(
          `INSERT INTO bank_reco_results
             (job_id, brand_id, txn_date, description, debit, credit, balance,
              txn_type, ledger_name, confidence)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (brand_id, description, txn_date,
                        COALESCE(debit,0), COALESCE(credit,0), COALESCE(balance,0))
           DO UPDATE SET
             ledger_name = EXCLUDED.ledger_name,
             confidence  = EXCLUDED.confidence,
             txn_type    = EXCLUDED.txn_type,
             job_id      = EXCLUDED.job_id`,
          {
            bind: [
              jobId, brandId,
              parseIndianDate(r.date), r.description || null,
              r.debit  != null ? r.debit  : null,
              r.credit != null ? r.credit : null,
              r.balance != null ? r.balance : null,
              r.type || null, r.ledger_name || null, conf
            ],
            transaction: t
          }
        );
        saved++;
      }
    });
    const high = rows.filter(r => (r.confidence || '').toLowerCase() === 'high').length;
    console.log(`[RECO-DB] ✅ Saved ${saved} rows (${high} High) for job ${jobId}`);
  } catch (err) {
    console.error('[RECO-DB] saveBankRecoResults error:', err.message);
  }
};

/**
 * Convert any date-ish value to an ISO 'YYYY-MM-DD' string PostgreSQL accepts,
 * or null if unparseable (handles Python pandas NaN → "nan", empty strings, etc.)
 */
const toSqlDate = (val) => {
  if (val == null) return null;
  const s = String(val).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (['nan', 'nat', 'none', 'null', 'n/a', '-'].includes(lower)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // Already ISO
  const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
};

/**
 * Bulk-insert GST reco result rows (gstr_2b_results or gstr_2a_2b_results).
 * Each result from Python is a MatchResult.as_dict() with suggested_action / suggested_action_2.
 * Uses per-row try-catch so one bad row never aborts the entire batch.
 */
const saveGstRecoResults = async (sequelize, jobId, brandId, results, tableName) => {
  if (!results || results.length === 0) return;
  let saved = 0;
  let failed = 0;
  try {
    await sequelize.transaction(async (t) => {
      await sequelize.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
      for (const r of results) {
        const inv = r.gstr2b || r.purchase || {};
        try {
          await sequelize.query(
            `INSERT INTO ${tableName}
               (job_id, brand_id, supplier_name, supplier_gstin, invoice_number, invoice_date,
                taxable_value, igst, cgst, sgst, remark_1, remark_2)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            {
              bind: [
                jobId,
                brandId,
                inv.supplier_name  || null,
                inv.supplier_gstin || null,
                inv.doc_no         || null,
                toSqlDate(inv.doc_date),
                inv.taxable_value != null ? Number(inv.taxable_value) : null,
                inv.igst          != null ? Number(inv.igst)          : null,
                inv.cgst          != null ? Number(inv.cgst)          : null,
                inv.sgst          != null ? Number(inv.sgst)          : null,
                r.suggested_action  || null,
                r.suggested_action_2 || null,
              ],
              transaction: t,
            }
          );
          saved++;
        } catch (rowErr) {
          failed++;
          if (failed <= 3) {
            console.error(`[RECO-DB] Row insert error (${tableName}):`, rowErr.message,
              '| inv_no:', inv.doc_no, '| date:', inv.doc_date);
          }
        }
      }
    });
    console.log(`[RECO-DB] ✅ Saved ${saved}/${results.length} rows to ${tableName} for job ${jobId}` +
      (failed > 0 ? ` (${failed} rows skipped)` : ''));
  } catch (err) {
    console.error(`[RECO-DB] saveGstRecoResults transaction error (${tableName}):`, err.message);
  }
};

const saveTallyEntryResults = async (sequelize, jobId, brandId, results) => {
  if (!results?.length) return;
  const toNum = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
  try {
    await sequelize.transaction(async (t) => {
      await sequelize.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
      for (const r of results) {
        await sequelize.query(
          `INSERT INTO gstr_3b_tally_results (job_id, brand_id, row_type, sno, particulars, debit, credit)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          { bind: [jobId, brandId, r._type || null, String(r.sno ?? ''), r.particulars || null, toNum(r.debit), toNum(r.credit)], transaction: t }
        );
      }
    });
    console.log(`[RECO-DB] ✅ Saved ${results.length} tally rows for job ${jobId}`);
  } catch (err) {
    console.error(`[RECO-DB] saveTallyEntryResults error:`, err.message);
  }
};

// Frontend reco types that use the gstr_2b_books Python engine → persist to gstr_2b_results
const GST_2B_FRONTEND_TYPES = new Set([
  'gstr_2b_books', 'gstr_2a_vs_2b_vs_books', 'gstr_2b_vs_purchase',
  'gstr_2b_books_multistate',
]);

// Map frontend reco_type names → Python server reco_type names
const RECO_TYPE_MAP = {
  'bank_statement': 'bank_reco',
  'universal_bank_statement': 'universal_bank_reco',
  'gstr_2b_vs_purchase': 'gstr_2b_vs_purchase',
  'gstr_2a_2b_books': 'gstr_2a_2b_books',
  'gstr_2a_vs_2b_vs_books': 'gstr_2b_books',           // 3-file: GSTR-2B + Purchase + Debit Note
  'gstr_2b_books': 'gstr_2b_books',                     // same handler
  'gstr_3b_vs_2b': 'gstr_3b_vs_2b',
  'gstr_3b_tally_entry': 'gstr_3b_tally_entry',
  'gstr_1_vs_books': 'gstr_1_vs_books',
  'gstr_2b_books_multistate': 'gstr_2b_books_multistate', // multi-state variant
};

/**
 * Execute standalone Python classifier CLI via child process.
 * Uses execFile (not exec) — no shell expansion, safe with arbitrary file paths.
 * Path resolved from BANK_CLASSIFIER_PATH env var or project-relative default.
 */
const runUniversalClassifier = (ledgerPath, bankPath, outputPath, correctionsPath) => {
  return new Promise((resolve, reject) => {
    console.log(`[RECO] Executing standalone classifier: ${CLASSIFIER_PATH}`);
    const args = ['--ledger', ledgerPath, '--bank', bankPath, '--out', outputPath];
    if (correctionsPath) args.push('--corrections', correctionsPath);
    execFile('python3', [CLASSIFIER_PATH, ...args], { timeout: 180000 },
      (error, stdout, stderr) => {
        if (error) {
          console.error(`[RECO] CLI execution error:`, stderr || error.message);
          return reject(new Error(stderr || error.message));
        }
        resolve(stdout);
      }
    );
  });
};

/**
 * Fetch ledger_master JSON from brand DB and convert to Excel buffer.
 * The ledger_master is stored as a JSON array: [{name: 'ABC Traders', ...}, ...]
 * Returns null if no saved ledger exists for this brand.
 */
const getLedgerMasterBuffer = (brandId) => {
  try {
    const filePath = path.join(LEDGER_MASTER_DIR, `${brandId}.xlsx`);
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath);
    return null;
  } catch (err) {
    console.error('[RECO] getLedgerMasterBuffer error:', err.message);
    return null;
  }
};

/**
 * Persist a ledger master Excel for a brand so future runs load it automatically.
 * Overwrites any previously saved file — no duplicates, always latest CoA.
 */
const saveLedgerMaster = (brandId, buffer) => {
  try {
    fs.mkdirSync(LEDGER_MASTER_DIR, { recursive: true });
    fs.writeFileSync(path.join(LEDGER_MASTER_DIR, `${brandId}.xlsx`), buffer);
    console.log(`[RECO] Ledger master saved for brand ${brandId}`);
  } catch (err) {
    console.error('[RECO] saveLedgerMaster error:', err.message);
  }
};

/**
 * POST /api/reco/run
 * Forward files to Python reconciliation microservice.
 * For bank_statement in production: auto-fetch ledger_master from DB.
 */
const runReco = async (req, res) => {
  // Concurrency gate — prevents OOM when 50+ users submit large files simultaneously
  if (_activeRecoJobs >= MAX_CONCURRENT_RECO) {
    return res.status(429).json({
      error: 'Server is busy processing other reconciliations. Please retry in 30 seconds.',
      retry_after: 30,
    });
  }
  _activeRecoJobs++;
  try {
    const recoType = req.body.reco_type || 'gstr_2b_vs_purchase';
    const isDemo = req.body.is_demo === 'true';
    const brandId = req.body.brand_id;

    // --- Standalone Decoupled Universal Bank Statement Integration ---
    if (recoType === 'universal_bank_statement') {
      const jobId = crypto.randomUUID();
      const jobDir = path.join(RECO_TEMP_DIR, `job_${jobId}`);
      await fs.promises.mkdir(jobDir, { recursive: true });

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No bank statement file uploaded' });
      }

      // 1. Locate and Save Bank Statement File
      const bankFile = req.files.find(f => f.fieldname === 'bank_statement');
      if (!bankFile) {
        return res.status(400).json({ error: 'Please upload a bank statement file' });
      }
      let bankPath = path.join(jobDir, `bank_statement_${bankFile.originalname}`);
      await fs.promises.writeFile(bankPath, bankFile.buffer);

      let ledgerPath = '';

      // Check if it is a multi-tab Excel file containing both ledger master and statement
      if (bankFile.originalname.endsWith('.xlsx') || bankFile.originalname.endsWith('.xls')) {
        try {
          const XLSX = require('xlsx');
          const workbook = XLSX.readFile(bankPath);
          const sheetNames = workbook.SheetNames;
          
          if (sheetNames.length >= 2) {
            console.log(`[RECO-UNIVERSAL] SheetJS Multi-tab Excel detected. Finding tabs...`);
            
            let bankSheetName = null;
            let ledgerSheetName = null;

            // Search by name keywords first (avoid 'sheet' — too generic, matches Sheet1/Sheet2)
            for (const name of sheetNames) {
              const lowerName = name.toLowerCase();
              if (lowerName.includes('ledger') || lowerName.includes('master') || lowerName.includes('coa') || lowerName.includes('chart')) {
                ledgerSheetName = name;
              } else if (lowerName.includes('statement') || lowerName.includes('working') || lowerName.includes('od') || lowerName.includes('bank')) {
                bankSheetName = name;
              }
            }

            // Content-based fallback: scan each sheet for bank-statement headers
            if (!bankSheetName || !ledgerSheetName) {
              const bankHeaderKeys = ['date', 'txn', 'desc', 'narration', 'particular', 'detail', 'debit', 'withdrawal', 'credit', 'deposit', 'balance'];
              const scores = {};
              for (const name of sheetNames) {
                const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' });
                let score = 0;
                for (let ri = 0; ri < Math.min(20, rows.length); ri++) {
                  const cells = rows[ri].map(v => String(v || '').toLowerCase());
                  for (const key of bankHeaderKeys) {
                    if (cells.some(c => c.includes(key))) score++;
                  }
                }
                scores[name] = score;
              }
              const ranked = [...sheetNames].sort((a, b) => scores[b] - scores[a]);
              bankSheetName   = bankSheetName   || ranked[0];
              ledgerSheetName = ledgerSheetName || ranked[1] || sheetNames.find(n => n !== bankSheetName);
            }

            console.log(`[RECO-UNIVERSAL] Mapped tabs: Bank Statement -> "${bankSheetName}", Ledger Master -> "${ledgerSheetName}"`);

            // Extract Bank Statement Sheet
            const bankSheet = workbook.Sheets[bankSheetName];
            const newBankWb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(newBankWb, bankSheet, 'Bank Statement');
            const newBankPath = path.join(jobDir, 'extracted_bank_statement.xlsx');
            XLSX.writeFile(newBankWb, newBankPath);
            bankPath = newBankPath;

            // Extract Ledger Master Sheet
            const ledgerSheet = workbook.Sheets[ledgerSheetName];
            const newLedgerWb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(newLedgerWb, ledgerSheet, 'List of Ledger');
            const newLedgerPath = path.join(jobDir, 'extracted_ledger_master.xlsx');
            XLSX.writeFile(newLedgerWb, newLedgerPath);
            ledgerPath = newLedgerPath;

            console.log(`[RECO-UNIVERSAL] ✅ SheetJS successfully split multi-tab file!`);
          }
        } catch (err) {
          console.error(`[RECO-UNIVERSAL] SheetJS parsing error:`, err.message);
        }
      }

      // Track whether a fresh ledger was uploaded (vs loaded from saved copy)
      let freshLedgerBuffer = null;

      // If no ledgerPath was extracted (single tab or CSV), check: uploaded file → saved copy → fallback
      if (!ledgerPath) {
        const ledgerFile = req.files.find(f => f.fieldname === 'ledger_master');
        if (ledgerFile) {
          ledgerPath = path.join(jobDir, `ledger_master_${ledgerFile.originalname}`);
          await fs.promises.writeFile(ledgerPath, ledgerFile.buffer);
          freshLedgerBuffer = ledgerFile.buffer; // will be saved after successful run
        } else if (!isDemo && brandId && brandId !== 'demo') {
          const savedLedger = getLedgerMasterBuffer(brandId);
          if (savedLedger) {
            ledgerPath = path.join(jobDir, 'ledger_master.xlsx');
            await fs.promises.writeFile(ledgerPath, savedLedger);
            console.log(`[RECO-UNIVERSAL] ✅ Loaded saved ledger master for brand ${brandId}`);
          }
        }
      } else if (!isDemo && brandId && brandId !== 'demo') {
        // Multi-tab extraction produced a ledger — read it back to persist
        freshLedgerBuffer = fs.readFileSync(ledgerPath);
      }

      if (!ledgerPath) {
        const fallbackLedgerPath = '/tmp/RECOFULL/RECOFULL/List of Ledger.xlsx';
        if (fs.existsSync(fallbackLedgerPath)) {
          ledgerPath = path.join(jobDir, 'List of Ledger.xlsx');
          fs.copyFileSync(fallbackLedgerPath, ledgerPath);
          console.log(`[RECO-UNIVERSAL] ✅ Using fallback ledger master`);
        } else {
          return res.status(400).json({
            error: 'No ledger master found. Please upload an Excel workbook containing a "List of Ledger" tab.'
          });
        }
      }

      // 3. Write Layer 0 corrections to temp JSON so classify.py checks DB first
      //    Order inside classify.py: Layer 0 → CoA fuzzy → keywords → Suspense A/c
      let correctionsPath = null;
      if (brandId && brandId !== 'demo' && !isDemo) {
        try {
          const { Brand } = require('../models/master');
          const { getBrandConnection } = require('../config/database');
          const corrBrand = await Brand.findByPk(brandId);
          if (corrBrand) {
            const corrSeq = getBrandConnection(corrBrand.db_name);
            const corrMap = await loadCorrectionMap(brandId, corrSeq);
            if (Object.keys(corrMap).length > 0) {
              // Convert to classify.py format: {NARRATION_KEY: {ledger, type}}
              const corrJson = {};
              for (const [key, val] of Object.entries(corrMap)) {
                corrJson[key] = { ledger: val.ledger, type: val.type || null };
              }
              correctionsPath = path.join(jobDir, 'corrections.json');
              fs.writeFileSync(correctionsPath, JSON.stringify(corrJson));
              console.log(`[RECO-CORRECTIONS] Wrote ${Object.keys(corrJson).length} Layer 0 corrections for classify.py`);
            }
          }
        } catch (corrErr) {
          console.warn('[RECO-CORRECTIONS] Non-fatal error writing corrections:', corrErr.message);
        }
      }

      // 4. Execute Standalone Classifier Script
      const outputPath = path.join(jobDir, 'output.xlsx');
      await runUniversalClassifier(ledgerPath, bankPath, outputPath, correctionsPath);

      if (!fs.existsSync(outputPath)) {
        throw new Error('Standalone classifier failed to generate output spreadsheet.');
      }

      // Lock the ledger master for this brand — saved once, reused on all future runs.
      // Overwrites any previous CoA so updates are reflected immediately.
      if (freshLedgerBuffer && brandId && brandId !== 'demo' && !isDemo) {
        saveLedgerMaster(brandId, freshLedgerBuffer);
      }

      // 4. Load & Parse Excel Output Sheets using exceljs
      const outWorkbook = new ExcelJS.Workbook();
      await outWorkbook.xlsx.readFile(outputPath);
      const ws = outWorkbook.getWorksheet('Bank Statement');
      if (!ws) {
        throw new Error('Output sheet "Bank Statement" not found.');
      }

      const results = [];
      let highCount = 0;
      let mediumCount = 0;
      let lowCount = 0;

      // Extract row data (Header is row 1)
      ws.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // Skip headers
        const cells = row.values;
        // cells[1] is empty padding in ExcelJS, 1-based indexing
        const rawDate = cells[1];
        let formattedDate = '';
        if (rawDate) {
          if (rawDate instanceof Date) {
            const d = rawDate;
            const day = String(d.getDate()).padStart(2, '0');
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const year = d.getFullYear();
            formattedDate = `${day}-${month}-${year}`;
          } else if (typeof rawDate === 'object' && rawDate.result) {
            formattedDate = String(rawDate.result);
          } else {
            formattedDate = String(rawDate);
          }
        }

        const rowData = {
          date: formattedDate,
          description: cells[2] || '',
          debit: cells[3] ? parseFloat(cells[3]) : null,
          credit: cells[4] ? parseFloat(cells[4]) : null,
          balance: cells[5] ? parseFloat(cells[5]) : null,
          type: cells[6] || '',
          ledger_name: cells[7] || '',
          confidence: cells[8] || 'Low'
        };

        if (rowData.confidence === 'High') highCount++;
        else if (rowData.confidence === 'Medium') mediumCount++;
        else lowCount++;

        results.push(rowData);
      });

      // ── Apply per-brand corrections (Layer 0) ────────────────────────────
      // Overrides predicted_ledger with accountant-confirmed mappings stored in
      // bank_reco_corrections. Skipped entirely for "Other" brand (no DB).
      if (brandId && brandId !== 'demo' && brandId !== 'other' && !isDemo) {
        try {
          const { Brand } = require('../models/master');
          const { getBrandConnection } = require('../config/database');
          const corrBrand = await Brand.findByPk(brandId);
          if (corrBrand) {
            const corrSeq = getBrandConnection(corrBrand.db_name);
            const corrMap = await loadCorrectionMap(brandId, corrSeq);

            // Build CoA ledger set for validation (skip stale corrections)
            const ledgerSet = new Set();
            try {
              const lWb = new ExcelJS.Workbook();
              await lWb.xlsx.readFile(ledgerPath);
              lWb.worksheets[0]?.eachRow((row) => {
                const val = row.getCell(1).text?.trim();
                if (val) ledgerSet.add(val);
              });
            } catch (_) { /* non-fatal */ }

            let corrected = 0;
            results.forEach(row => {
              const key = normalizeNarration(row.description);
              const fix = corrMap[key];
              if (!fix) return;
              // Safeguard: skip if ledger was deleted/renamed from CoA
              if (ledgerSet.size > 0 && !ledgerSet.has(fix.ledger)) return;
              row.ledger_name = fix.ledger;
              if (fix.type) row.type = fix.type;
              row.confidence = 'High';
              row.corrected = true;
              corrected++;
            });

            if (corrected > 0) {
              // Recount confidence buckets after corrections
              highCount = results.filter(r => r.confidence === 'High').length;
              mediumCount = results.filter(r => r.confidence === 'Medium').length;
              lowCount = results.filter(r => r.confidence === 'Low').length;
              console.log(`[RECO-CORRECTIONS] Applied ${corrected} stored corrections for brand ${brandId}`);
            }
          }
        } catch (corrErr) {
          console.warn('[RECO-CORRECTIONS] Non-fatal error loading corrections:', corrErr.message);
        }
      }

      // Count master ledgers dynamically
      let ledgerRowCount = 0;
      try {
        const ledgerWorkbook = new ExcelJS.Workbook();
        await ledgerWorkbook.xlsx.readFile(ledgerPath);
        const lws = ledgerWorkbook.worksheets[0];
        ledgerRowCount = lws ? lws.rowCount - 1 : 0; // Exclude header row
      } catch (err) {
        console.warn('[RECO-UNIVERSAL] Failed to parse ledger row count:', err.message);
      }

      // 5. Persist Excel File for Direct Download
      fs.mkdirSync(RECO_OUTPUT_DIR, { recursive: true });
      const persistentPath = path.join(RECO_OUTPUT_DIR, `${jobId}.xlsx`);
      fs.copyFileSync(outputPath, persistentPath);

      // 6. Guaranteed cleanup of sandboxed job folder — runs even if response throws
      fs.rm(jobDir, { recursive: true, force: true }, (err) => {
        if (err) console.error('[RECO-UNIVERSAL] Cleanup error:', err.message);
        else console.log(`[RECO-UNIVERSAL] Sandboxed job folder cleaned up: job_${jobId}`);
      });

      // 6b. Persist to Hero DB (fire-and-forget, never blocks download)
      // Only saves if: output is valid, rows > 0, not a duplicate run
      if (!isDemo && brandId && brandId !== 'demo' && results.length > 0) {
        setImmediate(async () => {
          try {
            const { Brand } = require('../models/master');
            const { getBrandConnection } = require('../config/database');
            const brand = await Brand.findByPk(brandId);
            if (!brand) return;
            const seq = getBrandConnection(brand.db_name);
            const fileHash = hashFiles(bankFile.buffer);
            const month = parseInt(req.body.month) || null;
            const year = parseInt(req.body.year) || null;

            // Idempotency: same file → update output_file_id AND upsert any new High-confidence rows.
            // ON CONFLICT DO NOTHING in saveBankRecoResults means true duplicates are safely skipped,
            // but newly High rows (improved by classifier upgrades) are inserted.
            const existing = await findExistingJob(seq, brandId, 'bank_reco', month, year, fileHash);
            if (existing) {
              if (existing.total_rows > 0) {
                await updateOutputFileId(seq, existing.id, jobId);
                // Re-save High rows — new classifier may produce more High-confidence rows
                // than the original run. ON CONFLICT DO NOTHING prevents true duplicates.
                await saveBankRecoResults(seq, existing.id, brandId, results);
                console.log(`[RECO-DB] Same file re-run — output updated, upserted new High rows`);
                return;
              }
              await deleteJob(seq, existing.id);
              console.log(`[RECO-DB] Removed 0-row bank_reco job ${existing.id}, re-saving`);
            }

            const savedJobId = await saveRecoJob(seq, {
              brandId, agentType: 'bank_reco', month, year, fileHash,
              outputFileId: jobId,
              totalRows: results.length,
              matchedRows: highCount + mediumCount,
              unmatchedRows: lowCount,
              createdBy: req.user?.id,
            });
            if (savedJobId) await saveBankRecoResults(seq, savedJobId, brandId, results);
          } catch (e) {
            console.error('[RECO-DB] Background save error:', e.message);
          }
        });
      }

      // 7. Return standard format payload to Frontend
      return res.json({
        job_id: jobId,
        summary: {
          total_transactions: results.length,
          matched: highCount + mediumCount,
          unmatched: lowCount
        },
        counts: {
          high: highCount,
          medium: mediumCount,
          low: lowCount,
          master_ledgers: ledgerRowCount > 0 ? ledgerRowCount : 2023
        },
        results: results
      });
    }

    // Map frontend reco_type → Python reco_type
    const pythonRecoType = RECO_TYPE_MAP[recoType] || recoType;

    const form = new FormData();
    form.append('reco_type', pythonRecoType);
    form.append('tolerance', req.body.tolerance || '1.0');

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    // Forward all uploaded files
    for (const file of req.files) {
      form.append(file.fieldname, file.buffer, {
        filename: file.originalname,
        contentType: file.mimetype
      });
    }

    // Bank statement in production: auto-attach ledger master from DB
    if (recoType === 'bank_statement' && !isDemo && brandId && brandId !== 'demo') {
      const hasLedgerUploaded = req.files.some(f => f.fieldname === 'ledger_master');
      if (!hasLedgerUploaded) {
        console.log(`[RECO] Fetching ledger_master from DB for brand ${brandId}...`);
        const ledgerBuffer = getLedgerMasterBuffer(brandId);
        if (ledgerBuffer) {
          form.append('ledger_master', ledgerBuffer, {
            filename: 'ledger_master.xlsx',
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          });
          console.log(`[RECO] ✅ Ledger master attached from DB`);
        } else {
          return res.status(400).json({
            error: 'No ledger master found in your brand\'s database. Please upload it first via the Admin panel under Master Data.'
          });
        }
      }
    }

    const response = await axios.post(`${PYTHON_RECO_URL}/api/reconcile`, form, {
      headers: { ...form.getHeaders() },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 120000
    });

    res.json(response.data);

    // Save job record to Hero DB (fire-and-forget, after response sent)
    if (!isDemo && brandId && brandId !== 'demo') {
      setImmediate(async () => {
        try {
          console.log(`[RECO-DB] 🔄 Starting DB save for ${recoType} brand=${brandId}`);
          const { Brand } = require('../models/master');
          const { getBrandConnection } = require('../config/database');
          const brand = await Brand.findByPk(brandId);
          if (!brand) { console.log('[RECO-DB] ❌ Brand not found'); return; }
          const seq = getBrandConnection(brand.db_name);
          const fileHash = hashFiles(...(req.files || []).map(f => f.buffer));
          const month = parseInt(req.body.month) || null;
          const year  = parseInt(req.body.year)  || null;
          console.log(`[RECO-DB] fileHash=${fileHash.slice(0,12)} month=${month} year=${year}`);

          const pythonJobId = response.data?.job_id || null;

          const existing = await findExistingJob(seq, brandId, recoType, month, year, fileHash);
          console.log(`[RECO-DB] existing job:`, existing ? `id=${existing.id} total_rows=${existing.total_rows}` : 'none');
          if (existing) {
            if (existing.total_rows > 0) {
              await updateOutputFileId(seq, existing.id, pythonJobId || existing.output_file_id);
              console.log(`[RECO-DB] Duplicate ${recoType} — updated output_file_id to ${pythonJobId}`);
              // For tally entry: delete old rows and re-save fresh (no unique constraint, safe to replace)
              if (recoType === 'gstr_3b_tally_entry') {
                const tallyRows = response.data?.results;
                if (tallyRows?.length > 0) {
                  await seq.query(`DELETE FROM gstr_3b_tally_results WHERE job_id = $1`, { bind: [existing.id] });
                  await saveTallyEntryResults(seq, existing.id, brandId, tallyRows);
                }
              }
              return;
            }
            await deleteJob(seq, existing.id);
            console.log(`[RECO-DB] Removed 0-row ${recoType} job ${existing.id}, re-saving`);
          }
          const pyResults  = response.data?.results || [];
          const pySummary  = response.data?.summary  || {};
          const totalRows    = pySummary.total    ?? pyResults.length;
          const matchedRows  = pySummary.matched  ?? pyResults.filter(r => r.suggested_action === 'Matched').length;
          const unmatchedRows = pySummary.unmatched ?? (totalRows - matchedRows);
          console.log(`[RECO-DB] pyResults=${pyResults.length} totalRows=${totalRows} matched=${matchedRows}`);

          const savedJobId = await saveRecoJob(seq, {
            brandId, agentType: recoType, month, year, fileHash,
            outputFileId: pythonJobId,
            totalRows, matchedRows, unmatchedRows,
            createdBy: req.user?.id,
          });
          console.log(`[RECO-DB] savedJobId=${savedJobId}`);

          // Persist row-level results for GST 2B agents
          if (savedJobId && GST_2B_FRONTEND_TYPES.has(recoType)) {
            const gstRows = response.data?.results;
            console.log(`[RECO-DB] GST path: gstRows=${gstRows?.length} recoType=${recoType}`);
            if (gstRows?.length > 0) {
              await saveGstRecoResults(seq, savedJobId, brandId, gstRows, 'gstr_2b_results');
            }
          } else if (savedJobId && recoType === 'gstr_3b_tally_entry') {
            const tallyRows = response.data?.results;
            if (tallyRows?.length > 0) {
              await saveTallyEntryResults(seq, savedJobId, brandId, tallyRows);
            }
          } else {
            console.log(`[RECO-DB] Skipping GST rows: savedJobId=${savedJobId} isGST=${GST_2B_FRONTEND_TYPES.has(recoType)}`);
          }
        } catch (e) {
          console.error('[RECO-DB] Python path save error:', e.message, e.stack?.split('\n')[1]);
        }
      });
    }
  } catch (err) {
    console.error('[RECO] runReco error:', err.message);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({
        error: `Reconciliation engine is not running. Please start the Python service on port ${PYTHON_RECO_URL.split(':').pop()}.`
      });
    }
    res.status(500).json({ error: err.response?.data?.error || err.message });
  } finally {
    _activeRecoJobs--;
  }
};

/**
 * GET /api/reco/ledger-status/:brandId
 * Check if ledger master exists in DB for a brand (used by frontend)
 */
const getLedgerStatus = async (req, res) => {
  const { brandId } = req.params;
  const isDemo = req.user?.id === 'demo';

  if (isDemo || brandId === 'demo') {
    return res.json({ hasLedger: false, count: 0 });
  }

  try {
    const ledgerBuffer = getLedgerMasterBuffer(brandId);
    res.json({ hasLedger: !!ledgerBuffer, count: ledgerBuffer ? 1 : 0 });
  } catch (err) {
    res.json({ hasLedger: false, count: 0, error: err.message });
  }
};

/**
 * GET /api/reco/export/:jobId
 * Stream Excel result from Python service to client
 */
const exportReco = async (req, res) => {
  try {
    const rawName = req.query.name || 'reconciliation';
    const safeName = rawName.replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/^_+|_+$/g, '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.xlsx"`);

    const localPath = path.join(RECO_OUTPUT_DIR, `${req.params.jobId}.xlsx`);
    if (fs.existsSync(localPath)) {
      console.log(`[RECO] Streaming local persistent Excel sheet: ${localPath}`);
      return fs.createReadStream(localPath).pipe(res);
    }

    const response = await axios.get(
      `${PYTHON_RECO_URL}/api/jobs/${req.params.jobId}/export.xlsx`,
      { responseType: 'stream', timeout: 30000 }
    );
    response.data.pipe(res);
  } catch (err) {
    console.error('[RECO] exportReco error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/reco/health
 */
const checkHealth = async (req, res) => {
  try {
    // Python server serves index.html on GET / — use that as health probe
    await axios.get(`${PYTHON_RECO_URL}/`, { timeout: 5000 });
    res.json({ status: 'ok', python_url: PYTHON_RECO_URL });
  } catch (err) {
    res.status(503).json({
      status: 'unavailable',
      message: 'Python reconciliation service is not running',
      python_url: PYTHON_RECO_URL
    });
  }
};

module.exports = { runReco, exportReco, checkHealth, getLedgerStatus };
