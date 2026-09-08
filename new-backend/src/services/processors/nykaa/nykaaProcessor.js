'use strict';
const XLSX = require('xlsx-js-style');

function safeNum(v) { const n = Number(v); return isNaN(n) ? 0 : n; }

// Normalize a SKU value for map lookup (trim + uppercase, collapse internal whitespace)
function normSku(v) {
  return String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, ' ');
}

// Build { normalizedProductSku -> Stock Name } from the uploaded SKU master sheet.
// Expected columns: "Product SKU", "Stock Name" (lenient on header casing / variants).
function buildSkuMap(skuMaster) {
  const map = {};
  if (!Array.isArray(skuMaster)) return map;
  for (const item of skuMaster) {
    if (!item || typeof item !== 'object') continue;
    const sku =
      item['Product SKU'] || item['Product Sku'] || item['product sku'] || item['ProductSKU'] ||
      item['Sales portal SKU'] || item['Sales Portal SKU'] || item['SKU'] || item['sku'] ||
      item.product_sku || item.productSku || item.salesPortalSku || '';
    const stockName =
      item['Stock Name'] || item['Stock name'] || item['stock name'] || item['StockName'] ||
      item['FG'] || item['fg'] || item['Tally new SKU'] || item['Tally New SKU'] ||
      item.stock_name || item.stockName || '';
    const key = normSku(sku);
    if (key) map[key] = String(stockName == null ? '' : stockName).trim();
  }
  return map;
}

function toExcelDate(date) {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  // Use UTC getters to avoid timezone shifts
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000 + 25569;
}

// Nykaa billing cycles end on the 30th of the month (not the calendar last day)
function lastDayOfMonth(year, monthNum) {
  return new Date(Date.UTC(year, monthNum - 1, 30));
}

const STATE_CODES = {
  'andaman and nicobar islands':'AN','andaman & nicobar islands':'AN','andaman & nicobar':'AN',
  'andhra pradesh':'AP','arunachal pradesh':'AR','assam':'AS','bihar':'BR','chandigarh':'CG',
  'chhattisgarh':'CH','dadra and nagar haveli and daman and diu':'DN',
  'dadra & nagar haveli and daman & diu':'DN','dadra and nagar haveli':'DN',
  'daman and diu':'DN','delhi':'DL','goa':'GA',
  'gujarat':'GJ','haryana':'HR','himachal pradesh':'HP','jammu and kashmir':'JK',
  'jammu & kashmir':'JK','jharkhand':'JH','karnataka':'KA','kerala':'KL','ladakh':'LA',
  'lakshadweep':'LD','madhya pradesh':'MP','maharashtra':'MH','manipur':'MN','meghalaya':'MG',
  'mizoram':'MZ','nagaland':'NL','odisha':'OR','orissa':'OR','puducherry':'PY','pondicherry':'PY',
  'punjab':'PB','rajasthan':'RJ','sikkim':'SK','tamil nadu':'TN','telangana':'TS',
  'tripura':'TR','uttar pradesh':'UP','uttarakhand':'UK','uttaranchal':'UK','west bengal':'WB',
};

// STATE_LEDGER_MAP: canonical Tally ledger name per state (for Party Ledger col 7)
const STATE_LEDGER_MAP = {
  'pondicherry': 'Puducherry',
  'dadra and nagar haveli': 'Dadra & Nagar Haveli and Daman & Diu',
  'daman and diu': 'Dadra & Nagar Haveli and Daman & Diu',
  'jammu and kashmir': 'Jammu And Kashmir',
  'jammu & kashmir': 'Jammu And Kashmir',
  'telangana': 'Telangana',
};
// STATE_DISPLAY_MAP: display normalization for State/Place-of-Supply cols (cols 48, 51)
const STATE_DISPLAY_MAP = {
  'pondicherry': 'Puducherry',
  'daman and diu': 'Dadra and Nagar Haveli',
  'telangana': 'Telangana',
};

function normalizeStateName(s) {
  if (!s) return s;
  const key = String(s).trim().toLowerCase();
  return STATE_LEDGER_MAP[key] || String(s).trim();
}
function normalizeStateDisplay(s) {
  if (!s) return s;
  const key = String(s).trim().toLowerCase();
  return STATE_DISPLAY_MAP[key] || String(s).trim();
}

function getStateCode(s) {
  if (!s) return 'XX';
  return STATE_CODES[String(s).trim().toLowerCase()] || String(s).substring(0,2).toUpperCase();
}

function getSalesLedger(p) { return `Nykaa Sales @${safeNum(p)}%`; }

function getTaxSuffix(taxPercent) {
  const t = safeNum(taxPercent);
  if (t === 18) return 'A';
  if (t === 12) return 'B';
  return '';
}

const MONTH_NUMS = {
  january:1,february:2,march:3,april:4,may:5,june:6,
  july:7,august:8,september:9,october:10,november:11,december:12,
};

const TALLY_HEADERS = [
  'Vch. Date* ','Vch. Type*','Vch. No.*','Ref. No.','Ref. Date',
  'Is CN?','Is Vch?','Party Ledger*','Sales Ledger*','Stock Item',
  'Description','Godown','Actual Qty','Quantity','Rate',
  'Unit','Discount','Amount*','Discount','Output IGST',
  'Output CGST','Output SGST',
  null,null,null,null,null,null,null,null,null,
  'CESS','TCS','Round Off','Narration','Taxability',
  'GST Nature','GST Rate','Cess','RCM?','HSN','HSN Desc',
  'Supply Type','Cost Category','Cost Centre',
  'Name','Address 1','Address 2','State','Country',
  'PIN Code','Place of Supply','GST Type','GSTIN',
  'Name','Address 1','Address 2','State','Country','PIN Code','Place','GSTIN',
  'Name','Address 1','Address 2','State','Country','PIN Code','Place','GSTIN',
  'DN No.','DN Date','Doc. No.','Dis. Through','Destination','Carrier Name',
  'LR No.','LR Date','Order No.','Order Date','Term of Delivery','Terms of Paymemt',
  'Other Ref.','Place of Receipt','Vessel/Flight No.','Port of Loading',
  'Port of Discharge','Country to','Shipping Bill No.','Date','Port Code',
  'e-Way Bill No','Date','Cons. e-Way Bill No.','Date',
  'Sub Type','Doc. Type','Distance (KM)','Transporter Name','Transporter ID',
  'Transport Mode','Doc No.','Date','Vehicle No.','Vehicle Type',
  'Status','Note Reason','Orig. Inv. No.','Orig. Inv. Date',
];

// FG (Stock Name from the SKU master) is inserted right after "Stock Item" (index 9),
// shifting every following Tally column one place to the right.
const FG_COL = 10;

function parseBuffer(buffer) {
  const wb = XLSX.read(buffer, { type:'buffer', cellDates:true, raw:false });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  return { rows: XLSX.utils.sheet_to_json(ws, { defval:null }), sheetName, ws };
}

// Determine entry type based on FinalStatus + Previous Final Status from the input file.
// No VLOOKUP needed — the input files already carry the prior-cycle status in "Previous Final Status".
function classifyEntry(row) {
  const fs   = String(row['FinalStatus']          || '').trim();
  const prev = String(row['Previous Final Status'] || '').trim();
  const wasBooked = prev === 'Delivered' || prev === 'Shipped' || prev === 'Not Shipped';
  const isNegative = fs === 'Return' || fs === 'RTO' || fs === 'Cancelled';
  if (isNegative && wasBooked) return 'Credit Note';
  const isPositive = fs === 'Delivered' || fs === 'Shipped' || fs === 'Not Shipped';
  if (isPositive && !prev) return 'Sales';
  if (fs === 'Delivered' && prev === 'Return') return 'Sales'; // status correction
  return null;
}

function buildTallyRow(entry, vchDate, monthPadded, skuMap, withInventory) {
  const wantInv = withInventory !== false;
  const isCN  = entry.entryType === 'Credit Note';
  const rawState = String(entry.order_shipping_state || '').trim();
  const state = normalizeStateName(rawState);       // for Party Ledger (col 7)
  const stateDisplay = normalizeStateDisplay(rawState); // for State/Place-of-Supply (cols 48, 51)
  const code  = getStateCode(state);
  const base  = safeNum(entry.base_value);
  const igst  = safeNum(entry.igst);
  const cgst  = safeNum(entry.cgst);
  const sgst  = safeNum(entry.sgst) + safeNum(entry.ugst);
  const qty   = safeNum(entry.Quantity || entry.quantity) || 1;

  // Voucher number: use the row's own Month column for per-order grouping
  const rowMonth = safeNum(entry.Month) || safeNum(monthPadded);
  const rowMonthPad = String(rowMonth).padStart(2, '0');
  const taxSuffix = getTaxSuffix(entry.tax_percent);
  const vchNo = isCN
    ? `Nykaa-${code}-CN${rowMonthPad}${taxSuffix}`
    : `Nykaa-${code}-${rowMonthPad}${taxSuffix}`;

  const excelDate = toExcelDate(vchDate);
  // CN: amounts and taxes are negative (Tally standard — direction via Vch Type, not Is CN flag alone)
  const sign = isCN ? -1 : 1;

  const row = new Array(109).fill(null);
  row[0]  = excelDate;
  row[1]  = entry.entryType;
  row[2]  = vchNo;
  row[3]  = vchNo;
  row[4]  = excelDate;
  row[5]  = isCN ? 'Yes' : null;
  row[6]  = null;
  row[7]  = `Nykaa Debtor-${state}`;
  row[8]  = getSalesLedger(safeNum(entry.tax_percent));
  // Stock Item now carries the raw-file Product SKU (was product_name).
  // Without-inventory runs are ledger-only vouchers: no stock item / qty / rate / unit / FG.
  const productSku = entry.product_sku != null ? String(entry.product_sku).trim() : '';
  row[9]  = wantInv ? productSku : null;
  row[10] = null;
  row[11] = 'Main Location';
  row[12] = null;
  row[13] = wantInv ? qty : null;
  row[14] = wantInv ? Math.abs(base) : null;   // Rate: taxable base per unit (always positive)
  row[15] = wantInv ? 'Pcs' : null;
  row[16] = null;
  row[17] = sign * base;            // Amount*: negative for CN
  row[18] = null;
  row[19] = sign * igst;            // IGST: negative for CN
  row[20] = sign * cgst;            // CGST: negative for CN
  row[21] = sign * sgst;            // SGST: negative for CN
  row[31] = null; row[32] = null; row[33] = null;
  row[34] = entry._narration || '';
  row[35] = 'Taxable';
  row[42] = 'Goods';
  row[45] = null; row[46] = null; row[47] = null;
  row[48] = stateDisplay;
  row[49] = 'India';
  row[50] = null;
  row[51] = stateDisplay;
  row[52] = 'Unregistered/Consumer';
  row[53] = null;
  // FG: Stock Name mapped from the SKU master by Product SKU (with-inventory only).
  // Inserted right after Stock Item (index 9) — pushes Description..onward one column right.
  const fgValue = wantInv ? ((skuMap && skuMap[normSku(productSku)]) || '') : null;
  row.splice(FG_COL, 0, fgValue);
  return row;
}

// GSTR-1 B2C summary sheet — one row per Seller GSTIN + Final GST Rate +
// Customer's Delivery State, netting Credit Notes against Sales.
// Source columns (from the raw cycle files):
//   Seller GSTIN              <- "Child Vendor GST"
//   Final GST Rate            <- tax_percent
//   Customer's Delivery State <- order_shipping_state
//   Taxable / IGST / CGST / SGST(+UTGST) <- base_value / igst / cgst / sgst + ugst
const GSTR1_HEADERS = [
  'Seller GSTIN',
  'Final GST Rate',
  "Customer's Delivery State",
  'Sum of Taxable Value (Final Invoice Amount -Taxes)',
  'Sum of IGST Amount',
  'Sum of CGST Amount',
  'Sum of SGST Amount (Or UTGST as applicable)',
];

function buildGstr1Rows(allEntries) {
  const map = {};
  for (const e of allEntries) {
    const sign  = e.entryType === 'Credit Note' ? -1 : 1;
    const gstin = String(e['Child Vendor GST'] || '').trim();
    const rate  = safeNum(e.tax_percent);
    const state = String(e.order_shipping_state || '').trim();
    const key   = `${gstin}|${rate}|${state.toLowerCase()}`;
    if (!map[key]) {
      map[key] = {
        'Seller GSTIN': gstin,
        'Final GST Rate': rate,
        "Customer's Delivery State": state,
        'Sum of Taxable Value (Final Invoice Amount -Taxes)': 0,
        'Sum of IGST Amount': 0,
        'Sum of CGST Amount': 0,
        'Sum of SGST Amount (Or UTGST as applicable)': 0,
      };
    }
    const g = map[key];
    g['Sum of Taxable Value (Final Invoice Amount -Taxes)'] += sign * safeNum(e.base_value);
    g['Sum of IGST Amount'] += sign * safeNum(e.igst);
    g['Sum of CGST Amount'] += sign * safeNum(e.cgst);
    g['Sum of SGST Amount (Or UTGST as applicable)'] += sign * (safeNum(e.sgst) + safeNum(e.ugst));
  }
  const round2 = n => parseFloat(n.toFixed(2));
  return Object.values(map).map(g => ({
    ...g,
    'Sum of Taxable Value (Final Invoice Amount -Taxes)': round2(g['Sum of Taxable Value (Final Invoice Amount -Taxes)']),
    'Sum of IGST Amount': round2(g['Sum of IGST Amount']),
    'Sum of CGST Amount': round2(g['Sum of CGST Amount']),
    'Sum of SGST Amount (Or UTGST as applicable)': round2(g['Sum of SGST Amount (Or UTGST as applicable)']),
  }));
}

// GSTR-1 HSN summary sheet — one row per Seller Gstin + Hsn/sac + Rate,
// netting Credit Notes against Sales (same value/tax convention as the gstr1 sheet).
// Source columns (from the raw cycle files):
//   Seller Gstin <- "Child Vendor GST"   Hsn/sac <- hsn_code   Rate <- tax_percent
//   Quantity <- Quantity/quantity   Final Taxable Sales Value <- base_value
//   Final CGST/SGST/IGST Tax <- cgst / sgst + ugst / igst
const GSTR_HSN_HEADERS = [
  'Seller Gstin',
  'Hsn/sac',
  'Rate',
  'Quantity',
  'Final Taxable Sales Value',
  'Final IGST Tax',
  'Final CGST Tax',
  'Final SGST Tax',
];

function buildGstrHsnRows(allEntries) {
  const map = {};
  for (const e of allEntries) {
    const sign  = e.entryType === 'Credit Note' ? -1 : 1;
    const gstin = String(e['Child Vendor GST'] || '').trim();
    const hsn   = String(e.hsn_code == null ? '' : e.hsn_code).trim();
    const rate  = safeNum(e.tax_percent);
    const qty   = safeNum(e.Quantity || e.quantity) || 1;
    const key   = `${gstin}|${hsn}|${rate}`;
    if (!map[key]) {
      map[key] = {
        'Seller Gstin': gstin,
        'Hsn/sac': hsn,
        'Rate': rate,
        'Quantity': 0,
        'Final Taxable Sales Value': 0,
        'Final IGST Tax': 0,
        'Final CGST Tax': 0,
        'Final SGST Tax': 0,
      };
    }
    const h = map[key];
    h['Quantity']                  += sign * qty;
    h['Final Taxable Sales Value']  += sign * safeNum(e.base_value);
    h['Final IGST Tax']            += sign * safeNum(e.igst);
    h['Final CGST Tax']            += sign * safeNum(e.cgst);
    h['Final SGST Tax']            += sign * (safeNum(e.sgst) + safeNum(e.ugst));
  }
  const round2 = n => parseFloat(n.toFixed(2));
  return Object.values(map).map(h => ({
    ...h,
    'Quantity': round2(h['Quantity']),
    'Final Taxable Sales Value': round2(h['Final Taxable Sales Value']),
    'Final IGST Tax': round2(h['Final IGST Tax']),
    'Final CGST Tax': round2(h['Final CGST Tax']),
    'Final SGST Tax': round2(h['Final SGST Tax']),
  }));
}

function buildWorkbook(tallyRows) {
  // tallyRows already have FG spliced in at index 10, so the numeric columns
  // sit one place further right than the raw TALLY_HEADERS template.
  let totalQty=0, totalAmt=0, totalIGST=0, totalCGST=0, totalSGST=0;
  for (const r of tallyRows) {
    totalQty  += safeNum(r[14]);   // Quantity
    totalAmt  += safeNum(r[18]);   // Amount*
    totalIGST += safeNum(r[20]);   // Output IGST
    totalCGST += safeNum(r[21]);   // Output CGST
    totalSGST += safeNum(r[22]);   // Output SGST
  }
  const summaryRow = new Array(110).fill(null);
  summaryRow[14] = Math.round(totalQty);
  summaryRow[18] = parseFloat(totalAmt.toFixed(3));
  summaryRow[20] = parseFloat(totalIGST.toFixed(3));
  summaryRow[21] = parseFloat(totalCGST.toFixed(3));
  summaryRow[22] = parseFloat(totalSGST.toFixed(3));
  const headers = TALLY_HEADERS.slice();
  headers.splice(FG_COL, 0, 'FG');
  const aoa = [summaryRow, headers, ...tallyRows];
  const ws  = XLSX.utils.aoa_to_sheet(aoa);
  const wb  = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Excel to Tally');
  return wb;
}

function nykaaProcessor(cycle1Buffer, cycle2Buffer, monthName, yearStr, skuMaster, withInventory = true) {
  const year     = parseInt(yearStr, 10);
  const monthNum = MONTH_NUMS[monthName.toLowerCase()] || 5;
  const monthPad = String(monthNum).padStart(2, '0');
  const wantInv  = withInventory !== false;
  const skuMap   = wantInv ? buildSkuMap(skuMaster) : {};
  const { rows: c1Raw, sheetName: s1, ws: c1Ws } = parseBuffer(cycle1Buffer);
  const { rows: c2Raw, sheetName: s2, ws: c2Ws } = parseBuffer(cycle2Buffer);

  const c1Narration = (c1Raw[0] && c1Raw[0].Period) ? c1Raw[0].Period : s1;
  const c2Narration = (c2Raw[0] && c2Raw[0].Period) ? c2Raw[0].Period : s2;

  // Single voucher date for all entries: last day of the processing month
  const vchDate = lastDayOfMonth(year, monthNum);

  // Process C1 rows independently using Previous Final Status
  const c1Entries = [];
  for (const row of c1Raw) {
    const entryType = classifyEntry(row);
    if (entryType) c1Entries.push({ ...row, entryType, _narration: row.Period || c1Narration, _cycle: 'C1' });
  }

  // Process C2 rows independently using Previous Final Status
  const c2Entries = [];
  for (const row of c2Raw) {
    const entryType = classifyEntry(row);
    if (entryType) c2Entries.push({ ...row, entryType, _narration: row.Period || c2Narration, _cycle: 'C2' });
  }

  const allEntries = [...c1Entries, ...c2Entries];
  const tallyRows = allEntries.map(e => buildTallyRow(e, vchDate, monthPad, skuMap, wantInv));

  const workingFileData = allEntries.map(e => ({
    externorderno: e.externorderno||null, product_sku: e.product_sku||null,
    invoiceno: e.invoiceno||null, product_name: e.product_name||null,
    fg: wantInv ? (skuMap[normSku(e.product_sku)] || null) : null,
    cycle: e._cycle, entry_type: e.entryType,
    final_status: String(e['FinalStatus']||'').trim(),
    prev_status: String(e['Previous Final Status']||'').trim(),
    base_value: safeNum(e.base_value), igst: safeNum(e.igst), cgst: safeNum(e.cgst),
    sgst: safeNum(e.sgst)+safeNum(e.ugst), quantity: safeNum(e.Quantity||e.quantity)||1,
    state: String(e.order_shipping_state||'').trim(), tax_percent: safeNum(e.tax_percent),
    month: safeNum(e.Month), narration: e._narration,
  }));

  let totalQty=0, salesAmt=0, salesIGST=0, salesCGST=0, salesSGST=0;
  let cnAmt=0, cnIGST=0, cnCGST=0, cnSGST=0;
  for (const r of workingFileData) {
    totalQty += r.quantity;
    if (r.entry_type === 'Sales') {
      salesAmt += r.base_value; salesIGST += r.igst; salesCGST += r.cgst; salesSGST += r.sgst;
    } else {
      cnAmt += r.base_value; cnIGST += r.igst; cnCGST += r.cgst; cnSGST += r.sgst;
    }
  }
  const summary = {
    totalRows: workingFileData.length,
    c1Count: c1Entries.length,
    c2Count: c2Entries.length,
    salesCount: workingFileData.filter(r => r.entry_type === 'Sales').length,
    cnCount: workingFileData.filter(r => r.entry_type === 'Credit Note').length,
    totalQty: Math.round(totalQty),
    salesAmount:  parseFloat(salesAmt.toFixed(2)),
    salesIGST:    parseFloat(salesIGST.toFixed(2)),
    salesCGST:    parseFloat(salesCGST.toFixed(2)),
    salesSGST:    parseFloat(salesSGST.toFixed(2)),
    cnAmount:     parseFloat(cnAmt.toFixed(2)),
    cnIGST:       parseFloat(cnIGST.toFixed(2)),
    cnCGST:       parseFloat(cnCGST.toFixed(2)),
    cnSGST:       parseFloat(cnSGST.toFixed(2)),
    totalAmount:  parseFloat((salesAmt - cnAmt).toFixed(2)),
    totalIGST:    parseFloat((salesIGST - cnIGST).toFixed(2)),
    totalCGST:    parseFloat((salesCGST - cnCGST).toFixed(2)),
    totalSGST:    parseFloat((salesSGST - cnSGST).toFixed(2)),
  };

  const outputWorkbook = buildWorkbook(tallyRows);
  const gstr1Rows = buildGstr1Rows(allEntries);
  XLSX.utils.book_append_sheet(
    outputWorkbook,
    XLSX.utils.json_to_sheet(gstr1Rows, { header: GSTR1_HEADERS }),
    'gstr1'
  );
  const gstrHsnRows = buildGstrHsnRows(allEntries);
  XLSX.utils.book_append_sheet(
    outputWorkbook,
    XLSX.utils.json_to_sheet(gstrHsnRows, { header: GSTR_HSN_HEADERS }),
    'gstr-hsn'
  );

  // Carry both uploaded raw files through into the output workbook, verbatim.
  const rawSheet = (ws, rows) => (ws && ws['!ref']) ? ws : XLSX.utils.json_to_sheet(rows || []);
  XLSX.utils.book_append_sheet(outputWorkbook, rawSheet(c1Ws, c1Raw), 'raw 1-15');
  XLSX.utils.book_append_sheet(outputWorkbook, rawSheet(c2Ws, c2Raw), 'raw 16-30');

  return { outputWorkbook, workingFileData, summary, gstr1Rows, gstrHsnRows };
}

module.exports = { nykaaProcessor };
