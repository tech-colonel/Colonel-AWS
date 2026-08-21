const XLSX = require('xlsx-js-style');
const { getStateCodeFromName, getStateAbbr } = require('../../../utils/gstStateCodes');
const { createMissingMasterTracker } = require('../../../utils/missingMasterTracker');

/**
 * Safe number conversion
 */
function safeNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const num = Number(value);
  return isNaN(num) ? 0 : num;
}

/**
 * Safe string conversion
 */
function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/**
 * Calculate GST Rate = IGST + CGST + SGST
 */
function calculateGSTRate(row) {
  const igst = safeNumber(row['IGST(%)'] || row['IGST (%)'] || 0);
  const cgst = safeNumber(row['CGST(%)'] || row['CGST (%)'] || 0);
  const sgst = safeNumber(row['SGST(%)'] || row['SGST (%)'] || 0);
  return igst + cgst + sgst;
}

/**
 * Calculate Taxable Value = (Selling Price (Rs) * 100) / (100 + GST Rate)
 */
function calculateTaxableValue(sellingPrice, gstRate) {
  if (!sellingPrice || sellingPrice === 0) return 0;
  if (!gstRate || gstRate === 0) return sellingPrice;
  return (sellingPrice * 100) / (100 + gstRate);
}

/**
 * Process Blinkit raw file and generate all sheets
 * @param {Buffer} rawFileBuffer - Raw Blinkit Excel file buffer
 * @param {Array} skuData - Array of {SKU, FG} objects (optional, for SKU mapping)
 * @param {Array} stateConfigData - Array of state config objects (optional)
 * @param {string} brandName - Brand name
 * @param {string} date - Date string (Month-YYYY)
 * @param {boolean} withInventory - Whether to include inventory/SKU mapping
 * @returns {Object} - { salesReportData, gtReportData, hsnReportData, outputWorkbook, rawDataJson }
 */
async function blinkitProcessor(
  rawFileBuffer,
  skuData = [],
  stateConfigData = [],
  brandName,
  date,
  withInventory = true
) {
  // Read the raw file
  const workbook = XLSX.read(rawFileBuffer, { type: 'buffer', cellDates: true });

  // Get the first sheet
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];

  // Convert to JSON
  const rawData = XLSX.utils.sheet_to_json(worksheet, { defval: null });

  if (!rawData || rawData.length === 0) {
    throw new Error('Raw file is empty or could not be parsed');
  }

  console.log(`Processing ${rawData.length} rows from Blinkit raw file`);

  // Track raw SKU values that aren't found in this brand's SKU master
  const missingMasterTracker = createMissingMasterTracker();

  // Create SKU lookup map
  const skuMap = {};
  if (skuData && skuData.length > 0) {
    skuData.forEach(item => {
      const sku = safeString(item.SKU || item.sku || item['Sales Portal SKU']);
      const fg = safeString(item.FG || item.fg || item['Tally New SKU']);
      if (sku) {
        skuMap[sku] = fg;
      }
    });
  }

  // Process raw data and add calculated columns
  const salesReportData = rawData.map((row, index) => {
    const processedRow = { ...row };

    // Handle Order Date - convert to YYYY-MM-DD format if it's a date object
    if (row['Order Date']) {
      if (row['Order Date'] instanceof Date) {
        const year = row['Order Date'].getFullYear();
        const month = String(row['Order Date'].getMonth() + 1).padStart(2, '0');
        const day = String(row['Order Date'].getDate()).padStart(2, '0');
        processedRow['Order Date'] = `${year}-${month}-${day}`;
      } else if (typeof row['Order Date'] === 'string') {
        // Try to parse string date
        const dateObj = new Date(row['Order Date']);
        if (!isNaN(dateObj.getTime())) {
          const year = dateObj.getFullYear();
          const month = String(dateObj.getMonth() + 1).padStart(2, '0');
          const day = String(dateObj.getDate()).padStart(2, '0');
          processedRow['Order Date'] = `${year}-${month}-${day}`;
        }
      }
    }

    // Calculate GST Rate
    const gstRate = calculateGSTRate(row);
    processedRow['GST Rate'] = gstRate;

    // Calculate Taxable Value
    const sellingPrice = safeNumber(row['Selling Price (Rs)'] || row['Selling Price'] || 0);
    const taxableValue = calculateTaxableValue(sellingPrice, gstRate);
    processedRow['Taxable value'] = taxableValue;

    // Add SKU mapping if withInventory is true
    if (withInventory) {
      const upc = safeString(row['UPC'] || row['upc']);
      if (upc && skuMap[upc]) {
        processedRow['FG'] = skuMap[upc];
      } else if (upc) {
        missingMasterTracker.track({ masterType: 'sku', matchField: 'SKU', value: row['UPC'] || row['upc'] });
      }
    }

    return processedRow;
  });

  // Create GT Report (Group by Customer State)
  const gtReportMap = {};
  salesReportData.forEach(row => {
    const customerState = safeString(row['Customer State'] || row['Customer State'] || 'Unknown');
    const gstRate = safeNumber(row['GST Rate'] || 0);
    const taxableValue = safeNumber(row['Taxable value'] || 0);
    const igstValue = safeNumber(row['IGST Value'] || row['IGST Value'] || 0);
    const cgstValue = safeNumber(row['CGST Value'] || row['CGST Value'] || 0);
    const sgstValue = safeNumber(row['SGST Value'] || row['SGST Value'] || 0);

    // 🔥 KEY CHANGE → group by State + GST Rate
    const key = `${customerState}_${gstRate}`;

    if (!gtReportMap[key]) {
      gtReportMap[key] = {
        'Customer State': customerState,
        'GST Rate': gstRate,
        'Sum of Taxable Value': 0,
        'Sum of IGST Value': 0,
        'Sum of CGST Value': 0,
        'Sum of SGST Value': 0
      };
    }

    gtReportMap[key]['Sum of Taxable Value'] =
      safeNumber(gtReportMap[key]['Sum of Taxable Value']) + taxableValue;

    gtReportMap[key]['Sum of IGST Value'] =
      safeNumber(gtReportMap[key]['Sum of IGST Value']) + igstValue;

    gtReportMap[key]['Sum of CGST Value'] =
      safeNumber(gtReportMap[key]['Sum of CGST Value']) + cgstValue;

    gtReportMap[key]['Sum of SGST Value'] =
      safeNumber(gtReportMap[key]['Sum of SGST Value']) + sgstValue;
    // Update GST Rate (use the maximum or average - using max for now)


    // if (gstRate > gtReportMap[customerState]['GST Rate']) {
    //   gtReportMap[customerState]['GST Rate'] = gstRate;
    // }
  });

  const gtReportData = Object.values(gtReportMap).map(row => ({
    ...row,
    'Sum of Taxable Value': parseFloat(row['Sum of Taxable Value'].toFixed(2)),
    'Sum of IGST Value': parseFloat(row['Sum of IGST Value'].toFixed(2)),
    'Sum of CGST Value': parseFloat(row['Sum of CGST Value'].toFixed(2)),
    'Sum of SGST Value': parseFloat(row['Sum of SGST Value'].toFixed(2))
  }));

  // ================= HSN REPORT =================
  const hsnReportMap = {};

  salesReportData.forEach(row => {

    const hsnCode = safeString(row['HSN Code']) || 'Unknown';
    const gstRate = safeNumber(row['GST Rate']) || 0;

    const quantity = safeNumber(row['Quantity']);
    const taxableValue = safeNumber(row['Taxable value']);
    const igstValue = safeNumber(row['IGST Value']);
    const cgstValue = safeNumber(row['CGST Value']);
    const sgstValue = safeNumber(row['SGST Value']);

    const key = hsnCode + '_' + gstRate;

    // 🔥 Safe initialization
    hsnReportMap[key] = hsnReportMap[key] || {
      'HSN Code': hsnCode,
      'GST Rate': gstRate,
      'Quantity': 0,
      'Sum of Taxable Value': 0,
      'Sum of IGST Value': 0,
      'Sum of CGST Value': 0,
      'Sum of SGST Value': 0
    };

    hsnReportMap[key]['Quantity'] += quantity;
    hsnReportMap[key]['Sum of Taxable Value'] += taxableValue;
    hsnReportMap[key]['Sum of IGST Value'] += igstValue;
    hsnReportMap[key]['Sum of CGST Value'] += cgstValue;
    hsnReportMap[key]['Sum of SGST Value'] += sgstValue;

  });

  const hsnReportData = Object.values(hsnReportMap).map(row => ({
    ...row,
    'Quantity': Number(row['Quantity'].toFixed(2)),
    'Sum of Taxable Value': Number(row['Sum of Taxable Value'].toFixed(2)),
    'Sum of IGST Value': Number(row['Sum of IGST Value'].toFixed(2)),
    'Sum of CGST Value': Number(row['Sum of CGST Value'].toFixed(2)),
    'Sum of SGST Value': Number(row['Sum of SGST Value'].toFixed(2))
  }));

  // Create output workbook with 3 sheets
  const outputWorkbook = XLSX.utils.book_new();

  // Sheet 1: Sales Report (Invoice - GST)
  const salesReportSheet = XLSX.utils.json_to_sheet(salesReportData);
  XLSX.utils.book_append_sheet(outputWorkbook, salesReportSheet, 'Sales Report (Invoice - GST)');

  // Sheet 2: GT Report
  const gtReportSheet = XLSX.utils.json_to_sheet(gtReportData);
  XLSX.utils.book_append_sheet(outputWorkbook, gtReportSheet, 'GT Report');

  // Sheet 3: HSN Report
  const hsnReportSheet = XLSX.utils.json_to_sheet(hsnReportData);
  XLSX.utils.book_append_sheet(outputWorkbook, hsnReportSheet, 'HSN');

  // Sheet 4: X2Beta working — same 108-column Tally e-invoice import
  // template used by the other marketplace processors.
  const x2betaSheet = buildX2betaSheet(salesReportData, date);
  XLSX.utils.book_append_sheet(outputWorkbook, x2betaSheet, 'x2beta working');

  // Extract unique SKUs and states for database storage
  const uniqueSKUs = new Set();
  const uniqueStates = new Set();

  salesReportData.forEach(row => {
    const upc = safeString(row['UPC'] || row['upc']);
    if (upc) {
      uniqueSKUs.add(upc);
    }

    const customerState = safeString(row['Customer State'] || '');
    if (customerState) {
      uniqueStates.add(customerState);
    }
  });

  return {
    salesReportData,
    gtReportData,
    hsnReportData,
    outputWorkbook,
    rawDataJson: rawData,
    uniqueSKUs: Array.from(uniqueSKUs),
    uniqueStates: Array.from(uniqueStates),
    missingMasterValues: missingMasterTracker.list()
  };
}

// ============================================================
// X2BETA WORKING SHEET
// Same 108-column Tally "X2Beta" e-invoice import template used by the
// other marketplace processors. Blinkit's processor has no ledger master,
// no seller-state parameter, and no per-row invoice number/HSN-independent
// identifier at all — unlike every other channel, `stateConfigData` is
// accepted but never used upstream. The IGST/CGST/SGST split is already
// computed per row directly from the source file's own tax columns, so it
// is reused as-is (no seller-state comparison needed to derive it). Party
// Ledger, Vch No. and the Output-column state dimension are all
// synthesized from Customer State (the only per-row location field that
// exists), grouped by month so each state gets one shared voucher number
// across its line items — the same self-contained-numbering approach
// Amazon B2B uses when no external invoice-number master is available.
// ============================================================
function buildX2betaSheet(salesReportData, date) {
  let vchDate;
  let monthPad = '';
  if (date) {
    const parsed = new Date(date);
    if (!isNaN(parsed.getTime())) {
      vchDate = new Date(parsed.getFullYear(), parsed.getMonth() + 1, 0);
      monthPad = String(parsed.getMonth() + 1).padStart(2, '0');
    }
  }
  if (!vchDate) vchDate = new Date();

  function rowStateAbbr(row) {
    const state = row['Customer State'] || '';
    const code = getStateCodeFromName(state);
    return (code && getStateAbbr(code)) || safeString(state).toUpperCase();
  }

  function rowRate(row) {
    return safeNumber(row['GST Rate']);
  }

  const uniqueRates = [...new Set(salesReportData.map(r => rowRate(r)))].filter(r => r > 0);
  const sortedStateCodes = [...new Set(salesReportData.map(r => rowStateAbbr(r)))].filter(Boolean).sort();

  const x2betaColumns = [
    { header: 'Vch. Date* ', get: () => vchDate },
    { header: 'Vch. Type*', get: r => `Sales-${rowStateAbbr(r)}` },
    { header: 'Vch. No.*', get: r => `BLK-${rowStateAbbr(r)}-${monthPad}` },
    { header: 'Ref. No.', get: r => `BLK-${rowStateAbbr(r)}-${monthPad}` },
    { header: 'Ref. Date', get: () => vchDate },
    { header: 'Is CN?', get: () => null },
    { header: 'Is Vch?', get: () => null },
    { header: 'Party Ledger*', get: r => `Blinkit Debtor-${rowStateAbbr(r)}` },
    { header: 'Sales Ledger*', get: r => `Sales Blinkit-${rowStateAbbr(r)} ${rowRate(r)}%` },
    { header: 'Stock Item', get: r => r['FG'] || '' },
    { header: 'Description', get: () => null },
    { header: 'Godown', get: () => null },
    { header: 'Quantity', get: r => safeNumber(r['Quantity']) },
    {
      header: 'Rate',
      get: r => {
        const qty = safeNumber(r['Quantity']);
        return qty !== 0 ? Math.abs(safeNumber(r['Taxable value']) / qty) : 0;
      }
    },
    { header: 'Unit', get: () => 'Pcs' },
    { header: 'Discount', get: () => null },
    { header: 'Amount*', get: r => safeNumber(r['Taxable value']) },
    { header: 'Discount', get: () => null }
  ];

  uniqueRates.forEach(rate => {
    const halfRate = Math.round((rate / 2) * 100) / 100;
    sortedStateCodes.forEach(sc => {
      x2betaColumns.push({
        header: `Output IGST ${rate}%-${sc}`,
        get: row => (rowRate(row) === rate && rowStateAbbr(row) === sc) ? safeNumber(row['IGST Value']) : 0
      });
      x2betaColumns.push({
        header: `Output CGST ${halfRate}%-${sc}`,
        get: row => (rowRate(row) === rate && rowStateAbbr(row) === sc) ? safeNumber(row['CGST Value']) : 0
      });
      x2betaColumns.push({
        header: `Output SGST ${halfRate}%-${sc}`,
        get: row => (rowRate(row) === rate && rowStateAbbr(row) === sc) ? safeNumber(row['SGST Value']) : 0
      });
    });
  });

  x2betaColumns.push(
    { header: null, get: () => null },
    { header: null, get: () => null },
    { header: 'Narration', get: () => `Blinkit-${date || ''}` },
    { header: 'Taxability', get: () => null },
    { header: 'GST Nature', get: () => null },
    { header: 'GST Rate', get: r => rowRate(r) },
    { header: 'Cess', get: () => null },
    { header: 'RCM?', get: () => null },
    { header: 'HSN', get: r => r['HSN Code'] || '' },
    { header: 'HSN Desc', get: () => null },
    { header: 'Supply Type', get: () => null },
    { header: 'Cost Category', get: () => null },
    { header: 'Cost Centre', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: r => r['Customer State'] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
    { header: 'Place of Supply', get: r => r['Customer State'] || '' }, { header: 'GST Type', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: r => r['Customer State'] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
    { header: 'Place', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: r => r['Customer State'] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
    { header: 'Place', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'DN No.', get: () => null }, { header: 'DN Date', get: () => null }, { header: 'Doc. No.', get: () => null },
    { header: 'Dis. Through', get: () => null }, { header: 'Destination', get: () => null }, { header: 'Carrier Name', get: () => null },
    { header: 'LR No.', get: () => null }, { header: 'LR Date', get: () => null }, { header: 'Order No.', get: () => null },
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
  const aoa = [headers, ...salesReportData.map(row => x2betaColumns.map(c => c.get(row)))];
  return XLSX.utils.aoa_to_sheet(aoa);
}

module.exports = {
  blinkitProcessor
};
