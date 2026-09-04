'use strict';

const XLSX = require('xlsx-js-style');
const { GST_STATE_CODES, getStateCodeFromName, getStateAbbr } = require('../../../utils/gstStateCodes');
const { createMissingMasterTracker } = require('../../../utils/missingMasterTracker');

// ────────────────────────────────────────────────────────────────────────────
// Meesho sales working
//
// Meesho gives the accountant TWO monthly TCS extracts (one sheet each, the
// sheet named after the supplier id):
//   • tcs_sales        — forward shipments
//   • tcs_sales_return — cancellations / customer returns
//
// The "working" sheet is the two files stacked on top of each other, matched
// by header. Every row carries a `file` column with the source file's name.
// On the return rows the money/qty columns are flipped negative so the sheet
// nets down to the taxable turnover for the month.
//
// Per row we derive:
//   • `selling state` (first column) — the seller's state name from the GSTIN's
//     first two digits (07 -> Delhi) via the project's GST_STATE_CODES map.
//   • the GST split: gross = total_taxable_sale_value * gst_rate / 100.
//     selling state == end_customer_state_new  -> CGST = SGST = gross / 2 (IGST 0)
//     otherwise                                -> IGST = gross (CGST/SGST 0)
//   • Party Name + Invoice No. from the Ledger master, keyed on the customer's
//     delivery state. Invoice No. = ledger "Invoice No." + "-<month number>".
//
// "With inventory" adds ONE extra column — FG — right after `identifier`
// (the Meesho portal SKU), looked up from the SKU master. Everything else
// (working columns, GSTR B2C, GSTR HSN) is identical between the two modes.
// A missing SKU-master entry is tracked and surfaced to the caller.
//
// Two summary sheets are emitted alongside the working — "GSTR B2C"
// (selling state × rate × state) and "GSTR HSN" (selling state × hsn × rate) —
// each led by the seller's `selling state` and closed with a Grand Total.
// ────────────────────────────────────────────────────────────────────────────

// Columns whose sign is flipped for return rows. `taxable_shipping` is left as
// the source reports it (Meesho already signs it), matching the sample working.
const NEGATE_ON_RETURN = [
  'quantity',
  'total_taxable_sale_value',
  'tax_amount',
  'total_invoice_value',
];

const FG_COL = 'FG';
const FILE_COL = 'file';
const SELLING_STATE_COL = 'selling state';
const LEDGER_COLS = ['Party Name', 'Invoice No.'];
const FINAL_COLS = ['Final IGST Amount', 'Final CGST Amount', 'Final SGST Amount'];

const num = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
};

// "tcs_sales Jul-26.xlsx" -> "tcs_sales Jul-26"
const stripExt = (name) => String(name || '').replace(/\.[^.]+$/, '').trim();

const normKey = (v) => String(v ?? '').replace(/["']/g, '').trim().toLowerCase();
const normState = (s) => String(s ?? '').trim().toLowerCase();

const sellerStateCode = (gstin) => String(gstin || '').trim().slice(0, 2);

// GSTIN first two digits -> state name, e.g. "07AAH…" -> "Delhi".
const sellerStateName = (gstin) => GST_STATE_CODES[sellerStateCode(gstin)] || '';

// Unpadded 1-12 month number from the controller's `date` ("July-2026" or "7-2026").
function monthNumber(date) {
  const part = String(date || '').split('-')[0].trim();
  const names = ['january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'];
  const byName = names.indexOf(part.toLowerCase());
  if (byName !== -1) return String(byName + 1);
  const n = parseInt(part, 10);
  return n >= 1 && n <= 12 ? String(n) : '';
}

// SKU master: Meesho portal SKU (the raw `identifier`) -> Tally FG.
function buildSkuMap(skuJson) {
  const map = {};
  (skuJson || []).forEach((item) => {
    const key = normKey(
      item['Sales portal SKU'] || item['Sales Portal SKU'] || item['sales portal sku'] ||
      item['salesPortalSku'] || item['SKU'] || item['sku'] ||
      item['Identifier'] || item['identifier'],
    );
    if (!key) return;
    const fg = item['Tally new SKU'] || item['Tally New SKU'] || item['Tally SKU'] ||
      item['FG'] || item['fg'] || item['tallyNewSku'] || '';
    map[key] = String(fg).trim();
  });
  return map;
}

// Ledger master: customer delivery state -> { ledger, invoiceNo }.
function buildLedgerMap(ledgerJson) {
  const map = {};
  (ledgerJson || []).forEach((item) => {
    const st = normState(item['States'] || item['State'] || item['states'] || item['state']);
    if (!st) return;
    map[st] = {
      ledger: item['Ledger'] || item['ledger'] || item['Party Name'] || item['party name'] || '',
      invoiceNo:
        item['Invoice No.'] || item['Invoice No'] || item['invoice no.'] ||
        item['invoice_no'] || item['Invoice Number'] || '',
    };
  });
  return map;
}

// gross = total_taxable_sale_value * gst_rate / 100 (already signed by the
// return-row negation). Intra-state when the seller's state matches the
// customer's delivery state — compared by name, with a GST-code fallback so
// spelling variants (CHATTISGARH / Chhattisgarh, PONDICHERRY / Puducherry…)
// still resolve.
function splitTax(row) {
  const gross = num(row['total_taxable_sale_value']) * num(row['gst_rate']) / 100;
  const sellCode = sellerStateCode(row['gstin']);
  const custState = row['end_customer_state_new'];
  const sameState =
    (normState(row[SELLING_STATE_COL]) && normState(row[SELLING_STATE_COL]) === normState(custState)) ||
    (sellCode && getStateCodeFromName(custState) === sellCode);
  if (sameState) {
    const half = gross / 2;
    return { 'Final IGST Amount': 0, 'Final CGST Amount': half, 'Final SGST Amount': half };
  }
  return { 'Final IGST Amount': gross, 'Final CGST Amount': 0, 'Final SGST Amount': 0 };
}

// Column order Meesho emits (sales file first, then any return-only column such
// as `cancel_return_date`), with FG spliced in after `identifier` when the run
// is "with inventory", then the appended file / ledger / Final GST columns.
function buildHeaderOrder(salesRows, returnRows, withInventory) {
  const base = [];
  const seen = new Set();
  const add = (k) => { if (!seen.has(k)) { seen.add(k); base.push(k); } };
  (salesRows[0] ? Object.keys(salesRows[0]) : []).forEach(add);
  (returnRows[0] ? Object.keys(returnRows[0]) : []).forEach(add);

  const order = [];
  base.forEach((k) => {
    order.push(k);
    if (withInventory && k === 'identifier') order.push(FG_COL);
  });
  if (withInventory && !order.includes(FG_COL)) order.push(FG_COL);
  // `selling state` leads the sheet; header is row 1 (no totals row above it).
  return [SELLING_STATE_COL, ...order, FILE_COL, ...LEDGER_COLS, ...FINAL_COLS];
}

function buildWorkingSheet(rows, headerOrder) {
  const body = rows.map((r) => headerOrder.map((h) => (h in r ? r[h] : '')));
  return XLSX.utils.aoa_to_sheet([headerOrder, ...body]);
}

// ────────────────────────────────────────────────────────────────────────────
// X2beta sheet — the same 108-column Tally "X2Beta" e-invoice import template
// the Flipkart processor emits, built the "without inventory" way: a ledger-
// only voucher import with Stock Item / Qty / Rate / Unit blanked, Party Ledger
// from the Ledger master ("Party Name"), Vch/Ref No. from the ledger "Invoice
// No.", and rows sharing a voucher grouped (Amount* + every dynamic Output
// IGST/CGST/SGST column summed across the group).
// ────────────────────────────────────────────────────────────────────────────
function sellerStateAbbr(gstin) {
  const code = sellerStateCode(gstin);
  return getStateAbbr(code) || code;
}

function buildX2betaSheet(working, date) {
  let vchDate;
  if (date) {
    const d = new Date(date);
    if (!Number.isNaN(d.getTime())) vchDate = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  }
  if (!vchDate) vchDate = new Date();

  const amt = (r) => num(r['total_taxable_sale_value']);
  const rateOf = (r) => num(r['gst_rate']);
  const abbrOf = (r) => sellerStateAbbr(r['gstin']);

  const uniqueRates = [...new Set(working.map(rateOf))].filter((r) => r > 0);
  const stateCodes = [...new Set(working.map(abbrOf))].filter(Boolean).sort();

  const columns = [
    { header: 'Vch. Date* ', get: () => vchDate },
    { header: 'Vch. Type*', get: (r) => `${amt(r) < 0 ? 'CN-' : ''}Sales-${abbrOf(r) || ''}` },
    { header: 'Vch. No.*', get: (r) => `${amt(r) < 0 ? 'CN-' : ''}${r['Invoice No.'] || ''}` },
    { header: 'Ref. No.', get: (r) => r['Invoice No.'] || '' },
    { header: 'Ref. Date', get: () => vchDate },
    { header: 'Is CN?', get: (r) => (amt(r) < 0 ? 'Yes' : null) },
    { header: 'Is Vch?', get: () => null },
    { header: 'Party Ledger*', get: (r) => r['Party Name'] || '' },
    { header: 'Sales Ledger*', get: (r) => `Sales Meesho-${abbrOf(r) || ''} ${rateOf(r)}%` },
    { header: 'Stock Item', get: () => null },
    { header: 'Description', get: () => null },
    { header: 'Godown', get: (r) => r[SELLING_STATE_COL] || '' },
    { header: 'Quantity', get: () => 0 },
    { header: 'Rate', get: () => 0 },
    { header: 'Unit', get: () => null },
    { header: 'Discount', get: () => null },
    { header: 'Amount*', get: (r) => amt(r) },
    { header: 'Discount', get: () => null },
  ];

  uniqueRates.forEach((rate) => {
    const halfRate = Math.round((rate / 2) * 100) / 100;
    stateCodes.forEach((sc) => {
      columns.push({
        header: `Output IGST ${rate}%-${sc}`,
        get: (row) => (rateOf(row) === rate && abbrOf(row) === sc ? num(row['Final IGST Amount']) : 0),
      });
      columns.push({
        header: `Output CGST ${halfRate}%-${sc}`,
        get: (row) => (rateOf(row) === rate && abbrOf(row) === sc ? num(row['Final CGST Amount']) : 0),
      });
      columns.push({
        header: `Output SGST ${halfRate}%-${sc}`,
        get: (row) => (rateOf(row) === rate && abbrOf(row) === sc ? num(row['Final SGST Amount']) : 0),
      });
    });
  });

  columns.push(
    { header: null, get: () => null },
    { header: null, get: () => null },
    { header: 'Narration', get: () => `Meesho-${date || ''}` },
    { header: 'Taxability', get: () => null },
    { header: 'GST Nature', get: () => null },
    { header: 'GST Rate', get: (r) => rateOf(r) },
    { header: 'Cess', get: () => null },
    { header: 'RCM?', get: () => null },
    { header: 'HSN', get: () => null },
    { header: 'HSN Desc', get: () => null },
    { header: 'Supply Type', get: () => null },
    { header: 'Cost Category', get: () => null },
    { header: 'Cost Centre', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: (r) => r['end_customer_state_new'] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
    { header: 'Place of Supply', get: (r) => r['end_customer_state_new'] || '' }, { header: 'GST Type', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: (r) => r['end_customer_state_new'] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
    { header: 'Place', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: (r) => r['end_customer_state_new'] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
    { header: 'Place', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'DN No.', get: () => null }, { header: 'DN Date', get: () => null }, { header: 'Doc. No.', get: () => null },
    { header: 'Dis. Through', get: () => null }, { header: 'Destination', get: () => null }, { header: 'Carrier Name', get: () => null },
    { header: 'LR No.', get: () => null }, { header: 'LR Date', get: () => null }, { header: 'Order No.', get: () => null },
    { header: 'Order Date', get: () => null }, { header: 'Term of Delivery', get: () => null }, { header: 'Terms of Paymemt', get: () => null },
    { header: 'Other Ref.', get: () => null }, { header: 'Place of Receipt', get: () => null }, { header: 'Vessel/Flight No.', get: () => null },
    { header: 'Port of Loading', get: () => null }, { header: 'Port of Discharge', get: () => null }, { header: 'Country to', get: () => null },
    { header: 'Shipping Bill No.', get: () => null }, { header: 'Date', get: () => null }, { header: 'Port Code', get: () => null },
    { header: 'e-Way Bill No', get: () => null }, { header: 'Date', get: () => null }, { header: 'Cons. e-Way Bill No.', get: () => null },
    { header: 'Date', get: () => null }, { header: 'Sub Type', get: () => null }, { header: 'Doc. Type', get: () => null },
    { header: 'Distance (KM)', get: () => null }, { header: 'Transporter Name', get: () => null }, { header: 'Transporter ID', get: () => null },
    { header: 'Transport Mode', get: () => null }, { header: 'Doc No.', get: () => null }, { header: 'Date', get: () => null },
    { header: 'Vehicle No.', get: () => null }, { header: 'Vehicle Type', get: () => null }, { header: 'Status', get: () => null },
    { header: 'Note Reason', get: () => null }, { header: 'Orig. Inv. No.', get: () => null }, { header: 'Orig. Inv. Date', get: () => null },
  );

  const headers = columns.map((c) => c.header);
  const rawRows = working.map((row) => columns.map((c) => c.get(row)));

  const groupByHeaders = [
    'Vch. Date* ', 'Vch. Type*', 'Vch. No.*', 'Ref. No.', 'Ref. Date',
    'Is CN?', 'Is Vch?', 'Party Ledger*', 'Sales Ledger*', 'Stock Item',
    'Description', 'Godown',
  ];
  const groupByIdx = groupByHeaders.map((h) => headers.indexOf(h));
  const sumIdx = columns
    .map((c, i) => ({ header: c.header, i }))
    .filter(({ header }) => header === 'Amount*' || (typeof header === 'string' && header.startsWith('Output ')))
    .map(({ i }) => i);

  const grouped = new Map();
  for (const rowArr of rawRows) {
    const key = groupByIdx.map((i) => rowArr[i]).join('|');
    if (!grouped.has(key)) {
      grouped.set(key, [...rowArr]);
    } else {
      const existing = grouped.get(key);
      sumIdx.forEach((i) => { existing[i] = num(existing[i]) + num(rowArr[i]); });
    }
  }

  return XLSX.utils.aoa_to_sheet([headers, ...grouped.values()]);
}

// Generic "group by keys, sum measures, append Grand Total" summary builder.
function buildSummarySheet(rows, keyCols, measureCols) {
  const map = new Map();
  rows.forEach((r) => {
    const keyVals = keyCols.map((k) => (k === 'gst_rate' ? num(r[k]) : (r[k] ?? '')));
    const key = keyVals.join('|');
    if (!map.has(key)) {
      const seed = {};
      keyCols.forEach((k, i) => { seed[k] = keyVals[i]; });
      measureCols.forEach((m) => { seed[`Sum of ${m}`] = 0; });
      map.set(key, seed);
    }
    const acc = map.get(key);
    measureCols.forEach((m) => { acc[`Sum of ${m}`] += num(r[m]); });
  });

  const out = [...map.values()].sort((a, b) => {
    for (const k of keyCols) {
      const av = a[k], bv = b[k];
      if (typeof av === 'number' && typeof bv === 'number') {
        if (av !== bv) return av - bv;
      } else {
        const cmp = String(av).localeCompare(String(bv));
        if (cmp) return cmp;
      }
    }
    return 0;
  });
  const grand = { [keyCols[0]]: 'Grand Total' };
  keyCols.slice(1).forEach((k) => { grand[k] = ''; });
  measureCols.forEach((m) => {
    grand[`Sum of ${m}`] = out.reduce((a, r) => a + num(r[`Sum of ${m}`]), 0);
  });
  out.push(grand);
  return XLSX.utils.json_to_sheet(out);
}

/**
 * @param {Array<Object>} salesJson  parsed rows of the tcs_sales file
 * @param {Array<Object>} returnJson parsed rows of the tcs_sales_return file
 * @param {Object} opts
 *   salesFileName, returnFileName — source names for the `file` column
 *   withInventory  — true adds the FG column from the SKU master
 *   skuJson        — SKU master rows (identifier -> FG)
 *   ledgerJson     — Ledger master rows (state -> Ledger / Invoice No.)
 *   date           — "Month-YYYY", drives the "-<month number>" invoice suffix
 */
function meeshoProcessor(salesJson = [], returnJson = [], opts = {}) {
  const {
    salesFileName = 'tcs_sales',
    returnFileName = 'tcs_sales_return',
    withInventory = true,
    skuJson = [],
    ledgerJson = [],
    date = '',
  } = opts;

  const salesRows = (salesJson || []).filter((r) => r && Object.keys(r).length);
  const returnRows = (returnJson || []).filter((r) => r && Object.keys(r).length);

  const headerOrder = buildHeaderOrder(salesRows, returnRows, withInventory);
  const skuMap = buildSkuMap(skuJson);
  const ledgerMap = buildLedgerMap(ledgerJson);
  const mm = monthNumber(date);
  const missing = createMissingMasterTracker();

  const normaliseRow = (raw, sourceName, isReturn) => {
    const row = { ...raw };
    if (isReturn) NEGATE_ON_RETURN.forEach((c) => { row[c] = -Math.abs(num(row[c])); });

    row[SELLING_STATE_COL] = sellerStateName(row['gstin']);
    row[FILE_COL] = stripExt(sourceName);

    if (withInventory) {
      const id = normKey(row['identifier']);
      const fg = id ? skuMap[id] : '';
      if (id && !fg) missing.track({ masterType: 'sku', matchField: 'identifier', value: row['identifier'] });
      row[FG_COL] = fg || '';
    }

    const cfg = ledgerMap[normState(row['end_customer_state_new'])] || {};
    row['Party Name'] = cfg.ledger || '';
    row['Invoice No.'] = cfg.invoiceNo ? `${cfg.invoiceNo}${mm ? `-${mm}` : ''}` : '';

    Object.assign(row, splitTax(row));
    return row;
  };

  const working = [
    ...salesRows.map((r) => normaliseRow(r, salesFileName, false)),
    ...returnRows.map((r) => normaliseRow(r, returnFileName, true)),
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildWorkingSheet(working, headerOrder), 'working');

  const gstrB2C = buildSummarySheet(
    working,
    [SELLING_STATE_COL, 'gst_rate', 'end_customer_state_new'],
    ['total_taxable_sale_value', 'Final IGST Amount', 'Final SGST Amount', 'Final CGST Amount'],
  );
  XLSX.utils.book_append_sheet(wb, gstrB2C, 'GSTR B2C');

  const gstrHSN = buildSummarySheet(
    working,
    [SELLING_STATE_COL, 'hsn_code', 'gst_rate'],
    ['quantity', 'total_taxable_sale_value', 'Final IGST Amount', 'Final SGST Amount', 'Final CGST Amount'],
  );
  XLSX.utils.book_append_sheet(wb, gstrHSN, 'GSTR HSN');

  XLSX.utils.book_append_sheet(wb, buildX2betaSheet(working, date), 'X2beta');

  const summarise = (rows) => {
    let quantity = 0, taxableValue = 0, igst = 0, cgst = 0, sgst = 0;
    rows.forEach((r) => {
      quantity += num(r['quantity']);
      taxableValue += num(r['total_taxable_sale_value']);
      igst += num(r['Final IGST Amount']);
      cgst += num(r['Final CGST Amount']);
      sgst += num(r['Final SGST Amount']);
    });
    return {
      rows: rows.length,
      quantity: Math.round(quantity),
      taxableValue: Number(taxableValue.toFixed(2)),
      igst: Number(igst.toFixed(2)),
      cgst: Number(cgst.toFixed(2)),
      sgst: Number(sgst.toFixed(2)),
    };
  };

  return {
    outputWorkbook: wb,
    processedData: working,
    headerOrder,
    withInventory,
    summary: {
      sales: summarise(working.filter((r) => r[FILE_COL] === stripExt(salesFileName))),
      returns: summarise(working.filter((r) => r[FILE_COL] === stripExt(returnFileName))),
      net: summarise(working),
    },
    missingMasterValues: missing.list(),
  };
}

module.exports = { meeshoProcessor };
