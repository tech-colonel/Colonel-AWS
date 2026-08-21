/**
 * Pepperfry GSTR-1 sales report processing.
 * Follows the accountant's SOP (test files receivables/Pepperfry/Pepperfry_Sales_Report_SOP_Colonel_Consultancy.pdf):
 *   1. Source is two CSVs downloaded from the Pepperfry Seller Portal (Reports -> GSTR1 Report):
 *      the GSTR-1 Sales report and the GSTR-1 Refunds report.
 *   2. Merge both into one working sheet, without duplicating refund invoices that already
 *      exist in the sales report.
 *      - A sales row whose OrderID-SKU also appears in the refund file with a populated
 *        "Return Qty" (i.e. an actual return happened, not just a refund-report listing) is
 *        the SAME line item reported twice by the portal: keep the sales row but flip the sign
 *        of its money columns (Invoice Value, Invoiced Quantity, Taxable Value, IGST/CGST/SGST
 *        Amount) to record it as a credit, and drop the matching refund-file row so it isn't
 *        counted twice.
 *      - Every other refund-file row is a distinct line (not present in the sales file) and is
 *        appended as its own row, mapped into the sales column layout. Its money columns are
 *        negated the same way when "Return Qty" is populated; rows with a blank Return Qty are
 *        appended as-is (positive) since no return actually happened yet.
 *      - Fee/discount columns (Total Discount, Sale Price, TCS Amount, Commission Amount
 *        Charged) and rate/percentage columns are never negated — only the columns above.
 *   3. GSTIN of Recipient present -> B2B; "URD" or blank -> B2C (SOP section 6).
 *   4. Column mapping per SOP section 7: Ship To State -> Delivery State, Invoice Number ->
 *      Invoice No., Invoice Date -> Invoice Date, Total GST Rate -> Tax Rate, Taxable Value ->
 *      Taxable Value, IGST/CGST/SGST Amount -> IGST/CGST/SGST.
 *   5. B2B Sales sheet: Invoice No./Invoice Date/GSTIN of Recipient/Delivery State/Tax Rate,
 *      summed Taxable Value/IGST/CGST/SGST — sorted ascending by Invoice No. (numeric).
 *   6. B2C Sales sheet: Delivery State/Tax Rate, summed Taxable Value/IGST/CGST/SGST — sorted
 *      by Delivery State then Tax Rate.
 *   7. HSN Summary: HSN/SAC/Tax Rate, summed Quantity/Taxable Value/IGST/CGST/SGST (B2B+B2C
 *      combined) — sorted by HSN then Tax Rate.
 * All three summaries and the grouping/dedup logic were validated cell-for-cell against the
 * accountant's reference working file (test files receivables/Pepperfry/Pepperfry-Working-July.xlsx).
 *
 * The report layout is read dynamically from each file's own header row (first-occurrence
 * column index) rather than hardcoded positions — Pepperfry's export repeats some header names
 * (e.g. two "Taxable Value" columns, one before/after the credit-note adjustment), so a naive
 * object-keyed CSV parse would silently keep only the last, empty one.
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

function isBlank(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

// Same local-date round-trip rationale as vareeProcessor.js: build from local getters so
// SheetJS's serial-number writer lands on the same wall-clock value it read, regardless of
// the server's timezone.
function excelSerialToLocalDate(serial) {
  const utcMs = Date.UTC(1899, 11, 30) + serial * 86400000;
  const d = new Date(utcMs);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

// Pepperfry's two reports mix date formats across columns: "DD/MM/YYYY" (Invoice Date),
// "YYYY-MM-DD HH:MM:SS" (Remittance/Return Date) and "YYYY-MM-DD" (Commission/IRN Date).
function parseFlexibleDate(v) {
  if (isBlank(v)) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') return excelSerialToLocalDate(v);
  const s = String(v).trim();

  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, dd, mm, yyRaw, hh, min, sec] = m;
    const year = yyRaw.length === 2 ? 2000 + Number(yyRaw) : Number(yyRaw);
    return new Date(year, Number(mm) - 1, Number(dd), hh ? Number(hh) : 0, min ? Number(min) : 0, sec ? Number(sec) : 0);
  }

  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, yyyy, mm, dd, hh, min, sec] = m;
    return new Date(Number(yyyy), Number(mm) - 1, Number(dd), hh ? Number(hh) : 0, min ? Number(min) : 0, sec ? Number(sec) : 0);
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Money/quantity columns whose sign flips when a line item is being recorded as a return
// (credit). Everything else — rates, percentages, discounts, fees, TCS, commission — is
// copied through unchanged; see file header for why.
const NEGATE_COLUMNS = ['Invoice Value', 'Invoiced Quantity', 'Taxable Value', 'IGST Amount', 'CGST Amount', 'SGST/UTGST Amount'];

// Columns that should round-trip as JS Date objects (rather than raw strings) in the output.
const DATE_COLUMNS = ['Invoice Date', 'Credit Note Date', 'Remittance Date', 'Commission Date', 'IRN Date', 'Return Date'];

function firstIndexMap(header) {
  const map = {};
  header.forEach((h, i) => {
    const name = clean(h);
    if (name && !(name in map)) map[name] = i;
  });
  return map;
}

// Both reports repeat some column names (e.g. two "Taxable Value" columns — one before and
// one after the credit-note adjustment), so mapping refund rows into the sales layout has to
// match the Nth occurrence of a name to the Nth occurrence of the same name, not just the
// first — otherwise the second block's real (usually zero) values get overwritten by the
// first block's.
function allIndexMap(header) {
  const map = {};
  header.forEach((h, i) => {
    const name = clean(h);
    if (!name) return;
    if (!map[name]) map[name] = [];
    map[name].push(i);
  });
  return map;
}

function sheetToAOA(buffer) {
  // raw:true keeps every cell a plain string/number as the source CSV wrote it, instead of
  // SheetJS auto-detecting ambiguous date-looking cells as Excel serials (same rationale as
  // vareeProcessor.js's parseUploadedReport).
  const wb = XLSX.read(buffer, { type: 'buffer', raw: true });
  const sheetName = wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
}

/**
 * Builds the merged 52(ish)-column dataset: sales rows first (in file order, duplicates
 * negated in place), then unmatched refund rows appended (in file order).
 * Returns { header, rows } where each row is a plain array aligned to `header`.
 */
function mergeReports(salesAOA, refundAOA) {
  const salesHeader = salesAOA[0] || [];
  const refundHeader = refundAOA[0] || [];
  const salesRows = salesAOA.slice(1).filter((r) => r.some((c) => !isBlank(c)));
  const refundRows = refundAOA.slice(1).filter((r) => r.some((c) => !isBlank(c)));

  const si = firstIndexMap(salesHeader);
  const ri = firstIndexMap(refundHeader);
  const riAll = allIndexMap(refundHeader);

  const negateSalesIdx = NEGATE_COLUMNS.map((name) => si[name]).filter((i) => i !== undefined);

  function negateRow(row, idxList) {
    const out = row.slice();
    idxList.forEach((i) => { out[i] = -num(row[i]); });
    return out;
  }

  // Index refund rows by OrderID-SKU so sales rows can find their matching return.
  const refundByOrderSku = new Map();
  if (ri['OrderID-SKU'] !== undefined) {
    refundRows.forEach((row, idx) => {
      const key = clean(row[ri['OrderID-SKU']]);
      if (!key) return;
      if (!refundByOrderSku.has(key)) refundByOrderSku.set(key, []);
      refundByOrderSku.get(key).push(idx);
    });
  }

  const consumedRefundIdx = new Set();
  const merged = [];

  salesRows.forEach((row) => {
    const key = si['OrderID-SKU'] !== undefined ? clean(row[si['OrderID-SKU']]) : '';
    const candidates = key ? (refundByOrderSku.get(key) || []) : [];
    const matchIdx = candidates.find((idx) => !isBlank(refundRows[idx][ri['Return Qty']]));

    if (matchIdx !== undefined) {
      consumedRefundIdx.add(matchIdx);
      merged.push(negateRow(row, negateSalesIdx));
    } else {
      merged.push(row.slice());
    }
  });

  // Map an unmatched refund row into the sales column layout by name; 'Invoiced Qty' and
  // 'Return Date' land in the sales schema's differently-named/positioned equivalents.
  refundRows.forEach((row, idx) => {
    if (consumedRefundIdx.has(idx)) return;
    const out = salesHeader.map(() => '');
    const occurrenceSeen = {};
    salesHeader.forEach((h, sIdx) => {
      const name = clean(h);
      const occurrence = occurrenceSeen[name] || 0;
      occurrenceSeen[name] = occurrence + 1;
      if (name === 'Invoiced Quantity' && occurrence === 0 && riAll['Invoiced Qty']) {
        out[sIdx] = row[riAll['Invoiced Qty'][0]];
      } else if (riAll[name] && riAll[name][occurrence] !== undefined) {
        out[sIdx] = row[riAll[name][occurrence]];
      }
    });
    const returned = !isBlank(row[ri['Return Qty']]);
    merged.push(returned ? negateRow(out, negateSalesIdx) : out);
  });

  return { header: salesHeader, rows: merged, index: si };
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function buildRecords(header, rows, idx) {
  const get = (row, name) => (idx[name] !== undefined ? row[idx[name]] : '');
  return rows.map((row) => {
    const gstinRecipient = clean(get(row, 'GSTIN of Recipient'));
    const saleType = (!gstinRecipient || gstinRecipient.toUpperCase() === 'URD') ? 'B2C' : 'B2B';
    const taxable = num(get(row, 'Taxable Value'));
    const isReturn = taxable < 0;
    return {
      raw: row,
      orderIdSku: clean(get(row, 'OrderID-SKU')),
      state: clean(get(row, 'State')),
      gstin: clean(get(row, 'GSTIN')),
      documentType: clean(get(row, 'Document Type')),
      taxability: clean(get(row, 'Taxability')),
      supplyType: clean(get(row, 'Supply Type')),
      gstinRecipient,
      recipientState: clean(get(row, 'Recipient State')),
      nameOfRecipient: clean(get(row, 'Name of the Recipient')),
      invoiceNumber: clean(get(row, 'Invoice Number')),
      invoiceDate: parseFlexibleDate(get(row, 'Invoice Date')),
      invoiceValue: num(get(row, 'Invoice Value')),
      totalDiscount: num(get(row, 'Total Discount')),
      itemCode: clean(get(row, 'Item Code')),
      category: clean(get(row, 'Category')),
      hsnSac: clean(get(row, 'HSN/SAC')),
      productDescription: clean(get(row, 'Product/Service Description')),
      invoicedQuantity: num(get(row, 'Invoiced Quantity')),
      salePrice: num(get(row, 'Sale Price(Before discount)')),
      merchantDiscount: num(get(row, 'Merchant Discount')),
      taxableValue: taxable,
      taxRate: num(get(row, 'Total GST Rate')),
      igst: num(get(row, 'IGST Amount')),
      cgst: num(get(row, 'CGST Amount')),
      sgst: num(get(row, 'SGST/UTGST Amount')),
      shipFromState: clean(get(row, 'Ship from (State)')),
      shipToState: clean(get(row, 'Ship to (State)')),
      tcsAmount: num(get(row, 'TCS Amount')),
      statusOfDelivery: clean(get(row, 'Status of Delivery')),
      commissionAmount: num(get(row, 'Commission Amount Charged')),
      commissionInvoiceNo: clean(get(row, 'Commission Invoice No')),
      returnDate: parseFlexibleDate(get(row, 'Return Date')),
      saleType,
      transactionType: isReturn ? 'Return' : 'Sale',
    };
  });
}

// ── B2C Sales: Delivery State x Tax Rate, all B2C rows (sales + returns) ──
function buildB2CSummary(records) {
  const b2c = records.filter((r) => r.saleType === 'B2C');
  const groups = new Map();
  b2c.forEach((r) => {
    const key = `${r.shipToState}||${r.taxRate}`;
    if (!groups.has(key)) groups.set(key, { state: r.shipToState, rate: r.taxRate, taxable: 0, igst: 0, cgst: 0, sgst: 0 });
    const g = groups.get(key);
    g.taxable += r.taxableValue; g.igst += r.igst; g.cgst += r.cgst; g.sgst += r.sgst;
  });
  const list = [...groups.values()].sort((a, b) => a.state.localeCompare(b.state) || a.rate - b.rate);
  const headers = ['Delivery State', 'Tax Rate', 'Taxable Value', 'IGST', 'CGST', 'SGST'];
  const aoa = [headers, ...list.map((g) => [g.state, g.rate, round2(g.taxable), round2(g.igst), round2(g.cgst), round2(g.sgst)])];
  if (list.length) {
    const t = list.reduce((acc, g) => ({ taxable: acc.taxable + g.taxable, igst: acc.igst + g.igst, cgst: acc.cgst + g.cgst, sgst: acc.sgst + g.sgst }), { taxable: 0, igst: 0, cgst: 0, sgst: 0 });
    aoa.push(['Grand Total', '', round2(t.taxable), round2(t.igst), round2(t.cgst), round2(t.sgst)]);
  }
  return XLSX.utils.aoa_to_sheet(aoa);
}

// ── B2B Sales: Invoice No. x Invoice Date x GSTIN x Delivery State x Tax Rate, all B2B rows ──
function buildB2BSummary(records) {
  const b2b = records.filter((r) => r.saleType === 'B2B');
  const groups = new Map();
  b2b.forEach((r) => {
    const key = `${r.invoiceNumber}||${+r.invoiceDate}||${r.gstinRecipient}||${r.shipToState}||${r.taxRate}`;
    if (!groups.has(key)) {
      groups.set(key, {
        invoiceNo: r.invoiceNumber, invoiceDate: r.invoiceDate, gstin: r.gstinRecipient,
        state: r.shipToState, rate: r.taxRate, taxable: 0, igst: 0, cgst: 0, sgst: 0,
      });
    }
    const g = groups.get(key);
    g.taxable += r.taxableValue; g.igst += r.igst; g.cgst += r.cgst; g.sgst += r.sgst;
  });
  const numOrString = (v) => { const n = Number(v); return Number.isFinite(n) && v !== '' ? n : v; };
  const list = [...groups.values()].sort((a, b) => {
    const an = numOrString(a.invoiceNo), bn = numOrString(b.invoiceNo);
    if (typeof an === 'number' && typeof bn === 'number') return an - bn;
    return String(an).localeCompare(String(bn));
  });
  const headers = ['Invoice No.', 'Invoice Date', 'GSTIN of Recipient', 'Delivery State', 'Tax Rate', 'Taxable Value', 'IGST', 'CGST', 'SGST'];
  const aoa = [headers, ...list.map((g) => [
    numOrString(g.invoiceNo), g.invoiceDate, g.gstin, g.state, g.rate,
    round2(g.taxable), round2(g.igst), round2(g.cgst), round2(g.sgst),
  ])];
  if (list.length) {
    const t = list.reduce((acc, g) => ({ taxable: acc.taxable + g.taxable, igst: acc.igst + g.igst, cgst: acc.cgst + g.cgst, sgst: acc.sgst + g.sgst }), { taxable: 0, igst: 0, cgst: 0, sgst: 0 });
    aoa.push(['Grand Total', '', '', '', '', round2(t.taxable), round2(t.igst), round2(t.cgst), round2(t.sgst)]);
  }
  return XLSX.utils.aoa_to_sheet(aoa);
}

// ── HSN Summary: HSN/SAC x Tax Rate, B2B + B2C combined ──
function buildHsnSummary(records) {
  const groups = new Map();
  records.forEach((r) => {
    const key = `${r.hsnSac}||${r.taxRate}`;
    if (!groups.has(key)) groups.set(key, { hsn: r.hsnSac, rate: r.taxRate, qty: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 });
    const g = groups.get(key);
    g.qty += r.invoicedQuantity; g.taxable += r.taxableValue; g.igst += r.igst; g.cgst += r.cgst; g.sgst += r.sgst;
  });
  const list = [...groups.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate);
  const headers = ['HSN', 'Tax Rate', 'Quantity', 'Taxable Value', 'IGST', 'CGST', 'SGST'];
  const aoa = [headers, ...list.map((g) => [g.hsn, g.rate, g.qty, round2(g.taxable), round2(g.igst), round2(g.cgst), round2(g.sgst)])];
  if (list.length) {
    const t = list.reduce((acc, g) => ({ qty: acc.qty + g.qty, taxable: acc.taxable + g.taxable, igst: acc.igst + g.igst, cgst: acc.cgst + g.cgst, sgst: acc.sgst + g.sgst }), { qty: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 });
    aoa.push(['Grand Total', '', t.qty, round2(t.taxable), round2(t.igst), round2(t.cgst), round2(t.sgst)]);
  }
  return XLSX.utils.aoa_to_sheet(aoa);
}

function buildMergedSheet(header, rows, idx) {
  const dateIdx = new Set(DATE_COLUMNS.map((name) => idx[name]).filter((i) => i !== undefined));
  const numericNames = new Set([
    'Invoice Value', 'Total Discount', 'Invoiced Quantity', 'Sale Price(Before discount)', 'Merchant Discount',
    'Taxable Value', 'Total GST Rate', 'IGST (%)', 'IGST Amount', 'CSGT (%)', 'CGST Amount',
    'SGST/UTGST (%)', 'SGST/UTGST Amount', 'Credit Note Amount', 'TCS Amount', 'Commission Amount Charged',
  ]);
  const numericIdx = new Set(header.map((h, i) => (numericNames.has(clean(h)) ? i : -1)).filter((i) => i >= 0));

  const aoa = [header, ...rows.map((row) => row.map((cell, i) => {
    if (dateIdx.has(i)) return parseFlexibleDate(cell);
    if (numericIdx.has(i)) return num(cell);
    return cell === '' ? null : cell;
  }))];
  return XLSX.utils.aoa_to_sheet(aoa);
}

async function pepperfryProcessor(salesBuffer, refundBuffer, brandName, date) {
  const salesAOA = sheetToAOA(salesBuffer);
  const refundAOA = sheetToAOA(refundBuffer);

  const { header, rows, index } = mergeReports(salesAOA, refundAOA);
  const records = buildRecords(header, rows, index);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildB2CSummary(records), 'B2C Sales');
  XLSX.utils.book_append_sheet(wb, buildB2BSummary(records), 'B2B Sales');
  XLSX.utils.book_append_sheet(wb, buildHsnSummary(records), 'HSN Summary');
  XLSX.utils.book_append_sheet(wb, buildMergedSheet(header, rows, index), 'Merged Report');

  return {
    outputWorkbook: wb,
    processedData: records,
  };
}

module.exports = { pepperfryProcessor };
