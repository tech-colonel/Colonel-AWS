const XLSX = require('xlsx-js-style');
const { getStateCodeFromName, getStateAbbr } = require('../../../utils/gstStateCodes');

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const num = Number(value);
  return isNaN(num) ? 0 : num;
}

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

// Case-insensitive, space/dash/underscore-tolerant field lookup.
// Tries each name in order: exact first, then normalized fallback.
function findField(obj, ...names) {
  for (const name of names) {
    if (name in obj) return obj[name];
  }
  const objKeys = Object.keys(obj);
  for (const name of names) {
    const norm = name.toLowerCase().replace(/[\s_-]+/g, '');
    const hit = objKeys.find(k => k.toLowerCase().replace(/[\s_-]+/g, '') === norm);
    if (hit !== undefined) return obj[hit];
  }
  return undefined;
}

const MONTH_NUM = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12'
};

// Rows included in Working sheet
const INCLUDED_STATUSES = new Set(['delivered', 'lost']);

// Snap a raw GST rate to the nearest standard Indian GST slab
const STANDARD_GST_RATES = [0.05, 0.12, 0.18, 0.28];
function snapGstRate(rawRate) {
  return STANDARD_GST_RATES.reduce((prev, curr) =>
    Math.abs(curr - rawRate) < Math.abs(prev - rawRate) ? curr : prev
  );
}

async function creadProcessor(
  rawFileBuffer,
  skuData = [],
  ledgerData = [],
  brandName,
  month,
  year,
  sellingState = 'Delhi',
  withInventory = true
) {
  const wb = XLSX.read(rawFileBuffer, { type: 'buffer', cellDates: true });

  // Two-sheet format: raw sheet (Jul25) + Final sheet (Final-Jul25 with Cred Status / Final Status)
  // Single-sheet format: only one sheet with all data (no Final Status column)
  const rawSheetName   = wb.SheetNames[0];
  const finalSheetName = wb.SheetNames.find(n => n.toLowerCase().includes('final')) || rawSheetName;
  const hasTwoSheets   = finalSheetName !== rawSheetName;

  const rawSheet  = wb.Sheets[rawSheetName];
  const finalSheet = wb.Sheets[finalSheetName];

  const finalData = XLSX.utils.sheet_to_json(finalSheet, { defval: null });

  if (!finalData || finalData.length === 0) {
    throw new Error('Source sheet is empty or could not be parsed');
  }

  console.log(`Cread: ${finalData.length} total rows`);

  // SKU map: portal SKU (lowercase) → Final SKU (Tally Item Name)
  const skuMap = {};
  skuData.forEach(item => {
    const key = safeString(
      findField(item, 'Sales Portal SKU', 'Portal SKU', 'SKU', 'sku') ?? ''
    ).toLowerCase();
    if (!key) return;
    skuMap[key] = safeString(
      findField(item, 'Tally new SKU', 'Tally SKU', 'Tally Item Name', 'Final SKU', 'FG', 'fg') ?? ''
    );
  });

  // Ledger map: state name (lowercase) → { partyName, invoicePrefix }
  const ledgerMap = {};
  ledgerData.forEach(item => {
    const stateKey = safeString(
      findField(item, 'State', 'Shipping State', 'States', 'state') ?? ''
    ).toLowerCase();
    if (!stateKey) return;
    ledgerMap[stateKey] = {
      states: safeString(findField(item, 'State', 'Shipping State', 'States', 'state') ?? ''),
      partyName: safeString(findField(item, 'Party Name', 'Ledger', 'Tally Name', 'partyName') ?? ''),
      invoicePrefix: safeString(findField(item, 'Invoice No.', 'Invoice No', 'Invoice Number', 'invoiceNo') ?? '')
    };
  });

  const monthNum = MONTH_NUM[safeString(month).toLowerCase()] || '';
  const sellingStateLower = safeString(sellingState).toLowerCase();

  // Filter rows: only apply when the Final Status column exists (two-sheet format).
  // Single-sheet files are already pre-filtered; exclude only explicit returns/cancels.
  const hasFinalStatus = finalData.some(r => r['Final Status'] != null || r['As Per Sourabh'] != null);
  const filteredData = finalData.filter(row => {
    if (hasFinalStatus) {
      const status = safeString(row['Final Status'] || row['As Per Sourabh'] || '').toLowerCase();
      return INCLUDED_STATUSES.has(status);
    }
    // Single-sheet: exclude Returned/Cancelled orders
    const orderStatus = safeString(row['Order Status'] || '').toLowerCase();
    return orderStatus !== 'returned' && orderStatus !== 'cancelled' && orderStatus !== 'rto';
  });

  console.log(`Cread: ${filteredData.length} rows after filtering`);

  const workingData = filteredData.map(row => {
    const sku = safeString(row['SKU'] || '');
    const shippingState = safeString(row['Shipping State'] || '');

    // SKU master lookup for Final SKU
    const finalSku = withInventory
      ? (skuMap[sku.toLowerCase()] || skuMap[safeString(row['MIS SKU'] || '').toLowerCase()] || '')
      : '';

    // Ledger master lookup for Party Name and Invoice No.
    const ledgerEntry = ledgerMap[shippingState.toLowerCase()] || {};
    const normalizedState = ledgerEntry.states || shippingState;
    const partyName = ledgerEntry.partyName || '';
    const invoiceNo = ledgerEntry.invoicePrefix && monthNum
      ? `${ledgerEntry.invoicePrefix}-${monthNum}`
      : ledgerEntry.invoicePrefix || '';

    // Taxable Amount = Item Price Excluding Tax (already pre-tax in the source)
    const tax = safeNumber(row['Tax']);
    const itemPriceExTax = safeNumber(row['Item Price Excluding Tax']);
    const taxableAmount = itemPriceExTax;

    // GST rate: use Tax Rate column directly if present, otherwise derive + snap to standard slab
    const rawRate = taxableAmount > 0 ? tax / taxableAmount : 0;
    const gstRate = row['Tax Rate'] != null
      ? safeNumber(row['Tax Rate']) / 100
      : snapGstRate(rawRate);
    const computedTax = parseFloat((taxableAmount * gstRate).toFixed(7));

    // GST logic: Delhi (seller) → CGST + SGST; all other states → IGST
    let cgst = 0, sgst = 0, igst = 0;
    if (normalizedState.toLowerCase() === sellingStateLower) {
      cgst = parseFloat((computedTax / 2).toFixed(7));
      sgst = parseFloat((computedTax / 2).toFixed(7));
    } else {
      igst = computedTax;
    }

    return {
      'Reference Code': safeString(row['Reference Code'] || ''),
      'EE Invoice No': safeString(row['EE Invoice No'] || ''),
      'Order Status': safeString(row['Order Status'] || ''),
      'Shipping Status': safeString(row['Shipping Status'] || ''),
      'Order Date': row['Order Date'] || null,
      'AWB No': safeString(row['AWB No'] || ''),
      'Suborder Quantity': safeNumber(row['Suborder Quantity']),
      'Item Quantity': safeNumber(row['Item Quantity']),
      'SKU': sku,
      'Final SKU': finalSku,
      'MIS SKU': safeString(row['MIS SKU'] || ''),
      'Shipping Zip Code': safeNumber(row['Shipping Zip Code']),
      'Shipping States': normalizedState,
      'Party Name': partyName,
      'Invoice No.': invoiceNo,
      'Order Invoice Amount': safeNumber(row['Order Invoice Amount']),
      'Tax': tax,
      'Item Price Excluding Tax': itemPriceExTax,
      'Cred Status': safeString(row['Cred Status'] || row['Status'] || ''),
      'Taxable Amount': parseFloat(taxableAmount.toFixed(4)),
      'CGST ': cgst,
      'SGST': sgst,
      'IGST': igst,
      'Final Status': safeString(row['Final Status'] || row['As Per Sourabh'] || '')
    };
  });

  // Pivot: group by Invoice No. + Party Name + Final SKU (Tally Sku)
  const pivotMap = {};
  workingData.forEach(row => {
    const key = `${row['Invoice No.']}||${row['Party Name']}||${row['Final SKU']}`;
    if (!pivotMap[key]) {
      pivotMap[key] = {
        'Invoice No.': row['Invoice No.'],
        'Party Name': row['Party Name'],
        'Tally Sku': row['Final SKU'],
        'Sum of Suborder Quantity': 0,
        'Sum of Taxable Amount': 0,
        'Sum of CGST ': 0,
        'Sum of SGST': 0,
        'Sum of IGST': 0
      };
    }
    pivotMap[key]['Sum of Suborder Quantity'] += safeNumber(row['Suborder Quantity']);
    pivotMap[key]['Sum of Taxable Amount']    += safeNumber(row['Taxable Amount']);
    pivotMap[key]['Sum of CGST ']            += safeNumber(row['CGST ']);
    pivotMap[key]['Sum of SGST']             += safeNumber(row['SGST']);
    pivotMap[key]['Sum of IGST']             += safeNumber(row['IGST']);
  });

  const pivotData = Object.values(pivotMap).map(r => ({
    ...r,
    'Sum of Taxable Amount': parseFloat(r['Sum of Taxable Amount'].toFixed(4)),
    'Sum of CGST ':          parseFloat(r['Sum of CGST '].toFixed(6)),
    'Sum of SGST':           parseFloat(r['Sum of SGST'].toFixed(6)),
    'Sum of IGST':           parseFloat(r['Sum of IGST'].toFixed(6))
  }));

  // Build output workbook with 4 sheets
  const outputWorkbook = XLSX.utils.book_new();

  // Sheet 1: Raw data (original source sheet, unchanged)
  XLSX.utils.book_append_sheet(outputWorkbook, rawSheet, rawSheetName);

  // Sheet 2: Main Sheet (Final sheet if two-sheet format, else same raw sheet)
  if (hasTwoSheets) {
    XLSX.utils.book_append_sheet(outputWorkbook, finalSheet, '1. Main Sheet');
  } else {
    XLSX.utils.book_append_sheet(outputWorkbook, rawSheet, '1. Main Sheet');
  }

  // Sheet 3: Working — empty row, then headers, then data (matches output reference)
  const workingSheet = buildWorkingSheet(workingData);
  XLSX.utils.book_append_sheet(outputWorkbook, workingSheet, '2. Working');

  // Sheet 4: Pivot — "Values" label row, headers row, then data
  const pivotSheet = buildPivotSheet(pivotData);
  XLSX.utils.book_append_sheet(outputWorkbook, pivotSheet, '3. Pivot');

  // Sheet 5: After Pivot — totals row, headers row, then data
  const afterPivotSheet = buildAfterPivotSheet(pivotData);
  XLSX.utils.book_append_sheet(outputWorkbook, afterPivotSheet, '4. After Pivot');

  // Sheet 6: X2Beta working — same 108-column Tally e-invoice import template
  // used by the other marketplace processors.
  const x2betaSheet = buildX2betaSheet(workingData, month, year, sellingState);
  XLSX.utils.book_append_sheet(outputWorkbook, x2betaSheet, 'x2beta working');

  return { outputWorkbook, workingData, pivotData };
}

// ============================================================
// X2BETA WORKING SHEET
// Same 108-column Tally "X2Beta" e-invoice import template used by the
// other marketplace processors. Cread is a single-GSTIN business (one
// `sellingState`, not a multi-seller-GSTIN model like Amazon/Flipkart), and
// its ledger master already resolves a real Party Ledger + Invoice No. per
// shipping state (see ledgerMap above) — reused directly here rather than
// synthesized. Returns/cancellations are already excluded upstream
// (INCLUDED_STATUSES), so there are no negative/CN rows to handle.
// ============================================================
function buildX2betaSheet(workingData, month, year, sellingState) {
  const monthNum = MONTH_NUM[safeString(month).toLowerCase()];
  const yearNum = parseInt(year, 10);
  const fallbackVchDate = (monthNum && !isNaN(yearNum)) ? new Date(yearNum, Number(monthNum), 0) : new Date();

  function rowVchDate(row) {
    const d = row['Order Date'] instanceof Date ? row['Order Date'] : new Date(row['Order Date']);
    if (!isNaN(d?.getTime?.())) return d;
    return fallbackVchDate;
  }

  function rowRate(row) {
    const taxable = safeNumber(row['Taxable Amount']);
    const totalTax = safeNumber(row['CGST ']) + safeNumber(row['SGST']) + safeNumber(row['IGST']);
    return taxable > 0 ? snapGstRate(totalTax / taxable) : 0;
  }

  const sellerCode = getStateCodeFromName(sellingState);
  const sellerStateAbbr = (sellerCode && getStateAbbr(sellerCode)) || safeString(sellingState);

  const uniqueRates = [...new Set(workingData.map(r => Math.round(rowRate(r) * 100)))].filter(r => r > 0).map(r => r / 100);

  const x2betaColumns = [
    { header: 'Vch. Date* ', get: r => rowVchDate(r) },
    { header: 'Vch. Type*', get: () => `Sales-${sellerStateAbbr}` },
    { header: 'Vch. No.*', get: r => r['Invoice No.'] || '' },
    { header: 'Ref. No.', get: r => r['Invoice No.'] || '' },
    { header: 'Ref. Date', get: r => rowVchDate(r) },
    { header: 'Is CN?', get: () => null },
    { header: 'Is Vch?', get: () => null },
    { header: 'Party Ledger*', get: r => r['Party Name'] || '' },
    { header: 'Sales Ledger*', get: r => `Sales Cread-${sellerStateAbbr} ${Math.round(rowRate(r) * 10000) / 100}%` },
    { header: 'Stock Item', get: r => r['Final SKU'] || '' },
    { header: 'Description', get: () => null },
    { header: 'Godown', get: () => sellingState || '' },
    { header: 'Quantity', get: r => Number(r['Suborder Quantity'] || 0) },
    {
      header: 'Rate',
      get: r => {
        const qty = Number(r['Suborder Quantity'] || 0);
        return qty !== 0 ? Math.abs(Number(r['Taxable Amount'] || 0) / qty) : 0;
      }
    },
    { header: 'Unit', get: () => 'Pcs' },
    { header: 'Discount', get: () => null },
    { header: 'Amount*', get: r => Number(r['Taxable Amount'] || 0) },
    { header: 'Discount', get: () => null }
  ];

  uniqueRates.forEach(rate => {
    const ratePercent = Math.round(rate * 10000) / 100;
    const halfRatePercent = Math.round((ratePercent / 2) * 100) / 100;
    x2betaColumns.push({
      header: `Output IGST ${ratePercent}%-${sellerStateAbbr}`,
      get: row => (Math.round(rowRate(row) * 100) === Math.round(rate * 100)) ? Number(row['IGST'] || 0) : 0
    });
    x2betaColumns.push({
      header: `Output CGST ${halfRatePercent}%-${sellerStateAbbr}`,
      get: row => (Math.round(rowRate(row) * 100) === Math.round(rate * 100)) ? Number(row['CGST '] || 0) : 0
    });
    x2betaColumns.push({
      header: `Output SGST ${halfRatePercent}%-${sellerStateAbbr}`,
      get: row => (Math.round(rowRate(row) * 100) === Math.round(rate * 100)) ? Number(row['SGST'] || 0) : 0
    });
  });

  x2betaColumns.push(
    { header: null, get: () => null },
    { header: null, get: () => null },
    { header: 'Narration', get: () => `Cread-${month || ''}-${year || ''}` },
    { header: 'Taxability', get: () => null },
    { header: 'GST Nature', get: () => null },
    { header: 'GST Rate', get: r => Math.round(rowRate(r) * 10000) / 100 },
    { header: 'Cess', get: () => null },
    { header: 'RCM?', get: () => null },
    // Cread's source report carries no HSN column — left blank rather than fabricated.
    { header: 'HSN', get: () => null },
    { header: 'HSN Desc', get: () => null },
    { header: 'Supply Type', get: () => null },
    { header: 'Cost Category', get: () => null },
    { header: 'Cost Centre', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: r => r['Shipping States'] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: r => r['Shipping Zip Code'] || null },
    { header: 'Place of Supply', get: r => r['Shipping States'] || '' }, { header: 'GST Type', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: r => r['Shipping States'] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: r => r['Shipping Zip Code'] || null },
    { header: 'Place', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: r => r['Shipping States'] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: r => r['Shipping Zip Code'] || null },
    { header: 'Place', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'DN No.', get: () => null }, { header: 'DN Date', get: () => null }, { header: 'Doc. No.', get: () => null },
    { header: 'Dis. Through', get: () => null }, { header: 'Destination', get: () => null }, { header: 'Carrier Name', get: () => null },
    { header: 'LR No.', get: () => null }, { header: 'LR Date', get: () => null }, { header: 'Order No.', get: r => r['Reference Code'] || null },
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
  const aoa = [headers, ...workingData.map(row => x2betaColumns.map(c => c.get(row)))];
  return XLSX.utils.aoa_to_sheet(aoa);
}

function buildWorkingSheet(workingData) {
  if (!workingData || workingData.length === 0) return XLSX.utils.aoa_to_sheet([]);

  const COLS = [
    'Reference Code', 'EE Invoice No', 'Order Status', 'Shipping Status',
    'Order Date', 'AWB No', 'Suborder Quantity', 'Item Quantity',
    'SKU', 'Final SKU', 'MIS SKU', 'Shipping Zip Code',
    'Shipping States', 'Party Name', 'Invoice No.',
    'Order Invoice Amount', 'Tax', 'Item Price Excluding Tax',
    'Cred Status', 'Taxable Amount', 'CGST ', 'SGST', 'IGST', 'Final Status'
  ];

  // Row 1: empty (matches reference output), Row 2: headers, Rows 3+: data
  const aoa = [
    COLS.map(() => null),   // empty first row
    COLS,                   // header row
    ...workingData.map(row => COLS.map(col => {
      const val = row[col];
      if (val instanceof Date) return val;
      return val !== undefined ? val : null;
    }))
  ];

  return XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
}

function buildPivotSheet(pivotData) {
  const COLS = [
    'Invoice No.', 'Party Name', 'Tally Sku',
    'Sum of Suborder Quantity', 'Sum of Taxable Amount',
    'Sum of CGST ', 'Sum of SGST', 'Sum of IGST'
  ];

  // Compute grand totals
  let totalQty = 0, totalTaxable = 0, totalCgst = 0, totalSgst = 0, totalIgst = 0;
  pivotData.forEach(r => {
    totalQty     += safeNumber(r['Sum of Suborder Quantity']);
    totalTaxable += safeNumber(r['Sum of Taxable Amount']);
    totalCgst    += safeNumber(r['Sum of CGST ']);
    totalSgst    += safeNumber(r['Sum of SGST']);
    totalIgst    += safeNumber(r['Sum of IGST']);
  });
  const grandTotalRow = ['Grand Total', null, null, totalQty, totalTaxable, totalCgst, totalSgst, totalIgst];

  // Row 1: "Values" label in 4th position (matches Excel pivot table header)
  const labelRow  = ['', '', '', 'Values', '', '', '', ''];
  const headerRow = COLS;
  const dataRows  = pivotData.map(row => COLS.map(col => row[col] !== undefined ? row[col] : null));

  return XLSX.utils.aoa_to_sheet([labelRow, headerRow, ...dataRows, grandTotalRow]);
}

function buildAfterPivotSheet(pivotData) {
  const COLS = [
    'Invoice No.', 'Party Name', 'Tally Sku',
    'Sum of Suborder Quantity', 'Sum of Taxable Amount',
    'Sum of CGST ', 'Sum of SGST', 'Sum of IGST'
  ];

  // Compute column totals for row 1
  let totalTaxable = 0, totalCgst = 0, totalSgst = 0, totalIgst = 0;
  pivotData.forEach(r => {
    totalTaxable += safeNumber(r['Sum of Taxable Amount']);
    totalCgst    += safeNumber(r['Sum of CGST ']);
    totalSgst    += safeNumber(r['Sum of SGST']);
    totalIgst    += safeNumber(r['Sum of IGST']);
  });

  // Row 1: totals in value columns (Invoice/Party/Sku columns are empty)
  const totalsRow = ['', '', '', '', totalTaxable, totalCgst, totalSgst, totalIgst];
  const headerRow = COLS;
  const dataRows = pivotData.map(row => COLS.map(col => row[col] !== undefined ? row[col] : null));

  return XLSX.utils.aoa_to_sheet([totalsRow, headerRow, ...dataRows]);
}

module.exports = { creadProcessor };
