const axios = require('axios');
const FormData = require('form-data');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');

const enginePool = require('../lib/enginePool');
// Retained for error messages and the health endpoint only — never used to
// dispatch work. Dispatch goes through enginePool so several engine processes
// (one per CPU core; Python's GIL caps one process at one core) can share load.
const PYTHON_RECO_URL = enginePool.listEngines()[0];
const { exportFromEngines } = enginePool;

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

// ── KOPARO-specific: Tally Debit/Credit ledger output ─────────────────────────
const KOPARO_BRAND_ID = '546976a5-6ca5-42d1-8b7d-2c6379ffa221';

const KOPARO_BANK_ACCOUNTS = [
  { pattern: '50200060142961',  name: 'HDFC Bank Ltd-50200060142961'   },
  { pattern: '409001624930',    name: 'RBL-Bank (409001624930)'        },
  { pattern: '409002286984',    name: 'RBL-Bank (409002286984)'        },
  { pattern: '3141295500063761',name: 'IDFC Bank (3141295500063761)'   },
  { pattern: '2049187735',      name: 'Kotak Mahindra Bank-7735'       },
  { pattern: '7735',            name: 'Kotak Mahindra Bank-7735'       },
];

const KOPARO_IFSC_TO_ACCOUNT = {
  'KKBK': 'Kotak Mahindra Bank-7735',
  'RATN': 'RBL-Bank (409001624930)',
  'HDFC': 'HDFC Bank Ltd-50200060142961',
  'IDFB': 'IDFC Bank (3141295500063761)',
};

const KOPARO_ACCOUNT_TO_BANK = {
  '2049187735':      'Kotak Mahindra Bank-7735',
  '409001624930':    'RBL-Bank (409001624930)',
  '409002286984':    'RBL-Bank (409002286984)',
  '50200060142961':  'HDFC Bank Ltd-50200060142961',
  '3141295500063761':'IDFC Bank (3141295500063761)',
};

async function detectKoparoBankAccount(bankPath) {
  // Scan row-by-row (max 35 rows) and return on the FIRST matching account pattern.
  // Self-account appears at row ~24 (header area); counterparty account appears later
  // in transaction narrations (~row 28+). First-hit ensures we pick the correct self-bank.
  try {
    const isXls = bankPath.toLowerCase().endsWith('.xls');
    if (isXls) {
      const XLSX = require('xlsx');
      const wb = XLSX.readFile(bankPath);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
      for (let i = 0; i < Math.min(35, rows.length); i++) {
        const rowText = rows[i].map(v => String(v || '')).join(' ');
        for (const { pattern, name } of KOPARO_BANK_ACCOUNTS) {
          if (rowText.includes(pattern)) return name;
        }
      }
    } else {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(bankPath);
      const ws = wb.worksheets[0];
      let found = null;
      ws.eachRow((row, rn) => {
        if (found || rn > 35) return;
        let rowText = '';
        row.values.forEach(v => {
          if (!v) return;
          let s = typeof v === 'object'
            ? String(v.result ?? v.text ?? (Array.isArray(v.richText) ? v.richText.map(r => r.text).join('') : '') ?? '')
            : String(v);
          if (s) rowText += s + ' ';
        });
        for (const { pattern, name } of KOPARO_BANK_ACCOUNTS) {
          if (rowText.includes(pattern)) { found = name; return; }
        }
      });
      if (found) return found;
    }
  } catch (e) {
    console.warn('[KOPARO] Bank account detection error:', e.message);
  }
  return 'Bank Account';
}

function detectContraCounterparty(narration, selfBankName) {
  const u = String(narration || '').toUpperCase();
  // P1: HDFC "RTGS CR-KKBK..." / "RTGS DR-RATN..."
  const m1 = u.match(/(?:RTGS|NEFT|IMPS)\s+(CR|DR)-([A-Z]{4})/);
  if (m1) {
    const otherBank = KOPARO_IFSC_TO_ACCOUNT[m1[2]] || null;
    if (otherBank) return { otherBank, isCredit: m1[1] === 'CR' };
  }
  // P2: RBL slash "RTGS/KKBKH.../SIMK..."
  // Exclude RATN only when self-bank IS RBL 4930 (both RBL accounts share RATN IFSC prefix;
  // in RBL 6984 statement, RATN = valid counterparty RBL 4930).
  const m2 = u.match(/(?:RTGS|NEFT|IMPS)\/([A-Z]{4})[^/]*\/SIMK/);
  if (m2) {
    const ifsc = m2[1];
    const selfIsRbl4930 = selfBankName && selfBankName.includes('409001624930');
    if (ifsc !== 'RATN' || !selfIsRbl4930) {
      const otherBank = KOPARO_IFSC_TO_ACCOUNT[ifsc] || null;
      if (otherBank && otherBank !== selfBankName) return { otherBank, isCredit: null };
    }
  }
  // P3: RBL IB:OFT "IB:OFT409001624930/INTER TRF/..."
  const m3 = u.match(/IB:OFT(\d+)\//);
  if (m3) {
    const otherBank = KOPARO_ACCOUNT_TO_BANK[m3[1]] || null;
    if (otherBank) return { otherBank, isCredit: null };
  }
  // P4: RBL alt-slash "NEFT/ref/KKBK/Simk Labels..."
  const m4 = u.match(/(?:RTGS|NEFT|IMPS)\/[^/]+\/([A-Z]{4})\/[^/]*SIMK/);
  if (m4) {
    const ifsc = m4[1];
    const selfIsRbl4930b = selfBankName && selfBankName.includes('409001624930');
    if (ifsc !== 'RATN' || !selfIsRbl4930b) {
      const otherBank = KOPARO_IFSC_TO_ACCOUNT[ifsc] || null;
      if (otherBank && otherBank !== selfBankName) return { otherBank, isCredit: null };
    }
  }
  // P5: IMPS masked "IMPS-ref-name-IFSC-XXXXXXXX6984-..."
  const m5 = u.match(/IMPS[-\/][^-]+[-\/][^-]+[-\/]([A-Z]{4})[-\/]X+(\d{4,})/);
  if (m5) {
    const acctSuffix = m5[2];
    const matchKey = Object.keys(KOPARO_ACCOUNT_TO_BANK).find(k => k.endsWith(acctSuffix));
    if (matchKey) return { otherBank: KOPARO_ACCOUNT_TO_BANK[matchKey], isCredit: null };
  }
  return { otherBank: null, isCredit: null };
}

async function generateKoparoExcel(results, bankAccountName, outputPath) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Bank Statement');
  const GREEN  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC8E6C9' } };
  const YELLOW = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF9C4' } };
  const RED    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFCDD2' } };
  const HEADER = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF263238' } };
  const THIN   = {
    left:   { style: 'thin', color: { argb: 'FFCCCCCC' } },
    right:  { style: 'thin', color: { argb: 'FFCCCCCC' } },
    top:    { style: 'thin', color: { argb: 'FFCCCCCC' } },
    bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
  };
  ws.addRow(['Txn Date', 'Narration', 'Chq / Ref No.', 'Withdrawal Amt.', 'Deposit Amt.',
             'Voucher Type', 'Debit', 'Credit', 'Amount', 'Confidence']);
  ws.getRow(1).height = 25;
  ws.getRow(1).eachCell(cell => {
    cell.fill      = HEADER;
    cell.font      = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.border    = THIN;
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  const KOPARO_BANK_LEDGER_NAMES = new Set(Object.values(KOPARO_ACCOUNT_TO_BANK));
  for (const r of results) {
    const withdrawal = r.debit  || null;
    const deposit    = r.credit || null;
    const amount     = withdrawal || deposit || null;
    const ledger     = r.ledger_name || '';
    const { otherBank, isCredit: rawIsCredit } = detectContraCounterparty(r.description, bankAccountName);
    const isCorrectionsContra = r.type === 'Contra' && KOPARO_BANK_LEDGER_NAMES.has(ledger);
    let debitLedger, creditLedger, voucherType;
    if (otherBank) {
      voucherType  = 'Contra';
      const isCredit = rawIsCredit !== null ? rawIsCredit : (!!r.credit && !r.debit);
      debitLedger  = isCredit ? bankAccountName : otherBank;
      creditLedger = isCredit ? otherBank        : bankAccountName;
    } else if (isCorrectionsContra) {
      voucherType  = 'Contra';
      const isDeposit = !!deposit && !withdrawal;
      debitLedger  = isDeposit ? bankAccountName : ledger;
      creditLedger = isDeposit ? ledger           : bankAccountName;
    } else if (r.type === 'Receipt') {
      voucherType  = 'Receipt';
      debitLedger  = bankAccountName;
      creditLedger = ledger;
    } else if (r.type === 'Payment') {
      voucherType  = 'Payment';
      debitLedger  = ledger;
      creditLedger = bankAccountName;
    } else {
      voucherType  = r.type || '';
      debitLedger  = bankAccountName;
      creditLedger = ledger || bankAccountName;
    }
    ws.addRow([r.date || '', r.description || '', r.chq_ref || '', withdrawal, deposit,
               voucherType, debitLedger, creditLedger, amount, r.confidence || 'Low']);
    const rowNum = ws.rowCount;
    const conf   = r.confidence || 'Low';
    const fill   = conf === 'High' ? GREEN : (conf === 'Medium' ? YELLOW : RED);
    ws.getRow(rowNum).height = 20;
    ws.getRow(rowNum).eachCell((cell, ci) => {
      cell.font   = { name: 'Calibri', size: 11 };
      cell.border = THIN;
      if ([4, 5, 9].includes(ci)) {
        cell.numFmt    = '#,##0.00';
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
      } else if ([1, 6, 10].includes(ci)) {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      } else {
        cell.alignment = { horizontal: 'left', vertical: 'middle' };
      }
      if ([7, 8, 9, 10].includes(ci)) cell.fill = fill;
    });
  }
  ws.columns.forEach(col => {
    let maxLen = 10;
    col.eachCell(cell => { const l = String(cell.value || '').length; if (l > maxLen) maxLen = l; });
    col.width = Math.min(maxLen + 3, 55);
  });
  await wb.xlsx.writeFile(outputPath);
}
// ── END KOPARO-specific ────────────────────────────────────────────────────────

const drive = require('../services/driveService');
const zeptoDrive = require('../services/zeptoDrive');

// jobId → Google Sheet URL, so repeat "Open in Sheets" clicks reuse one Sheet.
const _sheetUrlCache = new Map();

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
const findExistingJob = async (sequelize, brandId, agentType, month, year, fileHash,
  periodEndMonth = null, periodEndYear = null) => {
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
           AND period_end_month IS NOT DISTINCT FROM $6
           AND period_end_year  IS NOT DISTINCT FROM $7
           AND file_hash = $5
         LIMIT 1`,
        { bind: [brandId, agentType, month || null, year || null, fileHash,
            periodEndMonth || null, periodEndYear || null], transaction: t }
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
  outputFileId, totalRows, matchedRows, unmatchedRows, createdBy,
  periodEndMonth = null, periodEndYear = null }) => {
  try {
    let jobId;
    await sequelize.transaction(async (t) => {
      await sequelize.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
      const [rows] = await sequelize.query(
        `INSERT INTO reco_jobs
           (brand_id, agent_type, month, year, file_hash, status,
            total_rows, matched_rows, unmatched_rows, output_file_id, created_by,
            period_end_month, period_end_year)
         VALUES ($1,$2,$3,$4,$5,'completed',$6,$7,$8,$9,$10,$11,$12)
         RETURNING id`,
        { bind: [brandId, agentType, month || null, year || null, fileHash,
            totalRows, matchedRows, unmatchedRows, outputFileId, createdBy || null,
            periodEndMonth || null, periodEndYear || null],
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

// GSTR-1 vs Books — sales/outward (customer-side). The Python engine returns the slim
// reconciled B2B rows in `b2b_ui_rows` (its `results` is intentionally empty). Map the
// engine remark → Remark 1 (status) / Remark 2 (detail) and persist to gstr_1_results.
const G1_MATCHED_REMARKS = new Set(['Match', 'Amazon Entry As per Tally', 'Amazon Entry as per GSTR-1']);
const mapGstr1Remark = (raw, diffTaxable) => {
  const r = String(raw || '').trim();
  if (r === 'Match') return ['Matched', null];
  if (r === 'Diff') return ['Amount Mismatch', Number(diffTaxable) > 0 ? 'Excess in GSTR-1' : 'Excess in Books'];
  if (r === 'Not in GSTR-1') return ['Showing in Books but Not in GSTR-1', null];
  if (r === 'Not in Books') return ['Showing in GSTR-1 but Not in Books', null];
  if (r.includes('Amazon')) return ['Matched', r];
  return [r || 'Unknown', null];
};

const saveGstr1Results = async (sequelize, jobId, brandId, uiRows) => {
  if (!uiRows?.length) return;
  const num = v => { const n = Number(v); return isNaN(n) ? null : n; };
  let saved = 0, failed = 0;
  try {
    await sequelize.transaction(async (t) => {
      await sequelize.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
      for (const u of uiRows) {
        const [rm1, rm2] = mapGstr1Remark(u.remark, u.diff_taxable);
        const gstr1Only = String(u.remark || '').trim() === 'Not in Books'; // GSTR-1 side only → use g1_* amounts
        try {
          await sequelize.query(
            `INSERT INTO gstr_1_results
               (job_id, brand_id, customer_name, gstin, invoice_number, invoice_date,
                taxable_value, igst, cgst, sgst, remark_1, remark_2)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            { bind: [
                jobId, brandId,
                u.party  || null,
                u.gstin  || null,
                u.inv_no || u.g1_inv || null,
                toSqlDate(u.date),
                num(gstr1Only ? u.g1_taxable : u.t_taxable),
                num(gstr1Only ? u.g1_igst    : u.t_igst),
                num(gstr1Only ? u.g1_cgst    : u.t_cgst),
                num(gstr1Only ? u.g1_sgst    : u.t_sgst),
                rm1, rm2,
              ], transaction: t }
          );
          saved++;
        } catch (rowErr) {
          failed++;
          if (failed <= 3) console.error('[RECO-DB] gstr_1 row insert error:', rowErr.message, '| inv:', u.inv_no);
        }
      }
    });
    console.log(`[RECO-DB] ✅ Saved ${saved}/${uiRows.length} GSTR-1 rows for job ${jobId}` + (failed ? ` (${failed} skipped)` : ''));
  } catch (err) {
    console.error('[RECO-DB] saveGstr1Results error:', err.message);
  }
};

// GSTR-1 B2C (consumer sales) — aggregated, no invoice/GSTIN. Persist ONE summary row
// (remark_1 = 'B2C Summary') so the analysis page can show a B2C totals strip.
const saveGstr1B2cSummary = async (sequelize, jobId, brandId, b2cRows) => {
  if (!b2cRows?.length) return;
  const sum = (k) => b2cRows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const r2 = (n) => Math.round(n * 100) / 100;
  const g1Tax = sum('gstr1_taxable'), bkTax = sum('books_taxable');
  try {
    await sequelize.transaction(async (t) => {
      await sequelize.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
      await sequelize.query(
        `INSERT INTO gstr_1_results
           (job_id, brand_id, customer_name, gstin, invoice_number, invoice_date,
            taxable_value, igst, cgst, sgst, remark_1, remark_2)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        { bind: [
            jobId, brandId,
            'B2C — Consumer Sales (aggregated)', null, null, null,
            r2(bkTax), r2(sum('books_igst')), r2(sum('books_cgst')), r2(sum('books_sgst')),
            'B2C Summary',
            `GSTR-1 taxable ₹${Math.round(g1Tax).toLocaleString('en-IN')} vs Books ₹${Math.round(bkTax).toLocaleString('en-IN')} (${b2cRows.length} group${b2cRows.length === 1 ? '' : 's'})`,
          ], transaction: t }
      );
    });
    console.log(`[RECO-DB] ✅ Saved GSTR-1 B2C summary for job ${jobId}`);
  } catch (err) {
    console.error('[RECO-DB] saveGstr1B2cSummary error:', err.message);
  }
};

/**
 * Bulk-insert Receivable Cycle results (Main Sheet + COD sub-sheets) as JSON rows —
 * this agent's output has ~90 columns across 6 differently-shaped sheets, so each row
 * is stored as (sheet_name, row_index, row_data) rather than a rigid flat schema.
 * Also persists one extra metadata row (sheet_name='__columns__') holding the explicit
 * column ORDER per sheet, as arrays — the frontend uses this instead of deriving column
 * order from a row's own object keys, since any key that looks like an array index
 * ("2", "3", "4") is forced to the front of a JS object's own-property order regardless
 * of insertion order, no matter what the source JSON/DB preserved.
 * Batches ~500 rows per INSERT (Main Sheet alone commonly runs 20k+ rows — a per-row
 * loop like the other save* helpers use would mean tens of thousands of awaited
 * round-trips for a single job).
 */
const saveReceivableCycleResults = async (sequelize, jobId, brandId, mainRows, codSheets, mainColumns, codColumns, receivableSummary) => {
  const sheets = [['Main Sheet', mainRows || []]];
  for (const [name, rows] of Object.entries(codSheets || {})) {
    if (rows?.length) sheets.push([name, rows]);
  }
  const totalRows = sheets.reduce((n, [, rows]) => n + rows.length, 0);
  if (totalRows === 0 && !receivableSummary) return;

  const CHUNK = 500;
  let saved = 0;
  try {
    await sequelize.transaction(async (t) => {
      await sequelize.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
      for (const [sheetName, rows] of sheets) {
        for (let i = 0; i < rows.length; i += CHUNK) {
          const batch = rows.slice(i, i + CHUNK);
          const placeholders = [];
          const bind = [];
          batch.forEach((row, idx) => {
            const base = bind.length;
            placeholders.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5}::json)`);
            bind.push(jobId, brandId, sheetName, i + idx, JSON.stringify(row));
          });
          await sequelize.query(
            `INSERT INTO receivable_cycle_results (job_id, brand_id, sheet_name, row_index, row_data)
             VALUES ${placeholders.join(',')}`,
            { bind, transaction: t }
          );
          saved += batch.length;
        }
      }
      if (mainColumns?.length) {
        const columnsBySheet = { 'Main Sheet': mainColumns, ...(codColumns || {}) };
        await sequelize.query(
          `INSERT INTO receivable_cycle_results (job_id, brand_id, sheet_name, row_index, row_data)
           VALUES ($1,$2,'__columns__',-1,$3::json)`,
          { bind: [jobId, brandId, JSON.stringify(columnsBySheet)], transaction: t }
        );
      }
      // Receivable Amount card (Delivery/Ekart/Xpressbees/DTDC pending-minus-SRN
      // breakdown) — stored the same way as the column-order metadata row above.
      if (receivableSummary) {
        await sequelize.query(
          `INSERT INTO receivable_cycle_results (job_id, brand_id, sheet_name, row_index, row_data)
           VALUES ($1,$2,'__receivable_summary__',-1,$3::json)`,
          { bind: [jobId, brandId, JSON.stringify(receivableSummary)], transaction: t }
        );
      }
    });
    console.log(`[RECO-DB] ✅ Saved ${saved}/${totalRows} receivable_cycle rows (${sheets.length} sheet(s)) for job ${jobId}`);
  } catch (err) {
    console.error('[RECO-DB] saveReceivableCycleResults error:', err.message);
  }
};

// Frontend reco types that use the gstr_2b_books Python engine → persist to gstr_2b_results
const GST_2B_FRONTEND_TYPES = new Set([
  'gstr_2b_books', 'gstr_2a_vs_2b_vs_books', 'gstr_2b_vs_purchase',
  'gstr_2b_books_multistate', 'einvoice_reco',
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
  'zepto_receivables': 'zepto_receivables',
  'einvoice_reco': 'einvoice_reco',                    // E-Invoice Register vs Books (Sales + Credit Note)
  'receivable_cycle': 'receivable_cycle',              // Tally GST + Sales Order + courier COD settlement + SRN -> Main/COD sheets
};

/**
 * Execute standalone Python classifier CLI via child process.
 * Uses execFile (not exec) — no shell expansion, safe with arbitrary file paths.
 * Path resolved from BANK_CLASSIFIER_PATH env var or project-relative default.
 */
/**
 * Resolve the per-brand side-rule map for a run and write it to a temp JSON in the shape
 * classify.py's --side-map already parses.
 *
 * DB first (bank_side_rules — editable, learnable), checked-in JSON as the fallback so a
 * brand whose rules have not been migrated behaves exactly as it did before. Returns null
 * when the brand has neither, in which case no --side-map is passed at all.
 */
const resolveSideMapPath = async (brandId, brandName, jobDir) => {
  const slug = (brandName || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return null;

  if (brandId && brandId !== 'demo' && brandId !== 'other') {
    try {
      const { loadSideRules } = require('./bankCorrectionsController');
      const { Brand } = require('../models/master');
      const { getBrandConnection } = require('../config/database');
      const brand = await Brand.findByPk(brandId);
      if (brand) {
        const rules = await loadSideRules(brandId, getBrandConnection(brand.db_name));
        if (rules.length) {
          const p = path.join(jobDir, 'side_map.json');
          fs.writeFileSync(p, JSON.stringify({ brand: brandName, counterparties: rules }));
          console.log(`[RECO] Side-rule map from DB for "${brandName}" (${rules.length} rules).`);
          return p;
        }
      }
    } catch (e) {
      console.warn('[RECO] DB side-rule load failed, using seed JSON:', e.message);
    }
  }

  const seed = path.resolve(__dirname, '../../output/side_ledgers/' + slug + '.json');
  if (fs.existsSync(seed)) {
    console.log(`[RECO] Side-ledger map attached for "${brandName}" (${slug}.json, seed file).`);
    return seed;
  }
  return null;
};

const runUniversalClassifier = (ledgerPath, bankPath, outputPath, correctionsPath, brandName,
                                sideMapPath = null) => {
  return new Promise((resolve, reject) => {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
    const geminiKey = process.env.GEMINI_API_KEY;
    const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const llmOn = anthropicKey ? `claude(${anthropicModel})` : (geminiKey ? 'gemini' : 'off');
    console.log(`[RECO] Executing standalone classifier (llm=${llmOn}, brand=${brandName || 'none'}): ${CLASSIFIER_PATH}`);
    const args = ['--ledger', ledgerPath, '--bank', bankPath, '--output', outputPath];
    if (correctionsPath) args.push('--corrections', correctionsPath);
    if (brandName) args.push('--brand', brandName);
    // Per-brand side-dependent ledger map (credit-side ledger for Receipts, debit-side for
    // Payments; entries may pin a fixed type e.g. Contra). Resolved by resolveSideMapPath:
    // bank_side_rules first, then the checked-in seed JSON. A brand with neither passes no
    // --side-map at all, so no other brand — and no shared universal-bank/DB logic — is
    // affected. classify.py treats an absent map as empty.
    if (sideMapPath) args.push('--side-map', sideMapPath);
    // LLM fallback: candidate-constrained pass over Low/Medium rows only.
    // Claude is preferred when its key is present; Gemini is the fallback.
    if (anthropicKey) args.push('--anthropic-key', anthropicKey, '--anthropic-model', anthropicModel);
    if (geminiKey) args.push('--gemini-key', geminiKey, '--gemini-model', geminiModel);
    execFile('python3', [CLASSIFIER_PATH, ...args], { timeout: 600000 },
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
 * Execute the standalone Bank-vs-Tally Reco python CLI (scripts/bank_reco.py).
 * Mirrors runUniversalClassifier's execFile conventions: python3, no shell, generous
 * timeout/buffer for larger daybooks. The script prints one JSON line to stdout —
 * { counts: {...}, summary: {...}, results: [...], analytics: {...} } — after writing
 * the output workbook.
 */
const runBankReco = (tallyPath, bankPath, outputPath, brandName, tolerance, aggregateConfigPath) =>
  new Promise((resolve, reject) => {
    const script = path.join(__dirname, '../../scripts/bank_reco.py');
    const args = ['--tally', tallyPath, '--bank', bankPath, '--output', outputPath, '--brand', brandName || 'Brand'];
    // Amount-match tolerance from the UI (defaults to 1.0). Guard against NaN/negatives.
    const tol = Number(tolerance);
    args.push('--tolerance', String(Number.isFinite(tol) && tol >= 0 ? tol : 1.0));
    // Per-brand learned aggregate-reco config (dense parties + salary keywords), so a single-month
    // file recalls what prior runs learned. Brand-scoped — see load/saveAggregateConfig.
    if (aggregateConfigPath) args.push('--aggregate-config', aggregateConfigPath);
    // Optional LLM gate (GenSpark proxy → claude-haiku-4.5) to confirm a detected dense party
    // before it's learned. One small call per run; skipped if no GenSpark key configured.
    const gskKey = process.env.GSK_API_KEY;
    if (gskKey) {
      args.push('--llm-key', gskKey);
      if (process.env.GSK_BASE_URL) args.push('--llm-base-url', process.env.GSK_BASE_URL);
      // Haiku on purpose (cheap, ~1 small call/run) — NOT GSK_MODEL, which may be a costlier model.
      args.push('--llm-model', process.env.BANK_RECO_LLM_MODEL || 'claude-haiku-4-5');
    }
    console.log(`[RECO-BANK-TALLY] Executing standalone bank_reco CLI (brand=${brandName || 'none'}): ${script}`);
    execFile('python3', [script, ...args], { timeout: 600000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          console.error(`[RECO-BANK-TALLY] CLI execution error:`, stderr || error.message);
          return reject(new Error(`bank_reco.py failed: ${stderr || error.message}`));
        }
        let meta = {};
        try { meta = JSON.parse((stdout || '').trim().split('\n').pop()); } catch (_) { /* leave meta = {} */ }
        resolve(meta);
      }
    );
  });

// --- Per-brand learned aggregate-reco config (bank_reco_aggregate_config, brand_id-keyed) ---
// Dense aggregate parties (e.g. "flo sleep solutions") + custom salary keywords LEARNED from prior
// runs, so even a single-month file recalls them. Brand-scoped by brand_id + RLS, exactly like
// bank_reco_corrections. The table is owned by postgres with DML granted to colonel_app; the app
// user cannot CREATE, so it's provisioned by the migration db-restructure/010_bank_reco_aggregate_config.sql
// (run per environment as the DB owner). If the table is missing, load/save just no-op gracefully.
const loadAggregateConfig = async (brandId, brandName, jobDir) => {
  if (!brandId || brandId === 'demo' || brandId === 'other') return null;
  try {
    const { Brand } = require('../models/master');
    const { getBrandConnection } = require('../config/database');
    const brand = await Brand.findByPk(brandId);
    if (!brand) return null;
    const seq = getBrandConnection(brand.db_name);
    const [rows] = await seq.query(
      `SELECT parties, salary_keywords FROM bank_reco_aggregate_config WHERE brand_id = $1`,
      { bind: [brandId] }
    );
    const cfg = (rows && rows[0]) || { parties: [], salary_keywords: [] };
    const p = path.join(jobDir, 'aggregate_config.json');
    fs.writeFileSync(p, JSON.stringify({
      parties: Array.isArray(cfg.parties) ? cfg.parties : [],
      salary_keywords: Array.isArray(cfg.salary_keywords) ? cfg.salary_keywords : [],
    }));
    console.log(`[RECO] Aggregate config for "${brandName}": ${(cfg.parties || []).length} learned parties`);
    return p;
  } catch (e) {
    console.warn('[RECO] loadAggregateConfig failed (non-fatal):', e.message);
    return null;
  }
};

const saveAggregateConfig = async (brandId, detectedParties) => {
  if (!brandId || brandId === 'demo' || brandId === 'other') return;
  if (!Array.isArray(detectedParties) || detectedParties.length === 0) return;
  try {
    const { Brand } = require('../models/master');
    const { getBrandConnection } = require('../config/database');
    const brand = await Brand.findByPk(brandId);
    if (!brand) return;
    const seq = getBrandConnection(brand.db_name);
    const [rows] = await seq.query(
      `SELECT parties FROM bank_reco_aggregate_config WHERE brand_id = $1`, { bind: [brandId] });
    const existing = (rows && rows[0] && Array.isArray(rows[0].parties)) ? rows[0].parties : [];
    const merged = Array.from(new Set([...existing, ...detectedParties]));
    if (merged.length === existing.length && existing.every((p, i) => p === merged[i])) return;
    await seq.query(
      `INSERT INTO bank_reco_aggregate_config (brand_id, parties, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (brand_id) DO UPDATE SET parties = EXCLUDED.parties, updated_at = now()`,
      { bind: [brandId, JSON.stringify(merged)] }
    );
    console.log(`[RECO] Learned ${merged.length - existing.length} new aggregate parties for brand ${brandId} (total ${merged.length})`);
  } catch (e) {
    console.warn('[RECO] saveAggregateConfig failed (non-fatal):', e.message);
  }
};

/**
 * Build the brand's FULL Chart of Accounts as an Excel buffer for classify.py.
 * Source of truth = the DB-backed `ledger_master` table (populated when an accountant
 * uploads a COA), unioned with accountant-verified `bank_reco_corrections` ledgers.
 * Shared Postgres → identical COA across Colonel Full (3001) and this app (ngrok).
 * Returns null only when the brand has no COA at all.
 */
const getLedgerMasterBuffer = async (brandId) => {
  try {
    const { Brand } = require('../models/master');
    const { getBrandConnection } = require('../config/database');
    const brand = await Brand.findByPk(brandId);
    if (!brand) throw new Error('Brand not found');
    const brandDb = getBrandConnection(brand.db_name);

    const ledgerNames = new Set();
    let coaCount = 0;
    try {
      await brandDb.transaction(async (t) => {
        await brandDb.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
        const [rows] = await brandDb.query(
          `SELECT ledger_name FROM ledger_master WHERE brand_id = $1`,
          { bind: [brandId], transaction: t }
        );
        for (const r of rows) if (r.ledger_name) ledgerNames.add(String(r.ledger_name).trim());
      });
      coaCount = ledgerNames.size;
    } catch (err) {
      console.warn(`[RECO] ledger_master read failed: ${err.message}`);
    }

    try {
      await brandDb.transaction(async (t) => {
        await brandDb.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
        const [rows] = await brandDb.query(
          `SELECT DISTINCT correct_ledger FROM bank_reco_corrections WHERE brand_id = $1`,
          { bind: [brandId], transaction: t }
        );
        for (const r of rows) if (r.correct_ledger) ledgerNames.add(r.correct_ledger.trim());
      });
    } catch (_) { /* corrections table may not exist yet */ }

    const corrCount = ledgerNames.size - coaCount;
    console.log(`[RECO] COA source: ledger_master=${coaCount} + corrections=${corrCount} ` +
      `→ ${ledgerNames.size} total ledgers for brand ${brandId}`);
    if (coaCount === 0) {
      console.warn(`[RECO] ⚠️  No COA in ledger_master for brand ${brandId} — running on ` +
        `${ledgerNames.size} corrections-derived ledgers only. Upload the full COA.`);
    }
    if (ledgerNames.size === 0) return null;

    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('List of Ledgers');
    ws.columns = [{ header: 'Ledger Name', key: 'name', width: 40 }];
    for (const name of ledgerNames) ws.addRow({ name });
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
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

    // --- "From Drive" input: materialize req.files from a confirmed Drive selection ---
    // Body `drive` = { slotKey: [{fileId,name}] }. We download each file via the
    // service account and push it into req.files with fieldname = slotKey, so EVERY
    // downstream branch (which reads req.files by fieldname) works unchanged. This
    // adds an alternate file SOURCE only — no agent logic changes.
    if (req.body.drive) {
      let driveSel;
      try { driveSel = JSON.parse(req.body.drive); } catch (_) { driveSel = null; }
      if (driveSel && typeof driveSel === 'object') {
        req.files = req.files || [];
        for (const [slotKey, items] of Object.entries(driveSel)) {
          for (const it of (Array.isArray(items) ? items : [items])) {
            if (!it || !it.fileId) continue;
            const buffer = await drive.downloadFile(it.fileId);
            req.files.push({
              fieldname: slotKey,
              originalname: it.name || `${slotKey}`,
              buffer,
              size: buffer.length,
            });
          }
        }
      }
    }

    // --- Multi-state "From Drive": body.drive_states = [{gstr2b,purchase,debit}] per
    // state (each = {fileId,name} or null). Download in STATE ORDER and push to
    // req.files as repeated gstr2b/purchase/debit fields, with an empty debit
    // placeholder when a state has none — matching the manual multipart order the
    // Python engine pairs by index. Alternate file SOURCE only.
    if (req.body.drive_states) {
      let states;
      try { states = JSON.parse(req.body.drive_states); } catch (_) { states = null; }
      if (Array.isArray(states) && states.length) {
        req.files = req.files || [];
        for (const st of states) {
          for (const key of ['gstr2b', 'purchase', 'debit']) {
            const item = st && st[key];
            if (item && item.fileId) {
              const buffer = await drive.downloadFile(item.fileId);
              req.files.push({ fieldname: key, originalname: item.name || `${key}.xlsx`, buffer, size: buffer.length });
            } else if (key === 'debit') {
              // Keep debit index-aligned with the states (engine tolerates empty).
              req.files.push({ fieldname: 'debit', originalname: 'empty.xlsx', buffer: Buffer.alloc(0), size: 0 });
            }
          }
        }
      }
    }

    // --- Zepto Receivables: fetch classified files from Drive folder, proxy to Python engine ---
    if (recoType === 'zepto_receivables') {
      const folderUrl = req.body.folder_url || req.body.folderLink;
      if (!folderUrl) return res.status(400).json({ error: 'folder_url is required for Zepto Receivables' });
      const grouped = await zeptoDrive.downloadClassified(folderUrl);   // { type: [{filename, buffer}] }
      const form = new FormData();
      form.append('reco_type', 'zepto_receivables');
      form.append('tolerance', String(req.body.tolerance || 100));
      for (const [type, arr] of Object.entries(grouped)) {
        for (const { filename, buffer } of arr) {
          form.append(type, buffer, { filename });   // multi files -> engine reads as list
        }
      }
      const zEngine = enginePool.acquireEngine();
      let pyResp;
      try {
        pyResp = await axios.post(`${zEngine}/api/reconcile`, form, {
          headers: { ...form.getHeaders() }, timeout: 600000,
          maxContentLength: Infinity, maxBodyLength: Infinity,
        });
      } finally {
        enginePool.releaseEngine(zEngine);
      }
      if (pyResp.data && pyResp.data.job_id) enginePool.rememberJob(pyResp.data.job_id, zEngine);
      return res.json(pyResp.data);   // { job_id, summary, counts, results }
    }

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

      // PDF bank statement → convert to structured xlsx via the pdf_bank_extract engine, then classify as usual.
      if (bankFile.originalname.toLowerCase().endsWith('.pdf')) {
        console.log('[RECO-UNIVERSAL] PDF bank statement detected — converting via pdf_bank_extract');
        const pdfForm = new FormData();
        pdfForm.append('reco_type', 'pdf_bank_extract');
        pdfForm.append('bank_pdf', bankFile.buffer, { filename: bankFile.originalname, contentType: 'application/pdf' });
        if (req.body.pdf_password) pdfForm.append('pdf_password', String(req.body.pdf_password));
        const pdfEngine = enginePool.acquireEngine();
        let extractResp;
        try {
          extractResp = await axios.post(`${pdfEngine}/api/reconcile`, pdfForm, {
            headers: { ...pdfForm.getHeaders() }, timeout: 600000, maxContentLength: Infinity, maxBodyLength: Infinity,
          });
        } finally {
          enginePool.releaseEngine(pdfEngine);
        }
        if (!extractResp.data || !extractResp.data.job_id) {
          return res.status(400).json({ error: 'Could not read the PDF bank statement.', detail: extractResp.data && extractResp.data.validation });
        }
        enginePool.rememberJob(extractResp.data.job_id, pdfEngine);
        const xlsxResp = await exportFromEngines(extractResp.data.job_id, { responseType: 'arraybuffer', timeout: 200000 });
        bankPath = path.join(jobDir, 'converted_bank_statement.xlsx');
        await fs.promises.writeFile(bankPath, Buffer.from(xlsxResp.data));
        console.log(`[RECO-UNIVERSAL] PDF converted → ${extractResp.data.transaction_count || '?'} rows`);
      }

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
          const savedLedger = await getLedgerMasterBuffer(brandId);
          if (savedLedger) {
            ledgerPath = path.join(jobDir, 'ledger_master.xlsx');
            await fs.promises.writeFile(ledgerPath, savedLedger);
            console.log(`[RECO-UNIVERSAL] ✅ Loaded full COA from DB for brand ${brandId}`);
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
      let brandName = '';
      if (brandId && brandId !== 'demo' && !isDemo) {
        try {
          const { Brand } = require('../models/master');
          const { getBrandConnection } = require('../config/database');
          const corrBrand = await Brand.findByPk(brandId);
          if (corrBrand) {
            brandName = corrBrand.name || '';
            const corrSeq = getBrandConnection(corrBrand.db_name);
            const corrMap = await loadCorrectionMap(brandId, corrSeq);
            // corrMap is keyed: { exact:{…}, phone:{…}, vpa:{…}, neft_name:{…}, name:{…} }
            const totalKeys = Object.values(corrMap).reduce((s, v) => s + Object.keys(v).length, 0);
            if (totalKeys > 0) {
              correctionsPath = path.join(jobDir, 'corrections.json');
              fs.writeFileSync(correctionsPath, JSON.stringify(corrMap));
              console.log(`[RECO-CORRECTIONS] Wrote ${totalKeys} Layer 0 corrections for classify.py`);
            }
          }
        } catch (corrErr) {
          console.warn('[RECO-CORRECTIONS] Non-fatal error writing corrections:', corrErr.message);
        }
      }

      // 4. Execute Standalone Classifier Script
      const outputPath = path.join(jobDir, 'output.xlsx');
      const sideMapPath = await resolveSideMapPath(brandId, brandName, jobDir);
      await runUniversalClassifier(ledgerPath, bankPath, outputPath, correctionsPath, brandName,
                                   sideMapPath);

      if (!fs.existsSync(outputPath)) {
        throw new Error('Standalone classifier failed to generate output spreadsheet.');
      }

      // Persist an uploaded/extracted COA into the DB-backed ledger_master table so every
      // future run (and the Colonel Full app, which shares this Postgres) uses the full COA.
      // Best-effort: a persistence hiccup must not fail the reconciliation the user just ran.
      if (freshLedgerBuffer && brandId && brandId !== 'demo' && !isDemo) {
        try {
          const { ingestLedgerMasterToTable } = require('../services/salesService');
          const r = await ingestLedgerMasterToTable(brandId, freshLedgerBuffer);
          console.log(`[RECO-UNIVERSAL] COA persisted to ledger_master: +${r.inserted} new ` +
            `(${r.total} in file) for brand ${brandId}`);
        } catch (ingestErr) {
          console.error('[RECO-UNIVERSAL] COA ingest to ledger_master failed (non-fatal):', ingestErr.message);
        }
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

      // Build a header→column-index map from row 1 so column ORDER is irrelevant
      // (a new column like "Chq / Ref No." can be inserted without shifting reads).
      const _normH = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const colIdx = {};
      (ws.getRow(1).values || []).forEach((h, i) => {
        const n = _normH(h);
        if (!n) return;
        const set = (k, cond) => { if (cond && colIdx[k] === undefined) colIdx[k] = i; };
        set('date', n.includes('txndate') || n === 'date');
        set('description', n.includes('description') || n.includes('narration'));
        set('chq_ref', n.includes('chq') || n.includes('refno') || n.includes('reference'));
        set('debit', n === 'debit' || n.includes('withdrawal'));
        set('credit', n === 'credit' || n.includes('deposit'));
        set('balance', n.includes('balance'));
        set('type', n === 'type' || n.includes('vouchertype'));
        set('ledger_name', n.includes('ledgername') || n === 'ledger');
        set('confidence', n.includes('confidence'));
      });
      // Fallback to current classify.py column order if a header isn't matched.
      const C = {
        date: colIdx.date || 1, description: colIdx.description || 2, chq_ref: colIdx.chq_ref || 3,
        debit: colIdx.debit || 4, credit: colIdx.credit || 5, balance: colIdx.balance || 6,
        type: colIdx.type || 7, ledger_name: colIdx.ledger_name || 8, confidence: colIdx.confidence || 9,
      };

      // Extract row data (Header is row 1)
      ws.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // Skip headers
        const cells = row.values; // 1-based; cells[0] is undefined
        const rawDate = cells[C.date];
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
          description: cells[C.description] || '',
          chq_ref: cells[C.chq_ref] != null ? String(cells[C.chq_ref]) : '',
          debit: cells[C.debit] ? parseFloat(cells[C.debit]) : null,
          credit: cells[C.credit] ? parseFloat(cells[C.credit]) : null,
          balance: cells[C.balance] ? parseFloat(cells[C.balance]) : null,
          type: cells[C.type] || '',
          ledger_name: cells[C.ledger_name] || '',
          confidence: cells[C.confidence] || 'Low'
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

            // Case/whitespace-insensitive COA index. A hand-typed correction eventually
            // varies the capitalisation ('Ria-Salary' vs the COA's 'Ria-salary'); an exact
            // check calls that a non-existent ledger and drops the correction silently, so
            // the accountant re-corrects the same row every month and it never learns.
            const coaByKey = new Map();
            for (const l of ledgerSet) coaByKey.set(l.toLowerCase().replace(/\s+/g, ' ').trim(), l);
            const resolveLedger = (name) => {
              if (!name) return null;
              if (ledgerSet.has(name)) return name;
              return coaByKey.get(String(name).toLowerCase().replace(/\s+/g, ' ').trim()) || null;
            };

            let corrected = 0;
            const unknownLedgers = new Set();
            results.forEach(row => {
              const key = normalizeNarration(row.description);
              const fix = corrMap.exact ? corrMap.exact[key] : corrMap[key];
              if (!fix) return;
              // Safeguard: skip if ledger was deleted/renamed from CoA. Snap to the COA's
              // own spelling so one ledger can never be stored under two casings.
              const resolved = ledgerSet.size > 0 ? resolveLedger(fix.ledger) : fix.ledger;
              if (!resolved) { unknownLedgers.add(fix.ledger); return; }
              row.ledger_name = resolved;
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
            // Never drop a correction in silence: a ledger the accountant typed that is in
            // no COA at all is either a typo or a ledger that still needs creating, and
            // they have no other way to find out why their fix keeps not sticking.
            if (unknownLedgers.size) {
              console.warn(`[RECO-CORRECTIONS] ${unknownLedgers.size} correction(s) skipped — ` +
                `ledger not in the CoA: ${[...unknownLedgers].slice(0, 10).join(' | ')}`);
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


      // ── KOPARO: overwrite classify.py output with Tally Debit/Credit ledger format ──
      // Guarded by brandId === KOPARO_BRAND_ID — zero impact on other brands.
      if (brandId === KOPARO_BRAND_ID && results.length > 0) {
        try {
          const bankAccountName = await detectKoparoBankAccount(bankPath);
          console.log(`[KOPARO] Detected bank account: ${bankAccountName}`);
          await generateKoparoExcel(results, bankAccountName, outputPath);
          console.log(`[KOPARO] Generated Tally Debit/Credit format output (${results.length} rows)`);
        } catch (koparoErr) {
          console.warn('[KOPARO] Non-fatal: falling back to standard output:', koparoErr.message);
        }
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

    // --- Bank-vs-Tally Reco: standalone bank_reco.py, chained off a saved Universal output ---
    if (recoType === 'bank_tally_reco') {
      const jobId = crypto.randomUUID();
      const jobDir = path.join(RECO_TEMP_DIR, `job_${jobId}`);
      await fs.promises.mkdir(jobDir, { recursive: true });

      try {
        // 1. Tally daybook — required upload
        const tallyFile = (req.files || []).find(f => f.fieldname === 'tally_daybook');
        if (!tallyFile) {
          return res.status(400).json({ error: 'Tally daybook file (tally_daybook) is required' });
        }
        const tallyPath = path.join(jobDir, `tally_daybook_${tallyFile.originalname}`);
        await fs.promises.writeFile(tallyPath, tallyFile.buffer);

        // 2. Bank side: chained from a prior Universal Bank Statement run (source_job_id)
        //    OR a directly uploaded classified bank_output workbook.
        const sourceJobId = req.body.source_job_id;
        if (sourceJobId && !/^[0-9a-fA-F-]{36}$/.test(sourceJobId)) {
          return res.status(400).json({ error: 'Invalid source_job_id' });
        }
        let bankPath;
        if (sourceJobId) {
          const savedOutput = path.join(RECO_OUTPUT_DIR, `${sourceJobId}.xlsx`);
          if (!fs.existsSync(savedOutput)) {
            return res.status(400).json({ error: 'Source Universal Bank Statement output not found for source_job_id' });
          }
          bankPath = path.join(jobDir, 'bank_output.xlsx');
          await fs.promises.copyFile(savedOutput, bankPath);
        } else {
          const bankFile = (req.files || []).find(f => f.fieldname === 'bank_output');
          if (!bankFile) {
            return res.status(400).json({ error: 'Bank output file (bank_output) or source_job_id is required' });
          }
          bankPath = path.join(jobDir, `bank_output_${bankFile.originalname}`);
          await fs.promises.writeFile(bankPath, bankFile.buffer);
        }

        // Read the bank bytes into memory NOW (synchronously, inside the try) — the
        // per-job temp dir (and this file with it) gets deleted by the `finally` block
        // below as soon as the response is sent. The deferred setImmediate DB-save must
        // hash these in-memory bytes, never re-read bankPath, or it races the cleanup
        // and silently fails with ENOENT (mirrors how the universal branch always hashes
        // in-memory buffers, never a soon-to-be-deleted path).
        const bankBuf = fs.readFileSync(bankPath);

        // 3. Resolve brand name for the workbook header — same DB lookup the universal
        //    branch uses for its brandName (falls back to the raw body field, then generic).
        let brandName = (req.body.brand_name || '').trim();
        if (!brandName && brandId && brandId !== 'demo' && !isDemo) {
          try {
            const { Brand } = require('../models/master');
            const brand = await Brand.findByPk(brandId);
            if (brand) brandName = brand.name || '';
          } catch (brandErr) {
            console.warn('[RECO-BANK-TALLY] Brand lookup failed (non-fatal):', brandErr.message);
          }
        }
        brandName = brandName || 'Brand';

        // 4. Execute Standalone Bank-vs-Tally Reco Script — with the brand's learned aggregate
        //    config (dense parties + salary keywords) so a single-month file recalls prior learning.
        const aggConfigPath = await loadAggregateConfig(brandId, brandName, jobDir);
        const outputPath = path.join(jobDir, 'output.xlsx');
        const meta = await runBankReco(tallyPath, bankPath, outputPath, brandName, req.body.tolerance, aggConfigPath);

        if (!fs.existsSync(outputPath)) {
          throw new Error('bank_reco.py failed to generate output spreadsheet.');
        }

        // Learn: persist the LLM-confirmed dense aggregate parties for THIS brand (fire-and-forget).
        // Falls back to the raw detected set when the LLM gate is off/unavailable.
        setImmediate(() => saveAggregateConfig(
          brandId, meta.confirmed_aggregate_parties || meta.detected_aggregate_parties));

        // 5. Persist Excel File for Direct Download (GET /api/reco/export/:jobId)
        fs.mkdirSync(RECO_OUTPUT_DIR, { recursive: true });
        const persistentPath = path.join(RECO_OUTPUT_DIR, `${jobId}.xlsx`);
        fs.copyFileSync(outputPath, persistentPath);

        const counts = meta.counts || {};
        const totalRows = ['matched', 'date_updated', 'partial', 'bank_only', 'tally_only']
          .reduce((sum, k) => sum + (parseInt(counts[k], 10) || 0), 0);
        const matchedRows = (parseInt(counts.matched, 10) || 0) + (parseInt(counts.date_updated, 10) || 0);
        const unmatchedRows = totalRows - matchedRows;

        // 6. Persist to Hero DB (fire-and-forget, never blocks download) — mirrors the
        //    universal branch's saveRecoJob call. No per-row results table exists for this
        //    agent (the workbook is the deliverable), so only the job summary is saved.
        if (!isDemo && brandId && brandId !== 'demo') {
          setImmediate(async () => {
            try {
              const { Brand } = require('../models/master');
              const { getBrandConnection } = require('../config/database');
              const brand = await Brand.findByPk(brandId);
              if (!brand) return;
              const seq = getBrandConnection(brand.db_name);
              const fileHash = hashFiles(tallyFile.buffer, bankBuf);
              const month = parseInt(req.body.month) || null;
              const year = parseInt(req.body.year) || null;

              const existing = await findExistingJob(seq, brandId, 'bank_tally_reco', month, year, fileHash);
              if (existing) {
                if (existing.total_rows > 0) {
                  await updateOutputFileId(seq, existing.id, jobId);
                  console.log(`[RECO-DB] Same file re-run — bank_tally_reco output updated`);
                  return;
                }
                await deleteJob(seq, existing.id);
                console.log(`[RECO-DB] Removed 0-row bank_tally_reco job ${existing.id}, re-saving`);
              }

              await saveRecoJob(seq, {
                brandId, agentType: 'bank_tally_reco', month, year, fileHash,
                outputFileId: jobId,
                totalRows, matchedRows, unmatchedRows,
                createdBy: req.user?.id,
              });
            } catch (e) {
              console.error('[RECO-DB] Background save error (bank_tally_reco):', e.message);
            }
          });
        }

        // 7. Return standard format payload to Frontend
        return res.json({
          job_id: jobId,
          summary: meta.summary || {},
          counts,
          results: meta.results || [],   // reco-bucket rows for the dashboard table (workbook remains the full deliverable)
          analytics: meta.analytics || null,  // monthly closing / top ledgers / buckets for the Analytics charts
        });
      } finally {
        // Guaranteed cleanup of sandboxed job folder — runs even if the response threw
        fs.rm(jobDir, { recursive: true, force: true }, (err) => {
          if (err) console.error('[RECO-BANK-TALLY] Cleanup error:', err.message);
          else console.log(`[RECO-BANK-TALLY] Sandboxed job folder cleaned up: job_${jobId}`);
        });
      }
    }

    // Map frontend reco_type → Python reco_type
    const pythonRecoType = RECO_TYPE_MAP[recoType] || recoType;

    const form = new FormData();
    form.append('reco_type', pythonRecoType);
    form.append('tolerance', req.body.tolerance || '10');
    // PDF → Bank Statement: optional password for locked/encrypted PDFs (from the UI field).
    if (req.body.pdf_password) form.append('pdf_password', String(req.body.pdf_password));

    // Receivable Cycle: forward the selected period so the engine's Receivable
    // Amount calc knows which SRN/return rows fall inside this run's month(s).
    if (recoType === 'receivable_cycle') {
      if (req.body.month) form.append('month', String(req.body.month));
      if (req.body.year) form.append('year', String(req.body.year));
      if (req.body.period_end_month) form.append('period_end_month', String(req.body.period_end_month));
      if (req.body.period_end_year) form.append('period_end_year', String(req.body.period_end_year));
    }

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

    // Credit Card Booking: attach the brand's chart of accounts and its
    // auto-learned merchant directory. The Python engine never touches the DB,
    // so everything it needs to map a merchant → ledger is passed in here, read
    // under RLS for this brand only. Missing COA is NOT fatal — the agent still
    // runs and simply books more rows to Suspense for review.
    if (recoType === 'credit_card_booking' && !isDemo && brandId && brandId !== 'demo') {
      const { getCardContext } = require('./creditCardController');
      const ctx = await getCardContext(brandId);
      form.append('coa', JSON.stringify(ctx.coa));
      form.append('directory', JSON.stringify(ctx.directory));
      if (req.body.card_ledger) form.append('card_ledger', String(req.body.card_ledger));
      if (req.body.voucher_type) form.append('voucher_type', String(req.body.voucher_type));
      console.log(`[CC] brand ${brandId}: ${ctx.coa.length} COA ledgers, ` +
        `${ctx.directory.length} learned keys`);
      if (!ctx.coa.length) {
        console.warn('[CC] no COA for this brand — rows will fall to Suspense');
      }
    }

    // Bank statement in production: auto-attach ledger master from DB
    if (recoType === 'bank_statement' && !isDemo && brandId && brandId !== 'demo') {
      const hasLedgerUploaded = req.files.some(f => f.fieldname === 'ledger_master');
      if (!hasLedgerUploaded) {
        console.log(`[RECO] Fetching ledger_master from DB for brand ${brandId}...`);
        const ledgerBuffer = await getLedgerMasterBuffer(brandId);
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

    const mainEngine = enginePool.acquireEngine();
    let response;
    try {
      response = await axios.post(`${mainEngine}/api/reconcile`, form, {
        headers: { ...form.getHeaders() },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        // Multi-state now pre-builds the (heavy) workbook during the run so downloads
        // are instant — give that build headroom for larger multi-state jobs.
        // Raised to 10 min: on the small EC2 box heavy recos run slower but DO complete;
        // 180s was cutting them off mid-build (engine still returned 200 afterwards).
        timeout: 600000
      });
    } finally {
      enginePool.releaseEngine(mainEngine);
    }
    if (response.data && response.data.job_id) enginePool.rememberJob(response.data.job_id, mainEngine);

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
          // Receivable Cycle's "Generate Receivables" form can tag a job with a month
          // RANGE instead of a single month — metadata only (see reco_jobs.period_end_*),
          // never sent by any other agent's page.
          const periodEndMonth = parseInt(req.body.period_end_month) || null;
          const periodEndYear  = parseInt(req.body.period_end_year)  || null;
          console.log(`[RECO-DB] fileHash=${fileHash.slice(0,12)} month=${month} year=${year}` +
            (periodEndMonth || periodEndYear ? ` periodEnd=${periodEndMonth}/${periodEndYear}` : ''));

          const pythonJobId = response.data?.job_id || null;

          const existing = await findExistingJob(seq, brandId, recoType, month, year, fileHash, periodEndMonth, periodEndYear);
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
          // GSTR-1 returns its reconciled rows in b2b_ui_rows (results is intentionally empty).
          const g1Rows = recoType === 'gstr_1_vs_books' ? (response.data?.b2b_ui_rows || []) : null;
          const totalRows    = g1Rows ? g1Rows.length
                              : (pySummary.total ?? pyResults.length);
          const matchedRows  = g1Rows ? g1Rows.filter(r => G1_MATCHED_REMARKS.has(String(r.remark || '').trim())).length
                              : (pySummary.matched ?? pyResults.filter(r => r.suggested_action === 'Matched').length);
          const unmatchedRows = g1Rows ? (totalRows - matchedRows)
                              : (pySummary.unmatched ?? (totalRows - matchedRows));
          console.log(`[RECO-DB] pyResults=${pyResults.length} g1Rows=${g1Rows?.length ?? '-'} totalRows=${totalRows} matched=${matchedRows}`);

          const savedJobId = await saveRecoJob(seq, {
            brandId, agentType: recoType, month, year, fileHash,
            outputFileId: pythonJobId,
            totalRows, matchedRows, unmatchedRows,
            createdBy: req.user?.id,
            periodEndMonth, periodEndYear,
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
          } else if (savedJobId && recoType === 'gstr_1_vs_books') {
            console.log(`[RECO-DB] GSTR-1 path: g1Rows=${g1Rows?.length} b2c=${response.data?.b2c_rows?.length}`);
            if (g1Rows?.length > 0) {
              await saveGstr1Results(seq, savedJobId, brandId, g1Rows);
            }
            await saveGstr1B2cSummary(seq, savedJobId, brandId, response.data?.b2c_rows);
          } else if (savedJobId && recoType === 'receivable_cycle') {
            await saveReceivableCycleResults(seq, savedJobId, brandId, pyResults,
              response.data?.cod_sheets, response.data?.main_sheet_columns, response.data?.cod_sheet_columns,
              response.data?.receivable_summary);
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
    // COA integrity guard tripped in classify.py — the file used as the COA was actually a
    // bank statement / transaction sheet. Surface the clean, actionable message.
    const coaErr = /COA integrity check failed:[^\n]*/.exec(err.message || '');
    if (coaErr) {
      return res.status(400).json({ error: coaErr[0] });
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
    const { Brand } = require('../models/master');
    const { getBrandConnection } = require('../config/database');
    const brand = await Brand.findByPk(brandId);
    if (!brand) return res.json({ hasLedger: false, count: 0 });
    const brandDb = getBrandConnection(brand.db_name);
    let count = 0;
    await brandDb.transaction(async (t) => {
      await brandDb.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
      const [rows] = await brandDb.query(
        `SELECT count(*)::int AS n FROM ledger_master WHERE brand_id = $1`,
        { bind: [brandId], transaction: t }
      );
      count = rows[0]?.n || 0;
    });
    res.json({ hasLedger: count > 0, count, source: 'ledger_master' });
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

    const response = await exportFromEngines(
      req.params.jobId,
      // Normally instant (pre-built bytes). Generous timeout covers the fallback
      // path where the engine must rebuild a large workbook on demand.
      { responseType: 'stream', timeout: 200000 }
    );
    response.data.pipe(res);
  } catch (err) {
    console.error('[RECO] exportReco error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/reco/open-in-sheets/:jobId
 * Upload the output xlsx to Drive as a Google Sheet (service account) and
 * return a shareable link. Cached per jobId so re-clicks reuse the same Sheet.
 */
const openInSheets = async (req, res) => {
  const { jobId } = req.params;
  try {
    if (!drive.isConfigured()) {
      return res.status(503).json({ error: 'Google Drive is not configured on the server.' });
    }
    // Reuse an already-created Sheet for this job.
    if (_sheetUrlCache.has(jobId)) {
      return res.json({ url: _sheetUrlCache.get(jobId), cached: true });
    }

    // Resolve the local xlsx; rebuild from the Python engine to a temp file if missing.
    let localPath = path.join(RECO_OUTPUT_DIR, `${jobId}.xlsx`);
    let cleanup = null;
    if (!fs.existsSync(localPath)) {
      fs.mkdirSync(RECO_TEMP_DIR, { recursive: true });
      const tmp = path.join(RECO_TEMP_DIR, `sheets-${jobId}.xlsx`);
      const response = await exportFromEngines(
        jobId,
        { responseType: 'stream', timeout: 200000 }
      );
      await new Promise((resolve, reject) => {
        const w = fs.createWriteStream(tmp);
        response.data.pipe(w);
        w.on('finish', resolve); w.on('error', reject);
      });
      localPath = tmp;
      cleanup = tmp;
    }

    const name = `${(req.query.name || 'Reconciliation').replace(/[^a-zA-Z0-9_\- ]/g, '_')} ${jobId.slice(0, 8)}`;
    // Prefer the connected Google account (real storage); fall back to the service
    // account (needs GOOGLE_OUTPUT_FOLDER_ID → a Shared Drive, else no storage).
    let sheet = await drive.uploadXlsxAsSheetOAuth(localPath, name);
    if (!sheet) {
      const { id, webViewLink } = await drive.uploadXlsxAsSheet(localPath, name);
      try { await drive.makeAnyoneReader(id); } catch (e) { console.warn('[RECO] share failed:', e.message); }
      sheet = { id, webViewLink };
    }
    const { webViewLink } = sheet;
    if (cleanup) fs.unlink(cleanup, () => {});

    _sheetUrlCache.set(jobId, webViewLink);
    res.json({ url: webViewLink });
  } catch (err) {
    const msg = String(err?.errors?.[0]?.reason || err?.message || '');
    console.error('[RECO] openInSheets error:', msg);
    if (/storage\s*quota/i.test(msg)) {
      return res.status(502).json({
        error: 'Drive upload blocked: the service account has no storage. Ask the admin to set GOOGLE_OUTPUT_FOLDER_ID to a Shared Drive folder. You can still Download the Excel.',
      });
    }
    res.status(502).json({ error: 'Could not open in Google Sheets. You can still Download the Excel.' });
  }
};

/**
 * GET /api/reco/health
 */
const checkHealth = async (req, res) => {
  try {
    // Python server serves index.html on GET / — use that as health probe.
    // Probe every engine in the pool so a half-down pool is visible.
    const engines = await Promise.all(
      enginePool.listEngines().map(async (base) => {
        try {
          await axios.get(`${base}/`, { timeout: 5000 });
          return { url: base, status: 'ok' };
        } catch (e) {
          return { url: base, status: 'down', message: e.message };
        }
      })
    );
    const up = engines.filter((e) => e.status === 'ok').length;
    if (up === 0) throw new Error('no reco engine reachable');
    res.json({
      status: up === engines.length ? 'ok' : 'degraded',
      engines,
      python_url: PYTHON_RECO_URL,
    });
  } catch (err) {
    res.status(503).json({
      status: 'unavailable',
      message: 'Python reconciliation service is not running',
      python_url: PYTHON_RECO_URL
    });
  }
};

/**
 * DELETE /api/reco/job/:brandId/:jobId
 * Per-run Reset — purge ONE reco job (and its CASCADE result rows) from the
 * brand's DB. Accepts either the Python output_file_id or the PG id as :jobId.
 */
const deleteRecoJob = async (req, res) => {
  try {
    const { brandId, jobId } = req.params;
    if (!brandId || ['other', 'demo'].includes(brandId)) {
      return res.json({ deleted: false, reason: 'no-db-for-brand' });
    }
    const { Brand } = require('../models/master');
    const { getBrandConnection } = require('../config/database');
    const brand = await Brand.findByPk(brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    const seq = getBrandConnection(brand.db_name);

    let pgId = null;
    await seq.transaction(async (t) => {
      await seq.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
      const [rows] = await seq.query(
        `SELECT id FROM reco_jobs WHERE output_file_id = $1 OR id::text = $1 LIMIT 1`,
        { bind: [jobId], transaction: t }
      );
      if (rows.length) pgId = rows[0].id;
    });

    if (!pgId) return res.json({ deleted: false, reason: 'not-found' });
    await deleteJob(seq, pgId); // CASCADE removes the row-level result rows
    return res.json({ deleted: true });
  } catch (err) {
    console.error('[RECO] deleteRecoJob error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// POST /api/reco/detect-files  { folder_url }
// Scans a Zepto Drive folder and returns classified file counts (preview only — no download).
async function detectZeptoFiles(req, res) {
  try {
    const folderUrl = req.body.folder_url || req.body.folderLink;
    if (!folderUrl) return res.status(400).json({ error: 'folder_url is required' });
    const { counts, ignored, files } = await zeptoDrive.collectZeptoFiles(folderUrl);
    res.json({
      counts,
      ignored: ignored.map(f => f.name),
      files: files.map(f => ({ name: f.name, type: f.type })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to scan Drive folder' });
  }
}

// Ephemeral master-data reset for the "Other" catch-all brand (no-op for real
// brands). Clears COA/SKU/Ledger master + learned corrections; keeps results.
const { purgeOtherMaster } = require('../services/otherBrandPurge');
const purgeSessionMaster = async (req, res, next) => {
  try {
    const result = await purgeOtherMaster(req.params.brandId);
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
};

module.exports = { runReco, exportReco, openInSheets, checkHealth, getLedgerStatus, deleteRecoJob, detectZeptoFiles, purgeSessionMaster };
