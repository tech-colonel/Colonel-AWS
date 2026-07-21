// new-backend/seed-flo-learned-layer.js
// Task 2.5b: seed FLO's classifier learned-layer (Step 0 in classify.py) from the
// human-verified previous output (col J "LEDGER as per Tally" in the RBL statement).
//
// Seeds THREE tables for FLO:
//   1. ledger_master        — every distinct col-J ledger, so off-COA ledgers
//                              (e.g. "Bharat X") become valid COA entries.
//                              REQUIRED: classify.py's _directory_lookup only
//                              returns a ledger that is in master_ledgers — a
//                              directory hit for a ledger not in the COA is
//                              silently dropped otherwise.
//   2. bank_reco_corrections — exact narration_key -> ledger (source='output_upload')
//   3. bank_payee_directory  — extractPayeeKeys(narration) keys (all except
//                              'exact') -> ledger (source='output_upload')
//
// Run: cd new-backend && node seed-flo-learned-layer.js
//
// LOCAL ONLY — writes to the live local unified DB (colonel_agent_accountant)
// via masterSequelize (postgres superuser, bypasses RLS), same pattern Task 1's
// seed-flo-brand.js used for ledger_master.

const path = require('path');
const XLSX = require('xlsx');
const { masterSequelize } = require('./src/config/database');
const { normalizeNarration, extractPayeeKeys } = require('./src/controllers/bankCorrectionsController');

const FLO_BRAND_ID = '099c8de8-5ff8-49eb-81a9-1f89658a6bb8';
const SOURCE_FILE = '/Users/dhavalchauhan/Dhaval/Bank RECO/Bank Statement RBL.xlsx';
const SHEET_NAME = 'Table 1';
const HEADER_ROW_INDEX = 1; // second row (0-based) — row 0 is a merged/total row

// Clean a raw narration: bank statement narrations contain embedded newlines
// which would break the single-line regexes in extractPayeeKeys/classify.py.
const cleanNarration = (raw) =>
  String(raw || '')
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Parse a bank-amount cell ("  17,000.00 ", "", 0, etc.) into a number.
const parseAmount = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseFloat(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
};

// Resolve a header name to its column index, tolerant of surrounding whitespace.
const findCol = (header, name) => header.findIndex((h) => String(h || '').trim() === name);

// Chunked multi-row upsert. `rows` is an array of bind-value arrays, one per
// row, in the same order as `columns`. Builds one INSERT ... VALUES (...),(...)...
// statement per chunk so ~14k logical rows don't become ~14k round trips.
async function chunkedUpsert(transaction, table, columns, conflictCols, updateClause, rows, chunkSize = 1000) {
  let count = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const params = [];
    const valueGroups = chunk.map((row) => {
      const placeholders = row.map((val) => {
        params.push(val);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    const sql = `
      INSERT INTO ${table} (${columns.join(', ')})
      VALUES ${valueGroups.join(', ')}
      ON CONFLICT (${conflictCols})
      DO ${updateClause}
    `;
    await masterSequelize.query(sql, { bind: params, transaction });
    count += chunk.length;
  }
  return count;
}

(async () => {
  await masterSequelize.authenticate();

  console.log(`[SEED] reading ${SOURCE_FILE} :: sheet "${SHEET_NAME}"`);
  const wb = XLSX.readFile(SOURCE_FILE);
  const ws = wb.Sheets[SHEET_NAME];
  if (!ws) throw new Error(`Sheet "${SHEET_NAME}" not found. Sheets: ${wb.SheetNames.join(', ')}`);

  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  const header = rows[HEADER_ROW_INDEX].map((h) => String(h || '').trim());

  const idxNarration = findCol(header, 'Narration');
  const idxLedger = findCol(header, 'LEDGER as per Tally');
  const idxWithdrawal = findCol(header, 'WITHDRAWAL AMT');
  const idxDeposit = findCol(header, 'DEPOSIT AMT');

  if (idxNarration < 0 || idxLedger < 0 || idxWithdrawal < 0 || idxDeposit < 0) {
    throw new Error(
      `Could not resolve required columns. header=${JSON.stringify(header)} ` +
      `idxNarration=${idxNarration} idxLedger=${idxLedger} idxWithdrawal=${idxWithdrawal} idxDeposit=${idxDeposit}`
    );
  }
  console.log(`[SEED] columns resolved: Narration=${idxNarration} Ledger=${idxLedger} Withdrawal=${idxWithdrawal} Deposit=${idxDeposit}`);

  // ── Pass 1: walk data rows (after the header row), build in-memory dedup maps ──
  const ledgerMap = new Map();      // ledger_name_key -> ledger_name (original casing)
  const correctionsMap = new Map(); // narration_key -> { narration_raw, correct_ledger, correct_type }
  const payeeMap = new Map();       // `${key_type}|${key_value}` -> { key_type, key_value, ledger, txn_type }

  let dataRows = 0;
  let rowsWithLedger = 0;

  for (let i = HEADER_ROW_INDEX + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    const ledgerRaw = String(row[idxLedger] || '').trim();
    if (!ledgerRaw) continue; // skip rows with no col-J ledger (blank trailing rows etc.)
    rowsWithLedger++;

    const narrationRaw = cleanNarration(row[idxNarration]);
    dataRows++;

    const withdrawal = parseAmount(row[idxWithdrawal]);
    const deposit = parseAmount(row[idxDeposit]);
    const correctType = withdrawal > 0 ? 'Payment' : (deposit > 0 ? 'Receipt' : null);

    // 1. ledger_master — distinct col-J ledgers
    const ledgerKey = normalizeNarration(ledgerRaw);
    if (!ledgerMap.has(ledgerKey)) ledgerMap.set(ledgerKey, ledgerRaw);

    // 2. bank_reco_corrections — exact narration_key -> ledger
    if (narrationRaw) {
      const narrationKey = normalizeNarration(narrationRaw);
      correctionsMap.set(narrationKey, {
        narration_raw: narrationRaw,
        correct_ledger: ledgerRaw,
        correct_type: correctType,
      });

      // 3. bank_payee_directory — payee identity keys (all except 'exact')
      const payeeKeys = extractPayeeKeys(narrationRaw);
      for (const [keyType, keyValue] of Object.entries(payeeKeys)) {
        if (keyType === 'exact') continue;
        payeeMap.set(`${keyType}|${keyValue}`, {
          key_type: keyType,
          key_value: keyValue,
          ledger: ledgerRaw,
          txn_type: correctType,
        });
      }
    }
  }

  console.log(`[SEED] scanned ${rows.length - HEADER_ROW_INDEX - 1} data rows; ${rowsWithLedger} have a col-J ledger`);
  console.log(`[SEED] distinct ledgers=${ledgerMap.size} distinct narration keys=${correctionsMap.size} distinct payee keys=${payeeMap.size}`);

  const keyTypeBreakdown = {};
  for (const { key_type } of payeeMap.values()) {
    keyTypeBreakdown[key_type] = (keyTypeBreakdown[key_type] || 0) + 1;
  }
  console.log(`[SEED] payee key_type breakdown:`, keyTypeBreakdown);

  // ── Pass 2: write everything inside a single transaction ──
  await masterSequelize.transaction(async (t) => {
    // 1. ledger_master (ON CONFLICT DO NOTHING, source='correction')
    const ledgerRows = [...ledgerMap.entries()].map(([key, name]) => [
      FLO_BRAND_ID, name, key, 'correction',
    ]);
    const ledgerAttempted = await chunkedUpsert(
      t,
      'ledger_master',
      ['brand_id', 'ledger_name', 'ledger_name_key', 'source'],
      'brand_id, ledger_name_key',
      'NOTHING',
      ledgerRows
    );
    console.log(`[SEED] ledger_master: upserted (attempted) ${ledgerAttempted} rows`);

    // 2. bank_reco_corrections (ON CONFLICT DO UPDATE, source='output_upload')
    const correctionRows = [...correctionsMap.values()].map((c) => [
      FLO_BRAND_ID, c.narration_raw, normalizeNarration(c.narration_raw), c.correct_ledger, c.correct_type, 'output_upload',
    ]);
    const correctionsAttempted = await chunkedUpsert(
      t,
      'bank_reco_corrections',
      ['brand_id', 'narration_raw', 'narration_key', 'correct_ledger', 'correct_type', 'source'],
      'brand_id, narration_key',
      `UPDATE SET
         correct_ledger = EXCLUDED.correct_ledger,
         correct_type   = EXCLUDED.correct_type,
         source         = EXCLUDED.source,
         narration_raw  = EXCLUDED.narration_raw,
         updated_at     = NOW()`,
      correctionRows
    );
    console.log(`[SEED] bank_reco_corrections: upserted (attempted) ${correctionsAttempted} rows`);

    // 3. bank_payee_directory (ON CONFLICT DO UPDATE, source='output_upload')
    const payeeRows = [...payeeMap.values()].map((p) => [
      FLO_BRAND_ID, p.key_type, p.key_value, p.ledger, p.txn_type, 'output_upload',
    ]);
    const payeeAttempted = await chunkedUpsert(
      t,
      'bank_payee_directory',
      ['brand_id', 'key_type', 'key_value', 'ledger', 'txn_type', 'source'],
      'brand_id, key_type, key_value',
      `UPDATE SET
         ledger     = EXCLUDED.ledger,
         txn_type   = EXCLUDED.txn_type,
         source     = EXCLUDED.source,
         updated_at = NOW()`,
      payeeRows
    );
    console.log(`[SEED] bank_payee_directory: upserted (attempted) ${payeeAttempted} rows`);
  });

  console.log('[SEED] done.');
  await masterSequelize.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
