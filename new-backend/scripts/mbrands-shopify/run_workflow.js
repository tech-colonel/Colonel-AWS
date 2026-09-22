/**
 * Runs the "shopify mbrands" Workflow Manager workflow.json against the real
 * raw report + last month's template file, through the ACTUAL engine
 * (applyMultiSheetWorkflow) the app uses in production. Writes the generated
 * workbook, then independently re-derives the expected SUBTOTAL sums + QA
 * stats straight from the raw report (same approach test_build_sales_working.py
 * uses for the standalone script) and cross-checks them against what the
 * generated formula cells will resolve to in Excel — since the cells carry
 * live formulas, not precomputed values, this script evaluates the same
 * business logic independently rather than reading back a cached `v`.
 *
 * Usage: cd new-backend && node scripts/mbrands-shopify/run_workflow.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { applyMultiSheetWorkflow } = require('../../src/services/workflowEngine');

const DIR = __dirname;
const BASE = '/Users/apple/Documents/Colonel-AWS/test files receivables/shopify MBrands';
const RAW_REPORT = path.join(BASE, '2026 JULY REPORT.xlsx');
const TEMPLATE = path.join(BASE, 'Shopify Sales Working July 26.xlsx');
const OUT_PATH = path.join(DIR, 'output_generated.xlsx');

const workflow = JSON.parse(fs.readFileSync(path.join(DIR, 'workflow.json'), 'utf8'));

const rawBuf = fs.readFileSync(RAW_REPORT);
const tplBuf = fs.readFileSync(TEMPLATE);

const { buffer } = applyMultiSheetWorkflow(
  workflow.sheets,
  { raw_report: rawBuf, template: tplBuf },
  {},
  workflow.fileInputs,
  { month: 'July', year: 2026 }
);
fs.writeFileSync(OUT_PATH, buffer);
console.log(`Wrote ${OUT_PATH} (${buffer.length} bytes)`);

// ── Independent re-derivation, mirroring test_build_sales_working.py ──────────

const wbIn = XLSX.read(rawBuf, { type: 'buffer', cellDates: true, raw: false });
// The raw export's own headers carry stray trailing spaces ("Mrp ", "Delivery
// Status ", ...) — sheet_to_json uses them as object keys verbatim, so trim
// here the same way the engine's normalizeRow() does internally.
const rawRowsUntrimmed = XLSX.utils.sheet_to_json(wbIn.Sheets[wbIn.SheetNames[0]], { defval: '' });
const rawRows = rawRowsUntrimmed.map(r => {
  const out = {};
  for (const [k, v] of Object.entries(r)) out[k.trim()] = v;
  return out;
});

const wbTpl = XLSX.read(tplBuf, { type: 'buffer', cellDates: true, raw: false });
const sourceRows = XLSX.utils.sheet_to_json(wbTpl.Sheets['Source'], { defval: '' });
const stockRows = XLSX.utils.sheet_to_json(wbTpl.Sheets['Stock Master'], { defval: '' });

const norm = s => String(s ?? '').trim().toLowerCase();
const stateMap = new Map();
for (const r of sourceRows) {
  const state = r['State'];
  if (state) stateMap.set(norm(state), true);
}
const skuMap = new Map();
for (const r of stockRows) {
  const sku = r['Lineitem SKU'];
  if (sku) skuMap.set(norm(sku), true);
}

const EXPORT_STATES = new Set(['texas', 'new south wales']);
const DELIVERY_COUNTED = new Set(['delivered', 'in transit', 'pending']);

let nRows = 0;
const voucherTypeCounts = {};
const sums = { qty: 0, invoiceValue: 0, taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cost: 0, costQty: 0 };
let debtorLookupFail = 0;
const unmatchedSkus = new Map();

for (const row of rawRows) {
  nRows++;
  const price = parseFloat(row['Lineitem price'] || 0);
  const discount = parseFloat(row['Discount Amount'] || 0);
  const qty = parseFloat(row['Lineitem quantity'] || 0);
  const costPrice = parseFloat(row['Cost price'] || 0) || 0;
  const province = String(row['Shipping Province Name'] || '').trim();
  const deliveryStatus = norm(row['Delivery Status']);
  const sku = row['Lineitem sku'];

  const invoiceValue = price - discount;
  const gstRate = invoiceValue > 2500 ? 18 : 5;
  const taxableValue = invoiceValue / (gstRate + 100) * 100;

  sums.qty += qty;
  sums.invoiceValue += invoiceValue;
  sums.taxableValue += taxableValue;

  let voucherType = '';
  if (DELIVERY_COUNTED.has(deliveryStatus)) voucherType = taxableValue < 0 ? 'Credit Note' : 'Sales';
  voucherTypeCounts[voucherType || '(blank)'] = (voucherTypeCounts[voucherType || '(blank)'] || 0) + 1;
  if (voucherType === '') continue;

  const provinceN = norm(province);
  const isExport = EXPORT_STATES.has(provinceN);
  if (!isExport && !stateMap.has(provinceN)) debtorLookupFail++;

  const skuN = norm(sku);
  if (!skuMap.has(skuN)) unmatchedSkus.set(sku, (unmatchedSkus.get(sku) || 0) + 1);

  let igst = 0, cgst = 0, sgst = 0;
  if (isExport) { igst = cgst = sgst = 0; }
  else if (provinceN === 'maharashtra') { cgst = sgst = taxableValue * gstRate / 2 / 100; }
  else { igst = taxableValue * gstRate / 100; }

  const cost = voucherType === 'Credit Note' ? -costPrice : costPrice;
  const costQty = cost * qty;

  sums.igst += igst; sums.cgst += cgst; sums.sgst += sgst;
  sums.cost += cost; sums.costQty += costQty;
}

console.log(`\nRows processed: ${nRows}`);
console.log('Voucher Type breakdown:', voucherTypeCounts);
console.log('\nExpected SUBTOTAL sums (what row 1 formulas should resolve to in Excel):');
console.log(`  Lineitem quantity : ${sums.qty.toLocaleString()}`);
console.log(`  Invoice Value     : ${sums.invoiceValue.toFixed(2)}`);
console.log(`  Taxable Value     : ${sums.taxableValue.toFixed(2)}`);
console.log(`  Output IGST       : ${sums.igst.toFixed(2)}`);
console.log(`  Output CGST       : ${sums.cgst.toFixed(2)}`);
console.log(`  Output SGST       : ${sums.sgst.toFixed(2)}`);
console.log(`  Cost              : ${sums.cost.toFixed(2)}`);
console.log(`  Cost x Qty        : ${sums.costQty.toFixed(2)}`);
console.log(`\nDebtor VLOOKUP would fail on ${debtorLookupFail} counted rows`);
console.log(`Stock Name VLOOKUP would fail on ${[...unmatchedSkus.values()].reduce((a, b) => a + b, 0)} counted rows (${unmatchedSkus.size} distinct SKUs)`);

// ── Read back what the generated workbook actually wrote ──────────────────────

const wbOut = XLSX.read(buffer, { type: 'buffer', cellFormula: true });
console.log('\nGenerated sheets:', wbOut.SheetNames.join(', '));
const salesSheetName = wbOut.SheetNames.find(n => n.startsWith('Sales-'));
const salesWs = wbOut.Sheets[salesSheetName];
console.log(`\nSales sheet: "${salesSheetName}", range ${salesWs['!ref']}`);
console.log('Row 1 SUBTOTAL formulas:');
for (const addr of ['F1', 'X1', 'Z1', 'AI1', 'AJ1', 'AK1', 'AL1', 'AM1']) {
  if (salesWs[addr]) console.log(`  ${addr}: =${salesWs[addr].f}`);
}
console.log('\nSample row 3 formula cells:');
for (const addr of ['D3', 'X3', 'Y3', 'Z3', 'AC3', 'AD3', 'AE3', 'AF3', 'AJ3']) {
  if (salesWs[addr]) console.log(`  ${addr}: =${salesWs[addr].f}`);
}
