const XLSX = require('xlsx-js-style');
const { getStateAbbr } = require('../../../utils/gstStateCodes');
const { createMissingMasterTracker } = require('../../../utils/missingMasterTracker');

/**
 * GST State Code to State Name mapping
 */
const GST_STATE_CODES = {
  '01': 'Jammu & Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Dadra & Nagar Haveli and Daman & Diu',
  '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh (New)',
  '38': 'Ladakh'
};

/**
 * Raw file header mapping to internal keys
 */
const RAW_HEADERS = [
  'Seller GSTIN',
  'Order ID',
  'Order Item ID',
  'Product Title/Description',
  'FSN',
  'SKU',
  'HSN Code',
  'Event Type',
  'Event Sub Type',
  'Order Type',
  'Fulfilment Type',
  'Order Date',
  'Order Approval Date',
  'Item Quantity',
  'Order Shipped From (State)',
  'Warehouse ID',
  'Price before discount',
  'Total Discount',
  'Seller Share',
  'Bank Offer Share',
  'Price after discount (Price before discount-Total discount)',
  'Shipping Charges',
  'Final Invoice Amount (Price after discount+Shipping Charges)',
  'Type of tax',
  'Taxable Value (Final Invoice Amount -Taxes)',
  'CST Rate',
  'CST Amount',
  'VAT Rate',
  'VAT Amount',
  'Luxury Cess Rate',
  'Luxury Cess Amount',
  'IGST Rate',
  'IGST Amount',
  'CGST Rate',
  'CGST Amount',
  'SGST Rate (or UTGST as applicable)',
  'SGST Amount (Or UTGST as applicable)',
  'TCS IGST Rate',
  'TCS IGST Amount',
  'TCS CGST Rate',
  'TCS CGST Amount',
  'TCS SGST Rate',
  'TCS SGST Amount',
  'Total TCS Deducted',
  'Buyer Invoice ID',
  'Buyer Invoice Date',
  'Buyer Invoice Amount',
  "Customer's Billing Pincode",
  "Customer's Billing State",
  "Customer's Delivery Pincode",
  "Customer's Delivery State",
  'Usual Price',
  'Is Shopsy Order?',
  'TDS Rate',
  'TDS Amount',
  'IRN',
  'Business Name',
  'Business GST Number',
  'Beneficiary Name',
  'IMEI'
];

/**
 * Safe number conversion
 */
function safeNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const num = Number(value);
  return isNaN(num) ? 0 : num;
}

/**
 * Clean SKU - remove quotes and SKU: prefix
 */
/**
 * Standard Normalize SKU (From Amazon Processor)
 */
function normalizeSKU(sku) {
  if (!sku) return '';

  return sku
    .toString()
    .replace(/"/g, '')   // remove double quotes
    .replace(/'/g, '')   // remove single quotes (just in case)
    .trim()
    .toLowerCase();
}
/**
 * Get state name from GSTIN (first 2 chars = state code)
 */
function getStateFromGSTIN(gstin) {
  if (!gstin || gstin.length < 2) return '';
  const stateCode = gstin.substring(0, 2);
  return GST_STATE_CODES[stateCode] || '';
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
  const cgstCol = getColIndex('Sum of Final CGST on Taxable value');
  const sgstCol = getColIndex('Sum of Final SGST on Taxable value');
  const igstCol = getColIndex('Sum of Final IGST on Taxable value');
  const taxableCol = getColIndex('Sum of Final Taxable sales value');

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
 * Process Flipkart raw file and generate all sheets
 * @param {Buffer} rawFileBuffer - Raw Flipkart Excel file buffer
 * @param {Array} skuData - Array of {SKU, FG} objects
 * @param {Array} stateConfigData - Array of {States, 'Amazon Pay Ledger', 'Invoice No.'} objects
 * @param {string} brandName - Brand name
 * @param {string} date - Date string (Month-YYYY)
 * @returns {Object} - { workingFileData, pivotData, afterPivotData, outputWorkbook }
 */

function generateTallyReady(pivotRows, fileDate, withInventory) {
  console.log()
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

    const invoiceNo = row.final_invoice_no;
    if (!invoiceNo) return;

    const quantity = safeNumber(row.sum_of_item_quantity);
    const rate = safeNumber(row.rate);
    const amount = safeNumber(row.sum_of_final_taxable_sales_value);
    const ratePerPiece = quantity !== 0 ? +(amount / quantity).toFixed(2) : 0;
    const stockItem = withInventory ? row.fg : '';
    const cgst =
      safeNumber(row.sum_of_final_cgst_taxable) +
      safeNumber(row.sum_of_final_cgst_shipping);

    const sgst =
      safeNumber(row.sum_of_final_sgst_taxable) +
      safeNumber(row.sum_of_final_sgst_shipping);

    const igst =
      safeNumber(row.sum_of_final_igst_taxable) +
      safeNumber(row.sum_of_final_igst_shipping);

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
      row.tally_ledgers,
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
    const amount = safeNumber(row.sum_of_final_taxable_sales_value);
    const rate = row.rate;  // ✅
    const cgst = safeNumber(row.sum_of_final_cgst_taxable);
    const sgst = safeNumber(row.sum_of_final_sgst_taxable);
    const igst = safeNumber(row.sum_of_final_igst_taxable);


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


async function flipkartProcessor(rawFileBuffer, skuData, stateConfigData, brandName, date, withInventory) {
  console.log('=== FLIPKART MACROS PROCESSING ===');
  console.log(`Brand: ${brandName}, Date: ${date}`, "withInventory", withInventory);

  console.log("SKU", skuData);
  // ==========================
  // Get Month Number from date
  // ==========================
  let monthSuffix = '';

  if (date) {
    const parsedDate = new Date(date);

    if (!isNaN(parsedDate.getTime())) {
      const month = parsedDate.getMonth() + 1; // JS months start at 0
      monthSuffix = '-' + String(month).padStart(2, '0'); // -01, -02, -03
    }
  }

  console.log('Month suffix for invoice:', monthSuffix);

  // Build SKU lookup map
  const skuMap = {};

  if (withInventory) {
    if (skuData && Array.isArray(skuData)) {
      for (const item of skuData) {
        console.log("item", item);
        // Handle various possible column names from different SKU master versions
        const rawSkuKey = item['Sales portal SKU'] || item['Sales Portal SKU'] || item['sales portal sku'] || item['salesPortalSku'] || item['SKU'] || item['sku'] || '';
        const normalizedKey = normalizeSKU(rawSkuKey);
        // console.log("raw skuy", rawSkuKey);
        const fg = item['Tally new SKU'] || item['Tally New SKU'] || item['Tally SKU'] || item['FG'] || item['tallyNewSku'] || item['fg'] || '';
        // console.log("MAP ENTRY:", normalizedKey, "=>", fg);
        if (normalizedKey) {
          skuMap[normalizedKey] = String(fg).trim();
        }
      }
    }
    console.log(`[Flipkart] SKU map loaded with ${Object.keys(skuMap).length} entries`);
  }

  // Build state config lookup map (by normalized state name)
  const stateConfigMap = {};
  if (stateConfigData && Array.isArray(stateConfigData)) {
    for (const item of stateConfigData) {

      const stateName = normalizeStateName(item.States || item.states || item.State);

      const ledger =
        item['Flipkart Pay Ledger'] ||
        item['flipkart pay ledger'] ||
        item['Amazon Pay Ledger'] ||
        item['Amazon pay ledger'] ||
        item['Ledger'] ||
        '';

      console.log('STATE → LEDGER MAP:', stateName, '=>', ledger);

      if (stateName) {
        stateConfigMap[stateName] = {
          tallyLedger: ledger,
          invoiceNo:
            item['Invoice No.'] ||
            item['Invoice No'] ||
            item['invoice no.'] ||
            ''
        };
      }
    }
  }

  console.log(`State config map loaded with ${Object.keys(stateConfigMap).length} entries`);




  // Read raw file
  const workbook = XLSX.read(rawFileBuffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];

  if (!worksheet) {
    throw new Error('No worksheet found in the uploaded file');
  }

  // Convert to JSON
  const rawData = XLSX.utils.sheet_to_json(worksheet, { defval: null });
  console.log(`Raw data loaded: ${rawData.length} rows`);

  if (rawData.length === 0) {
    throw new Error('Uploaded file has no data rows');
  }

  // ==========================
  // DETECT SKU COLUMN IN RAW DATA (Adopted from Amazon Logic)
  // ==========================
  const possibleSkuCols = ['SKU', 'Sku', 'sku', 'Seller SKU', 'seller sku', 'Item SKU', 'Seller-Sku', 'Seller-SKU'];
  let detectedSkuCol = null;

  const firstRowKeys = Object.keys(rawData[0] || {});
  for (const col of possibleSkuCols) {
    if (firstRowKeys.includes(col)) {
      detectedSkuCol = col;
      break;
    }
  }

  // Fallback to 'SKU' if not found
  if (!detectedSkuCol) {
    detectedSkuCol = 'SKU';
  }


  // Track raw SKU/state values that aren't found in this brand's SKU/Ledger master
  const missingMasterTracker = createMissingMasterTracker();

  // Process working file data
  const workingFileData = [];
  const mainReportData = []; // Cleaned version of raw

  for (const row of rawData) {
    // Get Event Type for filtering
    const eventTypeRaw = String(row['Event Type'] || '').trim();
    const eventSubTypeRaw = String(row['Event Sub Type'] || '').trim();

    const eventType = eventTypeRaw.toLowerCase();
    const eventSubType = eventSubTypeRaw.toLowerCase();

    // allow only Sale or Return in BOTH columns
    const validEventType =
      eventType === 'sale' || eventType === 'return';

    const validEventSubType =
      eventSubType === 'sale' || eventSubType === 'return';

    // if either column is not Sale/Return → skip row
    if (!validEventSubType) {
      continue;
    }

    // Return if ANY column says Return
    const isReturn = eventSubType === 'return' || eventSubType === 'return';


    // Get SKU and Normalize (Amazon logic)
    const rawSku = row[detectedSkuCol] || '';
    const cleanedSku = normalizeSKU(rawSku);

    // console.log("RAW SKU:", rawSku);
    // console.log("CLEANED SKU:", cleanedSku);
    // console.log("FG FOUND:", skuMap[cleanedSku]);

    // Lookup FG from SKU map
    let fg = skuMap[cleanedSku];

    // STRICT FAIL LOG
    if (!fg) {
      console.log("❌ SKU NOT FOUND:", cleanedSku);
    }

    // 🔥 SMART MATCHING
    if (!fg && cleanedSku) {
      for (const key in skuMap) {
        const normalizedKey = normalizeSKU(key);

        if (
          cleanedSku === normalizedKey ||
          cleanedSku.includes(normalizedKey) ||
          normalizedKey.includes(cleanedSku)
        ) {
          fg = skuMap[key];
          console.log("✅ MATCHED VIA FALLBACK:", cleanedSku, "=>", key);
          break;
        }
      }
    }

    if (withInventory && !fg && cleanedSku) {
      missingMasterTracker.track({ masterType: 'sku', matchField: 'Sales portal SKU', value: rawSku });
    }

    // Get Seller State from GSTIN
    const sellerGstin = String(row['Seller GSTIN'] || '').trim();
    const sellerState = getStateFromGSTIN(sellerGstin);

    // Get Customer Delivery State
    const customerDeliveryState = String(row["Customer's Delivery State"] || '').trim();

    // Lookup Tally Ledger and Invoice No from state config
    const normalizedDeliveryState = normalizeStateName(customerDeliveryState);
    const stateConfig = stateConfigMap[normalizedDeliveryState] || {};
    if (!stateConfig.tallyLedger && normalizedDeliveryState) {
      missingMasterTracker.track({ masterType: 'ledger', matchField: 'State', value: customerDeliveryState });
    }
    const tallyLedgers = stateConfig.tallyLedger || '';
    const baseInvoiceNo = stateConfig.invoiceNo || '';
    // Insert the seller GSTIN's 2-digit state code before the month suffix so
    // vouchers stay unique across sellers filing under different GSTINs but
    // shipping to the same delivery state, e.g. FKT-KA-27-07.
    const sellerGstinPrefix = sellerGstin.slice(0, 2);
    const finalInvoiceNo = baseInvoiceNo
      ? `${baseInvoiceNo}${sellerGstinPrefix ? `-${sellerGstinPrefix}` : ''}${monthSuffix}`
      : '';

    // Get raw values
    const priceAfterDiscount = safeNumber(row['Price after discount (Price before discount-Total discount)']);
    const shippingCharges = safeNumber(row['Shipping Charges']);
    const itemQuantity = safeNumber(row['Item Quantity']);
    const igstRate = safeNumber(row['IGST Rate']);
    const cgstRate = safeNumber(row['CGST Rate']);
    const sgstRate = safeNumber(row['SGST Rate (or UTGST as applicable)']);

    // Compute derived columns
    // Final Price after discount (negative if Return)
    const finalPriceAfterDiscount = isReturn ? -Math.abs(priceAfterDiscount) : priceAfterDiscount;

    // Final Shipping Charges (negative if Return)
    const finalShippingCharges = isReturn ? -Math.abs(shippingCharges) : shippingCharges;

    // Final Item Quantity (negative if Return)
    const finalItemQuantity = isReturn ? -Math.abs(itemQuantity) : itemQuantity;

    // Final GST rate = IGST Rate > 0 ? IGST Rate : CGST Rate + SGST Rate
    const finalGstRate = igstRate > 0 ? igstRate : cgstRate + sgstRate;

    // Conversion rate = Final GST rate != 12 ? 1.18 : 1.12
    // const conversionRate = finalGstRate !== 12 ? 1.18 : 1.12;
    let conversionRate = 1; // default fallback

    if (finalGstRate === 2.5 || finalGstRate === 5) {
      conversionRate = 1.05;
    } else if (finalGstRate === 12 || finalGstRate === 6) {
      conversionRate = 1.12;
    } else if (finalGstRate === 9 || finalGstRate === 18) {
      conversionRate = 1.18;
    }

    // Final Taxable sales value = Final Price after discount / Conversion rate
    // (kept to 2 decimal places, no roundoff to a whole number)
    const finalTaxableSalesValue = +(finalPriceAfterDiscount / conversionRate).toFixed(2);

    // Final Shipping Taxable value = Final Shipping Charges / Conversion rate
    // (kept to 2 decimal places, no roundoff to a whole number)
    const finalShippingTaxableValue = +(finalShippingCharges / conversionRate).toFixed(2);

    // Intra-state vs Inter-state
    const isIntraState = normalizeStateName(sellerState) === normalizeStateName(customerDeliveryState);

    // Tax calculations
    let finalCgstTaxable = 0;
    let finalSgstTaxable = 0;
    let finalIgstTaxable = 0;
    let finalCgstShipping = 0;
    let finalSgstShipping = 0;
    let finalIgstShipping = 0;

    if (isIntraState) {
      // Intra-state: CGST and SGST
      finalCgstTaxable = finalTaxableSalesValue * (finalGstRate / 100);
      finalSgstTaxable = finalTaxableSalesValue * (finalGstRate / 100);
      finalCgstShipping = finalShippingTaxableValue * (finalGstRate / 100);
      finalSgstShipping = finalShippingTaxableValue * (finalGstRate / 100);
    } else {
      // Inter-state: IGST
      finalIgstTaxable = finalTaxableSalesValue * (finalGstRate / 100);
      finalIgstShipping = finalShippingTaxableValue * (finalGstRate / 100);
    }

    // Build working file row
    const workingRow = {
      seller_gstin: sellerGstin,
      seller_state: sellerState,
      order_id: row['Order ID'] || null,
      order_item_id: row['Order Item ID'] || null,
      product_title: row['Product Title/Description'] || null,
      fsn: row['FSN'] || null,
      sku: cleanedSku,
      hsn_code: row['HSN Code'] || null,
      event_type: eventType,
      event_sub_type: row['Event Sub Type'] || null,
      order_type: row['Order Type'] || null,
      fulfilment_type: row['Fulfilment Type'] || null,
      order_date: row['Order Date'] || null,
      order_approval_date: row['Order Approval Date'] || null,
      item_quantity: finalItemQuantity,
      order_shipped_from_state: row['Order Shipped From (State)'] || null,
      warehouse_id: row['Warehouse ID'] || null,
      price_before_discount: safeNumber(row['Price before discount']),
      total_discount: safeNumber(row['Total Discount']),
      seller_share: safeNumber(row['Seller Share']),
      bank_offer_share: safeNumber(row['Bank Offer Share']),
      price_after_discount: priceAfterDiscount,
      shipping_charges: shippingCharges,
      final_price_after_discount: finalPriceAfterDiscount,
      final_shipping_charges: finalShippingCharges,
      final_taxable_sales_value: finalTaxableSalesValue,
      final_shipping_taxable_value: finalShippingTaxableValue,
      final_cgst_taxable: finalCgstTaxable,
      final_sgst_taxable: finalSgstTaxable,
      final_igst_taxable: finalIgstTaxable,
      final_cgst_shipping: finalCgstShipping,
      final_sgst_shipping: finalSgstShipping,
      final_igst_shipping: finalIgstShipping,
      final_invoice_amount: safeNumber(row['Final Invoice Amount (Price after discount+Shipping Charges)']),
      tax_type: row['Type of tax'] || null,
      taxable_value: safeNumber(row['Taxable Value (Final Invoice Amount -Taxes)']),
      cst_rate: safeNumber(row['CST Rate']),
      cst_amount: safeNumber(row['CST Amount']),
      vat_rate: safeNumber(row['VAT Rate']),
      vat_amount: safeNumber(row['VAT Amount']),
      luxury_cess_rate: safeNumber(row['Luxury Cess Rate']),
      luxury_cess_amount: safeNumber(row['Luxury Cess Amount']),
      conversion_rate: conversionRate,
      final_gst_rate: finalGstRate,
      igst_rate: igstRate,
      igst_amount: safeNumber(row['IGST Amount']),
      cgst_rate: cgstRate,
      cgst_amount: safeNumber(row['CGST Amount']),
      sgst_rate: safeNumber(row['SGST Rate (or UTGST as applicable)']),
      sgst_amount: safeNumber(row['SGST Amount (Or UTGST as applicable)']),
      tcs_igst_rate: safeNumber(row['TCS IGST Rate']),
      tcs_igst_amount: safeNumber(row['TCS IGST Amount']),
      tcs_cgst_rate: safeNumber(row['TCS CGST Rate']),
      tcs_cgst_amount: safeNumber(row['TCS CGST Amount']),
      tcs_sgst_rate: safeNumber(row['TCS SGST Rate']),
      tcs_sgst_amount: safeNumber(row['TCS SGST Amount']),
      total_tcs_deducted: safeNumber(row['Total TCS Deducted']),
      buyer_invoice_id: row['Buyer Invoice ID'] || null,
      buyer_invoice_date: row['Buyer Invoice Date'] || null,
      buyer_invoice_amount: safeNumber(row['Buyer Invoice Amount']),
      customer_billing_pincode: row["Customer's Billing Pincode"] || null,
      customer_billing_state: row["Customer's Billing State"] || null,
      customer_delivery_pincode: row["Customer's Delivery Pincode"] || null,
      customer_delivery_state: customerDeliveryState,
      tally_ledgers: tallyLedgers,
      final_invoice_no: finalInvoiceNo,
      usual_price: safeNumber(row['Usual Price']),
      is_shopsy_order: row['Is Shopsy Order?'] === 'Yes' || row['Is Shopsy Order?'] === true,
      tds_rate: safeNumber(row['TDS Rate']),
      tds_amount: safeNumber(row['TDS Amount']),
      irn: row['IRN'] || null,
      business_name: row['Business Name'] || null,
      business_gst_number: row['Business GST Number'] || null,
      beneficiary_name: row['Beneficiary Name'] || null,
      imei: row['IMEI'] || null
    };

    if (withInventory) {
      const updatedRow = {};

      for (const key in workingRow) {
        updatedRow[key] = workingRow[key];

        // Insert FG immediately after SKU
        if (key === 'sku') {
          updatedRow.fg = fg || null;
        }
      }

      workingFileData.push(updatedRow);
    } else {
      // No FG column at all
      workingFileData.push(workingRow);
    }

    // Build main report row (cleaned raw data)
    const mainReportRow = {
      'Seller GSTIN': sellerGstin,
      'Seller State': sellerState,
      'Order ID': row['Order ID'],
      'Order Item ID': row['Order Item ID'],
      'Product Title/Description': row['Product Title/Description'],
      'FSN': row['FSN'],
      'SKU': cleanedSku,
      'HSN Code': row['HSN Code'],
      'Event Type': eventType,
      'Event Sub Type': row['Event Sub Type'],
      'Order Type': row['Order Type'],
      'Fulfilment Type': row['Fulfilment Type'],
      'Order Date': row['Order Date'],
      'Order Approval Date': row['Order Approval Date'],
      'Item Quantity': finalItemQuantity,
      'Order Shipped From (State)': row['Order Shipped From (State)'],
      'Warehouse ID': row['Warehouse ID'],
      'Price before discount': safeNumber(row['Price before discount']),
      'Total Discount': safeNumber(row['Total Discount']),
      'Seller Share': safeNumber(row['Seller Share']),
      'Bank Offer Share': safeNumber(row['Bank Offer Share']),
      'Price after discount': priceAfterDiscount,
      'Shipping Charges': shippingCharges,
      'Final -Price after discount': finalPriceAfterDiscount,
      'Final-Shipping Charges': finalShippingCharges,
      'Final Taxable sales value': finalTaxableSalesValue,
      'Final Shipping Taxable value': finalShippingTaxableValue,
      'Final CGST on Taxable value': finalCgstTaxable,
      'Final SGST on Taxable value': finalSgstTaxable,
      'Final IGST on Taxable value': finalIgstTaxable,
      'Final CGST on Shipping value': finalCgstShipping,
      'Final SGST on Shipping value': finalSgstShipping,
      'Final IGST on Shipping value': finalIgstShipping,
      'Final Invoice Amount': safeNumber(row['Final Invoice Amount (Price after discount+Shipping Charges)']),
      'Type of tax': row['Type of tax'],
      'Taxable Value': safeNumber(row['Taxable Value (Final Invoice Amount -Taxes)']),
      'CST Rate': safeNumber(row['CST Rate']),
      'CST Amount': safeNumber(row['CST Amount']),
      'VAT Rate': safeNumber(row['VAT Rate']),
      'VAT Amount': safeNumber(row['VAT Amount']),
      'Luxury Cess Rate': safeNumber(row['Luxury Cess Rate']),
      'Luxury Cess Amount': safeNumber(row['Luxury Cess Amount']),
      'Conversion rate': conversionRate,
      'Final GST rate': finalGstRate,
      'IGST Rate': igstRate,
      'IGST Amount': safeNumber(row['IGST Amount']),
      'CGST Rate': cgstRate,
      'CGST Amount': safeNumber(row['CGST Amount']),
      'SGST Rate': safeNumber(row['SGST Rate (or UTGST as applicable)']),
      'SGST Amount': safeNumber(row['SGST Amount (Or UTGST as applicable)']),
      'TCS IGST Rate': safeNumber(row['TCS IGST Rate']),
      'TCS IGST Amount': safeNumber(row['TCS IGST Amount']),
      'TCS CGST Rate': safeNumber(row['TCS CGST Rate']),
      'TCS CGST Amount': safeNumber(row['TCS CGST Amount']),
      'TCS SGST Rate': safeNumber(row['TCS SGST Rate']),
      'TCS SGST Amount': safeNumber(row['TCS SGST Amount']),
      'Total TCS Deducted': safeNumber(row['Total TCS Deducted']),
      'Buyer Invoice ID': row['Buyer Invoice ID'],
      'Buyer Invoice Date': row['Buyer Invoice Date'],
      'Buyer Invoice Amount': safeNumber(row['Buyer Invoice Amount']),
      "Customer's Billing Pincode": row["Customer's Billing Pincode"],
      "Customer's Billing State": row["Customer's Billing State"],
      "Customer's Delivery Pincode": row["Customer's Delivery Pincode"],
      "Customer's Delivery State": customerDeliveryState,
      'Tally ledgers': tallyLedgers,
      'Final Invoice No.': finalInvoiceNo,
      'Usual Price': safeNumber(row['Usual Price']),
      'Is Shopsy Order?': row['Is Shopsy Order?'],
      'TDS Rate': safeNumber(row['TDS Rate']),
      'TDS Amount': safeNumber(row['TDS Amount']),
      'IRN': row['IRN'],
      'Business Name': row['Business Name'],
      'Business GST Number': row['Business GST Number'],
      'Beneficiary Name': row['Beneficiary Name'],
      'IMEI': row['IMEI']
    };

    // ✅ Inject FG after SKU only when inventory is enabled
    if (withInventory) {
      const updatedRow = {};

      for (const key in mainReportRow) {
        updatedRow[key] = mainReportRow[key];

        if (key === 'SKU') {
          updatedRow['FG'] = fg || '';
        }
      }

      mainReportData.push(updatedRow);
    } else {
      // No FG column at all
      mainReportData.push(mainReportRow);
    }

  }

  console.log(`Working file data: ${workingFileData.length} rows`);

  // ==========================
  // Generate Pivot
  // ==========================
  const pivotMap = {};

  for (const row of workingFileData) {
    // Build pivot key
    const keyObject = {
      seller_gstin: row.seller_gstin || '',
      tally_ledgers: row.tally_ledgers || '',
      final_invoice_no: row.final_invoice_no || '',
      rate: row.final_gst_rate || ''
    };

    if (withInventory) {
      keyObject.fg = row.fg || '';
    }

    const key = JSON.stringify(keyObject);

    // Initialize pivot row
    if (!pivotMap[key]) {
      pivotMap[key] = {
        seller_gstin: row.seller_gstin,
        tally_ledgers: row.tally_ledgers,
        final_invoice_no: row.final_invoice_no,
        rate: row.final_gst_rate,
        sum_of_item_quantity: 0,
        sum_of_final_taxable_sales_value: 0,
        sum_of_final_cgst_taxable: 0,
        sum_of_final_sgst_taxable: 0,
        sum_of_final_igst_taxable: 0,
        sum_of_final_shipping_taxable_value: 0,
        sum_of_final_cgst_shipping: 0,
        sum_of_final_sgst_shipping: 0,
        sum_of_final_igst_shipping: 0
      };

      if (withInventory) {
        pivotMap[key].fg = row.fg || '';
      }
    }

    // Aggregate values
    pivotMap[key].sum_of_item_quantity += safeNumber(row.item_quantity);
    pivotMap[key].sum_of_final_taxable_sales_value += safeNumber(row.final_taxable_sales_value);
    pivotMap[key].sum_of_final_cgst_taxable += safeNumber(row.final_cgst_taxable);
    pivotMap[key].sum_of_final_sgst_taxable += safeNumber(row.final_sgst_taxable);
    pivotMap[key].sum_of_final_igst_taxable += safeNumber(row.final_igst_taxable);
    pivotMap[key].sum_of_final_shipping_taxable_value += safeNumber(row.final_shipping_taxable_value);
    pivotMap[key].sum_of_final_cgst_shipping += safeNumber(row.final_cgst_shipping);
    pivotMap[key].sum_of_final_sgst_shipping += safeNumber(row.final_sgst_shipping);
    pivotMap[key].sum_of_final_igst_shipping += safeNumber(row.final_igst_shipping);
    // pivotMap[key].rate += safeNumber(row.sum_of_final_cgst_taxable + row.sum_of_final_sgst_taxable + row.sum_of_final_igst_taxable) / safeNumber(row.sum_of_final_taxable_sales_value);

  }

  const pivotData = Object.values(pivotMap);
  console.log(`Pivot data: ${pivotData.length} rows`);

  // pivotData.forEach(row => {

  //   const totalTax =
  //     safeNumber(row.sum_of_final_cgst_taxable) +
  //     safeNumber(row.sum_of_final_sgst_taxable) +
  //     safeNumber(row.sum_of_final_igst_taxable);

  //   const taxableValue =
  //     safeNumber(row.sum_of_final_taxable_sales_value);

  //   let rate = 0;

  //   if (taxableValue != 0) {
  //     rate = totalTax / taxableValue;

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
  // Generate After-Pivot
  // ==========================

  const afterPivotData = pivotData.map(row => {
    const result = {
      seller_gstin: row.seller_gstin,
      tally_ledgers: row.tally_ledgers,
      invoice_no: row.final_invoice_no,
      quantity: row.sum_of_item_quantity,
      rate: row.rate,
      taxable_sales_value: row.sum_of_final_taxable_sales_value,
      cgst_sales_amount: row.sum_of_final_cgst_taxable,
      sgst_sales_amount: row.sum_of_final_sgst_taxable,
      igst_sales_amount: row.sum_of_final_igst_taxable,
      shipping_taxable_value: row.sum_of_final_shipping_taxable_value,
      cgst_shipping_amount: row.sum_of_final_cgst_shipping,
      sgst_shipping_amount: row.sum_of_final_sgst_shipping,
      igst_shipping_amount: row.sum_of_final_igst_shipping
    };

    if (withInventory) {
      result.fg = row.fg;
    }

    return result;
  });

  console.log(`After-pivot data: ${afterPivotData.length} rows`);

  // ==========================
  // Create Workbook
  // ==========================
  const outputWorkbook = XLSX.utils.book_new();

  // 1. main-report
  const mainReportSheet = XLSX.utils.json_to_sheet(mainReportData);
  XLSX.utils.book_append_sheet(outputWorkbook, mainReportSheet, 'main-report');

  // 2. working-file
  const workingFileSheetData = workingFileData.map(row => {
    const sheetRow = {
      'Seller GSTIN': row.seller_gstin,
      'Seller State': row.seller_state,
      'Order ID': row.order_id,
      'Order Item ID': row.order_item_id,
      'Product Title': row.product_title,
      'FSN': row.fsn,
      'SKU': row.sku,
    };

    if (withInventory) {
      sheetRow['FG'] = row.fg || '';
    }

    Object.assign(sheetRow, {
      'HSN Code': row.hsn_code,
      'Event Type': row.event_type,
      'Event Sub Type': row.event_sub_type,
      'Order Type': row.order_type,
      'Fulfilment Type': row.fulfilment_type,
      'Order Date': row.order_date,
      'Order Approval Date': row.order_approval_date,
      'Item Quantity': row.item_quantity,
      'Order Shipped From State': row.order_shipped_from_state,
      'Warehouse ID': row.warehouse_id,
      'Price Before Discount': row.price_before_discount,
      'Total Discount': row.total_discount,
      'Seller Share': row.seller_share,
      'Bank Offer Share': row.bank_offer_share,
      'Price After Discount': row.price_after_discount,
      'Shipping Charges': row.shipping_charges,
      'Final -Price after discount': row.final_price_after_discount,
      'Final-Shipping Charges': row.final_shipping_charges,
      'Final Taxable sales value': row.final_taxable_sales_value,
      'Final Shipping Taxable value': row.final_shipping_taxable_value,
      'Final CGST on Taxable value': row.final_cgst_taxable,
      'Final SGST on Taxable value': row.final_sgst_taxable,
      'Final IGST on Taxable value': row.final_igst_taxable,
      'Final CGST on Shipping value': row.final_cgst_shipping,
      'Final SGST on Shipping value': row.final_sgst_shipping,
      'Final IGST on Shipping value': row.final_igst_shipping,
      'Final Invoice Amount': row.final_invoice_amount,
      'Tax Type': row.tax_type,
      'Taxable Value': row.taxable_value,
      'Conversion Rate': row.conversion_rate,
      'Final GST Rate': row.final_gst_rate,
      'IGST Rate': row.igst_rate,
      'IGST Amount': row.igst_amount,
      'CGST Rate': row.cgst_rate,
      'CGST Amount': row.cgst_amount,
      'SGST Rate': row.sgst_rate,
      'SGST Amount': row.sgst_amount,
      'TCS IGST Rate': row.tcs_igst_rate,
      'TCS IGST Amount': row.tcs_igst_amount,
      'TCS CGST Rate': row.tcs_cgst_rate,
      'TCS CGST Amount': row.tcs_cgst_amount,
      'TCS SGST Rate': row.tcs_sgst_rate,
      'TCS SGST Amount': row.tcs_sgst_amount,
      'Total TCS Deducted': row.total_tcs_deducted,
      'Buyer Invoice ID': row.buyer_invoice_id,
      'Buyer Invoice Date': row.buyer_invoice_date,
      'Buyer Invoice Amount': row.buyer_invoice_amount,
      "Customer's Billing Pincode": row.customer_billing_pincode,
      "Customer's Billing State": row.customer_billing_state,
      "Customer's Delivery Pincode": row.customer_delivery_pincode,
      "Customer's Delivery State": row.customer_delivery_state,
      'Tally Ledgers': row.tally_ledgers,
      'Final Invoice No.': row.final_invoice_no,
      'Usual Price': row.usual_price,
      'Is Shopsy Order?': row.is_shopsy_order,
      'TDS Rate': row.tds_rate,
      'TDS Amount': row.tds_amount,
      'IRN': row.irn,
      'Business Name': row.business_name,
      'Business GST Number': row.business_gst_number,
      'Beneficiary Name': row.beneficiary_name,
      'IMEI': row.imei
    });

    return sheetRow;
  });

  XLSX.utils.book_append_sheet(
    outputWorkbook,
    XLSX.utils.json_to_sheet(workingFileSheetData),
    'working-file'
  );

  // 2.5 gstr1-working — grouped by Seller GSTIN + Final GST Rate + Customer's
  // Delivery State, summing the raw (not "Final"/conversion-derived) Taxable
  // Value and tax amount columns from the source report — matches the real
  // GSTR-1 B2C summary table (rate + destination state, no invoice/SKU detail).
  const gstr1WorkingMap = {};
  for (const row of workingFileData) {
    const key = `${row.seller_gstin || ''}|${row.final_gst_rate || 0}|${row.customer_delivery_state || ''}`;
    if (!gstr1WorkingMap[key]) {
      gstr1WorkingMap[key] = {
        'Seller GSTIN': row.seller_gstin || '',
        'Final GST Rate': row.final_gst_rate || 0,
        "Customer's Delivery State": row.customer_delivery_state || '',
        'Sum of Taxable Value (Final Invoice Amount -Taxes)': 0,
        'Sum of IGST Amount': 0,
        'Sum of CGST Amount': 0,
        'Sum of SGST Amount (Or UTGST as applicable)': 0
      };
    }
    gstr1WorkingMap[key]['Sum of Taxable Value (Final Invoice Amount -Taxes)'] += safeNumber(row.taxable_value);
    gstr1WorkingMap[key]['Sum of IGST Amount'] += safeNumber(row.igst_amount);
    gstr1WorkingMap[key]['Sum of CGST Amount'] += safeNumber(row.cgst_amount);
    gstr1WorkingMap[key]['Sum of SGST Amount (Or UTGST as applicable)'] += safeNumber(row.sgst_amount);
  }
  const gstr1WorkingSheetData = Object.values(gstr1WorkingMap);
  XLSX.utils.book_append_sheet(
    outputWorkbook,
    XLSX.utils.json_to_sheet(gstr1WorkingSheetData),
    'gstr1-working'
  );
  console.log(`✓ Added gstr1-working sheet with ${gstr1WorkingSheetData.length} rows`);

  // 2.6 GSTR-HSN — same Seller GSTIN + Final GST Rate + Customer's Delivery
  // State B2C summary as gstr1-working above (raw source-report Taxable Value
  // and tax amounts, not the conversion-derived "Final" values). Emitted only
  // for the "without inventory" run of sales-flipkart, per the accountant's
  // request.
  if (!withInventory) {
    const gstrHsnMap = {};
    for (const row of workingFileData) {
      const hsnCode = row.hsn_code || '';
      const key = `${row.seller_gstin || ''}|${hsnCode}|${row.final_gst_rate || 0}`;
      if (!gstrHsnMap[key]) {
        gstrHsnMap[key] = {
          'Seller GSTIN': row.seller_gstin || '',
          'HSN Code': hsnCode,
          'Final GST Rate': row.final_gst_rate || 0,
          'Sum of Item Quantity': 0,
          'Sum of Taxable Value (Final Invoice Amount -Taxes)': 0,
          'Sum of IGST Amount': 0,
          'Sum of CGST Amount': 0,
          'Sum of SGST Amount (Or UTGST as applicable)': 0
        };
      }
      gstrHsnMap[key]['Sum of Item Quantity'] += safeNumber(row.item_quantity);
      gstrHsnMap[key]['Sum of Taxable Value (Final Invoice Amount -Taxes)'] += safeNumber(row.taxable_value);
      gstrHsnMap[key]['Sum of IGST Amount'] += safeNumber(row.igst_amount);
      gstrHsnMap[key]['Sum of CGST Amount'] += safeNumber(row.cgst_amount);
      gstrHsnMap[key]['Sum of SGST Amount (Or UTGST as applicable)'] += safeNumber(row.sgst_amount);
    }
    const gstrHsnSheetData = Object.values(gstrHsnMap);
    XLSX.utils.book_append_sheet(
      outputWorkbook,
      XLSX.utils.json_to_sheet(gstrHsnSheetData),
      'GSTR-HSN'
    );
    console.log(`✓ Added GSTR-HSN sheet with ${gstrHsnSheetData.length} rows`);
  }

  // 3. pivot
  const pivotSheetData = pivotData.map(row => {
    const sheetRow = {
      'Seller GSTIN': row.seller_gstin,
      'Tally ledgers': row.tally_ledgers,
      'Final Invoice No.': row.final_invoice_no,
      'Sum of Item Quantity': row.sum_of_item_quantity,
      'Rate': row.rate,
      'Sum of Final Taxable sales value': row.sum_of_final_taxable_sales_value,
      'Sum of Final CGST on Taxable value': row.sum_of_final_cgst_taxable,
      'Sum of Final SGST on Taxable value': row.sum_of_final_sgst_taxable,
      'Sum of Final IGST on Taxable value': row.sum_of_final_igst_taxable,
      'Sum of Final Shipping Taxable value': row.sum_of_final_shipping_taxable_value,
      'Sum of Final CGST on Shipping value': row.sum_of_final_cgst_shipping,
      'Sum of Final SGST on Shipping value': row.sum_of_final_sgst_shipping,
      'Sum of Final IGST on Shipping value': row.sum_of_final_igst_shipping
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
  XLSX.utils.book_append_sheet(outputWorkbook, pivotSheet, 'pivot');

  // 4. after-pivot
  const afterPivotSheetData = afterPivotData.map(row => {
    const sheetRow = {
      'Seller GSTIN': row.seller_gstin,
      'Tally ledgers': row.tally_ledgers,
      'Final Invoice No.': row.invoice_no,
      'Quantity': row.quantity,
      'Rate': row.rate,
      'Taxable Sales Value': row.taxable_sales_value,
      'CGST Sales Amount': row.cgst_sales_amount,
      'SGST Sales Amount': row.sgst_sales_amount,
      'IGST Sales Amount': row.igst_sales_amount,
      'Shipping Taxable Value': row.shipping_taxable_value,
      'CGST Shipping Amount': row.cgst_shipping_amount,
      'SGST Shipping Amount': row.sgst_shipping_amount,
      'IGST Shipping Amount': row.igst_shipping_amount
    };

    if (withInventory) {
      sheetRow['FG'] = row.fg;
    }

    return sheetRow;
  });

  XLSX.utils.book_append_sheet(
    outputWorkbook,
    XLSX.utils.json_to_sheet(afterPivotSheetData),
    'after-pivot'
  );

  // ============================================================
  console.log('Step 4.5: Create Tally Ready sheet');
  const tallyReadyResult = generateTallyReady(pivotData, date, withInventory);
  // Build array of arrays: [headers, ...dataRows]
  const tallyReadySheetData = [tallyReadyResult.headers, ...tallyReadyResult.data];
  const tallyReadySheet = XLSX.utils.aoa_to_sheet(tallyReadySheetData);
  // Add formulas for calculated columns
  addFormulasToTallySheet(tallyReadySheet, tallyReadyResult.headers, tallyReadyResult.data.length);
  XLSX.utils.book_append_sheet(outputWorkbook, tallyReadySheet, 'tally ready');
  console.log(`✓ Added tally ready sheet with ${tallyReadyResult.data.length} rows and formulas`);


  // ============================================================
  console.log('Step 4.56: Create shipping ready sheet');
  const shippingtallyReadyResult = generateShippingTallyReady(pivotData, date, withInventory);
  // Build array of arrays: [headers, ...dataRows]
  const shippingtallyReadySheetData = [shippingtallyReadyResult.headers, ...shippingtallyReadyResult.data];
  const shippingtallyReadySheet = XLSX.utils.aoa_to_sheet(shippingtallyReadySheetData);
  // Add formulas for calculated columns (if any)
  addFormulasToTallySheet(shippingtallyReadySheet, shippingtallyReadyResult.headers, shippingtallyReadyResult.data.length);
  XLSX.utils.book_append_sheet(outputWorkbook, shippingtallyReadySheet, 'shipping tally ready');
  console.log(`✓ Added shipping tally ready sheet with ${shippingtallyReadyResult.data.length} rows and formulas`);


  // ============================================================
  // STEP 4.57: CREATE X2BETA WORKING SHEET
  // Same 108-column Tally "X2Beta" e-invoice import template used by the
  // Amazon B2B/B2C processors (see amazonB2CProcessor.js for the reference
  // layout, verified against the accountant's own "Excel to tally" sheet).
  // ============================================================
  console.log('Step 4.57: Create x2beta working sheet');

  function getSellerStateAbbr(gstin) {
    const code = String(gstin || '').trim().substring(0, 2);
    return getStateAbbr(code) || code;
  }

  let x2betaVchDate;
  if (date) {
    const parsedDate = new Date(date);
    if (!isNaN(parsedDate.getTime())) {
      x2betaVchDate = new Date(parsedDate.getFullYear(), parsedDate.getMonth() + 1, 0);
    }
  }
  if (!x2betaVchDate) x2betaVchDate = new Date();

  const x2betaUniqueRates = [...new Set(workingFileData.map(r => Number(r.final_gst_rate || 0)))].filter(r => r > 0);
  const x2betaStateCodes = [...new Set(workingFileData.map(r => getSellerStateAbbr(r.seller_gstin)))].filter(Boolean);
  const x2betaSortedStateCodes = [...x2betaStateCodes].sort();

  const x2betaColumns = [
    { header: 'Vch. Date* ', get: () => x2betaVchDate },
    { header: 'Vch. Type*', get: r => `${Number(r.final_taxable_sales_value || 0) < 0 ? 'CN-' : ''}Sales-${getSellerStateAbbr(r.seller_gstin) || ''}` },
    { header: 'Vch. No.*', get: r => `${Number(r.final_taxable_sales_value || 0) < 0 ? 'CN-' : ''}${r.final_invoice_no || ''}` },
    { header: 'Ref. No.', get: r => r.final_invoice_no || '' },
    { header: 'Ref. Date', get: () => x2betaVchDate },
    { header: 'Is CN?', get: r => (Number(r.final_taxable_sales_value || 0) < 0 ? 'Yes' : null) },
    { header: 'Is Vch?', get: () => null },
    { header: 'Party Ledger*', get: r => r.tally_ledgers || '' },
    { header: 'Sales Ledger*', get: r => `Sales Flipkart-${getSellerStateAbbr(r.seller_gstin) || ''} ${Number(r.final_gst_rate || 0)}%` },
    // Stock-item detail dropped per user request — this sheet is now a
    // ledger-only voucher import (no stock movement), so Stock Item/Qty/Rate/
    // Unit are blanked/zeroed and rows sharing a voucher are grouped below.
    { header: 'Stock Item', get: () => null },
    { header: 'Description', get: () => null },
    { header: 'Godown', get: r => r.order_shipped_from_state || '' },
    { header: 'Quantity', get: () => 0 },
    { header: 'Rate', get: () => 0 },
    { header: 'Unit', get: () => null },
    { header: 'Discount', get: () => null },
    { header: 'Amount*', get: r => Number(r.final_taxable_sales_value || 0) },
    { header: 'Discount', get: () => null }
  ];

  // Dynamic Output IGST/CGST/SGST columns — one triplet per (rate, seller-state)
  // combination present in this run's data, states sorted alphabetically
  // (matches the Amazon x2beta layout's state-column convention).
  x2betaUniqueRates.forEach(rate => {
    const halfRate = Math.round((rate / 2) * 100) / 100;
    x2betaSortedStateCodes.forEach(sc => {
      x2betaColumns.push({
        header: `Output IGST ${rate}%-${sc}`,
        get: row => (Number(row.final_gst_rate || 0) === rate && getSellerStateAbbr(row.seller_gstin) === sc) ? Number(row.final_igst_taxable || 0) : 0
      });
      x2betaColumns.push({
        header: `Output CGST ${halfRate}%-${sc}`,
        get: row => (Number(row.final_gst_rate || 0) === rate && getSellerStateAbbr(row.seller_gstin) === sc) ? Number(row.final_cgst_taxable || 0) : 0
      });
      x2betaColumns.push({
        header: `Output SGST ${halfRate}%-${sc}`,
        get: row => (Number(row.final_gst_rate || 0) === rate && getSellerStateAbbr(row.seller_gstin) === sc) ? Number(row.final_sgst_taxable || 0) : 0
      });
    });
  });

  x2betaColumns.push(
    { header: null, get: () => null },
    { header: null, get: () => null },
    { header: 'Narration', get: () => `Flipkart-${date || ''}` },
    { header: 'Taxability', get: () => null },
    { header: 'GST Nature', get: () => null },
    { header: 'GST Rate', get: r => Number(r.final_gst_rate || 0) },
    { header: 'Cess', get: () => null },
    { header: 'RCM?', get: () => null },
    { header: 'HSN', get: () => null },
    { header: 'HSN Desc', get: () => null },
    { header: 'Supply Type', get: () => null },
    { header: 'Cost Category', get: () => null },
    { header: 'Cost Centre', get: () => null },
    // Party/Consignee/Buyer ledger-master block (Name/Address/PIN/GSTIN blank
    // pending a confirmed master-data source, matching the Amazon sheet).
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: r => r.customer_delivery_state || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
    { header: 'Place of Supply', get: r => r.customer_delivery_state || '' }, { header: 'GST Type', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: r => r.customer_delivery_state || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
    { header: 'Place', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: r => r.customer_delivery_state || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
    { header: 'Place', get: () => null }, { header: 'GSTIN', get: () => null },
    // Dispatch / e-way-bill / transport fields — always blank, not used by this business.
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

  const x2betaHeaders = x2betaColumns.map(c => c.header);
  const x2betaRawRows = workingFileData.map(row => x2betaColumns.map(c => c.get(row)));

  // Group rows sharing the same voucher (Stock Item/Description are now blank
  // and Qty/Rate are zeroed above, so per-SKU line items would otherwise show
  // up as duplicate rows) — sum Amount* and every dynamic Output IGST/CGST/SGST
  // column across the group, keep the rest as-is (identical within a group).
  const x2betaGroupByHeaders = [
    'Vch. Date* ', 'Vch. Type*', 'Vch. No.*', 'Ref. No.', 'Ref. Date',
    'Is CN?', 'Is Vch?', 'Party Ledger*', 'Sales Ledger*', 'Stock Item',
    'Description', 'Godown'
  ];
  const x2betaGroupByIdx = x2betaGroupByHeaders.map(h => x2betaHeaders.indexOf(h));
  const x2betaSumIdx = x2betaColumns
    .map((c, i) => ({ header: c.header, i }))
    .filter(({ header }) => header === 'Amount*' || (typeof header === 'string' && header.startsWith('Output ')))
    .map(({ i }) => i);

  const x2betaGroupedMap = new Map();
  for (const rowArr of x2betaRawRows) {
    const key = x2betaGroupByIdx.map(i => rowArr[i]).join('|');
    if (!x2betaGroupedMap.has(key)) {
      x2betaGroupedMap.set(key, [...rowArr]);
    } else {
      const existing = x2betaGroupedMap.get(key);
      x2betaSumIdx.forEach(i => {
        existing[i] = Number(existing[i] || 0) + Number(rowArr[i] || 0);
      });
    }
  }
  const x2betaGroupedRows = [...x2betaGroupedMap.values()];

  const x2betaSheetData = [x2betaHeaders, ...x2betaGroupedRows];
  const x2betaSheet = XLSX.utils.aoa_to_sheet(x2betaSheetData);
  XLSX.utils.book_append_sheet(outputWorkbook, x2betaSheet, 'x2beta working');
  console.log(`✓ Added x2beta working sheet with ${x2betaGroupedRows.length} rows (grouped from ${x2betaRawRows.length})`);

  // ==================================
  // VALIDATION: x2beta sheet totals must reconcile with the pivot totals
  // ==================================
  const x2betaOutputCols = x2betaColumns.filter(c => typeof c.header === 'string' && c.header.startsWith('Output '));
  const sumX2betaOutput = prefix => workingFileData.reduce((acc, row) => {
    return acc + x2betaOutputCols
      .filter(c => c.header.startsWith(prefix))
      .reduce((rowAcc, c) => rowAcc + Number(c.get(row) || 0), 0);
  }, 0);
  const sumPivot = key => pivotData.reduce((acc, r) => acc + safeNumber(r[key]), 0);

  const x2betaReconciliationChecks = [
    ['Amount* (taxable value)', workingFileData.reduce((acc, r) => acc + Number(r.final_taxable_sales_value || 0), 0), sumPivot('sum_of_final_taxable_sales_value')],
    ['IGST', sumX2betaOutput('Output IGST'), sumPivot('sum_of_final_igst_taxable')],
    ['CGST', sumX2betaOutput('Output CGST'), sumPivot('sum_of_final_cgst_taxable')],
    ['SGST', sumX2betaOutput('Output SGST'), sumPivot('sum_of_final_sgst_taxable')]
  ];
  const X2BETA_RECONCILIATION_TOLERANCE = 0.01;
  x2betaReconciliationChecks.forEach(([label, x2betaTotal, mainTotal]) => {
    if (Math.abs(x2betaTotal - mainTotal) > X2BETA_RECONCILIATION_TOLERANCE) {
      console.warn(`[Flipkart] x2beta working sheet ${label} mismatch: x2beta=${x2betaTotal.toFixed(2)}, main=${mainTotal.toFixed(2)}`);
    }
  });

  // ============================================================
  // STEP 4.58: CREATE X2BETA-SHIPPING WORKING SHEET
  // Same 108-column X2Beta template as "x2beta working" above, but sourced
  // from the shipping-charge amounts — mirrors how "shipping tally ready" is
  // derived from "tally ready" and how the Amazon B2B/B2C processors build
  // their "x2beta-shipping" sheet. No Stock Item / Quantity / Rate / Unit /
  // Godown: freight is a ledger-only line, no stock movement.
  // ============================================================
  console.log('Step 4.58: Create x2beta-shipping sheet');

  const x2betaShippingColumns = [
    { header: 'Vch. Date* ', get: () => x2betaVchDate },
    { header: 'Vch. Type*', get: r => `${Number(r.final_shipping_taxable_value || 0) < 0 ? 'CN-' : ''}Sales-${getSellerStateAbbr(r.seller_gstin) || ''}` },
    { header: 'Vch. No.*', get: r => `${Number(r.final_shipping_taxable_value || 0) < 0 ? 'CN-' : ''}${r.final_invoice_no || ''}` },
    { header: 'Ref. No.', get: r => r.final_invoice_no || '' },
    { header: 'Ref. Date', get: () => x2betaVchDate },
    { header: 'Is CN?', get: r => (Number(r.final_shipping_taxable_value || 0) < 0 ? 'Yes' : null) },
    { header: 'Is Vch?', get: () => null },
    { header: 'Party Ledger*', get: r => r.tally_ledgers || '' },
    { header: 'Sales Ledger*', get: r => `Sales Flipkart-${getSellerStateAbbr(r.seller_gstin) || ''} ${Number(r.final_gst_rate || 0)}%` },
    { header: 'Stock Item', get: () => null },
    { header: 'Description', get: () => null },
    { header: 'Godown', get: () => null },
    { header: 'Quantity', get: () => null },
    { header: 'Rate', get: () => null },
    { header: 'Unit', get: () => null },
    { header: 'Discount', get: () => null },
    { header: 'Amount*', get: r => Number(r.final_shipping_taxable_value || 0) },
    { header: 'Discount', get: () => null }
  ];

  x2betaUniqueRates.forEach(rate => {
    const halfRate = Math.round((rate / 2) * 100) / 100;
    x2betaSortedStateCodes.forEach(sc => {
      x2betaShippingColumns.push({
        header: `Output IGST ${rate}%-${sc}`,
        get: row => (Number(row.final_gst_rate || 0) === rate && getSellerStateAbbr(row.seller_gstin) === sc) ? Number(row.final_igst_shipping || 0) : 0
      });
      x2betaShippingColumns.push({
        header: `Output CGST ${halfRate}%-${sc}`,
        get: row => (Number(row.final_gst_rate || 0) === rate && getSellerStateAbbr(row.seller_gstin) === sc) ? Number(row.final_cgst_shipping || 0) : 0
      });
      x2betaShippingColumns.push({
        header: `Output SGST ${halfRate}%-${sc}`,
        get: row => (Number(row.final_gst_rate || 0) === rate && getSellerStateAbbr(row.seller_gstin) === sc) ? Number(row.final_sgst_shipping || 0) : 0
      });
    });
  });

  x2betaShippingColumns.push(
    { header: null, get: () => null },
    { header: null, get: () => null },
    { header: 'Narration', get: () => `Flipkart-Shipping-${date || ''}` },
    { header: 'Taxability', get: () => null },
    { header: 'GST Nature', get: () => null },
    { header: 'GST Rate', get: r => Number(r.final_gst_rate || 0) },
    { header: 'Cess', get: () => null },
    { header: 'RCM?', get: () => null },
    // Freight doesn't share the stock item's HSN, and the report carries no
    // shipping-specific HSN/SAC — left blank rather than reusing the item's code.
    { header: 'HSN', get: () => null },
    { header: 'HSN Desc', get: () => null },
    { header: 'Supply Type', get: () => null },
    { header: 'Cost Category', get: () => null },
    { header: 'Cost Centre', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: r => r.customer_delivery_state || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
    { header: 'Place of Supply', get: r => r.customer_delivery_state || '' }, { header: 'GST Type', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: r => r.customer_delivery_state || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
    { header: 'Place', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: r => r.customer_delivery_state || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
    { header: 'Place', get: () => null }, { header: 'GSTIN', get: () => null },
    // Dispatch / e-way-bill / transport fields — always blank, not used by this business.
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

  const x2betaShippingHeaders = x2betaShippingColumns.map(c => c.header);
  const x2betaShippingSheetData = [x2betaShippingHeaders, ...workingFileData.map(row => x2betaShippingColumns.map(c => c.get(row)))];
  const x2betaShippingSheet = XLSX.utils.aoa_to_sheet(x2betaShippingSheetData);
  XLSX.utils.book_append_sheet(outputWorkbook, x2betaShippingSheet, 'x2beta-shipping');
  console.log(`✓ Added x2beta-shipping sheet with ${workingFileData.length} rows`);

  // ==================================
  // VALIDATION: x2beta-shipping sheet totals must reconcile with the pivot totals
  // ==================================
  const x2betaShippingOutputCols = x2betaShippingColumns.filter(c => typeof c.header === 'string' && c.header.startsWith('Output '));
  const sumX2betaShippingOutput = prefix => workingFileData.reduce((acc, row) => {
    return acc + x2betaShippingOutputCols
      .filter(c => c.header.startsWith(prefix))
      .reduce((rowAcc, c) => rowAcc + Number(c.get(row) || 0), 0);
  }, 0);

  const x2betaShippingReconciliationChecks = [
    ['Amount* (shipping taxable value)', workingFileData.reduce((acc, r) => acc + Number(r.final_shipping_taxable_value || 0), 0), sumPivot('sum_of_final_shipping_taxable_value')],
    ['Shipping IGST', sumX2betaShippingOutput('Output IGST'), sumPivot('sum_of_final_igst_shipping')],
    ['Shipping CGST', sumX2betaShippingOutput('Output CGST'), sumPivot('sum_of_final_cgst_shipping')],
    ['Shipping SGST', sumX2betaShippingOutput('Output SGST'), sumPivot('sum_of_final_sgst_shipping')]
  ];
  x2betaShippingReconciliationChecks.forEach(([label, x2betaTotal, mainTotal]) => {
    if (Math.abs(x2betaTotal - mainTotal) > X2BETA_RECONCILIATION_TOLERANCE) {
      console.warn(`[Flipkart] x2beta-shipping sheet ${label} mismatch: x2beta=${x2betaTotal.toFixed(2)}, main=${mainTotal.toFixed(2)}`);
    }
  });


  // 5. source-sku
  if (withInventory && console.log("withinventory source-sku", withInventory)) {
    XLSX.utils.book_append_sheet(
      outputWorkbook,
      XLSX.utils.json_to_sheet(
        (skuData || []).map(item => ({
          'SKU': item.SKU || item.salesPortalSku || '',
          'FG': item.FG || item.tallyNewSku || ''
        }))
      ),
      'source-sku'
    );
  }
  // 6. source-state
  XLSX.utils.book_append_sheet(
    outputWorkbook,
    XLSX.utils.json_to_sheet(
      (stateConfigData || []).map(item => ({
        'States': item.States || item.states || '',
        'Flipkart Pay Ledger': item['Ledger'] || item['ledger'] || '',
        'Invoice No.': item['Invoice No.'] || item['Invoice No'] || ''
      }))
    ),
    'source-state'
  );

  console.log('=== FLIPKART MACROS PROCESSING COMPLETE ===');
  console.log(`Output workbook sheets: ${outputWorkbook.SheetNames.join(', ')}`);

  return {
    workingFileData,
    pivotData,
    afterPivotData,
    outputWorkbook,
    missingMasterValues: missingMasterTracker.list()
  };
}

module.exports = {
  flipkartProcessor
};




