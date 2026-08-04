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

const MONTH_NUM = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12'
};

function formatDate(val) {
  if (!val) return null;
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null;
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const str = String(val).trim();
  const ddmmyyyy = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (ddmmyyyy) {
    const [, dd, mm, yyyy] = ddmmyyyy;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return str || null;
}

/**
 * Process Mirrow raw file and generate working + GSTR pivot sheets
 */
async function mirrowProcessor(
  rawFileBuffer,
  skuData = [],
  ledgerData = [],
  brandName,
  month,
  year,
  sellingState = '',
  withInventory = true
) {
  const workbook = XLSX.read(rawFileBuffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const rawData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null });

  if (!rawData || rawData.length === 0) {
    throw new Error('Raw file is empty or could not be parsed');
  }

  console.log(`Processing ${rawData.length} rows from Mirrow raw file`);

  // SKU Map: Sales Portal SKU -> { fg, rate }
  const skuMap = {};
  skuData.forEach(item => {
    const key = safeString(
      item['Sales Portal SKU'] || item['Sales portal SKU'] || item.salesPortalSku || item.SKU || item.sku || ''
    );
    if (!key) return;
    skuMap[key.toLowerCase()] = {
      fg: safeString(item['Tally New SKU'] || item['Tally new SKU'] || item.tallyNewSku || item.FG || item.fg || ''),
      rate: safeNumber(item['Rate'] || item.rate || 0)
    };
  });

  // Ledger map: state/city (lowercase) -> { states, ledger, invoiceNo }
  const ledgerMap = {};
  ledgerData.forEach(item => {
    // Check state first, fallback to city
    const stateKey = safeString(item['States'] || item.states || item['State'] || item.state || '').toLowerCase();
    const cityKey = safeString(item['City'] || item.city || '').toLowerCase();
    const mapKey = stateKey || cityKey;
    if (!mapKey) return;
    ledgerMap[mapKey] = {
      states: safeString(item['States'] || item.states || item['State'] || item.state || ''),
      ledger: safeString(item['Ledger'] || item.ledger || ''),
      invoiceNo: safeString(item['Invoice No.'] || item['Invoice No'] || item['Invoice Number'] || item.invoiceNo || '')
    };
  });

  const monthNum = MONTH_NUM[safeString(month).toLowerCase()] || '';
  const sellingStateLower = safeString(sellingState).toLowerCase();

  const workingData = rawData.map(row => {
    // Look up key fields with fallback spellings
    const dateVal = row['Date'] || row['Order Date'] || row['date'] || null;
    const orderId = safeString(row['Order ID'] || row['order_id'] || row['Order ID / No.'] || '');
    const sku = safeString(row['SKU'] || row['sku'] || row['Product SKU'] || row['SKU Name'] || '');
    const productName = safeString(row['Product Name'] || row['product_name'] || row['Item Name'] || row['SKU Name'] || '');
    const city = safeString(row['City'] || row['city'] || row['Shipping City'] || '');
    const rawState = safeString(row['State'] || row['state'] || row['Shipping State'] || '');

    // SKU lookup
    const skuEntry = withInventory ? (skuMap[sku.toLowerCase()] || skuMap[productName.toLowerCase()] || {}) : {};
    const fg = skuEntry.fg || '';
    const taxRate = safeNumber(skuEntry.rate || 0);

    // Ledger lookup - try state first, then city
    const ledgerEntry = ledgerMap[rawState.toLowerCase()] || ledgerMap[city.toLowerCase()] || {};
    const state = ledgerEntry.states || rawState;
    const tallyLedger = ledgerEntry.ledger || '';
    const baseInvoice = ledgerEntry.invoiceNo || '';
    const invoiceNumber = baseInvoice && monthNum ? `${baseInvoice}-${monthNum}` : baseInvoice;

    // Financial calculations
    const qty = safeNumber(row['Quantity'] || row['quantity'] || row['Qty'] || 0);
    const mrp = safeNumber(row['MRP'] || row['mrp'] || 0);
    const sellingPrice = safeNumber(row['Selling Price'] || row['selling_price'] || row['Price'] || 0);
    const totalAmount = sellingPrice * qty;

    const taxableValue = taxRate > 0 ? totalAmount / (1 + taxRate / 100) : totalAmount;
    const taxAmount = (taxableValue / 100) * taxRate;

    let igst = 0, cgst = 0, sgst = 0;
    const stateLower = state.toLowerCase();
    if (sellingStateLower && stateLower && stateLower === sellingStateLower) {
      cgst = taxAmount / 2;
      sgst = taxAmount / 2;
    } else {
      igst = taxAmount;
    }

    return {
      'Date': formatDate(dateVal),
      'Order ID': orderId,
      'SKU': sku,
      'Product Name': productName,
      'Quantity': qty,
      'MRP': mrp,
      'Selling Price': sellingPrice,
      'Taxable Value': parseFloat(taxableValue.toFixed(2)),
      'GST Rate': taxRate,
      'CGST': parseFloat(cgst.toFixed(2)),
      'SGST': parseFloat(sgst.toFixed(2)),
      'IGST': parseFloat(igst.toFixed(2)),
      'Total Amount': parseFloat(totalAmount.toFixed(2)),
      'State': state,
      'City': city,
      'Tally Ledger': tallyLedger,
      'Invoice Number': invoiceNumber,
      'FG': fg
    };
  });

  // Pivot: Group by Tally Ledger + FG + Invoice Number
  const pivotMap = {};
  workingData.forEach(row => {
    const key = `${row['Tally Ledger']}|${row['FG']}|${row['Invoice Number']}`;
    if (!pivotMap[key]) {
      pivotMap[key] = {
        'Tally Ledger': row['Tally Ledger'],
        'FG': row['FG'],
        'Invoice Number': row['Invoice Number'],
        'Sum of Quantity': 0,
        'Sum of Taxable Value': 0,
        'Sum of IGST': 0,
        'Sum of CGST': 0,
        'Sum of SGST': 0
      };
    }
    pivotMap[key]['Sum of Quantity']      += safeNumber(row['Quantity']);
    pivotMap[key]['Sum of Taxable Value'] += safeNumber(row['Taxable Value']);
    pivotMap[key]['Sum of IGST']          += safeNumber(row['IGST']);
    pivotMap[key]['Sum of CGST']          += safeNumber(row['CGST']);
    pivotMap[key]['Sum of SGST']          += safeNumber(row['SGST']);
  });

  const pivotData = Object.values(pivotMap).map(r => ({
    ...r,
    'Sum of Taxable Value': parseFloat(r['Sum of Taxable Value'].toFixed(2)),
    'Sum of IGST':          parseFloat(r['Sum of IGST'].toFixed(2)),
    'Sum of CGST':          parseFloat(r['Sum of CGST'].toFixed(2)),
    'Sum of SGST':          parseFloat(r['Sum of SGST'].toFixed(2))
  }));

  const outputWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(outputWorkbook, XLSX.utils.json_to_sheet(workingData), 'Working');
  XLSX.utils.book_append_sheet(outputWorkbook, XLSX.utils.json_to_sheet(pivotData), 'Pivot');

  // X2Beta working — same 108-column Tally e-invoice import template used by
  // the other marketplace processors.
  const x2betaSheet = buildX2betaSheet(workingData, month, year, sellingState);
  XLSX.utils.book_append_sheet(outputWorkbook, x2betaSheet, 'x2beta working');

  return { outputWorkbook, workingData, pivotData };
}

// ============================================================
// X2BETA WORKING SHEET
// Same 108-column Tally "X2Beta" e-invoice import template used by the
// other marketplace processors. Mirrow is a single-GSTIN business (one
// `sellingState`), and its ledger master already resolves a real Tally
// Ledger + Invoice Number per shipping state/city — reused directly here.
// No return/CN handling exists upstream, so none is added here either.
// ============================================================
function buildX2betaSheet(workingData, month, year, sellingState) {
  const monthNum = MONTH_NUM[safeString(month).toLowerCase()];
  const yearNum = parseInt(year, 10);
  const fallbackVchDate = (monthNum && !isNaN(yearNum)) ? new Date(yearNum, Number(monthNum), 0) : new Date();

  function rowVchDate(row) {
    const d = new Date(row['Date']);
    if (!isNaN(d.getTime())) return d;
    return fallbackVchDate;
  }

  const sellerCode = getStateCodeFromName(sellingState);
  const sellerStateAbbr = (sellerCode && getStateAbbr(sellerCode)) || safeString(sellingState);

  const uniqueRates = [...new Set(workingData.map(r => Number(r['GST Rate'] || 0)))].filter(r => r > 0);

  const x2betaColumns = [
    { header: 'Vch. Date* ', get: r => rowVchDate(r) },
    { header: 'Vch. Type*', get: () => `Sales-${sellerStateAbbr}` },
    { header: 'Vch. No.*', get: r => r['Invoice Number'] || '' },
    { header: 'Ref. No.', get: r => r['Invoice Number'] || '' },
    { header: 'Ref. Date', get: r => rowVchDate(r) },
    { header: 'Is CN?', get: () => null },
    { header: 'Is Vch?', get: () => null },
    { header: 'Party Ledger*', get: r => r['Tally Ledger'] || '' },
    { header: 'Sales Ledger*', get: r => `Sales Mirrow-${sellerStateAbbr} ${Number(r['GST Rate'] || 0)}%` },
    { header: 'Stock Item', get: r => r['FG'] || r['Product Name'] || '' },
    { header: 'Description', get: r => r['Product Name'] || '' },
    { header: 'Godown', get: r => r['State'] || '' },
    { header: 'Quantity', get: r => Number(r['Quantity'] || 0) },
    {
      header: 'Rate',
      get: r => {
        const qty = Number(r['Quantity'] || 0);
        return qty !== 0 ? Math.abs(Number(r['Taxable Value'] || 0) / qty) : 0;
      }
    },
    { header: 'Unit', get: () => 'Pcs' },
    { header: 'Discount', get: () => null },
    { header: 'Amount*', get: r => Number(r['Taxable Value'] || 0) },
    { header: 'Discount', get: () => null }
  ];

  uniqueRates.forEach(rate => {
    const halfRate = Math.round((rate / 2) * 100) / 100;
    x2betaColumns.push({
      header: `Output IGST ${rate}%-${sellerStateAbbr}`,
      get: row => (Number(row['GST Rate'] || 0) === rate) ? Number(row['IGST'] || 0) : 0
    });
    x2betaColumns.push({
      header: `Output CGST ${halfRate}%-${sellerStateAbbr}`,
      get: row => (Number(row['GST Rate'] || 0) === rate) ? Number(row['CGST'] || 0) : 0
    });
    x2betaColumns.push({
      header: `Output SGST ${halfRate}%-${sellerStateAbbr}`,
      get: row => (Number(row['GST Rate'] || 0) === rate) ? Number(row['SGST'] || 0) : 0
    });
  });

  x2betaColumns.push(
    { header: null, get: () => null },
    { header: null, get: () => null },
    { header: 'Narration', get: () => `Mirrow-${month || ''}-${year || ''}` },
    { header: 'Taxability', get: () => null },
    { header: 'GST Nature', get: () => null },
    { header: 'GST Rate', get: r => Number(r['GST Rate'] || 0) },
    { header: 'Cess', get: () => null },
    { header: 'RCM?', get: () => null },
    // Mirrow's source report carries no HSN column — left blank rather than fabricated.
    { header: 'HSN', get: () => null },
    { header: 'HSN Desc', get: () => null },
    { header: 'Supply Type', get: () => null },
    { header: 'Cost Category', get: () => null },
    { header: 'Cost Centre', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: r => r['State'] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
    { header: 'Place of Supply', get: r => r['State'] || '' }, { header: 'GST Type', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: r => r['State'] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
    { header: 'Place', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: r => r['State'] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
    { header: 'Place', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'DN No.', get: () => null }, { header: 'DN Date', get: () => null }, { header: 'Doc. No.', get: () => null },
    { header: 'Dis. Through', get: () => null }, { header: 'Destination', get: () => null }, { header: 'Carrier Name', get: () => null },
    { header: 'LR No.', get: () => null }, { header: 'LR Date', get: () => null }, { header: 'Order No.', get: r => r['Order ID'] || null },
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

module.exports = { mirrowProcessor };
