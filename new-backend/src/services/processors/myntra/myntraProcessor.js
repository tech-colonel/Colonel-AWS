const XLSX = require('xlsx-js-style');
const { getStateAbbr } = require('../../../utils/gstStateCodes');
const { createMissingMasterTracker } = require('../../../utils/missingMasterTracker');

/**
 * Safe number conversion
 */
function safeNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const num = Number(value);
  return isNaN(num) ? 0 : num;
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    return null;
  }
  return date;
}

/**
 * Get month number from date string (Month-YYYY format)
 */
function getMonthNumberFromDateString(dateString) {
  if (!dateString) return null;
  try {
    const parts = dateString.split('-');
    if (parts.length >= 2) {
      const monthNames = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
      ];
      const monthName = parts[0];
      const monthIndex = monthNames.findIndex(m => m.toLowerCase() === monthName.toLowerCase());
      if (monthIndex !== -1) {
        return monthIndex + 1; // 1-12
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Get last date of month from date string (Month-YYYY format)
 */
function getLastDateOfMonthFromDateString(dateString) {
  if (!dateString) return null;

  const parts = dateString.split('-');
  if (parts.length < 2) return null;

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  const monthIndex = monthNames.findIndex(
    m => m.toLowerCase() === parts[0].toLowerCase()
  );

  const year = parseInt(parts[1], 10);
  if (monthIndex === -1 || isNaN(year)) return null;

  // LAST DAY OF MONTH as Date object ✅
  return new Date(year, monthIndex + 1, 0);
}


/**
 * Get month number from transaction date
 */
function getMonthFromTransactionDate(dateValue) {
  if (!dateValue) return null;
  try {
    const date = new Date(dateValue);
    if (isNaN(date.getTime())) return null;
    return date.getMonth() + 1; // 1-12
  } catch (e) {
    return null;
  }
}

/**
 * Normalize state name for comparison
 */
function normalizeStateName(state) {
  if (!state) return '';
  return String(state).trim().toLowerCase();
}

/**
 * Get column letter from column number (1 = A, 2 = B, etc.)
 */
function getColLetterFromNum(colNum) {
  let result = '';
  let num = colNum;
  while (num > 0) {
    num--;
    result = String.fromCharCode(65 + (num % 26)) + result;
    num = Math.floor(num / 26);
  }
  return result;
}

/**
 * Add formulas to pivot sheet for calculated columns
 * @param {Object} sheet - XLSX sheet object
 * @param {Array} data - Array of row objects
 * @param {Array} headers - Array of header names
 * @returns {Object} - XLSX sheet with formulas added
 */
function addFormulasToPivotSheet(sheet, data, headers) {
  if (!data || data.length === 0) return sheet;

  // Find column indices
  const getColIndex = (headerName) => {
    const index = headers.indexOf(headerName);
    return index >= 0 ? index + 1 : null; // +1 because Excel is 1-based
  };

  const rateCol = getColIndex('Rate');
  const cgstCol = getColIndex('CGST Amount');
  const sgstCol = getColIndex('SGST Amount');
  const igstCol = getColIndex('IGST Amount');
  const taxableCol = getColIndex('Base Value');

  // Add formulas for Rate column if all required columns exist
  if (rateCol && cgstCol && sgstCol && igstCol && taxableCol) {
    const rateColLetter = getColLetterFromNum(rateCol);
    const cgstColLetter = getColLetterFromNum(cgstCol);
    const sgstColLetter = getColLetterFromNum(sgstCol);
    const igstColLetter = getColLetterFromNum(igstCol);
    const taxableColLetter = getColLetterFromNum(taxableCol);

    // Add formula for each data row (starting from row 2, row 1 is header)
    for (let i = 0; i < data.length; i++) {
      const rowNum = i + 2; // +2 because row 1 is header
      const cellAddress = `${rateColLetter}${rowNum}`;

      // Formula: IF(taxableValue<>0, (CGST+SGST+IGST)/taxableValue, 0)
      const formula = `IF(${taxableColLetter}${rowNum}<>0,(${cgstColLetter}${rowNum}+${sgstColLetter}${rowNum}+${igstColLetter}${rowNum})/${taxableColLetter}${rowNum},0)`;

      if (!sheet[cellAddress]) {
        sheet[cellAddress] = {};
      }
      sheet[cellAddress].f = formula;
      // Keep the calculated value
      if (data[i].rate !== undefined) {
        sheet[cellAddress].v = data[i].rate;
        sheet[cellAddress].t = 'n';
      }
    }
  }

  return sheet;
}

/**
 * Add formulas to tally ready sheet for calculated columns
 * @param {Object} sheet - XLSX sheet object created from array of arrays
 * @param {Array} headers - Array of header names
 * @param {number} dataRowCount - Number of data rows (excluding header)
 * @returns {Object} - XLSX sheet with formulas added
 */
function addFormulasToTallySheet(sheet, headers, dataRowCount) {
  if (!headers || dataRowCount === 0) return sheet;

  // Find column indices
  const getColIndex = (headerName) => {
    const index = headers.indexOf(headerName);
    return index >= 0 ? index + 1 : null; // +1 because Excel is 1-based
  };

  const ratePerPieceCol = getColIndex('Rate per piece');
  const quantityCol = getColIndex('Quantity');
  const amountCol = getColIndex('Amount');

  // Add formulas for Rate per piece column if all required columns exist
  if (ratePerPieceCol && quantityCol && amountCol) {
    const ratePerPieceColLetter = getColLetterFromNum(ratePerPieceCol);
    const quantityColLetter = getColLetterFromNum(quantityCol);
    const amountColLetter = getColLetterFromNum(amountCol);

    // Add formula for each data row (starting from row 2, row 1 is header)
    for (let i = 0; i < dataRowCount; i++) {
      const rowNum = i + 2; // +2 because row 1 is header
      const cellAddress = `${ratePerPieceColLetter}${rowNum}`;

      // Formula: IF(Quantity<>0, Amount/Quantity, 0)
      const formula = `IF(${quantityColLetter}${rowNum}<>0,${amountColLetter}${rowNum}/${quantityColLetter}${rowNum},0)`;

      if (!sheet[cellAddress]) {
        sheet[cellAddress] = {};
      }
      sheet[cellAddress].f = formula;
    }
  }

  return sheet;
}

/**
 * Parse CSV file buffer
 */
function parseCSV(csvBuffer) {
  try {
    const workbook = XLSX.read(csvBuffer, { type: 'buffer', cellDates: true });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) {
      throw new Error('No worksheet found in CSV file');
    }
    // Convert to JSON with header row
    const data = XLSX.utils.sheet_to_json(worksheet, { defval: null, raw: false });
    return data;
  } catch (error) {
    throw new Error(`Failed to parse CSV: ${error.message}`);
  }
}

function generateTallyReady(pivotRows, fileDate, withInventory) {

  const safeNumber = (v) => {
    const n = Number(v);
    return isNaN(n) ? 0 : n;
  };

  // ---------- PARSE FILE DATE ----------
  let voucherDate = new Date();
  if (fileDate) {
    const d = new Date(fileDate);
    if (!isNaN(d)) {
      voucherDate = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    }
  }

  // ---------- BASE HEADERS ----------
  const headers = [
    'Vch. Date',
    'Vch. Type',
    'Vch. No.',
    'Ref. No.',
    'Ref. Date',
    'Party Ledger',
    'Sales Ledger',
    'Stock Item',
    'Quantity',
    'Rate per piece',
    'Rate',
    'Unit',
    'Discount',
    'Amount',
    'Discount'
  ];

  const tallyRows = [];

  // 🔑 rate → starting column index
  const rateColumnMap = {}; // { 0.05: startIndex, 0.12: startIndex }

  pivotRows.forEach(row => {

    const invoiceNo = row.seller_gstin;
    if (!invoiceNo) return;

    const quantity = safeNumber(row.sum_of_quantity);
    const rate = safeNumber(row.rate);
    const stockItem = withInventory ? row.fg : '';
    const amount = safeNumber(row.sum_of_base_value);
    const ratePerPiece = quantity !== 0 ? +(amount / quantity).toFixed(2) : 0;
    const cgst =
      safeNumber(row.sum_of_cgst_amount);

    const sgst =
      safeNumber(row.sum_of_sgst_amount);

    const igst =
      safeNumber(row.sum_of_igst_amount);

    // ---------- CREATE NEW COLUMNS IF RATE IS NEW ----------
    if (rate > 0 && !rateColumnMap[rate]) {

      const startIndex = headers.length;

      headers.push(`CGST ${rate / 2}`);
      headers.push(`SGST ${rate / 2}`);
      headers.push(`IGST ${rate}`);

      rateColumnMap[rate] = startIndex;

      // 🧠 Backfill ZERO for all previous rows
      tallyRows.forEach(r => {
        r.push(0, 0, 0);
      });
    }

    // ---------- BUILD ROW ----------
    const rowArray = [
      voucherDate,
      'Sales',
      invoiceNo,
      invoiceNo,
      voucherDate,
      row.tally_ledgers,
      row.final_invoice_no,
      stockItem,
      quantity,
      ratePerPiece,
      rate,
      '',
      '',
      amount,
      ''
    ];

    // Fill zeros for all existing GST columns
    const gstColsCount = headers.length - rowArray.length;
    for (let i = 0; i < gstColsCount; i++) {
      rowArray.push(0);
    }

    // ---------- FILL VALUES ONLY IN THIS RATE’S COLUMNS ----------
    if (rateColumnMap[rate] !== undefined) {
      const idx = rateColumnMap[rate];
      rowArray[idx] = cgst;
      rowArray[idx + 1] = sgst;
      rowArray[idx + 2] = igst;
    }

    tallyRows.push(rowArray);
  });

  console.log(`✓ Generated ${tallyRows.length} tally rows`);
  console.log('GST rate columns:', rateColumnMap);

  return {
    headers,
    data: tallyRows
  };
}

function generateShippingTallyReady(pivotRows, fileDate, withInventory) {

  function normalizeGstRate(rawRate) {
    if (!rawRate || rawRate <= 0) return 0;

    // Force numeric
    const rate = Number(rawRate);

    // ---------- GST SLAB RANGES ----------
    if (rate >= 0.04 && rate <= 0.06) return 0.05;
    if (rate >= 0.11 && rate <= 0.13) return 0.12;
    if (rate >= 0.17 && rate <= 0.19) return 0.18;

    // 🚨 Outside expected GST ranges
    console.warn(`⚠ Unmapped GST rate detected: ${rate}`);
    return rawRate;
  }

  function addShipToVchNo(vchNo) {
    if (!vchNo || typeof vchNo !== 'string') return vchNo;

    // Insert -SHIP after first 3 characters
    return vchNo.slice(0, 3) + '-SHIP' + vchNo.slice(3);
  }



  // ---------- SAFE NUMBER ----------
  const safeNumber = (value) => {
    if (value === null || value === undefined || value === '') return 0;
    if (typeof value === 'string') {
      const cleaned = value.replace(/,/g, '').trim();
      const num = Number(cleaned);
      return isNaN(num) ? 0 : num;
    }
    const num = Number(value);
    return isNaN(num) ? 0 : num;
  };

  // ---------- NORMALIZE GST RATE IN PIVOT ROWS ----------
  pivotRows.forEach(row => {
    const rawRate = safeNumber(row.rate);
    row['_NormalizedRate'] = normalizeGstRate(rawRate);
  });

  // ---------- COLLECT UNIQUE GST RATES ----------
  const uniqueRatesSet = new Set();

  pivotRows.forEach(row => {
    const rate = row['_NormalizedRate'];
    if (rate > 0) {
      uniqueRatesSet.add(rate);
    }
  });

  const uniqueRates = Array.from(uniqueRatesSet).sort((a, b) => a - b);

  // Define headers (including duplicate Discount column)
  const headers = [
    'Vch. Date',
    'Vch. Type',
    'Vch. No.',
    'Ref. No.',
    'Ref. Date',
    'Party Ledger',
    'Sales Ledger',
    'Rate',
    'Amount',
  ];

  // ---------- ADD GST HEADERS PER RATE ----------
  uniqueRates.forEach(rate => {
    headers.push(`CGST ${rate / 2}`);
    headers.push(`SGST ${rate / 2}`);
    headers.push(`IGST ${rate}`);
  });
  const tallyRows = [];


  // ---------- PARSE FILE DATE ----------
  // fileDate format: YYYY-MM-DD, convert to Date object
  let voucherDate;

  if (fileDate) {
    const parsedDate = new Date(fileDate);

    if (!isNaN(parsedDate.getTime())) {
      const year = parsedDate.getFullYear();
      const month = parsedDate.getMonth(); // 0-based

      // ✅ Last date of file month
      voucherDate = new Date(year, month + 1, 0);
    } else {
      // fallback
      voucherDate = new Date();
    }
  } else {
    voucherDate = new Date();
  }

  // ---------- BUILD TALLY ROWS (as arrays to handle duplicate column names) ----------
  pivotRows.forEach((row) => {
    const sellerGstin = row.seller_gstin || '';
    const rawInvoiceNo = row.final_invoice_no || '';
    const invoiceNo = addShipToVchNo(rawInvoiceNo);
    const shipToState = row.seller_state || '';
    const partyLedger = row.tally_ledgers || 'Amazon Pay Ledger';
    const stockItem = withInventory ? row.fg : '';
    const quantity = safeNumber(row.sum_of_item_quantity);
    const amount = safeNumber(row.sum_of_base_value);
    const rate = row.rate;  // ✅
    const cgst = safeNumber(row.sum_of_cgst_amount);
    const sgst = safeNumber(row.sum_of_sgst_amount);
    const igst = safeNumber(row.sum_of_igst_amount);


    // Skip rows without invoice number
    if (!invoiceNo) {
      console.warn(`⚠ Skipping tally row: Missing Invoice No. for state: ${shipToState}`);
      return;
    }

    // Build row as array in exact order of headers
    const rowArray = [
      voucherDate,           // Vch. Date
      sellerGstin,           // Vch. Type
      invoiceNo,             // Vch. No.
      invoiceNo,             // Ref. No. (using invoice no)
      voucherDate,           // Ref. Date
      partyLedger,           // Party Ledger
      'Amazon Pay Ledger',   // Sales Ledger
      rate,                  // Rate
      amount,                // Amount
    ];

    // ---------- GST VALUES PER RATE ----------
    uniqueRates.forEach(r => {
      if (r === rate) {
        rowArray.push(cgst); // CGST r/2
        rowArray.push(sgst); // SGST r/2
        rowArray.push(igst); // IGST r
      } else {
        rowArray.push(0);
        rowArray.push(0);
        rowArray.push(0);
      }
    });

    tallyRows.push(rowArray);
  });

  console.log(`✓ Generated ${tallyRows.length} tally ready rows from ${pivotRows.length} pivot rows`);

  // Return as array of arrays format for aoa_to_sheet
  return {
    headers: headers,
    data: tallyRows
  };
}



/**
 * Process Myntra macros - handles 3 CSV files (RTO, Packed, RT)
 * @param {Object} fileBuffers - Object with keys: rtoFile, packedFile, rtFile
 * @param {Array} skuData - Array of {SKU, FG} objects from SKU master
 * @param {Array} stateConfigData - Array of state config objects
 * @param {string} brandName - Brand name
 * @param {string} date - Date string (Month-YYYY)
 * @param {boolean} withInventory - Whether to include SKU/FG mapping
 * @returns {Object} - { workingFileData, pivotData, afterPivotData, outputWorkbook }
 */
async function myntraProcessor(fileBuffers, skuData, stateConfigData, brandName, date, withInventory = true) {
  console.log('=== MYNTRA MACROS PROCESSING ===');
  console.log(`Brand: ${brandName}, Date: ${date}`);

  // Get month number and last date from date string
  const monthNumber = getMonthNumberFromDateString(date);
  const lastDateOfMonth = getLastDateOfMonthFromDateString(date);

  console.log(`Month Number: ${monthNumber}, Last Date: ${lastDateOfMonth}`);

  // Build SKU lookup map
  const skuMap = {};
  if (withInventory && skuData && Array.isArray(skuData)) {
    for (const item of skuData) {
      const sku = String(item.SKU || item.salesPortalSku || item.sku_id || '').trim();
      const fg = item.FG || item.tallyNewSku || '';
      if (sku) {
        skuMap[sku.toLowerCase()] = fg;
      }
    }
    console.log(`SKU map loaded with ${Object.keys(skuMap).length} entries`);
  }

  // Build state config lookup map
  const stateConfigMap = {};
  if (stateConfigData && Array.isArray(stateConfigData)) {
    for (const item of stateConfigData) {
      const stateName = normalizeStateName(item.States || item.states || item.state || item.ship_to_state || item.State);
      if (stateName) {
        stateConfigMap[stateName] = {
          tallyLedger: item['Myntra Pay Ledger'] || item['myntra pay ledger'] || item['Amazon Pay Ledger'] || item['Amazon pay Ledger'] || item['amazon_pay_ledger'] || item['Debtor Ledger'] || item['debtor_ledger'] || item['Ledger'] || '',
          invoiceNo: item['Invoice No.'] || item['Invoice No'] || item['invoice_no'] || item['Final Invoice No'] || ''
        };
      }
    }
  }
  console.log(`State config map loaded with ${Object.keys(stateConfigMap).length} entries`);

  // Parse the 3 CSV files
  const rtoData = fileBuffers.rtoFile ? parseCSV(fileBuffers.rtoFile) : [];
  const packedData = fileBuffers.packedFile ? parseCSV(fileBuffers.packedFile) : [];
  const rtData = fileBuffers.rtFile ? parseCSV(fileBuffers.rtFile) : [];

  console.log(`RTO data: ${rtoData.length} rows`);
  console.log(`Packed data: ${packedData.length} rows`);
  console.log(`RT data: ${rtData.length} rows`);

  // Track raw SKU/state values that aren't found in this brand's SKU/Ledger master
  const missingMasterTracker = createMissingMasterTracker();

  // ==========================
  // Working for Accounting - Merge all 3 reports
  // ==========================
  const workingFileData = [];
  const mainReportData = [];

  // Helper function to process a row from any report
  function processRow(row, reportType) {
    // Get SKU ID (try different field names)
    const skuId = String(row.sku_id || row.SKU || row.sku || '').trim();
    const sku = skuId;
    let fg = '';
    if (withInventory && skuId) {
      fg = skuMap[skuId.toLowerCase()] || '';
      if (!fg && skuId) {
        missingMasterTracker.track({ masterType: 'sku', matchField: 'Sales portal SKU', value: skuId });
      }
    }

    // Get Ship to State (different field names in different reports)
    let shipToState = '';
    if (reportType === 'Packed') {
      shipToState = row.customer_delivery_state_code || row.state || row.ship_to_state || '';
    } else if (reportType === 'RT') {
      shipToState = row.delivery_state || row.state || row.customer_delivery_state || '';
    } else if (reportType === 'RTO') {
      shipToState = row.customer_state || row.state || row.ship_to_state || '';
    }

    // Lookup Tally Ledger and Invoice No from state config
    const normalizedState = normalizeStateName(shipToState);
    const stateConfig = stateConfigMap[normalizedState] || {};
    if (!stateConfig.tallyLedger && normalizedState) {
      missingMasterTracker.track({ masterType: 'ledger', matchField: 'State', value: shipToState });
    }
    const debtorLedger = stateConfig.tallyLedger || '';
    const finalInvoiceNo = stateConfig.invoiceNo || '';

    // Get seller GSTIN
    const sellerGstin = String(row.seller_gstin || row.Seller_GSTIN || '').trim();

    // Get invoice number
    const invoiceNumber = finalInvoiceNo;

    // Get quantities and amounts
    let quantity = safeNumber(row.quantity || row.qty || row.Qty || 0);
    let baseAmount = safeNumber(row.base_amount || row.base_value || row.Base_Amount || 0);
    let baseValue = safeNumber(row.base_value || row.base_amount || row.Base_Value || 0);
    let igstAmount = safeNumber(row.igst_amt || row.igst_tcs_amount || row.IGST_Amount || row['Tax IGST'] || 0);
    let cgstAmount = safeNumber(row.cgst_amt || row.cgst_amount || row.CGST_Amount || row['CGST Tax'] || 0);
    let sgstAmount = safeNumber(row.sgst_amt || row.sgst_amount || row.SGST_Amount || row['SGST Tax'] || 0);
    let invoiceAmount = safeNumber(row.invoice_amount || row.invoiceamount || row.net_amount || row.Invoice_Amount || 0);
    let gstRate = safeNumber(row.gst_rate || row.tax_rate || row.GST_Rate || 0);
    let shippingCase = String(row.shipping_case || row.Shipping_case || 0);
    let taxAmount = safeNumber(row.tax_amount || row.Tax_Amount || 0);
    let state = String(row.state || '').trim().toLowerCase();
    let location = String(row.location || '').trim().toLowerCase();
    // Apply sign adjustments: Packed = positive, RT/RTO = negative
    // if (reportType === 'RT' || reportType === 'RTO') {
    //   console.log("reportType", reportType);
    //   quantity = -Math.abs(quantity);
    //   baseValue = -Math.abs(baseValue);
    //   igstAmount = -Math.abs(igstAmount);
    //   cgstAmount = -Math.abs(cgstAmount);
    //   sgstAmount = -Math.abs(sgstAmount);
    //   invoiceAmount = -Math.abs(invoiceAmount);
    // }

    // Build working file row
    const workingRow = {
      seller_gstin: sellerGstin,
      month: monthNumber,
      date_column: lastDateOfMonth,
      debtor_ledger: shipToState,
      invoice_number: finalInvoiceNo,
      sku: sku,
      quantity: quantity,
      state: state,
      location: location,
      shipping_case: shippingCase,
      gst_rate: gstRate,
      base_Value: baseValue,
      igst_amount: igstAmount,
      cgst_amount: cgstAmount,
      sgst_amount: sgstAmount,
      invoice_amount: invoiceAmount,
      report_type: reportType,
      ship_to_state: shipToState,
      ship_to_state_tally_ledger: debtorLedger,
      final_invoice_no: finalInvoiceNo,
      tax_amount: taxAmount,
      // Store raw data for reference
      order_id: row.order_id || '',
      item_id: row.item_id || '',
      sku_id: skuId,
      packet_id: row.packet_id || '',
      order_created_date: safeDate(row.order_created_date),
      order_packed_date: safeDate(row.order_packed_date),
      order_shipped_date: safeDate(row.order_shipped_date),
      order_delivered_date: safeDate(row.order_delivered_date),
      order_rto_date: safeDate(row.order_rto_date),
      warehouse_id: row.warehouse_id || '',
      warehouse_name: row.warehouse_name || '',
      seller_name: row.seller_name || '',
      seller_id: row.seller_id || '',
      brand_name: row.brand || brandName,
      master_category: row.master_category || '',
      article_type: row.article_type || '',
      net_amount: safeNumber(row.net_amount || 0),
      shipment_value: safeNumber(row.shipment_value || 0),
      base_value: safeNumber(row.base_value || 0),
      seller_price: safeNumber(row.seller_price || 0),
      platform_charges: safeNumber(row.platform_charges || 0),
      shipping_charges: safeNumber(row.shipping_charges || 0),
      mrp: safeNumber(row.mrp || 0),
      tcs_amount: safeNumber(row.tcs_amount || row.tcs || 0),
      tds_amount: safeNumber(row.tds_amount || 0),
      tds_rate: safeNumber(row.tds_rate || 0)
    };

    if (withInventory) {
      workingRow.fg = fg;
    }

    return workingRow;
  }

  // Process Packed data (positive values)
  for (const row of packedData) {
    const workingRow = processRow(row, 'Packed');
    workingFileData.push(workingRow);

    const taxAmount = safeNumber(workingRow.tax_amount);
    const isInterState = workingRow.shipping_case === 'Interstate';

    const igstAmount = isInterState ? taxAmount : 0;
    const cgstAmount = isInterState ? 0 : taxAmount / 2;
    const sgstAmount = isInterState ? 0 : taxAmount / 2;

    // Build main report row
    const mainRow = {
      'Month': workingRow.month,
      'Date': workingRow.date_column,
      'Seller GSTIN': workingRow.seller_gstin,
      'Invoice number': workingRow.invoice_number,
      'Debtor Ledger': workingRow.debtor_ledger,
      'SKU': workingRow.sku,
      'Quantity': workingRow.quantity,
      'Shipping': workingRow.shipping_case,
      'GST Rate': workingRow.gst_rate,
      'Base Value': workingRow.base_Value,
      'File': 'Packed',

      // ✅ CORRECT GST SPLIT
      'IGST Amount': igstAmount,
      'CGST Amount': cgstAmount,
      'SGST Amount': sgstAmount,

      'Invoice Amount': workingRow.invoice_amount
    };

    if (withInventory) {
      mainRow['FG'] = workingRow.fg;
    }

    mainReportData.push(mainRow);
  }

  // Process RT data (negative values)
  for (const row of rtData) {
    const workingRow = processRow(row, 'RT');
    workingFileData.push(workingRow);

    const taxAmount = safeNumber(workingRow.tax_amount);
    const isInterState =
      String(workingRow.shipping_case).toLowerCase() === 'interstate';

    const igstAmount = isInterState ? taxAmount : 0;
    const cgstAmount = isInterState ? 0 : taxAmount / 2;
    const sgstAmount = isInterState ? 0 : taxAmount / 2;

    const mainRow = {
      'Month': workingRow.month,
      'Date': workingRow.date_column,
      'Seller GSTIN': workingRow.seller_gstin,
      'Invoice number': workingRow.invoice_number,
      'Debtor Ledger': workingRow.debtor_ledger,
      'SKU': workingRow.sku,
      'Quantity': -Math.abs(workingRow.quantity),
      'Shipping': workingRow.shipping_case,
      'GST Rate': workingRow.gst_rate,
      'Base Value': -Math.abs(workingRow.base_value),
      'File': 'RT',
      // ✅ CORRECT GST BREAKUP
      'IGST Amount': -Math.abs(igstAmount),
      'CGST Amount': -Math.abs(cgstAmount),
      'SGST Amount': -Math.abs(sgstAmount),

      'Invoice Amount': -Math.abs(workingRow.invoice_amount)
    };

    if (withInventory) {
      mainRow['FG'] = workingRow.fg;
    }

    mainReportData.push(mainRow);
  }
  let count = 0;
  // Process RTO data (negative values)
  for (const row of rtoData) {
    const workingRow = processRow(row, 'RTO');
    workingFileData.push(workingRow);
    const taxAmount = safeNumber(workingRow.tax_amount);
    // const isInterState =
    //   String(workingRow.shipping_case).toLowerCase() === 'interstate';

    const state = String(workingRow.state || '').trim().toLowerCase();
    const location = String(workingRow.location || '').trim().toLowerCase();
    const isInterState = state !== location;

    const igstAmount = isInterState ? taxAmount : 0;
    const cgstAmount = isInterState ? 0 : taxAmount / 2;
    const sgstAmount = isInterState ? 0 : taxAmount / 2;

    const mainRow = {
      'Month': workingRow.month,
      'Date': workingRow.date_column,
      'Seller GSTIN': workingRow.seller_gstin,
      'Invoice number': workingRow.invoice_number,
      'Debtor Ledger': workingRow.debtor_ledger,
      'SKU': workingRow.sku,
      'Quantity': -Math.abs(workingRow.quantity),
      'Shipping': isInterState ? 'InterState' : 'Local',
      'GST Rate': workingRow.gst_rate,
      'Base Value': -Math.abs(workingRow.base_value),
      'File': 'RTO',
      // ✅ CORRECT GST BREAKUP
      'IGST Amount': -Math.abs(igstAmount),
      'CGST Amount': -Math.abs(cgstAmount),
      'SGST Amount': -Math.abs(sgstAmount),

      'Invoice Amount': -Math.abs(workingRow.invoice_amount)
    };

    if (withInventory) {
      mainRow['FG'] = workingRow.fg;
    }

    mainReportData.push(mainRow);
  }



  console.log(`Working file data: ${workingFileData.length} rows`);

  // ==========================
  // Generate Pivot Table
  // ==========================
  const pivotMap = {};

  for (const row of workingFileData) {
    // Build pivot key: Seller GSTIN, Month, Date, Final Invoice No, Tally Ledgers, FG


    const keyObject = {
      seller_gstin: row.seller_gstin || '',
      month: row.month || '',
      date_column: row.date_column || '',
      final_invoice_no: row.final_invoice_no || '',
      tally_ledgers: row.debtor_ledger || ''
    };

    if (withInventory) {
      keyObject.fg = row.fg || '';
    }

    const key = JSON.stringify(keyObject);

    // Initialize pivot row
    if (!pivotMap[key]) {
      pivotMap[key] = {
        seller_gstin: row.seller_gstin,
        month: row.month,
        date_column: row.date_column,
        final_invoice_no: row.final_invoice_no,
        tally_ledgers: row.debtor_ledger,
        sum_of_quantity: 0,
        rate: row.gst_rate,
        sum_of_base_value: 0,
        sum_of_igst_amount: 0,
        sum_of_cgst_amount: 0,
        sum_of_sgst_amount: 0,
        sum_of_invoice_amount: 0
      };

      if (withInventory) {
        pivotMap[key].fg = row.fg || '';
      }
    }

    // Aggregate values
    pivotMap[key].sum_of_quantity += safeNumber(row.quantity);
    pivotMap[key].sum_of_base_value += safeNumber(row.base_Value);
    pivotMap[key].sum_of_igst_amount += safeNumber(row.igst_amount);
    pivotMap[key].sum_of_cgst_amount += safeNumber(row.cgst_amount);
    pivotMap[key].sum_of_sgst_amount += safeNumber(row.sgst_amount);
    pivotMap[key].sum_of_invoice_amount += safeNumber(row.invoice_amount);
  }

  const pivotData = Object.values(pivotMap);
  console.log(`Pivot data: ${pivotData.length} rows`);

  // pivotData.forEach(row => {

  //   const totalTax =
  //     safeNumber(row.sum_of_cgst_amount) +
  //     safeNumber(row.sum_of_sgst_amount) +
  //     safeNumber(row.sum_of_igst_amount);

  //   const taxableValue =
  //     safeNumber(row.sum_of_invoice_amount);

  //   let rate = 0;

  //   if (taxableValue > 0) {
  //     rate = totalTax / taxableValue;
  //     console.log("rate==",rate);

  //     // ---------- GST SLAB NORMALIZATION ----------
  //     if (rate >= 0.04 && rate <= 0.06) {
  //       rate = 0.05;
  //     } else if (rate >= 0.11 && rate <= 0.13) {
  //       rate = 0.12;
  //     } else if (rate >= 0.17 && rate <= 0.19) {
  //       rate = 0.18;
  //     } else {
  //       rate = 0; // outside expected GST slabs
  //     }
  //   }

  //   row.rate = +rate.toFixed(2);
  // });
  // ==========================
  // Summarised Workings - Separate sheets for each report type
  // ==========================

  // Process Shipped (Packed) data
  const shippedData = [];
  for (const row of packedData) {
    const transactionDate = row.order_shipped_date || row.order_packed_date || row.order_created_date;
    const month = getMonthFromTransactionDate(transactionDate);

    shippedData.push({
      'Month': monthNumber,
      'Qty': safeNumber(row.quantity || row.qty || row.Qty || 0),
      'Base Value': -Math.abs(safeNumber(row.base_value || row.base_value || row.Base_Value || 0)),
      'Tax IGST': safeNumber(row.igst_amt || row.igst_amount || row.IGST_Amount || row['Tax IGST'] || 0),
      'CGST Tax': safeNumber(row.cgst_amt || row.cgst_amount || row.CGST_Amount || row['CGST Tax'] || 0),
      'SGST Tax': safeNumber(row.sgst_amt || row.sgst_amount || row.SGST_Amount || row['SGST Tax'] || 0)
    });
  }

  // Process Returns (RT) data
  const returnsData = [];
  for (const row of rtData) {
    const transactionDate = row.order_delivered_date || row.order_shipped_date || row.order_created_date;
    const month = getMonthFromTransactionDate(transactionDate);

    returnsData.push({
      'Month': monthNumber,
      'Qty': safeNumber(row.quantity || row.qty || row.Qty || 0),
      'Base Value': -Math.abs(safeNumber(row.base_value || row.base_amount || row.Base_Value || 0)),
      'Tax IGST': safeNumber(row.igst_amt || row.igst_amount || row.IGST_Amount || row['Tax IGST'] || 0),
      'CGST Tax': safeNumber(row.cgst_amt || row.cgst_amount || row.CGST_Amount || row['CGST Tax'] || 0),
      'SGST Tax': safeNumber(row.sgst_amt || row.sgst_amount || row.SGST_Amount || row['SGST Tax'] || 0)
    });
  }

  // Process RTO data
  const rtoSummarisedData = [];
  for (const row of rtoData) {
    const transactionDate = row.order_rto_date || row.order_shipped_date || row.order_created_date;
    const month = getMonthFromTransactionDate(transactionDate);

    rtoSummarisedData.push({
      'Month': monthNumber,
      'Qty': safeNumber(row.quantity || row.qty || row.Qty || 0),
      'Base Value': safeNumber(row.base_value || row.base_amount || row.Base_Amount || 0),
      'Tax IGST': safeNumber(row.igst_amt || row.igst_amount || row.IGST_Amount || row['Tax IGST'] || 0),
      'CGST Tax': safeNumber(row.cgst_amt || row.cgst_amount || row.CGST_Amount || row['CGST Tax'] || 0),
      'SGST Tax': safeNumber(row.sgst_amt || row.sgst_amount || row.SGST_Amount || row['SGST Tax'] || 0)
    });
  }

  // Create pivot tables for each report type
  const shippedPivotData = [];

  // total row using SAME column names
  const shippedTotalRow = {
    Month: monthNumber,
    Qty: 0,
    'Base Value': 0,
    'Tax IGST': 0,
    'CGST Tax': 0,
    'SGST Tax': 0
  };

  for (const row of shippedData) {
    // keep original rows untouched
    shippedPivotData.push(row);

    // calculate totals
    shippedTotalRow.Qty += safeNumber(row.Qty);
    shippedTotalRow['Base Value'] += safeNumber(row['Base Value']);
    shippedTotalRow['Tax IGST'] += safeNumber(row['Tax IGST']);
    shippedTotalRow['CGST Tax'] += safeNumber(row['CGST Tax']);
    shippedTotalRow['SGST Tax'] += safeNumber(row['SGST Tax']);
  }

  /* ✅ ADD ONE BLANK ROW BEFORE TOTAL */
  shippedPivotData.push({
    Month: '',
    Qty: '',
    'Base Value': '',
    'Tax IGST': '',
    'CGST Tax': '',
    'SGST Tax': ''
  });

  // add total row at the end
  shippedPivotData.push(shippedTotalRow);


  const returnsPivotData = [];

  // total row with SAME column names
  const returnsTotalRow = {
    Month: monthNumber,
    Qty: 0,
    'Base Value': 0,
    'Tax IGST': 0,
    'CGST Tax': 0,
    'SGST Tax': 0
  };

  for (const row of returnsData) {
    // push original row
    returnsPivotData.push(row);

    // accumulate totals
    returnsTotalRow.Qty += safeNumber(row.Qty);
    returnsTotalRow['Base Value'] += safeNumber(row['Base Value']);
    returnsTotalRow['Tax IGST'] += safeNumber(row['Tax IGST']);
    returnsTotalRow['CGST Tax'] += safeNumber(row['CGST Tax']);
    returnsTotalRow['SGST Tax'] += safeNumber(row['SGST Tax']);
  }

  returnsPivotData.push({
    Month: '',
    Qty: '',
    'Base Value': '',
    'Tax IGST': '',
    'CGST Tax': '',
    'SGST Tax': ''
  });

  // push total row at end
  returnsPivotData.push(returnsTotalRow);


  const rtoPivotData = [];

  // total row with SAME column names
  const rtoTotalRow = {
    Month: monthNumber,
    Qty: 0,
    'Base Value': 0,
    'Tax IGST': 0,
    'CGST Tax': 0,
    'SGST Tax': 0
  };

  for (const row of rtoSummarisedData) {
    // push original row as-is
    rtoPivotData.push(row);

    // accumulate totals
    rtoTotalRow.Qty += safeNumber(row.Qty);
    rtoTotalRow['Base Value'] += safeNumber(row['Base Value']);
    rtoTotalRow['Tax IGST'] += safeNumber(row['Tax IGST']);
    rtoTotalRow['CGST Tax'] += safeNumber(row['CGST Tax']);
    rtoTotalRow['SGST Tax'] += safeNumber(row['SGST Tax']);
  }

  rtoPivotData.push({
    Month: '',
    Qty: '',
    'Base Value': '',
    'Tax IGST': '',
    'CGST Tax': '',
    'SGST Tax': ''
  });

  // push total row at the end
  rtoPivotData.push(rtoTotalRow);


  // ==========================
  // Net Pivot Calculations
  // ==========================
  const shippedTotal = shippedPivotData[shippedPivotData.length - 1];
  const returnsTotal = returnsPivotData[returnsPivotData.length - 1];
  const rtoTotal = rtoPivotData[rtoPivotData.length - 1];

  const netPivotData = [
    {
      Month: monthNumber,

      Qty:
        safeNumber(shippedTotal.Qty)
        - safeNumber(returnsTotal.Qty)
        - safeNumber(rtoTotal.Qty),

      'Base Value':
        safeNumber(shippedTotal['Base Value'])
        - safeNumber(returnsTotal['Base Value'])
        - safeNumber(rtoTotal['Base Value']),

      'Tax IGST':
        safeNumber(shippedTotal['Tax IGST'])
        - safeNumber(returnsTotal['Tax IGST'])
        - safeNumber(rtoTotal['Tax IGST']),

      'CGST Tax':
        safeNumber(shippedTotal['CGST Tax'])
        - safeNumber(returnsTotal['CGST Tax'])
        - safeNumber(rtoTotal['CGST Tax']),

      'SGST Tax':
        safeNumber(shippedTotal['SGST Tax'])
        - safeNumber(returnsTotal['SGST Tax'])
        - safeNumber(rtoTotal['SGST Tax']),
    }
  ];


  // ==========================
  // Create Workbook
  // ==========================
  const outputWorkbook = XLSX.utils.book_new();

  // 1. Working for Accounting (main-report) - merged data from all 3 reports
  const mainReportSheet = XLSX.utils.json_to_sheet(mainReportData);
  XLSX.utils.book_append_sheet(outputWorkbook, mainReportSheet, 'working for Accounting');

  // 2. Pivot Table
  const pivotSheetData = pivotData.map(row => {
    const sheetRow = {
      'Seller GSTIN': row.seller_gstin,
      'Month': row.month,
      'Date': row.date_column,
      'Final Invoice No.': row.final_invoice_no,
      'Tally Ledgers': row.tally_ledgers,
      'Quantity': row.sum_of_quantity,
      'Base Value': row.sum_of_base_value,
      'IGST Amount': row.sum_of_igst_amount,
      'CGST Amount': row.sum_of_cgst_amount,
      'SGST Amount': row.sum_of_sgst_amount,
      'Invoice Amount': row.sum_of_invoice_amount
    };
    if (withInventory) {
      sheetRow['FG'] = row.fg;
    }
    return sheetRow;
  });
  const pivotSheet = XLSX.utils.json_to_sheet(pivotSheetData);
  // Add formulas for calculated columns
  const pivotHeaders = Object.keys(pivotSheetData[0] || {});
  addFormulasToPivotSheet(pivotSheet, pivotSheetData, pivotHeaders);
  XLSX.utils.book_append_sheet(outputWorkbook, pivotSheet, 'Pivot table');

  // ============================================================
  // STEP 2.5: CREATE TALLY READY SHEET
  // ============================================================
  console.log('Step 2.5: Create Tally Ready sheet');
  const tallyReadyResult = generateTallyReady(pivotData, date, withInventory);
  // Build array of arrays: [headers, ...dataRows]
  const tallyReadySheetData = [tallyReadyResult.headers, ...tallyReadyResult.data];
  const tallyReadySheet = XLSX.utils.aoa_to_sheet(tallyReadySheetData);
  // Add formulas for calculated columns
  addFormulasToTallySheet(tallyReadySheet, tallyReadyResult.headers, tallyReadyResult.data.length);
  XLSX.utils.book_append_sheet(outputWorkbook, tallyReadySheet, 'tally ready');
  console.log(`✓ Added tally ready sheet with ${tallyReadyResult.data.length} rows and formulas`);


  // ============================================================
  console.log('Step 2.5: Create shipping ready sheet');
  const shippingtallyReadyResult = generateShippingTallyReady(pivotData, date, withInventory);
  // Build array of arrays: [headers, ...dataRows]
  const shippingtallyReadySheetData = [shippingtallyReadyResult.headers, ...shippingtallyReadyResult.data];
  const shippingtallyReadySheet = XLSX.utils.aoa_to_sheet(shippingtallyReadySheetData);
  // Add formulas for calculated columns (if any)
  addFormulasToTallySheet(shippingtallyReadySheet, shippingtallyReadyResult.headers, shippingtallyReadyResult.data.length);
  XLSX.utils.book_append_sheet(outputWorkbook, shippingtallyReadySheet, 'shipping tally ready');
  console.log(`✓ Added shipping tally ready sheet with ${shippingtallyReadyResult.data.length} rows and formulas`);

  // ============================================================
  // STEP 2.6: CREATE X2BETA WORKING + X2BETA-SHIPPING SHEETS
  // Same 108-column Tally "X2Beta" e-invoice import template used by the
  // Amazon B2B/B2C and Flipkart processors. Built from pivotData (same
  // aggregation already used by "tally ready" above) so the numbers stay
  // consistent with that sheet: amounts are not sign-flipped for RT/RTO
  // (matching "tally ready"'s existing behaviour), and HSN is left blank
  // since Myntra's source reports carry no HSN column.
  // ============================================================
  console.log('Step 2.6: Create x2beta working sheet');

  function getSellerStateAbbr(gstin) {
    const code = String(gstin || '').trim().substring(0, 2);
    return getStateAbbr(code) || code;
  }

  const x2betaVchDate = lastDateOfMonth || new Date();
  const x2betaUniqueRates = [...new Set(pivotData.map(r => Number(r.rate || 0)))].filter(r => r > 0);
  const x2betaSortedStateCodes = [...new Set(pivotData.map(r => getSellerStateAbbr(r.seller_gstin)))].filter(Boolean).sort();

  function buildX2betaColumns() {
    const cols = [
      { header: 'Vch. Date* ', get: () => x2betaVchDate },
      { header: 'Vch. Type*', get: r => `Sales-${getSellerStateAbbr(r.seller_gstin) || ''}` },
      { header: 'Vch. No.*', get: r => r.final_invoice_no || '' },
      { header: 'Ref. No.', get: r => r.final_invoice_no || '' },
      { header: 'Ref. Date', get: () => x2betaVchDate },
      { header: 'Is CN?', get: () => null },
      { header: 'Is Vch?', get: () => null },
      { header: 'Party Ledger*', get: r => r.tally_ledgers || '' },
      { header: 'Sales Ledger*', get: r => `Sales Myntra-${getSellerStateAbbr(r.seller_gstin) || ''} ${Number(r.rate || 0)}%` },
      { header: 'Stock Item', get: r => r.fg || '' },
      { header: 'Description', get: () => null },
      { header: 'Godown', get: () => null },
      { header: 'Quantity', get: r => Number(r.sum_of_quantity || 0) },
      {
        header: 'Rate',
        get: r => {
          const qty = Number(r.sum_of_quantity || 0);
          return qty !== 0 ? Math.abs(Number(r.sum_of_base_value || 0) / qty) : 0;
        }
      },
      { header: 'Unit', get: () => 'Pcs' },
      { header: 'Discount', get: () => null },
      { header: 'Amount*', get: r => Number(r.sum_of_base_value || 0) },
      { header: 'Discount', get: () => null }
    ];

    // Dynamic Output IGST/CGST/SGST columns — one triplet per (rate, seller-state)
    // combination present in this run's data, mirroring the Amazon/Flipkart layout.
    x2betaUniqueRates.forEach(rate => {
      const halfRate = Math.round((rate / 2) * 100) / 100;
      x2betaSortedStateCodes.forEach(sc => {
        cols.push({
          header: `Output IGST ${rate}%-${sc}`,
          get: row => (Number(row.rate || 0) === rate && getSellerStateAbbr(row.seller_gstin) === sc) ? Number(row.sum_of_igst_amount || 0) : 0
        });
        cols.push({
          header: `Output CGST ${halfRate}%-${sc}`,
          get: row => (Number(row.rate || 0) === rate && getSellerStateAbbr(row.seller_gstin) === sc) ? Number(row.sum_of_cgst_amount || 0) : 0
        });
        cols.push({
          header: `Output SGST ${halfRate}%-${sc}`,
          get: row => (Number(row.rate || 0) === rate && getSellerStateAbbr(row.seller_gstin) === sc) ? Number(row.sum_of_sgst_amount || 0) : 0
        });
      });
    });

    cols.push(
      { header: null, get: () => null },
      { header: null, get: () => null },
      { header: 'Narration', get: () => `Myntra-${date || ''}` },
      { header: 'Taxability', get: () => null },
      { header: 'GST Nature', get: () => null },
      { header: 'GST Rate', get: r => Number(r.rate || 0) },
      { header: 'Cess', get: () => null },
      { header: 'RCM?', get: () => null },
      // Myntra's source reports carry no HSN column — left blank rather than fabricated.
      { header: 'HSN', get: () => null },
      { header: 'HSN Desc', get: () => null },
      { header: 'Supply Type', get: () => null },
      { header: 'Cost Category', get: () => null },
      { header: 'Cost Centre', get: () => null },
      { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
      { header: 'State', get: r => r.tally_ledgers || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
      { header: 'Place of Supply', get: r => r.tally_ledgers || '' }, { header: 'GST Type', get: () => null }, { header: 'GSTIN', get: () => null },
      { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
      { header: 'State', get: r => r.tally_ledgers || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
      { header: 'Place', get: () => null }, { header: 'GSTIN', get: () => null },
      { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
      { header: 'State', get: r => r.tally_ledgers || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
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

    return cols;
  }

  const x2betaColumns = buildX2betaColumns();
  const x2betaHeaders = x2betaColumns.map(c => c.header);
  const x2betaSheetData = [x2betaHeaders, ...pivotData.map(row => x2betaColumns.map(c => c.get(row)))];
  const x2betaSheet = XLSX.utils.aoa_to_sheet(x2betaSheetData);
  XLSX.utils.book_append_sheet(outputWorkbook, x2betaSheet, 'x2beta working');
  console.log(`✓ Added x2beta working sheet with ${pivotData.length} rows`);

  // 3. Shipped sheet (from Packed data)
  const shippedSheet = XLSX.utils.json_to_sheet(packedData);
  XLSX.utils.book_append_sheet(outputWorkbook, shippedSheet, 'shipped');

  // 4. Returns sheet (from RT data)
  const returnsSheet = XLSX.utils.json_to_sheet(rtData);
  XLSX.utils.book_append_sheet(outputWorkbook, returnsSheet, 'Returns');

  // 5. RTO sheet (from RTO data)
  const rtoSheet = XLSX.utils.json_to_sheet(rtoData);
  XLSX.utils.book_append_sheet(outputWorkbook, rtoSheet, 'RTO');

  // 6. Shipped Pivot
  const shippedPivotSheet = XLSX.utils.json_to_sheet(shippedPivotData);
  XLSX.utils.book_append_sheet(outputWorkbook, shippedPivotSheet, 'Shipped Pivot');

  // 7. Returns Pivot
  const returnsPivotSheet = XLSX.utils.json_to_sheet(returnsPivotData);
  XLSX.utils.book_append_sheet(outputWorkbook, returnsPivotSheet, 'Returns Pivot');

  // 8. RTO Pivot
  const rtoPivotSheet = XLSX.utils.json_to_sheet(rtoPivotData);
  XLSX.utils.book_append_sheet(outputWorkbook, rtoPivotSheet, 'RTO Pivot'); // PTO Pivot was likely a typo for RTO

  // 9. Net Pivot
  const netPivotSheet = XLSX.utils.json_to_sheet(netPivotData);
  XLSX.utils.book_append_sheet(outputWorkbook, netPivotSheet, 'Net Pivot');

  // 10. source-sku (if withInventory)
  if (withInventory && skuData && skuData.length > 0) {
    XLSX.utils.book_append_sheet(
      outputWorkbook,
      XLSX.utils.json_to_sheet(
        skuData.map(item => ({
          'SKU': item.SKU || item.salesPortalSku || item.sku_id || '',
          'FG': item.FG || item.tallyNewSku || ''
        }))
      ),
      'source-sku'
    );
  }

  // 11. source-state
  if (stateConfigData && stateConfigData.length > 0) {
    XLSX.utils.book_append_sheet(
      outputWorkbook,
      XLSX.utils.json_to_sheet(
        stateConfigData.map(item => ({
          'States': item.States || item.states || item.state || '',
          'Tally Ledger': item['Myntra Pay Ledger'] || item['myntra pay ledger'] || item['Amazon Pay Ledger'] || item['tally_ledger'] || item['Debtor Ledger'] || item['Ledger'] || '',
          'Invoice No.': item['Invoice No.'] || item['Invoice No'] || item['invoice_no'] || ''
        }))
      ),
      'source-state'
    );
  }

  console.log('=== MYNTRA MACROS PROCESSING COMPLETE ===');
  console.log(`Output workbook sheets: ${outputWorkbook.SheetNames.join(', ')}`);

  return {
    workingFileData,
    pivotData,
    afterPivotData: netPivotData,
    outputWorkbook,
    missingMasterValues: missingMasterTracker.list()
  };
}

module.exports = {
  myntraProcessor
};
