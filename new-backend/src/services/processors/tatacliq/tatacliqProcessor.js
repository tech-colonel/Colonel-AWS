/**
 * Tata Cliq (Tata UniStore / TUL) B2C sales reconciliation.
 * Follows the accountant's SOP (test files receivables/tata cliq/sop.md):
 *   1. Source is the monthly TCS report (one flat sheet, 30 columns).
 *   2. SKU is looked up by Transaction ID against the OMS Sales Report, which the
 *      accountant uploads here as the "SKU master" (skuJson) — keyed by
 *      Transaction ID, not by SKU code like most other portals.
 *   3. Place Of Supply (a numeric GST state code) is resolved to its full state name.
 *   4. Taxable Value = Product value, Taxes = Product CGST/SGST/IGST (already split
 *      by Tata Cliq in the TCS report — no state-based CGST/SGST-vs-IGST logic
 *      needed here), Invoice Value = Gross Product value, Quantity is always 1.
 *   5. GST Rate = (CGST + SGST + IGST) / Taxable Value * 100.
 *   6. Positive Product value => Voucher Type "Sales"; negative => "Credit Note".
 */
const XLSX = require('xlsx-js-style');
const { GST_STATE_CODES, getStateAbbr } = require('../../../utils/gstStateCodes');

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const s = String(v).trim().replace(/,/g, '').replace(/₹/g, '');
  if (s === '' || s === '-') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function clean(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

// The TCS report ships 4 columns with stray leading spaces (' TCS CGST', '  TCS IGST', ...).
// Normalize once per row so lookups can use clean header names.
function normalizeRow(row) {
  const out = {};
  Object.keys(row).forEach((k) => { out[k.trim()] = row[k]; });
  return out;
}

function excelSerialToDate(n) {
  return new Date(Date.UTC(1899, 11, 30) + n * 86400000);
}

// TCS report dates are DD.MM.YYYY strings (not native Excel dates).
function parseReportDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return excelSerialToDate(v);
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function stateNameFromCode(code) {
  const padded = clean(code).padStart(2, '0');
  return GST_STATE_CODES[padded] || '';
}

// SKU master here = the OMS Sales Report the SOP says to VLOOKUP against, keyed by
// Transaction ID (the TCS report itself carries no SKU). Optional — rows are left
// blank on SKU/cost/description until this is uploaded.
function buildTxnMap(skuJson) {
  const map = {};
  (skuJson || []).forEach((r) => {
    const txnId = clean(r['Transaction ID'] ?? r['TransactionID'] ?? r['Transaction Id'] ?? r['Txn ID']);
    if (!txnId) return;
    map[txnId] = {
      sku: clean(r['SKU'] ?? r['Seller SKU'] ?? ''),
      stockName: clean(r['Stock name as per Tally'] ?? r['Product Description'] ?? r['Description'] ?? r['Product Name'] ?? ''),
      cost: num(r['COST'] ?? r['Cost'] ?? 0),
    };
  });
  return map;
}

const RAW_COLUMNS = [
  'Seller Code', 'Seller Name', 'Order Reference No.', 'Order ID', 'Transaction ID',
  'HSN Code', 'Fulfillment Type', 'Order Type', 'Order Tag', 'Slave ID',
  'Slave GSTIN', 'Slave State', 'Destination Code', 'Place Of Supply', 'Seller Invoice',
  'Order Date', 'Transaction Date', 'Product value', 'Product CGST', 'Product SGST',
  'Product IGST', 'Gross Product value', 'TCS CGST', 'TCS SGST', 'TCS IGST',
  'Total TCS', 'Clearing Document', 'Document Date', 'TUL GSTIN', 'Gstin Status',
];

function buildRows(rawJson, skuJson) {
  const txnMap = buildTxnMap(skuJson);

  return rawJson.map((raw) => {
    const r = normalizeRow(raw);

    const productValue = num(r['Product value']);
    const cgst = num(r['Product CGST']);
    const sgst = num(r['Product SGST']);
    const igst = num(r['Product IGST']);
    const totalTax = cgst + sgst + igst;
    const gstRate = productValue !== 0 ? Math.round((totalTax / productValue) * 100) : 0;

    const stateCode = clean(r['Place Of Supply']).padStart(2, '0');
    const stateName = stateNameFromCode(stateCode);
    const abbr = getStateAbbr(stateCode) || '';

    const isCreditNote = productValue < 0;
    const voucherType = isCreditNote ? 'Credit Note' : 'Sales';

    // Tata Cliq's Tally chart of accounts tags the base (5%) GST slab ledger "5"
    // and any other slab "5A" — a fixed accounting label, not the literal rate
    // (confirmed against the accountant's reference working file, where 18%-rate
    // rows still carry a "-5A" suffixed ledger code).
    const ledgerSuffix = Math.round(gstRate) === 5 ? '5' : '5A';
    const invoiceBase = abbr ? `TATA-${abbr}-${ledgerSuffix}` : '';
    const invoiceNumber = invoiceBase ? `${invoiceBase}${isCreditNote ? '-CN' : ''}` : '';
    const debtor = abbr ? `TATA Cliq-${abbr}` : '';
    const salesLedger = `TATA Cliq-Sales @${gstRate}%`;

    const txnId = clean(r['Transaction ID']);
    const skuInfo = txnMap[txnId] || {};

    return {
      raw: r,
      orderDate: parseReportDate(r['Order Date']),
      transactionDate: parseReportDate(r['Transaction Date']),
      documentDate: parseReportDate(r['Document Date']),
      gstRate,
      stateName,
      sku: skuInfo.sku || '',
      voucherType,
      isCN: isCreditNote ? 'Yes' : '',
      invoiceNumber,
      debtor,
      salesLedger,
      stockName: skuInfo.stockName || '',
      qty: 1,
      outputIGST: igst,
      outputCGST: cgst,
      outputSGST: sgst,
      cost: skuInfo.cost || 0,
      costQty: skuInfo.cost || 0,
      productValue,
      cgst,
      sgst,
      igst,
      grossValue: num(r['Gross Product value']),
    };
  });
}

// Parsed-date fields render as the parsed Date instead of the raw DD.MM.YYYY string.
const PARSED_DATE_GETTERS = {
  'Order Date': (row) => row.orderDate,
  'Transaction Date': (row) => row.transactionDate,
  'Document Date': (row) => row.documentDate,
};

const SALES_COLUMNS = [
  ...RAW_COLUMNS.map((header) => ({ header, get: PARSED_DATE_GETTERS[header] || ((row) => row.raw[header]) })),
  { header: 'GST Rate', get: (row) => row.gstRate },
  { header: 'State', get: (row) => row.stateName },
  { header: 'SKU', get: (row) => row.sku },
  { header: 'Voucher Type', get: (row) => row.voucherType },
  { header: 'Is CN?', get: (row) => row.isCN || null },
  { header: 'Invoice Number', get: (row) => row.invoiceNumber },
  { header: 'Debtor', get: (row) => row.debtor },
  { header: 'Sales Ledger', get: (row) => row.salesLedger },
  { header: 'Stock name as per Tally', get: (row) => row.stockName },
  { header: 'Qty', get: (row) => row.qty },
  { header: 'Output IGST', get: (row) => row.outputIGST },
  { header: 'Output CGST', get: (row) => row.outputCGST },
  { header: 'Output SGST', get: (row) => row.outputSGST },
  { header: 'COST', get: (row) => row.cost },
  { header: 'COST*Qty', get: (row) => row.costQty },
];

const TALLY_COLUMNS = [
  { header: 'Vch. Date*', get: (row) => row.transactionDate },
  { header: 'Vch. Type*', get: (row) => row.voucherType },
  { header: 'Vch. No.*', get: (row) => row.invoiceNumber },
  { header: 'Ref. No.', get: (row) => row.raw['Seller Invoice'] },
  { header: 'Ref. Date', get: (row) => row.transactionDate },
  { header: 'Is CN?', get: (row) => row.isCN || null },
  { header: 'Party Ledger*', get: (row) => row.debtor },
  { header: 'Sales Ledger*', get: (row) => row.salesLedger },
  { header: 'Stock Item', get: (row) => row.stockName || row.sku },
  { header: 'Godown', get: () => 'Main Location' },
  { header: 'Quantity', get: (row) => row.qty },
  { header: 'Rate', get: (row) => row.productValue },
  { header: 'Unit', get: () => 'Pcs' },
  { header: 'Amount*', get: (row) => row.productValue },
  { header: 'Output IGST', get: (row) => row.outputIGST },
  { header: 'Output CGST', get: (row) => row.outputCGST },
  { header: 'Output SGST', get: (row) => row.outputSGST },
  { header: 'Taxability', get: () => 'Taxable' },
  { header: 'Supply Type', get: () => 'Goods' },
  { header: 'State', get: (row) => row.stateName },
  { header: 'Country', get: () => 'India' },
  { header: 'Place of Supply', get: (row) => row.stateName },
  { header: 'GST Type', get: () => 'Unregistered/Consumer' },
  { header: 'GST Rate', get: (row) => row.gstRate },
  { header: 'HSN', get: (row) => row.raw['HSN Code'] },
  { header: 'Narration', get: (row, date) => `Tata Cliq-${date || ''}` },
];

function buildSheet(columns, rows, date) {
  const headers = columns.map((c) => c.header);
  const aoa = [headers, ...rows.map((row) => columns.map((c) => c.get(row, date)))];
  return XLSX.utils.aoa_to_sheet(aoa);
}

// Reference lookup sheet: per-state Tally ledger codes, generated from the shared
// GST state-code table rather than re-typed — keeps this dynamic across states.
function buildSourceSheet() {
  const headers = ['State', 'Abbr', 'Debtor', 'Invoice No. (Base 5%)', 'Invoice No. (Other slab)', 'Credit Note No. (Base 5%)', 'Credit Note No. (Other slab)'];
  const states = Object.entries(GST_STATE_CODES)
    .filter(([code]) => code !== '97' && code !== '99')
    .sort((a, b) => a[1].localeCompare(b[1]));

  const aoa = [headers, ...states.map(([code, name]) => {
    const abbr = getStateAbbr(code) || '';
    const base = `TATA-${abbr}-5`;
    const other = `TATA-${abbr}-5A`;
    return [name, abbr, `TATA Cliq-${abbr}`, base, other, `${base}-CN`, `${other}-CN`];
  })];
  return XLSX.utils.aoa_to_sheet(aoa);
}

async function tatacliqProcessor(rawJson, skuJson = [], brandName, date) {
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(wb, buildSourceSheet(), 'Source');

  const rows = buildRows(rawJson, skuJson);
  XLSX.utils.book_append_sheet(wb, buildSheet(SALES_COLUMNS, rows, date), 'Sales');
  XLSX.utils.book_append_sheet(wb, buildSheet(TALLY_COLUMNS, rows, date), 'Excel to tally');

  return {
    outputWorkbook: wb,
    processedData: rows,
  };
}

module.exports = { tatacliqProcessor };
