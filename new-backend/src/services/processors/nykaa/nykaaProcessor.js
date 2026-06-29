'use strict';
const XLSX = require('xlsx-js-style');

function safeNum(v) { const n = Number(v); return isNaN(n) ? 0 : n; }

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

function parseBuffer(buffer) {
  const wb = XLSX.read(buffer, { type:'buffer', cellDates:true, raw:false });
  const sheetName = wb.SheetNames[0];
  return { rows: XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval:null }), sheetName };
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

function buildTallyRow(entry, vchDate, monthPadded) {
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
  row[9]  = entry.product_name || '';
  row[10] = null;
  row[11] = 'Main Location';
  row[12] = null;
  row[13] = qty;
  row[14] = Math.abs(base);         // Rate: taxable base per unit (always positive)
  row[15] = 'Pcs';
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
  return row;
}

function buildWorkbook(tallyRows) {
  let totalQty=0, totalAmt=0, totalIGST=0, totalCGST=0, totalSGST=0;
  for (const r of tallyRows) {
    totalQty  += safeNum(r[13]);
    totalAmt  += safeNum(r[17]);
    totalIGST += safeNum(r[19]);
    totalCGST += safeNum(r[20]);
    totalSGST += safeNum(r[21]);
  }
  const summaryRow = new Array(109).fill(null);
  summaryRow[13] = Math.round(totalQty);
  summaryRow[17] = parseFloat(totalAmt.toFixed(3));
  summaryRow[19] = parseFloat(totalIGST.toFixed(3));
  summaryRow[20] = parseFloat(totalCGST.toFixed(3));
  summaryRow[21] = parseFloat(totalSGST.toFixed(3));
  const aoa = [summaryRow, TALLY_HEADERS, ...tallyRows];
  const ws  = XLSX.utils.aoa_to_sheet(aoa);
  const wb  = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Excel to Tally');
  return wb;
}

function nykaaProcessor(cycle1Buffer, cycle2Buffer, monthName, yearStr) {
  const year     = parseInt(yearStr, 10);
  const monthNum = MONTH_NUMS[monthName.toLowerCase()] || 5;
  const monthPad = String(monthNum).padStart(2, '0');
  const { rows: c1Raw, sheetName: s1 } = parseBuffer(cycle1Buffer);
  const { rows: c2Raw, sheetName: s2 } = parseBuffer(cycle2Buffer);

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
  const tallyRows = allEntries.map(e => buildTallyRow(e, vchDate, monthPad));

  const workingFileData = allEntries.map(e => ({
    externorderno: e.externorderno||null, product_sku: e.product_sku||null,
    invoiceno: e.invoiceno||null, product_name: e.product_name||null,
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

  return { outputWorkbook: buildWorkbook(tallyRows), workingFileData, summary };
}

module.exports = { nykaaProcessor };
