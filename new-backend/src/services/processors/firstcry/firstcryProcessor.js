const XLSX = require('xlsx-js-style');
const moment = require('moment');
const { createMissingMasterTracker } = require('../../../utils/missingMasterTracker');

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

  // Track raw SKU values that aren't found in this brand's SKU master
  const missingMasterTracker = createMissingMasterTracker();

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
      } else if (productId) {
        missingMasterTracker.track({ masterType: 'sku', matchField: 'Product ID', value: productId });
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

  // X2Beta working — same 108-column Tally e-invoice import template used by
  // the other marketplace processors.
  const x2betaSheet = buildX2betaSheet(processedData);
  XLSX.utils.book_append_sheet(outputWorkbook, x2betaSheet, 'x2beta working');

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
    uniqueStates: [],
    missingMasterValues: missingMasterTracker.list()
  };
}

// Snap a raw GST rate (percent) to the nearest standard Indian GST slab
const STANDARD_GST_RATES = [5, 12, 18, 28];
function snapGstRatePercent(rawRatePercent) {
  return STANDARD_GST_RATES.reduce((prev, curr) =>
    Math.abs(curr - rawRatePercent) < Math.abs(prev - rawRatePercent) ? curr : prev
  );
}

// ============================================================
// X2BETA WORKING SHEET
// Same 108-column Tally "X2Beta" e-invoice import template used by the
// other marketplace processors. FirstCry's source report already carries a
// real per-row invoice number/date, so no synthesized invoice-numbering
// scheme is needed. Unlike every other channel this processor has no
// seller-state parameter and never extracts a ship-to state at all (its
// own `stateConfigData` input is accepted but unused upstream) — CGST/SGST
// vs IGST is driven entirely by whichever amount columns the source file
// itself populates. With no state data anywhere, Party Ledger, Sales
// Ledger and the Output tax column headers omit the "-<state>" suffix
// used by every other channel, and the State/Place of Supply/Godown
// columns are left blank rather than fabricated.
// ============================================================
function buildX2betaSheet(processedData) {
  function rowInvoiceDate(row) {
    const d = row['Invoice Date'];
    if (d instanceof Date && !isNaN(d.getTime())) return d;
    return new Date();
  }

  function rowInvoiceNo(row) {
    return row['Vendor Invoice no.'] || row['Vendor Invoice No.'] || row['Invoice no.'] || '';
  }

  function rowAmounts(row) {
    const taxable = safeNumber(row['Gross Amount']);
    const cgst = safeNumber(row['CGST Amount']);
    const sgst = safeNumber(row['SGST Amount']);
    const total = safeNumber(row['Total']);
    const igst = total - taxable - cgst - sgst;
    return { taxable, cgst, sgst, igst };
  }

  function rowRatePercent(row) {
    const cgstPct = safeNumber(row['CGST %']);
    const sgstPct = safeNumber(row['SGST %']);
    if (cgstPct || sgstPct) return cgstPct + sgstPct;
    const { taxable, igst } = rowAmounts(row);
    if (taxable > 0 && igst !== 0) return snapGstRatePercent((igst / taxable) * 100);
    return 0;
  }

  const uniqueRates = [...new Set(processedData.map(r => Math.round(rowRatePercent(r) * 100)))].filter(r => r > 0).map(r => r / 100);

  const x2betaColumns = [
    { header: 'Vch. Date* ', get: r => rowInvoiceDate(r) },
    { header: 'Vch. Type*', get: r => `${safeNumber(r['Total']) < 0 ? 'CN-' : ''}Sales` },
    { header: 'Vch. No.*', get: r => rowInvoiceNo(r) },
    { header: 'Ref. No.', get: r => rowInvoiceNo(r) },
    { header: 'Ref. Date', get: r => rowInvoiceDate(r) },
    { header: 'Is CN?', get: r => (safeNumber(r['Total']) < 0 ? 'Yes' : null) },
    { header: 'Is Vch?', get: () => null },
    { header: 'Party Ledger*', get: () => 'Firstcry Debtor' },
    { header: 'Sales Ledger*', get: r => `Sales Firstcry ${rowRatePercent(r)}%` },
    { header: 'Stock Item', get: r => r['FG'] || '' },
    { header: 'Description', get: () => null },
    { header: 'Godown', get: () => null },
    { header: 'Quantity', get: r => safeNumber(r['Qty'] || r['Quantity']) },
    {
      header: 'Rate',
      get: r => {
        const qty = safeNumber(r['Qty'] || r['Quantity']);
        return qty !== 0 ? Math.abs(rowAmounts(r).taxable / qty) : 0;
      }
    },
    { header: 'Unit', get: () => 'Pcs' },
    { header: 'Discount', get: () => null },
    { header: 'Amount*', get: r => rowAmounts(r).taxable },
    { header: 'Discount', get: () => null }
  ];

  uniqueRates.forEach(rate => {
    const halfRate = Math.round((rate / 2) * 100) / 100;
    x2betaColumns.push({
      header: `Output IGST ${rate}%`,
      get: row => (rowRatePercent(row) === rate) ? rowAmounts(row).igst : 0
    });
    x2betaColumns.push({
      header: `Output CGST ${halfRate}%`,
      get: row => (rowRatePercent(row) === rate) ? rowAmounts(row).cgst : 0
    });
    x2betaColumns.push({
      header: `Output SGST ${halfRate}%`,
      get: row => (rowRatePercent(row) === rate) ? rowAmounts(row).sgst : 0
    });
  });

  x2betaColumns.push(
    { header: null, get: () => null },
    { header: null, get: () => null },
    { header: 'Narration', get: () => 'Firstcry' },
    { header: 'Taxability', get: () => null },
    { header: 'GST Nature', get: () => null },
    { header: 'GST Rate', get: r => rowRatePercent(r) },
    { header: 'Cess', get: () => null },
    { header: 'RCM?', get: () => null },
    // FirstCry's source report carries no HSN column — left blank rather than fabricated.
    { header: 'HSN', get: () => null },
    { header: 'HSN Desc', get: () => null },
    { header: 'Supply Type', get: () => null },
    { header: 'Cost Category', get: () => null },
    { header: 'Cost Centre', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: () => null }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
    { header: 'Place of Supply', get: () => null }, { header: 'GST Type', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: () => null }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
    { header: 'Place', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: () => null }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
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
  const aoa = [headers, ...processedData.map(row => x2betaColumns.map(c => c.get(row)))];
  return XLSX.utils.aoa_to_sheet(aoa);
}

module.exports = {
  firstcryProcessor
};
