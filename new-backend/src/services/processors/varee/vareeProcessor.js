/**
 * Vaaree (Vaaree Home / Vaaree Seller Portal) GST sales report processing.
 * Follows the accountant's SOP (test files receivables/Varee/Vaaree_Sales_Report_SOP.pdf):
 *   1. Source is the monthly "GSTR Report" CSV/Excel download from the Vaaree Seller Portal
 *      (Menu -> Payments -> GSTR Report), one flat sheet.
 *   2. Final Taxable Value = Taxable value of goods + Taxable value of COD charges.
 *   3. Final Tax = GST on goods + GST on COD.
 *   4. Order Status "Open" = Sales; every other status (RTO, Returned, AWB Cancelled, ...) = Returns.
 *   5. Customer GST No. present = B2B; blank = B2C.
 *   6. Customer State = Delivery State; GST Rate column (its absolute value) = Tax Rate.
 *   7. IGST/CGST/SGST split on Customer State vs Seller State (same GSTIN state supplies
 *      CGST+SGST, cross-state supplies IGST) — computed for every row regardless of status,
 *      matching the accountant's reference working file (returns carry the split too, just
 *      with the row's own negative sign).
 *   8. HSN Summary uses the HSN Code column; Taxable Value/Tax Rate/IGST/CGST/SGST carry over
 *      from the GST Sales Report — combining Sales + Returns (own sign) and every Seller State,
 *      matching the accountant's reference working file.
 * Seller State represents a distinct GSTIN registration for the brand (Vaaree ships out of more
 * than one warehouse state) — the GST Sales and B2B Sales summaries are grouped by it rather than
 * assuming a single state, so the workbook stays correct if the brand adds/drops a registration.
 * (HSN Summary is the one exception — it is not split by Seller State, per the reference file.)
 */
'use strict';
const XLSX = require('xlsx-js-style');

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const s = String(v).trim().replace(/,/g, '');
  if (s === '' || s === '-') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function clean(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

// Vaaree report dates are "DD/MM/YY" or "DD/MM/YY HH:MM" strings — but SheetJS's CSV
// reader inconsistently auto-detects some of these cells as Excel date serials (numbers)
// while leaving others as plain strings, so both shapes have to be handled here.
// Dates are built from LOCAL Date components (not Date.UTC): SheetJS's own serial-number
// writer re-applies the process's timezone offset when a Date object is written back into
// a workbook, so constructing with local getters is what makes the round-trip (read this
// input -> write the output workbook) land on the same wall-clock Y/M/D/H/M regardless of
// the server's timezone.
function excelSerialToLocalDate(serial) {
  const utcMs = Date.UTC(1899, 11, 30) + serial * 86400000;
  const d = new Date(utcMs);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

function parseVareeDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') return excelSerialToLocalDate(v);
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!m) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const [, dd, mm, yyRaw, hh, min] = m;
  const year = yyRaw.length === 2 ? 2000 + Number(yyRaw) : Number(yyRaw);
  return new Date(year, Number(mm) - 1, Number(dd), hh ? Number(hh) : 0, min ? Number(min) : 0);
}

function statesMatch(a, b) {
  return clean(a).toLowerCase() === clean(b).toLowerCase();
}

const RAW_COLUMNS = [
  'Payment Cycle', 'Order Date', 'Order Number', 'Customer Name', 'Customer State',
  'Invoice Number', 'Order Status', 'SKU', 'Taxable value of goods', 'GST on goods',
  'GST Rate', 'Taxable value of COD charges', 'GST on COD', 'Total Invoice Value',
];
const RAW_TAIL_COLUMNS = [
  'TDS', 'TCS', 'Customer GST No.', 'Fulfilled By', 'Seller State', 'Invoice Date', 'HSN Code',
];

function buildRows(rawJson) {
  return rawJson.map((raw) => {
    const r = raw;

    const taxableGoods = num(r['Taxable value of goods']);
    const gstOnGoods = num(r['GST on goods']);
    const gstRate = num(r['GST Rate']);
    const taxableCod = num(r['Taxable value of COD charges']);
    const gstOnCod = num(r['GST on COD']);

    const finalRate = Math.abs(gstRate);
    const finalTaxable = taxableGoods + taxableCod;
    const finalTax = gstOnGoods + gstOnCod;

    const customerState = clean(r['Customer State']);
    const sellerState = clean(r['Seller State']);
    const sameState = statesMatch(customerState, sellerState);

    const igst = sameState ? 0 : finalTax;
    const cgst = sameState ? finalTax / 2 : 0;
    const sgst = sameState ? finalTax / 2 : 0;

    const orderStatus = clean(r['Order Status']);
    const transactionType = orderStatus.toLowerCase() === 'open' ? 'Sales' : 'Returns';
    const customerGstNo = clean(r['Customer GST No.']);
    const saleType = customerGstNo ? 'B2B' : 'B2C';

    return {
      raw: r,
      orderDate: parseVareeDate(r['Order Date']),
      invoiceDate: parseVareeDate(r['Invoice Date']),
      orderNumber: clean(r['Order Number']),
      customerName: clean(r['Customer Name']),
      customerState,
      invoiceNumber: clean(r['Invoice Number']),
      orderStatus,
      sku: clean(r['SKU']),
      taxableGoods,
      gstOnGoods,
      gstRate,
      taxableCod,
      gstOnCod,
      totalInvoiceValue: num(r['Total Invoice Value']),
      finalRate,
      finalTaxable,
      igst,
      cgst,
      sgst,
      quantity: 1,
      tds: num(r['TDS']),
      tcs: num(r['TCS']),
      customerGstNo,
      fulfilledBy: clean(r['Fulfilled By']),
      sellerState,
      hsnCode: clean(r['HSN Code']),
      transactionType,
      saleType,
    };
  });
}

const REPORT_COLUMNS = [
  ...RAW_COLUMNS.map((header) => ({ header, get: (row) => row.raw[header] })),
  { header: 'Final Rate', get: (row) => row.finalRate },
  { header: 'Fianl Taxable', get: (row) => row.finalTaxable },
  { header: 'IGST ', get: (row) => row.igst },
  { header: 'CGST', get: (row) => row.cgst },
  { header: 'SGST', get: (row) => row.sgst },
  { header: 'Quantity', get: (row) => row.quantity },
  ...RAW_TAIL_COLUMNS.map((header) => ({
    header,
    get: (row) => (header === 'Invoice Date' ? row.invoiceDate : header === 'Order Date' ? row.orderDate : row.raw[header]),
  })),
];
// Order Date needs the parsed value too — override its getter in RAW_COLUMNS mapping above.
REPORT_COLUMNS[1] = { header: 'Order Date', get: (row) => row.orderDate };

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ── GST Sales (B2C) summary: Seller State x Customer State x Tax Rate, Sales-only, B2C-only ──
function buildB2CSummary(rows) {
  const sales = rows.filter((r) => r.transactionType === 'Sales' && r.saleType === 'B2C');
  const groups = new Map();
  sales.forEach((r) => {
    const key = `${r.sellerState}||${r.customerState}||${r.finalRate}`;
    if (!groups.has(key)) {
      groups.set(key, {
        sellerState: r.sellerState, customerState: r.customerState, finalRate: r.finalRate,
        taxable: 0, igst: 0, cgst: 0, sgst: 0,
      });
    }
    const g = groups.get(key);
    g.taxable += r.finalTaxable; g.igst += r.igst; g.cgst += r.cgst; g.sgst += r.sgst;
  });
  const list = [...groups.values()].sort((a, b) =>
    a.sellerState.localeCompare(b.sellerState) || a.customerState.localeCompare(b.customerState) || a.finalRate - b.finalRate
  );
  const headers = ['Seller State', 'Customer State', 'Final Rate', 'Sum of Fianl Taxable', 'Sum of IGST ', 'Sum of CGST', 'Sum of SGST'];
  const aoa = [headers, ...list.map((g) => [g.sellerState, g.customerState, g.finalRate, round2(g.taxable), round2(g.igst), round2(g.cgst), round2(g.sgst)])];
  if (list.length) {
    const totals = list.reduce((acc, g) => ({
      taxable: acc.taxable + g.taxable, igst: acc.igst + g.igst, cgst: acc.cgst + g.cgst, sgst: acc.sgst + g.sgst,
    }), { taxable: 0, igst: 0, cgst: 0, sgst: 0 });
    aoa.push(['Grand Total', '', '', round2(totals.taxable), round2(totals.igst), round2(totals.cgst), round2(totals.sgst)]);
  }
  return XLSX.utils.aoa_to_sheet(aoa);
}

// ── GST B2B Sales: invoice-level list, Sales-only, B2B-only ──
function buildB2BSales(rows) {
  const sales = rows
    .filter((r) => r.transactionType === 'Sales' && r.saleType === 'B2B')
    .sort((a, b) => a.sellerState.localeCompare(b.sellerState) || a.invoiceNumber.localeCompare(b.invoiceNumber));
  const headers = ['Seller State', 'Invoice Number', 'Invoice Date', 'Customer State', 'Customer GST No.', 'Final Rate', 'Fianl Taxable', 'IGST ', 'CGST', 'SGST'];
  const aoa = [headers, ...sales.map((r) => [
    r.sellerState, r.invoiceNumber, r.invoiceDate, r.customerState, r.customerGstNo,
    r.finalRate, round2(r.finalTaxable), round2(r.igst), round2(r.cgst), round2(r.sgst),
  ])];
  if (sales.length) {
    const totals = sales.reduce((acc, r) => ({
      taxable: acc.taxable + r.finalTaxable, igst: acc.igst + r.igst, cgst: acc.cgst + r.cgst, sgst: acc.sgst + r.sgst,
    }), { taxable: 0, igst: 0, cgst: 0, sgst: 0 });
    aoa.push(['Grand Total', '', '', '', '', '', round2(totals.taxable), round2(totals.igst), round2(totals.cgst), round2(totals.sgst)]);
  }
  return XLSX.utils.aoa_to_sheet(aoa);
}

// ── HSN Summary: HSN Code x Tax Rate, Sales + Returns combined (matches the accountant's
// reference working file — returns keep their own negative sign, not netted out or dropped;
// unlike GST Sales/B2B Sales this is not split by Seller State, and the rate column carries
// the raw signed GST Rate rather than the absolute Final Rate) ──
function buildHsnSummary(rows) {
  const groups = new Map();
  rows.forEach((r) => {
    const key = `${r.hsnCode}||${r.gstRate}`;
    if (!groups.has(key)) {
      groups.set(key, {
        hsnCode: r.hsnCode, gstRate: r.gstRate,
        qty: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0,
      });
    }
    const g = groups.get(key);
    g.qty += r.quantity; g.taxable += r.finalTaxable; g.igst += r.igst; g.cgst += r.cgst; g.sgst += r.sgst;
  });
  const list = [...groups.values()].sort((a, b) =>
    a.hsnCode.localeCompare(b.hsnCode) || a.gstRate - b.gstRate
  );
  const headers = ['HSN Code', 'GST Rate', 'Sum of Quantity', 'Sum of Fianl Taxable', 'Sum of IGST ', 'Sum of CGST', 'Sum of SGST'];
  const aoa = [headers, ...list.map((g) => [g.hsnCode, g.gstRate, g.qty, round2(g.taxable), round2(g.igst), round2(g.cgst), round2(g.sgst)])];
  if (list.length) {
    const totals = list.reduce((acc, g) => ({
      qty: acc.qty + g.qty, taxable: acc.taxable + g.taxable, igst: acc.igst + g.igst, cgst: acc.cgst + g.cgst, sgst: acc.sgst + g.sgst,
    }), { qty: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 });
    aoa.push(['Grand Total', '', totals.qty, round2(totals.taxable), round2(totals.igst), round2(totals.cgst), round2(totals.sgst)]);
  }
  return XLSX.utils.aoa_to_sheet(aoa);
}

function buildReportSheet(rows) {
  const headers = REPORT_COLUMNS.map((c) => c.header);
  const aoa = [headers, ...rows.map((row) => REPORT_COLUMNS.map((c) => c.get(row)))];
  return XLSX.utils.aoa_to_sheet(aoa);
}

async function vareeProcessor(rawJson, brandName, date) {
  const rows = buildRows(rawJson);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildB2CSummary(rows), 'GST Sales');
  XLSX.utils.book_append_sheet(wb, buildB2BSales(rows), 'GST B2B Sales');
  XLSX.utils.book_append_sheet(wb, buildHsnSummary(rows), 'HSN');
  XLSX.utils.book_append_sheet(wb, buildReportSheet(rows), 'Report');

  return {
    outputWorkbook: wb,
    processedData: rows,
  };
}

module.exports = { vareeProcessor };
