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
  // Convert DD-MM-YYYY → YYYY-MM-DD (ISO) for PostgreSQL
  const str = String(val).trim();
  const ddmmyyyy = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (ddmmyyyy) {
    const [, dd, mm, yyyy] = ddmmyyyy;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return str || null;
}

/**
 * Process Zepto raw file and generate working + GSTR pivot sheets
 * @param {Buffer} rawFileBuffer
 * @param {Array}  skuData        - SKU master rows: { Tally New SKU, Sales Portal SKU, Rate }
 * @param {Array}  ledgerData     - Ledger master rows: { City, States, Ledger, Invoice No. }
 * @param {string} brandName
 * @param {string} month          - e.g. "April"
 * @param {string} year           - e.g. "2026"
 * @param {string} sellingState   - state from which Zepto ships (for IGST/CGST split)
 * @param {boolean} withInventory
 */
async function zeptoProcessor(
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

  console.log(`Processing ${rawData.length} rows from Zepto raw file`);

  // SKU map: Sales Portal SKU → { fg, rate }
  const skuMap = {};
  skuData.forEach(item => {
    const key = safeString(
      item['Sales Portal SKU'] || item['Sales portal SKU'] || item.salesPortalSku || ''
    );
    if (!key) return;
    skuMap[key] = {
      fg: safeString(item['Tally New SKU'] || item['Tally new SKU'] || item.tallyNewSku || item.FG || item.fg || ''),
      rate: safeNumber(item['Rate'] || item.rate || 0)
    };
  });

  // Ledger map: city (lowercase) → { states, ledger, invoiceNo }
  const ledgerMap = {};
  ledgerData.forEach(item => {
    const city = safeString(item['City'] || item.city || '').toLowerCase();
    if (!city) return;
    ledgerMap[city] = {
      states: safeString(item['States'] || item.states || item['State'] || item.state || ''),
      ledger: safeString(item['Ledger'] || item.ledger || ''),
      invoiceNo: safeString(item['Invoice No.'] || item['Invoice No'] || item['Invoice Number'] || item.invoiceNo || '')
    };
  });

  const monthNum = MONTH_NUM[safeString(month).toLowerCase()] || '';
  const sellingStateLower = safeString(sellingState).toLowerCase();

  const workingData = rawData.map(row => {
    const skuName = safeString(row['SKU Name'] || '');
    const cityKey = safeString(row['City'] || '').toLowerCase();

    const skuEntry = withInventory ? (skuMap[skuName] || {}) : {};
    const fg = skuEntry.fg || '';
    const taxRate = safeNumber(skuEntry.rate || 0);

    const ledgerEntry = ledgerMap[cityKey] || {};
    const state = ledgerEntry.states || '';
    const tallyLedger = ledgerEntry.ledger || '';
    const baseInvoice = ledgerEntry.invoiceNo || '';
    const invoiceNumber = baseInvoice && monthNum ? `${baseInvoice}-${monthNum}` : baseInvoice;

    const gmv = safeNumber(row['Gross Merchandise Value'] || 0);
    const taxableValue = taxRate > 0 ? gmv / (1 + taxRate / 100) : gmv;
    const taxAmount = (taxableValue / 100) * taxRate;

    let igst = 0, cgst = 0, sgst = 0;
    const stateLower = state.toLowerCase();
    if (sellingStateLower && stateLower && stateLower === sellingStateLower) {
      console.log("stateLower", stateLower);
      console.log("sellingStateLower", sellingStateLower);
      // Intra-state: CGST + SGST only
      cgst = taxAmount / 2;
      sgst = taxAmount / 2;
    } else {
      // Inter-state: IGST only
      igst = taxAmount;
    }

    // Preserve column insertion order for output Excel
    return {
      'Date': formatDate(row['Date']),
      'SKU Number': row['SKU Number'] || '',
      'SKU Name': skuName,
      'FG': fg,
      'EAN': row['EAN'] || '',
      'SKU Category': row['SKU Category'] || '',
      'SKU Sub Category': row['SKU Sub Category'] || '',
      'Brand Name': row['Brand Name'] || '',
      'Manufacturer Name': row['Manufacturer Name'] || '',
      'Manufacturer ID': row['Manufacturer ID'] || '',
      'City': row['City'] || '',
      'State': state,
      'Tally Ledger': tallyLedger,
      'Invoice Number': invoiceNumber,
      'Sales (Qty) - Units': safeNumber(row['Sales (Qty) - Units'] || 0),
      'MRP': safeNumber(row['MRP'] || 0),
      'Selling Price': safeNumber(row['Selling Price'] || 0),
      'Gross Merchandise Value': gmv,
      'Gross Selling Value': safeNumber(row['Gross Selling Value'] || 0),
      'Pack Size': safeNumber(row['Pack Size'] || 0),
      'Unit of Measure': row['Unit of Measure'] || '',
      'Orders': safeNumber(row['Orders'] || 0),
      'Tax': taxRate,
      'Taxable Value': parseFloat(taxableValue.toFixed(2)),
      'IGST': parseFloat(igst.toFixed(2)),
      'CGST': parseFloat(cgst.toFixed(2)),
      'SGST': parseFloat(sgst.toFixed(2))
    };
  });

  // Pivot: group by Tally Ledger + FG + Invoice Number
  const pivotMap = {};
  workingData.forEach(row => {
    const key = `${row['Tally Ledger']}|${row['FG']}|${row['Invoice Number']}`;
    if (!pivotMap[key]) {
      pivotMap[key] = {
        'Tally Ledger': row['Tally Ledger'],
        'FG': row['FG'],
        'Invoice Number': row['Invoice Number'],
        'Sum of Sales (Qty) - Units': 0,
        'Sum of Taxable Value': 0,
        'Sum of IGST': 0,
        'Sum of CGST': 0,
        'Sum of SGST': 0
      };
    }
    pivotMap[key]['Sum of Sales (Qty) - Units'] += safeNumber(row['Sales (Qty) - Units']);
    pivotMap[key]['Sum of Taxable Value']        += safeNumber(row['Taxable Value']);
    pivotMap[key]['Sum of IGST']                 += safeNumber(row['IGST']);
    pivotMap[key]['Sum of CGST']                 += safeNumber(row['CGST']);
    pivotMap[key]['Sum of SGST']                 += safeNumber(row['SGST']);
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

module.exports = { zeptoProcessor };
