'use strict';
const XLSX = require('xlsx-js-style');
const { getStateCodeFromName, getStateAbbr } = require('../../../utils/gstStateCodes');

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

const MONTH_NUMS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function getSellerStateAbbr(gstin) {
  const code = String(gstin || '').trim().substring(0, 2);
  return getStateAbbr(code) || code;
}

function getBuyerStateAbbr(stateName) {
  const code = getStateCodeFromName(stateName);
  return (code && getStateAbbr(code)) || String(stateName || '').trim();
}

// ============================================================
// X2BETA WORKING SHEET
// Same 108-column Tally "X2Beta" e-invoice import template used by the
// other marketplace processors. Built directly from processedRows (one row
// per line item, already sign-flipped for returns by processVendorSheet)
// since Limeroad's source report already carries its own invoiceId/
// invoiceDate/GSTIN per row — no separate ledger-master/invoice-numbering
// scheme is needed the way Amazon/Flipkart/Myntra require one.
//
// Output IGST/CGST/SGST columns are keyed by the *vendor's* (seller's)
// state, matching the seller-state-keyed Output-column convention used by
// every other channel's x2beta sheet; the buyer's customerState is used
// for the State/Place of Supply columns, mirroring Amazon's Ship-To-State
// convention. totalSupplyTaxableAmount/taxAmountFor{IGST,CGST,SGST} are the
// combined (item + shipping + COD) taxable value and tax split — Limeroad's
// report never separates shipping into its own taxable line, so (per the
// same rule applied to the other channels lacking a real shipping split)
// there is no separate x2beta-shipping sheet for Limeroad.
// ============================================================
function buildX2betaSheet(processedRows, monthName, yearStr) {
  const monthNum = MONTH_NUMS[String(monthName || '').trim().toLowerCase()] || null;
  const year = parseInt(yearStr, 10);
  const fallbackVchDate = (monthNum && !isNaN(year)) ? new Date(year, monthNum, 0) : new Date();

  function rowVchDate(row) {
    if (row.invoiceDate) {
      const d = new Date(row.invoiceDate);
      if (!isNaN(d.getTime())) return d;
    }
    return fallbackVchDate;
  }

  const uniqueRates = [...new Set(processedRows.map(r => Number(r.totalGSTRate || 0)))].filter(r => r > 0);
  const sortedStateCodes = [...new Set(processedRows.map(r => getSellerStateAbbr(r.GSTIN)))].filter(Boolean).sort();

  const x2betaColumns = [
    { header: 'Vch. Date* ', get: r => rowVchDate(r) },
    { header: 'Vch. Type*', get: r => `${Number(r.totalSupplyTaxableAmount || 0) < 0 ? 'CN-' : ''}Sales-${getSellerStateAbbr(r.GSTIN) || ''}` },
    { header: 'Vch. No.*', get: r => r.invoiceId || '' },
    { header: 'Ref. No.', get: r => r.invoiceId || '' },
    { header: 'Ref. Date', get: r => rowVchDate(r) },
    { header: 'Is CN?', get: r => (Number(r.totalSupplyTaxableAmount || 0) < 0 ? 'Yes' : null) },
    { header: 'Is Vch?', get: () => null },
    { header: 'Party Ledger*', get: r => `Limeroad Debtor-${getSellerStateAbbr(r.GSTIN) || ''}` },
    { header: 'Sales Ledger*', get: r => `Sales Limeroad-${getSellerStateAbbr(r.GSTIN) || ''} ${Number(r.totalGSTRate || 0)}%` },
    { header: 'Stock Item', get: r => r.productDescription || '' },
    { header: 'Description', get: r => r.productDescription || '' },
    { header: 'Godown', get: r => r.vendorState || '' },
    { header: 'Quantity', get: r => Number(r.quantity || 0) },
    {
      header: 'Rate',
      get: r => {
        const qty = Number(r.quantity || 0);
        return qty !== 0 ? Math.abs(Number(r.totalSupplyTaxableAmount || 0) / qty) : 0;
      }
    },
    { header: 'Unit', get: () => 'Pcs' },
    { header: 'Discount', get: () => null },
    { header: 'Amount*', get: r => Number(r.totalSupplyTaxableAmount || 0) },
    { header: 'Discount', get: () => null }
  ];

  uniqueRates.forEach(rate => {
    const halfRate = Math.round((rate / 2) * 100) / 100;
    sortedStateCodes.forEach(sc => {
      x2betaColumns.push({
        header: `Output IGST ${rate}%-${sc}`,
        get: row => (Number(row.totalGSTRate || 0) === rate && getSellerStateAbbr(row.GSTIN) === sc) ? Number(row.taxAmountForIGST || 0) : 0
      });
      x2betaColumns.push({
        header: `Output CGST ${halfRate}%-${sc}`,
        get: row => (Number(row.totalGSTRate || 0) === rate && getSellerStateAbbr(row.GSTIN) === sc) ? Number(row.taxAmountForCGST || 0) : 0
      });
      x2betaColumns.push({
        header: `Output SGST ${halfRate}%-${sc}`,
        get: row => (Number(row.totalGSTRate || 0) === rate && getSellerStateAbbr(row.GSTIN) === sc) ? Number(row.taxAmountForSGST || 0) : 0
      });
    });
  });

  x2betaColumns.push(
    { header: null, get: () => null },
    { header: null, get: () => null },
    { header: 'Narration', get: () => `Limeroad-${monthName || ''}-${yearStr || ''}` },
    { header: 'Taxability', get: () => null },
    { header: 'GST Nature', get: () => null },
    { header: 'GST Rate', get: r => Number(r.totalGSTRate || 0) },
    { header: 'Cess', get: r => Number(r.cessAmount || 0) || null },
    { header: 'RCM?', get: () => null },
    { header: 'HSN', get: r => r.hsnCode || '' },
    { header: 'HSN Desc', get: () => null },
    { header: 'Supply Type', get: () => null },
    { header: 'Cost Category', get: () => null },
    { header: 'Cost Centre', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: r => r.customerState || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: r => r.customerPincode || null },
    { header: 'Place of Supply', get: r => r.customerState || '' }, { header: 'GST Type', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: r => r.customerState || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: r => r.customerPincode || null },
    { header: 'Place', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: r => r.customerState || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: r => r.customerPincode || null },
    { header: 'Place', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'DN No.', get: () => null }, { header: 'DN Date', get: () => null }, { header: 'Doc. No.', get: () => null },
    { header: 'Dis. Through', get: () => null }, { header: 'Destination', get: () => null }, { header: 'Carrier Name', get: () => null },
    { header: 'LR No.', get: () => null }, { header: 'LR Date', get: () => null }, { header: 'Order No.', get: r => r.orderId || null },
    { header: 'Order Date', get: () => null }, { header: 'Term of Delivery', get: () => null }, { header: 'Terms of Paymemt', get: () => null },
    { header: 'Other Ref.', get: () => null }, { header: 'Place of Receipt', get: () => null }, { header: 'Vessel/Flight No.', get: () => null },
    { header: 'Port of Loading', get: () => null }, { header: 'Port of Discharge', get: () => null }, { header: 'Country to', get: () => null },
    { header: 'Shipping Bill No.', get: () => null }, { header: 'Date', get: () => null }, { header: 'Port Code', get: () => null },
    { header: 'e-Way Bill No', get: () => null }, { header: 'Date', get: () => null }, { header: 'Cons. e-Way Bill No.', get: () => null },
    { header: 'Date', get: () => null }, { header: 'Sub Type', get: () => null }, { header: 'Doc. Type', get: () => null },
    { header: 'Distance (KM)', get: () => null }, { header: 'Transporter Name', get: () => null }, { header: 'Transporter ID', get: () => null },
    { header: 'Transport Mode', get: () => null }, { header: 'Doc No.', get: () => null }, { header: 'Date', get: () => null },
    { header: 'Vehicle No.', get: () => null }, { header: 'Vehicle Type', get: () => null }, { header: 'Status', get: () => null },
    { header: 'Note Reason', get: () => null }, { header: 'Orig. Inv. No.', get: () => null }, { header: 'Orig. Inv. Date', get: () => null }
  );

  const headers = x2betaColumns.map(c => c.header);
  const aoa = [headers, ...processedRows.map(row => x2betaColumns.map(c => c.get(row)))];
  return XLSX.utils.aoa_to_sheet(aoa);
}

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

  const x2betaSheet = buildX2betaSheet(processedRows, monthName, yearStr);
  XLSX.utils.book_append_sheet(wb, x2betaSheet, 'x2beta working');

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
