'use strict';
const XLSX = require('xlsx-js-style');

function safeNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function negateIfNonZero(v) {
  const n = safeNum(v);
  return n !== 0 ? -Math.abs(n) : 0;
}

const VENDOR_COLS = [
  'vendorId', 'eventType', 'vendorName', 'GSTIN', 'invoiceId', 'invoiceDate',
  'customerName', 'customerState', 'customerPincode', 'vendorState', 'vendorPincode',
  'salesType', 'E-CommerceGSTIN', 'E-CommerceName', 'uniqueItemId', 'vendorStyleCode',
  'orderId', 'suborderId', 'hsnCode', 'productDescription', 'quantity', 'totalGSTRate',
  'IGST', 'CGST', 'SGST', 'taxAmountForIGST', 'taxAmountForCGST', 'taxAmountForSGST',
  'itemTaxableAmount', 'shippingTaxableAmount', 'codTaxableAmount', 'totalSupplyTaxableAmount',
  'tcsAmountForIGST', 'tcsAmountForCGST', 'tcsAmountForSGST',
  'invoiceValue', 'taxAmount', 'cessAmount', 'tdsAmount', '__EMPTY',
];

function parseBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: false });
  const result = {};
  for (const name of wb.SheetNames) {
    result[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null, raw: true });
  }
  return { sheetNames: wb.SheetNames, sheets: result };
}

function processVendorSheet(rows) {
  return rows.map(row => {
    const eventType = String(row.eventType || '').trim().toLowerCase();
    const processed = { ...row };
    if (eventType === 'return') {
      processed.quantity                 = negateIfNonZero(row.quantity);
      processed.taxAmountForIGST         = negateIfNonZero(row.taxAmountForIGST);
      processed.taxAmountForCGST         = negateIfNonZero(row.taxAmountForCGST);
      processed.taxAmountForSGST         = negateIfNonZero(row.taxAmountForSGST);
      processed.itemTaxableAmount        = negateIfNonZero(row.itemTaxableAmount);
      processed.totalSupplyTaxableAmount = negateIfNonZero(row.totalSupplyTaxableAmount);
    } else {
      // Sale: ensure numeric columns are numbers
      processed.quantity                 = safeNum(row.quantity);
      processed.taxAmountForIGST         = safeNum(row.taxAmountForIGST);
      processed.taxAmountForCGST         = safeNum(row.taxAmountForCGST);
      processed.taxAmountForSGST         = safeNum(row.taxAmountForSGST);
      processed.itemTaxableAmount        = safeNum(row.itemTaxableAmount);
      processed.totalSupplyTaxableAmount = safeNum(row.totalSupplyTaxableAmount);
    }
    processed.hsnCode    = safeNum(row.hsnCode)    || row.hsnCode;
    processed.totalGSTRate = safeNum(row.totalGSTRate);
    return processed;
  });
}

function buildPivot(rows, rowKeys, valueKeys) {
  const map = new Map();
  for (const row of rows) {
    const key = rowKeys.map(k => String(row[k] ?? '')).join('|||');
    if (!map.has(key)) {
      const entry = {};
      for (const k of rowKeys) entry[k] = row[k];
      for (const v of valueKeys) entry[v] = 0;
      map.set(key, entry);
    }
    const entry = map.get(key);
    for (const v of valueKeys) entry[v] += safeNum(row[v]);
  }
  return Array.from(map.values()).sort((a, b) => {
    const ka = String(a[rowKeys[0]] ?? '');
    const kb = String(b[rowKeys[0]] ?? '');
    return ka.localeCompare(kb);
  });
}

function buildPivotSheet(pivotRows, rowKeys, valueKeys) {
  const valueHeaders = valueKeys.map(k => `Sum of ${k}`);
  const headers = [...rowKeys, ...valueHeaders];

  // Totals row
  const totals = new Array(rowKeys.length).fill(null);
  for (const vk of valueKeys) {
    totals.push(pivotRows.reduce((s, r) => s + safeNum(r[vk]), 0));
  }

  // Pivot layout: Values label row, header row, data rows, grand total
  const aoa = [
    [null, null, 'Values', ...new Array(headers.length - 3).fill(null)],
    headers,
    ...pivotRows.map(r => [...rowKeys.map(k => r[k]), ...valueKeys.map(k => r[k])]),
    ['Grand Total', ...new Array(rowKeys.length - 1).fill(null), ...totals.slice(rowKeys.length)],
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Style header row (row 2, index 1 in aoa)
  const headerRow = 2;
  for (let c = 0; c < headers.length; c++) {
    const cellRef = XLSX.utils.encode_cell({ r: headerRow - 1, c });
    if (ws[cellRef]) {
      ws[cellRef].s = {
        font: { bold: true },
        fill: { fgColor: { rgb: 'D9D9D9' }, patternType: 'solid' },
        border: {
          top: { style: 'thin' }, bottom: { style: 'thin' },
          left: { style: 'thin' }, right: { style: 'thin' },
        },
      };
    }
  }

  // Style grand total row
  const totalRowIdx = aoa.length - 1;
  for (let c = 0; c < headers.length; c++) {
    const cellRef = XLSX.utils.encode_cell({ r: totalRowIdx, c });
    if (ws[cellRef]) {
      ws[cellRef].s = { font: { bold: true } };
    }
  }

  return ws;
}

function buildVendorSheet(processedRows) {
  const aoa = [VENDOR_COLS, ...processedRows.map(r => VENDOR_COLS.map(col => r[col] ?? null))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Bold header
  for (let c = 0; c < VENDOR_COLS.length; c++) {
    const cellRef = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[cellRef]) ws[cellRef].s = { font: { bold: true } };
  }

  return ws;
}

function buildTcsSheet(tcsRows) {
  if (!tcsRows || tcsRows.length === 0) return null;
  const headers = Object.keys(tcsRows[0]);
  const aoa = [headers, ...tcsRows.map(r => headers.map(h => r[h] ?? null))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (let c = 0; c < headers.length; c++) {
    const cellRef = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[cellRef]) ws[cellRef].s = { font: { bold: true } };
  }
  return ws;
}

function computeSummary(processedRows) {
  let saleQty = 0, saleAmt = 0, saleIGST = 0, saleCGST = 0, saleSGST = 0;
  let retQty  = 0, retAmt  = 0, retIGST  = 0, retCGST  = 0, retSGST  = 0;

  for (const row of processedRows) {
    const et = String(row.eventType || '').trim().toLowerCase();
    const qty  = safeNum(row.quantity);
    const amt  = safeNum(row.totalSupplyTaxableAmount);
    const igst = safeNum(row.taxAmountForIGST);
    const cgst = safeNum(row.taxAmountForCGST);
    const sgst = safeNum(row.taxAmountForSGST);

    if (et === 'return') {
      retQty  += Math.abs(qty);
      retAmt  += Math.abs(amt);
      retIGST += Math.abs(igst);
      retCGST += Math.abs(cgst);
      retSGST += Math.abs(sgst);
    } else {
      saleQty  += qty;
      saleAmt  += amt;
      saleIGST += igst;
      saleCGST += cgst;
      saleSGST += sgst;
    }
  }

  return {
    totalRows:   processedRows.length,
    saleCount:   processedRows.filter(r => String(r.eventType || '').toLowerCase() === 'sale').length,
    returnCount: processedRows.filter(r => String(r.eventType || '').toLowerCase() === 'return').length,
    saleQty:     Math.round(saleQty),
    saleAmount:  parseFloat(saleAmt.toFixed(2)),
    saleIGST:    parseFloat(saleIGST.toFixed(2)),
    saleCGST:    parseFloat(saleCGST.toFixed(2)),
    saleSGST:    parseFloat(saleSGST.toFixed(2)),
    returnQty:   Math.round(retQty),
    returnAmount: parseFloat(retAmt.toFixed(2)),
    returnIGST:  parseFloat(retIGST.toFixed(2)),
    returnCGST:  parseFloat(retCGST.toFixed(2)),
    returnSGST:  parseFloat(retSGST.toFixed(2)),
    netAmount:   parseFloat((saleAmt - retAmt).toFixed(2)),
    netIGST:     parseFloat((saleIGST - retIGST).toFixed(2)),
    netCGST:     parseFloat((saleCGST - retCGST).toFixed(2)),
    netSGST:     parseFloat((saleSGST - retSGST).toFixed(2)),
  };
}

const VALUE_KEYS = ['totalSupplyTaxableAmount', 'taxAmountForIGST', 'taxAmountForCGST', 'taxAmountForSGST'];

function limeroadProcessor(fileBuffer, monthName, yearStr) {
  const { sheetNames, sheets } = parseBuffer(fileBuffer);

  // Find the vendor sheet (the numeric vendor ID sheet, e.g. "65835")
  const vendorSheetName = sheetNames.find(n => n !== 'TCS Summary' && n !== 'TCS_Summary') || sheetNames[0];
  const tcsSheetName    = sheetNames.find(n => n === 'TCS Summary' || n === 'TCS_Summary') || null;

  const rawVendorRows = sheets[vendorSheetName] || [];
  const tcsRows       = tcsSheetName ? (sheets[tcsSheetName] || []) : [];

  // Step 3: Process return transactions (negate specified columns)
  const processedRows = processVendorSheet(rawVendorRows);

  // Step 4: B2C pivot — grouped by customerState + totalGSTRate
  const b2cPivot = buildPivot(processedRows, ['customerState', 'totalGSTRate'], VALUE_KEYS);

  // Step 5: HSN pivot — grouped by hsnCode + totalGSTRate
  const hsnPivot = buildPivot(processedRows, ['hsnCode', 'totalGSTRate'], VALUE_KEYS);

  // Build output workbook (sheet order matches working file: B2C, HSN, vendor, TCS)
  const wb = XLSX.utils.book_new();

  const b2cSheet = buildPivotSheet(b2cPivot, ['customerState', 'totalGSTRate'], VALUE_KEYS);
  XLSX.utils.book_append_sheet(wb, b2cSheet, 'B2C');

  const hsnSheet = buildPivotSheet(hsnPivot, ['hsnCode', 'totalGSTRate'], VALUE_KEYS);
  XLSX.utils.book_append_sheet(wb, hsnSheet, 'HSN');

  const vendorSheet = buildVendorSheet(processedRows);
  XLSX.utils.book_append_sheet(wb, vendorSheet, vendorSheetName);

  if (tcsRows.length > 0) {
    const tcsSheet = buildTcsSheet(tcsRows);
    if (tcsSheet) XLSX.utils.book_append_sheet(wb, tcsSheet, 'TCS_Summary');
  }

  const summary = computeSummary(processedRows);

  return {
    outputWorkbook: wb,
    processedRows,
    b2cPivot,
    hsnPivot,
    vendorSheetName,
    summary,
  };
}

module.exports = { limeroadProcessor };
