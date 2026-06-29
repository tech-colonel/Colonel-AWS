const XLSX = require('xlsx-js-style');
const moment = require('moment');

/**
 * Safe date conversion for DB (returns JS Date or null)
 */
function safeDate(value) {
  if (!value) return null;

  const m = moment(value, [
    'DD-MM-YYYY',
    'YYYY-MM-DD',
    'DD/MM/YYYY',
    'MM/DD/YYYY'
  ], true);

  if (!m.isValid()) return null;

  return m.toDate(); // ✅ RETURN REAL DATE OBJECT
}

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

async function firstcryProcessor(
  rawFileBuffer,
  skuData = [],
  stateConfigData = [],
  brandName,
  date,
  withInventory = true
) {
  const workbook = XLSX.read(rawFileBuffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const rawData = XLSX.utils.sheet_to_json(worksheet, { defval: null });

  if (!rawData || rawData.length === 0) {
    throw new Error('Raw file is empty or could not be parsed');
  }

  console.log(`Processing ${rawData.length} rows from FirstCry raw file`);

  // SKU Map
  const skuMap = {};
  if (skuData && skuData.length > 0 && withInventory) {
    skuData.forEach(item => {
      const productId = safeString(
        item.SKU || item.sku || item['Product ID'] || item['Sales Portal SKU']
      );
      const fg = safeString(
        item.FG || item.fg || item['Tally New SKU']
      );
      if (productId) {
        skuMap[productId] = fg;
      }
    });
  }

  const processedData = rawData.map(row => {
    const processedRow = { ...row };
    console.log("row", row);

    // 🔁 Debit Note Negative Logic
    const debitNote = safeString(
      row['Debit note no.'] ||
      row['Debit Note No.'] ||
      row['Debit Note']
    );

    const hasDebitNote =
      debitNote && debitNote !== '0' && debitNote !== 'null';

    if (hasDebitNote) {
      const fieldsToNegate = [
        'Qty',
        'MRP',
        'Rate',
        'Gross Amount',
        'CGST %',
        'CGST Amount',
        'SGST %',
        'SGST Amount',
        'Total'
      ];

      fieldsToNegate.forEach(field => {
        const value = safeNumber(row[field]);
        if (value !== 0) {
          processedRow[field] = -Math.abs(value);
        }
      });
    }

    // ✅ SAFE DATE HANDLING (NO INVALID DATE POSSIBLE)
    processedRow['Order Date'] = safeDate(row['Order Date']);
    processedRow['Invoice Date'] = safeDate(row['Shipping Date']);
    processedRow['Delivery date'] =
      safeDate(row['Delivery date']) ||
      safeDate(row['Delivery Date']);
    processedRow['SR/RTO date'] =
      safeDate(row['SR/RTO date']) ||
      safeDate(row['SR RTO date']) ||
      safeDate(row['SR/RTO Date']);

    // SKU Mapping
    if (withInventory) {
      const productId = safeString(
        row['Product ID'] ||
        row['ProductID'] ||
        row['Product Id']
      );
      if (productId && skuMap[productId]) {
        processedRow['FG'] = skuMap[productId];
      }
    }

    return processedRow;
  });

  // Working Sheet
  const workingSheetData = processedData.map(row => {
    const total = safeNumber(row['Total']);
    const taxable = safeNumber(row['Gross Amount']);
    const cgstAmount = safeNumber(row['CGST Amount']);
    const sgstAmount = safeNumber(row['SGST Amount']);
    const igstAmount = total - taxable - cgstAmount - sgstAmount;

    return {
      'Invoice Date': safeDate(row['Shipping Date']),
      'Invoice no.':
        row['Vendor Invoice no.'] ||
        row['Vendor Invoice No.'] ||
        row['Invoice no.'] ||
        '',
      'FG': safeString(row['FG']),
      'Quantity': safeNumber(row['Qty'] || row['Quantity']),
      'Taxable value': taxable,
      'CGST Amount': cgstAmount,
      'SGST Amount': sgstAmount,
      'IGST Amount': igstAmount
    };
  });

  // Output Workbook
  const outputWorkbook = XLSX.utils.book_new();
  const processedSheet = XLSX.utils.json_to_sheet(processedData);
  XLSX.utils.book_append_sheet(outputWorkbook, processedSheet, 'Processed Data');

  const workingSheet = XLSX.utils.json_to_sheet(workingSheetData);
  XLSX.utils.book_append_sheet(outputWorkbook, workingSheet, 'working');

  // Unique Product IDs
  const uniqueProductIds = new Set();
  processedData.forEach(row => {
    const productId = safeString(
      row['Product ID'] ||
      row['ProductID'] ||
      row['Product Id']
    );
    if (productId) {
      uniqueProductIds.add(productId);
    }
  });

  return {
    processedData,
    workingSheetData,
    outputWorkbook,
    rawDataJson: rawData,
    uniqueProductIds: Array.from(uniqueProductIds),
    uniqueStates: []
  };
}

module.exports = {
  firstcryProcessor
};
