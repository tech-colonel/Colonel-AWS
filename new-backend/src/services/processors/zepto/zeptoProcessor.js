const XLSX = require('xlsx-js-style');
const { getStateCodeFromName, getStateAbbr } = require('../../../utils/gstStateCodes');
const { createMissingMasterTracker } = require('../../../utils/missingMasterTracker');

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

  // Track raw SKU/City values that aren't found in this brand's SKU/Ledger master
  const missingMasterTracker = createMissingMasterTracker();

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
    if (withInventory && !skuMap[skuName] && skuName) {
      missingMasterTracker.track({ masterType: 'sku', matchField: 'SKU', value: row['SKU Name'] });
    }
    const fg = skuEntry.fg || '';
    const taxRate = safeNumber(skuEntry.rate || 0);

    const ledgerEntry = ledgerMap[cityKey] || {};
    if (!ledgerMap[cityKey] && cityKey) {
      missingMasterTracker.track({ masterType: 'ledger', matchField: 'City', value: row['City'] });
    }
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

  // X2Beta working — same 108-column Tally e-invoice import template used by
  // the other marketplace processors.
  const x2betaSheet = buildX2betaSheet(workingData, month, year, sellingState);
  XLSX.utils.book_append_sheet(outputWorkbook, x2betaSheet, 'x2beta working');

  return { outputWorkbook, workingData, pivotData, missingMasterValues: missingMasterTracker.list() };
}

// ============================================================
// X2BETA WORKING SHEET
// Same 108-column Tally "X2Beta" e-invoice import template used by the
// other marketplace processors. Zepto is a single-GSTIN business (one
// `sellingState`), and its ledger master already resolves a real Tally
// Ledger + Invoice Number per city — reused directly here. No return/CN
// handling exists upstream, so none is added here either.
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

  const uniqueRates = [...new Set(workingData.map(r => Number(r['Tax'] || 0)))].filter(r => r > 0);

  const x2betaColumns = [
    { header: 'Vch. Date* ', get: r => rowVchDate(r) },
    { header: 'Vch. Type*', get: () => `Sales-${sellerStateAbbr}` },
    { header: 'Vch. No.*', get: r => r['Invoice Number'] || '' },
    { header: 'Ref. No.', get: r => r['Invoice Number'] || '' },
    { header: 'Ref. Date', get: r => rowVchDate(r) },
    { header: 'Is CN?', get: () => null },
    { header: 'Is Vch?', get: () => null },
    { header: 'Party Ledger*', get: r => r['Tally Ledger'] || '' },
    { header: 'Sales Ledger*', get: r => `Sales Zepto-${sellerStateAbbr} ${Number(r['Tax'] || 0)}%` },
    { header: 'Stock Item', get: r => r['FG'] || r['SKU Name'] || '' },
    { header: 'Description', get: r => r['SKU Name'] || '' },
    { header: 'Godown', get: r => r['State'] || '' },
    { header: 'Quantity', get: r => Number(r['Sales (Qty) - Units'] || 0) },
    {
      header: 'Rate',
      get: r => {
        const qty = Number(r['Sales (Qty) - Units'] || 0);
        return qty !== 0 ? Math.abs(Number(r['Taxable Value'] || 0) / qty) : 0;
      }
    },
    { header: 'Unit', get: r => r['Unit of Measure'] || 'Pcs' },
    { header: 'Discount', get: () => null },
    { header: 'Amount*', get: r => Number(r['Taxable Value'] || 0) },
    { header: 'Discount', get: () => null }
  ];

  uniqueRates.forEach(rate => {
    const halfRate = Math.round((rate / 2) * 100) / 100;
    x2betaColumns.push({
      header: `Output IGST ${rate}%-${sellerStateAbbr}`,
      get: row => (Number(row['Tax'] || 0) === rate) ? Number(row['IGST'] || 0) : 0
    });
    x2betaColumns.push({
      header: `Output CGST ${halfRate}%-${sellerStateAbbr}`,
      get: row => (Number(row['Tax'] || 0) === rate) ? Number(row['CGST'] || 0) : 0
    });
    x2betaColumns.push({
      header: `Output SGST ${halfRate}%-${sellerStateAbbr}`,
      get: row => (Number(row['Tax'] || 0) === rate) ? Number(row['SGST'] || 0) : 0
    });
  });

  x2betaColumns.push(
    { header: null, get: () => null },
    { header: null, get: () => null },
    { header: 'Narration', get: () => `Zepto-${month || ''}-${year || ''}` },
    { header: 'Taxability', get: () => null },
    { header: 'GST Nature', get: () => null },
    { header: 'GST Rate', get: r => Number(r['Tax'] || 0) },
    { header: 'Cess', get: () => null },
    { header: 'RCM?', get: () => null },
    // Zepto's source report carries no HSN column — left blank rather than fabricated.
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
    { header: 'LR No.', get: () => null }, { header: 'LR Date', get: () => null }, { header: 'Order No.', get: r => r['SKU Number'] || null },
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

module.exports = { zeptoProcessor };
