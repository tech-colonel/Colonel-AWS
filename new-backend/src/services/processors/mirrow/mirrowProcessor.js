const XLSX = require('xlsx-js-style');

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

  return { outputWorkbook, workingData, pivotData };
}

module.exports = { mirrowProcessor };
