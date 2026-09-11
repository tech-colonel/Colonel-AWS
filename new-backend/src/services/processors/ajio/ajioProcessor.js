const XLSX = require('xlsx-js-style');
const { createMissingMasterTracker } = require('../../../utils/missingMasterTracker');

// ============================================================================
// AJIO (Reliance Retail — DropShip) sales working
//
// Two raw inputs:
//   • DropShip Order Report  → "Sales" sheet + Sales rows of "Excel to tally"
//   • DropShip RTV Report    → "Sales return" sheet + Credit-Note rows of "Excel to tally"
//
// SOP (AJIO RTV & ORDER REPORT SOP):
//   ORDER  — Status ∈ {Delivered, Shipped, Ready to Shipped, New} counts as a sale.
//            Seller Invoice No/Date → Vch No/Date, Base Price → Rate, Total Price →
//            Taxable Value, Cust Order No → Narration. CGST = SGST = Taxable × 2.5%.
//   RTV    — Return Order Number → Vch No, Return Created Date → Invoice Date,
//            Return Qty → Quantity, Credit Note Pre Tax Value → Taxable Value,
//            FWD B2B Invoice No/Date → Ref No/Date. When Credit Note Pre Tax Value
//            is blank: Taxable = FWD B2B Invoice Amt / (100 + GST Rate) × 100.
//   Party Ledger = "Reliance Retail Limited (AJIO)", Sales Ledger = "Ajio Sales-B2B@5%".
//
// AJIO DropShip is a B2B, single-GSTIN, intra-state (Maharashtra) flow — every
// sample line is CGST + SGST, so tax is always split (no IGST branch).
// ============================================================================

const GST_RATE_PERCENT = 5;                    // Ajio Sales-B2B@5%
const HALF_RATE = GST_RATE_PERCENT / 2 / 100;  // 0.025 — CGST share == SGST share

const PARTY_LEDGER = 'Reliance Retail Limited (AJIO)';
const SALES_LEDGER = 'Ajio Sales-B2B@5%';

// Constant AJIO Mumbai DropShip DC block (buyer / consignee). Overridable from the
// ledger master when a single-row master with address fields is supplied.
const AJIO_BUYER = {
  name: 'AJIO-DS-9626-MUM , Reliance Retail Limited',
  address: 'Unit 106 C&B Square Sangram\nComplex 127,Andheri Kurla Road\nAndheri East 0\nMUMBAI\nMaharashtra 400059',
  state: 'Maharashtra',
  country: 'India',
  pin: 400059,
  place: 'Maharashtra',
  gstType: 'Regular',
  gstin: '27AABCR1718E1ZP'
};

// Order-report statuses that book as a sale (SOP §2)
const SALE_STATUSES = new Set(['delivered', 'shipped', 'ready to ship', 'ready to shipped', 'new']);

// RTV rows to book as a credit note: the return has physically come back
// (Return Delivered Date populated) and a taxable basis is resolvable.
// RETURN_CREATED / blank status, or a return still in transit, are held for a
// later month — matching how the manual working only "takes" delivered returns.
const RETURN_STATUSES = new Set(['return_delivered', 'return_processed', 'credit_note_created']);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_ABBR = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const num = Number(String(value).replace(/,/g, ''));
  return isNaN(num) ? 0 : num;
}

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function round2(n) {
  return Math.round((safeNumber(n) + Number.EPSILON) * 100) / 100;
}

// Parse the two AJIO date shapes: "Fri Aug 14 16:43:42 IST 2026" and "2026-08-14".
function parseAjioDate(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const s = safeString(value);
  if (!s) return null;

  let m = s.match(/^\w{3}\s+(\w{3})\s+(\d{1,2})\s+\d{1,2}:\d{2}:\d{2}\s+(?:[A-Z]{2,4}\s+)?(\d{4})$/);
  if (m) {
    const mo = MONTH_ABBR[m[1].toLowerCase()];
    if (mo !== undefined) return new Date(Number(m[3]), mo, Number(m[2]));
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Case/space/underscore-tolerant field lookup over a raw row object.
function pick(row, ...names) {
  for (const n of names) {
    if (n in row && row[n] !== undefined) return row[n];
  }
  const keys = Object.keys(row);
  for (const n of names) {
    const norm = n.toLowerCase().replace(/[\s_-]+/g, '');
    const hit = keys.find(k => k.toLowerCase().replace(/[\s_-]+/g, '') === norm);
    if (hit) return row[hit];
  }
  return undefined;
}

function firstOfMonth(month, year) {
  let idx = -1;
  const s = safeString(month).toLowerCase();
  if (/^\d+$/.test(s)) idx = parseInt(s, 10) - 1;
  else idx = MONTHS.findIndex(mn => mn.toLowerCase() === s);
  const y = parseInt(year, 10) || new Date().getFullYear();
  if (idx < 0 || idx > 11) return new Date(y, 0, 1);
  return new Date(y, idx, 1);
}

function sheetToObjects(ws) {
  return XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
}

function headerList(ws) {
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  return (aoa[0] || []).map(h => safeString(h)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// SKU master → { stockName, cost } keyed by Seller SKU (upper-cased, trimmed)
// ---------------------------------------------------------------------------
function buildSkuMap(skuData) {
  const map = {};
  (skuData || []).forEach(item => {
    const key = safeString(pick(item, 'Seller SKU', 'SELLER SKU', 'SKU', 'Sales Portal SKU', 'Portal SKU', 'Style Code')).toUpperCase();
    if (!key) return;
    map[key] = {
      stockName: safeString(pick(item, 'Stock Name as per tally', 'Stock Name', 'Stock Item', 'Tally Item Name', 'Tally New SKU', 'FG', 'Item Name')),
      cost: safeNumber(pick(item, 'COST', 'Cost', 'Cost Price', 'Rate', 'Purchase Rate'))
    };
  });
  return map;
}

// Optional single-row ledger master overriding the constant buyer block / ledgers.
function resolveConfig(ledgerData) {
  const cfg = {
    partyLedger: PARTY_LEDGER,
    salesLedger: SALES_LEDGER,
    buyer: { ...AJIO_BUYER }
  };
  const row = (ledgerData || [])[0];
  if (!row) return cfg;
  const p = safeString(pick(row, 'Party Ledger*', 'Party Ledger', 'Party Name', 'Ledger'));
  const s = safeString(pick(row, 'Sales Ledger', 'Sales Ledger*'));
  if (p) cfg.partyLedger = p;
  if (s) cfg.salesLedger = s;
  const bn = safeString(pick(row, 'Name', 'Buyer Name', 'Address 1'));
  if (bn) cfg.buyer.name = bn;
  const ba = safeString(pick(row, 'Address 2', 'Address', 'Buyer Address'));
  if (ba) cfg.buyer.address = ba;
  const st = safeString(pick(row, 'State'));
  if (st) { cfg.buyer.state = st; cfg.buyer.place = st; }
  const pin = pick(row, 'PIN Code', 'PIN', 'Pincode');
  if (pin) cfg.buyer.pin = safeNumber(pin);
  const g = safeString(pick(row, 'GSTIN', 'GSTN', 'GST No'));
  if (g) cfg.buyer.gstin = g;
  return cfg;
}

// ---------------------------------------------------------------------------
// Per-row tax rate — raw CGST% + SGST% when populated, else the flat 5% slab.
// ---------------------------------------------------------------------------
function orderRatePercent(row) {
  const c = safeNumber(pick(row, 'CGST_PERCENTAGE', 'CGST %', 'CGST Percentage'));
  const s = safeNumber(pick(row, 'SGST_PERCENTAGE', 'SGST %', 'SGST Percentage'));
  return (c + s) > 0 ? (c + s) : GST_RATE_PERCENT;
}

function returnRatePercent(row) {
  const c = safeNumber(pick(row, 'CGST PERCENTAGE', 'CGST %'));
  const s = safeNumber(pick(row, 'SGST PERCENTAGE', 'SGST %'));
  return (c + s) > 0 ? (c + s) : GST_RATE_PERCENT;
}

async function ajioProcessor(
  orderFileBuffer,
  rtvFileBuffer,
  skuData = [],
  ledgerData = [],
  brandName = '',
  month = '',
  year = '',
  withInventory = true
) {
  if (!orderFileBuffer) throw new Error('AJIO order report file is required');
  if (!rtvFileBuffer) throw new Error('AJIO RTV (returns) report file is required');

  const orderWb = XLSX.read(orderFileBuffer, { type: 'buffer', cellDates: true });
  const rtvWb = XLSX.read(rtvFileBuffer, { type: 'buffer', cellDates: true });

  const orderWs = orderWb.Sheets[orderWb.SheetNames[0]];
  const rtvWs = rtvWb.Sheets[rtvWb.SheetNames[0]];

  const rawOrders = sheetToObjects(orderWs);
  const rawRtv = sheetToObjects(rtvWs);
  const orderHeaders = headerList(orderWs);
  const rtvHeaders = headerList(rtvWs);

  if (!rawOrders.length) throw new Error('AJIO order report is empty or could not be parsed');

  const skuMap = buildSkuMap(skuData);
  const cfg = resolveConfig(ledgerData);
  const tracker = createMissingMasterTracker();

  const vchDate = firstOfMonth(month, year);

  const lookupSku = (sellerSku, forTrack) => {
    const key = safeString(sellerSku).toUpperCase();
    const hit = key ? skuMap[key] : null;
    if (withInventory && key && !hit) {
      tracker.track({ masterType: 'sku', matchField: 'Seller SKU', value: sellerSku });
    }
    return {
      stockName: withInventory ? (hit ? hit.stockName : '') : '',
      cost: withInventory && hit ? hit.cost : 0
    };
  };

  // ==========================================================================
  // 1. SALES  — every raw order row, verbatim, plus the appended tally block.
  //    Tally columns are filled only for sale-status rows (SOP §2).
  // ==========================================================================
  const APPENDED_SALES_COLS = [
    'Remarks', 'Voucher Date', 'Invoice Date', 'Voucher Type', 'GSTN',
    'Party Ledger*', 'Sales Ledger', 'Stock Name as per tally',
    'Output CGST', 'Output SGST', 'COST', 'Cost*Qty', 'Narration',
    null,
    'Address 1', 'Address 2', 'State', 'Country', 'PIN Code', 'Place of Supply', 'GST Type', 'GSTIN',
    'Name', 'Address 1', 'Address 2', 'State', 'Country', 'PIN Code', 'Place', 'GSTIN'
  ];

  const buyerBlock = () => ([
    cfg.buyer.name, cfg.buyer.address, cfg.buyer.state, cfg.buyer.country, cfg.buyer.pin, cfg.buyer.place, cfg.buyer.gstType, cfg.buyer.gstin,
    null,
    cfg.buyer.name, cfg.buyer.address, cfg.buyer.state, cfg.buyer.country, cfg.buyer.pin, cfg.buyer.place, cfg.buyer.gstin
  ]);

  const salesRows = [];          // structured, for DB + tally + summary
  const salesSheetAoa = [[...orderHeaders, ...APPENDED_SALES_COLS]];

  rawOrders.forEach(row => {
    const status = safeString(pick(row, 'Status')).toLowerCase();
    const sellerSku = safeString(pick(row, 'Seller SKU'));
    const custOrderNo = safeString(pick(row, 'Cust Order No', 'Cust Order No.'));
    const invNo = safeString(pick(row, 'Seller Invoice No', 'Seller Invoice No.'));
    // A sale-status row is only bookable once it carries a Seller Invoice No —
    // an un-invoiced "New" / "Ready to Ship" order has no voucher number yet.
    const isSale = SALE_STATUSES.has(status) && !!invNo;
    const invDate = parseAjioDate(pick(row, 'Seller Invoice Date'));
    // "New" / "Ready to Ship" rows carry Shipped QTY 0 — fall back to Order Qty
    // (the invoice is still raised for the ordered quantity).
    const qty = safeNumber(pick(row, 'Shipped QTY', 'Shipped Qty')) || safeNumber(pick(row, 'Order Qty', 'Order QTY')) || 1;
    const rate = safeNumber(pick(row, 'Base Price'));
    let taxable = safeNumber(pick(row, 'Total Price'));
    if (!taxable) taxable = rate * qty;

    const { stockName, cost } = isSale ? lookupSku(sellerSku) : { stockName: '', cost: 0 };
    const cgst = isSale ? round2(taxable * HALF_RATE * 1e5) / 1e5 : 0; // keep full precision (taxable * 0.025)
    const cgstAmt = isSale ? taxable * HALF_RATE : 0;

    const rawValues = orderHeaders.map(h => (row[h] !== undefined ? row[h] : null));

    if (isSale) {
      salesSheetAoa.push([
        ...rawValues,
        null,                               // Remarks
        invDate, invDate, 'Sales', cfg.buyer.gstin,
        cfg.partyLedger, cfg.salesLedger, stockName,
        cgstAmt, cgstAmt,
        withInventory ? cost : null,
        withInventory ? cost * (qty || 0) : null,
        custOrderNo,
        ...buyerBlock()
      ]);

      salesRows.push({
        recordType: 'sale',
        status: safeString(pick(row, 'Status')),
        voucherNo: invNo,
        voucherDate: invDate,
        invoiceDate: invDate,
        custOrderNo,
        sellerSku,
        hsn: safeString(pick(row, 'HSN')),
        stockName,
        description: safeString(pick(row, 'Description')),
        quantity: qty,
        rate,
        taxableValue: taxable,
        cgstAmount: cgstAmt,
        sgstAmount: cgstAmt,
        igstAmount: 0,
        totalValue: taxable + cgstAmt * 2,
        cost,
        costQty: cost * (qty || 0),
        ratePercent: orderRatePercent(row)
      });
    } else {
      // non-sale (Cancelled / PO created …) — raw row retained, tally block blank
      salesSheetAoa.push([...rawValues, ...APPENDED_SALES_COLS.map(() => null)]);
    }
  });

  // "Sales" sheet order: by Seller Invoice No (string asc); rows without an
  // invoice first, ordered by Cust Order No.
  const headerRow = salesSheetAoa[0];
  const invIdx = orderHeaders.indexOf('Seller Invoice No');
  const custIdx = orderHeaders.indexOf('Cust Order No');
  const body = salesSheetAoa.slice(1).sort((a, b) => {
    const ai = safeString(a[invIdx]), bi = safeString(b[invIdx]);
    if (ai && bi) return ai < bi ? -1 : ai > bi ? 1 : 0;
    if (ai || bi) return ai ? 1 : -1;
    return safeString(a[custIdx]) < safeString(b[custIdx]) ? -1 : 1;
  });
  const salesSheet = XLSX.utils.aoa_to_sheet([headerRow, ...body], { cellDates: true });

  salesRows.sort((a, b) => (a.voucherNo < b.voucherNo ? -1 : a.voucherNo > b.voucherNo ? 1 : 0));

  // ==========================================================================
  // 2. SALES RETURN  — RTV rows booked as credit notes.
  // ==========================================================================
  const APPENDED_RETURN_COLS = [
    'Voucher Date', 'Invoice Date', 'Voucher Type', 'GSTN',
    'Party Ledger*', 'Sales Ledger', 'Stock Name as per tally',
    'Output CGST', 'Output SGST', 'COST', 'Cost*Qty', 'Narration'
  ];

  const returnRows = [];
  const returnSheetAoa = [['Month', ...rtvHeaders, ...APPENDED_RETURN_COLS]];

  rawRtv.forEach(row => {
    const retStatus = safeString(pick(row, 'Return Status')).toLowerCase();
    const returnDelivered = safeString(pick(row, 'Return Delivered Date'));
    const cnPreTax = safeNumber(pick(row, 'Credit Note Pre Tax Value'));
    const b2bAmt = safeNumber(pick(row, 'FWD B2B INVOICE Amt', 'FWD B2B Invoice Amt'));

    const included = RETURN_STATUSES.has(retStatus) && returnDelivered && (cnPreTax > 0 || b2bAmt > 0);
    if (!included) return;

    const retCreated = parseAjioDate(pick(row, 'Return Created Date'));
    const qty = safeNumber(pick(row, 'Return QTY', 'Return Qty')) || 1;
    const ratePct = returnRatePercent(row);
    const taxable = cnPreTax > 0
      ? cnPreTax
      : round2((b2bAmt / (100 + ratePct)) * 100);

    const sellerSku = safeString(pick(row, 'SELLER SKU', 'Seller SKU'));
    const custOrderNo = safeString(pick(row, 'Cust Order No', 'Cust Order No.'));
    const b2bInvNo = safeString(pick(row, 'FWD B2B INVOICE No', 'FWD B2B Invoice No'));
    const b2bInvDate = parseAjioDate(pick(row, 'FWD B2B INVOICE Date', 'FWD B2B Invoice Date'));
    const monthName = retCreated ? MONTHS[retCreated.getMonth()] : '';

    const { stockName, cost } = lookupSku(sellerSku);
    const cgstAmt = taxable * HALF_RATE;

    const rawValues = rtvHeaders.map(h => (row[h] !== undefined ? row[h] : null));
    returnSheetAoa.push([
      monthName,
      ...rawValues,
      vchDate, retCreated, 'Credit Note', cfg.buyer.gstin,
      cfg.partyLedger, cfg.salesLedger, stockName,
      cgstAmt, cgstAmt,
      withInventory ? cost : null,
      withInventory ? cost * qty : null,
      custOrderNo
    ]);

    returnRows.push({
      recordType: 'return',
      month: monthName,
      voucherNo: safeString(pick(row, 'RETURN ORDER NUMBER', 'Return Order Number')),
      voucherDate: vchDate,
      invoiceDate: retCreated,
      refNo: b2bInvNo,
      refDate: b2bInvDate,
      custOrderNo,
      sellerSku,
      hsn: safeString(pick(row, 'HSN')),
      stockName,
      quantity: qty,
      rate: qty ? taxable / qty : taxable,
      taxableValue: taxable,
      cgstAmount: cgstAmt,
      sgstAmount: cgstAmt,
      igstAmount: 0,
      totalValue: taxable + cgstAmt * 2,
      cost,
      costQty: cost * qty,
      ratePercent: ratePct
    });
  });

  const returnSheet = XLSX.utils.aoa_to_sheet(returnSheetAoa, { cellDates: true });

  // ==========================================================================
  // 3. EXCEL TO TALLY  — 109-column Tally import: Credit Notes first, then Sales.
  // ==========================================================================
  const tallySheet = buildTallySheet(returnRows, salesRows, cfg, withInventory);

  // ==========================================================================
  // OUTPUT WORKBOOK
  // ==========================================================================
  const outputWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(outputWorkbook, salesSheet, 'Sales');
  XLSX.utils.book_append_sheet(outputWorkbook, returnSheet, 'Sales return');
  XLSX.utils.book_append_sheet(outputWorkbook, tallySheet, 'Excel to tally');

  return {
    outputWorkbook,
    salesRows,
    returnRows,
    tallyRowCount: returnRows.length + (withInventory
      ? salesRows.length
      : new Set(salesRows.map(r => r.voucherNo)).size),
    missingMasterValues: tracker.list()
  };
}

// ---------------------------------------------------------------------------
// Tally "Excel to tally" sheet
// ---------------------------------------------------------------------------
function buildTallySheet(returnRows, salesRows, cfg, withInventory) {
  const b = cfg.buyer;
  // 45 = Name (blank), 46..53 carry the block; 54 = Name (blank), 55..61 carry it.
  const addressTail = () => ([
    null, b.name, b.address, b.state, b.country, b.pin, b.place, b.gstType, b.gstin,   // 45..53
    null, b.name, b.address, b.state, b.country, b.pin, b.place, b.gstin               // 54..61
  ]);

  const HEADERS = [
    'Vch. Date* ', 'Vch. Type*', 'Vch. No.*', 'Ref. No.', 'Ref. Date', 'Is CN?', 'Is Vch?',
    'Party Ledger*', 'Sales Ledger*', 'Stock Item', 'Description', 'Godown', 'Actual Qty',
    'Quantity', 'Rate', 'Unit', 'Discount', 'Amount*', 'Discount', 'Output CGST', 'Output SGST',
    null, null, null, null, null, null, null, null, null, null, null, null,
    'Round Off', 'Narration', 'Taxability', 'GST Nature', 'GST Rate', 'Cess', 'RCM?', 'HSN',
    'HSN Desc', 'Supply Type', 'Cost Category', 'Cost Centre',
    'Name', 'Address 1', 'Address 2', 'State', 'Country', 'PIN Code', 'Place of Supply', 'GST Type', 'GSTIN',
    'Name', 'Address 1', 'Address 2', 'State', 'Country', 'PIN Code', 'Place', 'GSTIN',
    'Name', 'Address 1', 'Address 2', 'State', 'Country', 'PIN Code', 'Place', 'GSTIN',
    'DN No.', 'DN Date', 'Doc. No.', 'Dis. Through', 'Destination', 'Carrier Name', 'LR No.', 'LR Date',
    'Order No.', 'Order Date', 'Term of Delivery', 'Terms of Paymemt', 'Other Ref.', 'Place of Receipt',
    'Vessel/Flight No.', 'Port of Loading', 'Port of Discharge', 'Country to', 'Shipping Bill No.', 'Date',
    'Port Code', 'e-Way Bill No', 'Date', 'Cons. e-Way Bill No.', 'Date', 'Sub Type', 'Doc. Type',
    'Distance (KM)', 'Transporter Name', 'Transporter ID', 'Transport Mode', 'Doc No.', 'Date',
    'Vehicle No.', 'Vehicle Type', 'Status', 'Note Reason', 'Orig. Inv. No.', 'Orig. Inv. Date'
  ];
  const WIDTH = HEADERS.length;

  const pad = (arr) => {
    const r = arr.slice(0, WIDTH);
    while (r.length < WIDTH) r.push(null);
    return r;
  };

  const mkRow = ({ vchDate, vchType, vchNo, refNo, refDate, isCn, stockItem, godown,
    qty, rate, unit, amount, cgst, sgst, narration, sign }) => {
    const row = new Array(WIDTH).fill(null);
    row[0] = vchDate;
    row[1] = vchType;
    row[2] = vchNo;
    row[3] = refNo || null;
    row[4] = refDate || null;
    row[5] = isCn ? 'Yes' : null;
    row[7] = cfg.partyLedger;
    row[8] = cfg.salesLedger;
    row[9] = withInventory ? (stockItem || null) : null;
    row[11] = withInventory ? (godown || null) : null;
    row[13] = withInventory ? qty : null;                       // Quantity
    row[14] = withInventory ? (qty ? Math.abs(amount / qty) : 0) : null; // Rate
    row[15] = withInventory ? unit : null;
    row[17] = sign * Math.abs(amount);                          // Amount*
    row[19] = sign * Math.abs(cgst);
    row[20] = sign * Math.abs(sgst);
    row[34] = narration || null;
    row[35] = 'Taxable';
    row[42] = 'Goods';
    const tail = addressTail();
    for (let i = 0; i < tail.length; i++) row[45 + i] = tail[i];
    return pad(row);
  };

  const aoa = [pad(HEADERS)];

  // Credit Notes
  returnRows.forEach(r => {
    aoa.push(mkRow({
      vchDate: r.voucherDate, vchType: 'Credit Note', vchNo: r.voucherNo,
      refNo: r.refNo, refDate: r.refDate, isCn: true,
      stockItem: r.stockName, godown: 'Main Location',
      qty: r.quantity, unit: 'Pcs', amount: r.taxableValue,
      cgst: r.cgstAmount, sgst: r.sgstAmount, narration: r.custOrderNo, sign: -1
    }));
  });

  // Sales — with inventory: one row per order line; without: grouped by voucher.
  let saleLines = salesRows;
  if (!withInventory) {
    const g = new Map();
    salesRows.forEach(r => {
      const e = g.get(r.voucherNo) || { ...r, quantity: 0, taxableValue: 0, cgstAmount: 0, sgstAmount: 0 };
      e.quantity += r.quantity;
      e.taxableValue += r.taxableValue;
      e.cgstAmount += r.cgstAmount;
      e.sgstAmount += r.sgstAmount;
      g.set(r.voucherNo, e);
    });
    saleLines = [...g.values()];
  }
  saleLines.forEach(r => {
    aoa.push(mkRow({
      vchDate: r.voucherDate, vchType: 'Sales', vchNo: r.voucherNo,
      refNo: r.voucherNo, refDate: r.invoiceDate, isCn: false,
      stockItem: r.stockName, godown: 'Main Location',
      qty: r.quantity, unit: 'Pcs', amount: r.taxableValue,
      cgst: r.cgstAmount, sgst: r.sgstAmount, narration: r.custOrderNo, sign: 1
    }));
  });

  return XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
}

module.exports = { ajioProcessor };
