/**
 * One-off ingestion: loads the 3 real prepaid/delivery-status source files into
 * receivable_cycle_imports for Flo Mattress, so buildReceivableLedger.js's new
 * matchDeliveryStatus/matchGatewaySettlements steps have something to read.
 *
 * Mirrors buildReceivableLedger.js's own conventions (hardcoded BRAND_ID, direct
 * sequelize, literal file paths) — that script matches import rows by literal
 * source_file/sheet_name, not by `role`, since this brand's existing 235k+ import
 * rows were never role-tagged (see plan doc). `role` is still set here for future
 * use by the generic role-based pipeline (receivableLedgerBuilder.js).
 *
 * Safe to re-run: deletes this brand's rows for each source_file first.
 *
 * Usage: node scripts/ingestPrepaidFiles.js
 */
const fs = require('fs');
const { masterSequelize } = require('../src/config/database');
const { parseExcelBuffer } = require('../src/services/processors/orderCycleShopifyProcessor');

const BRAND_ID = '00cd57b9-25e4-4f3c-8abb-69e50a691a3d'; // Flo Mattress
const SRC = '/Users/apple/Documents/Colonel-AWS/test files receivables';

const CHUNK = 500;

async function insertRows(sequelize, sourceFile, sheetName, rows, role) {
  await sequelize.query(
    `DELETE FROM receivable_cycle_imports WHERE brand_id = $1 AND source_file = $2`,
    { bind: [BRAND_ID, sourceFile] }
  );
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const placeholders = [];
    const bind = [];
    batch.forEach((row, idx) => {
      const base = bind.length;
      placeholders.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5}::json,$${base + 6})`);
      bind.push(BRAND_ID, sourceFile, sheetName, i + idx, JSON.stringify(row), role);
    });
    await sequelize.query(
      `INSERT INTO receivable_cycle_imports (brand_id, source_file, sheet_name, row_index, row_data, role)
       VALUES ${placeholders.join(',')}`,
      { bind }
    );
  }
  console.log(`[ingest] ${sourceFile} :: ${sheetName} -> ${rows.length} rows (role=${role})`);
}

async function main() {
  const sequelize = masterSequelize;

  // Sales Order Combined (285,742 rows x 139 cols) — project down to just the
  // order-number/status/dispatch-date bridge matchDeliveryStatus needs; the full row
  // is too large to round-trip through JSON.stringify/JSON column in one go and isn't
  // needed for anything else here.
  console.log('[ingest] parsing Sales Order Combined (this is a 174MB file, will take a bit)...');
  const soBuf = fs.readFileSync(`${SRC}/1. Sales Order combined Fy 24-25.xlsx`);
  const soRowsRaw = await parseExcelBuffer(soBuf, 'Sales Order Combined');
  const soRows = soRowsRaw.map((r) => ({
    'Order No': r['Display Order Code'],
    'Fulfillment Status': r['Sale Order Item Status'],
    'Dispatch Date': r['Dispatch Date'],
  }));
  await insertRows(sequelize, '1. Sales Order combined Fy 24-25.xlsx', 'Sheet1', soRows, 'so_status');

  console.log('[ingest] parsing Snapmint...');
  const snapBuf = fs.readFileSync(`${SRC}/prepaid/Combine MSDR Snapmint FY 24-25.xlsx`);
  const snapRows = await parseExcelBuffer(snapBuf, 'Snapmint');
  await insertRows(sequelize, 'Combine MSDR Snapmint FY 24-25.xlsx', 'Working', snapRows, 'snapmint');

  console.log('[ingest] parsing Razorpay...');
  const rzpBuf = fs.readFileSync(`${SRC}/prepaid/Razorpay 24-25 Combined Report.xlsx`);
  const rzpRows = await parseExcelBuffer(rzpBuf, 'Razorpay');
  await insertRows(sequelize, 'Razorpay 24-25 Combined Report.xlsx', 'Sheet1', rzpRows, 'razorpay');

  console.log('[ingest] DONE.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[ingest] FAILED', err);
  process.exit(1);
});
