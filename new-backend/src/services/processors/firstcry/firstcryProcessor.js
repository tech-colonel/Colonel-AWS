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

  // ============================================================
  // WORKING SHEET — every raw column verbatim (sourced from rawData, so the
  // debit-note sign-flip applied to `processedData` above never touches it),
  // plus an FG column right after "Product ID" on with-inventory runs, plus
  // eight calculated columns. Built as an array of arrays so the calculated
  // "HSN Code" can sit next to the raw "HSN Code" without a key collision.
  // ============================================================
  const num = safeNumber;
  const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

  // Raw header list in first-seen order across all rows (nothing hardcoded).
  const rawHeaders = [];
  {
    const seen = new Set();
    rawData.forEach(r => Object.keys(r).forEach(k => {
      if (!seen.has(k)) { seen.add(k); rawHeaders.push(k); }
    }));
  }

  // ---- raw-column getters (tolerate the header-name variants seen in the wild)
  const getGross     = (r) => num(r['Gross Amount']);
  const getCgstAmt   = (r) => num(r['CGST Amount']);
  const getSgstAmt   = (r) => num(r['SGST Amount']);
  const getQty       = (r) => num(r['Qty'] != null ? r['Qty'] : r['Quantity']);
  const getBaseCost  = (r) => num(r['Base Cost'] != null ? r['Base Cost'] : r['Rate']);
  const getSrQty     = (r) => num(r['SR Qty']);
  const getVendorInv = (r) => (r['Vendor Invoice no.'] != null ? r['Vendor Invoice no.']
                             : r['Vendor Invoice No.'] != null ? r['Vendor Invoice No.'] : '');
  const getShipDate  = (r) => (r['Shipping Date'] != null ? r['Shipping Date']
                             : r['Shipping date'] != null ? r['Shipping date'] : '');
  const getDebitNote = (r) => (r['Debit note no.'] != null ? r['Debit note no.']
                             : r['Debit Note No.'] != null ? r['Debit Note No.'] : '');

  // "GST Rate " = CGST % + SGST %  (raw whole-number percentages, e.g. 9 + 9 = 18)
  const gstRateOf = (r) => num(r['CGST %'] != null ? r['CGST %'] : r['CGST%'])
                         + num(r['SGST %'] != null ? r['SGST %'] : r['SGST%']);

  // Calc "HSN Code" / "HSN Code2" = text before "@" in the raw HSN cell, trimmed
  const hsn2Of = (r) => {
    const raw = r['HSN Code'] != null ? r['HSN Code'] : (r['HSN'] != null ? r['HSN'] : '');
    return String(raw).split('@')[0].trim();
  };

  // Per-row calculated block — shared by the working sheet and the GSTR pivots
  const calcOf = (r) => {
    const srQty    = getSrQty(r);
    const rtoQty   = num(r['RTO Qty']);
    const srGross  = num(r['SR Gross Amount']);
    const rtoGross = num(r['RTO Gross Amount']);
    const srTotal  = num(r['SR Total Amount']);
    const rtoTotal = num(r['RTO Total Amount']);
    const gstRate  = gstRateOf(r);

    // IFS(RTO Gross > 0 -> "RTO", SR Gross > 0 -> "SR", else 0)
    let type = 0;
    if (rtoGross > 0) type = 'RTO';
    else if (srGross > 0) type = 'SR';

    const srRtoQty   = srQty + rtoQty;
    const srRtoGross = rtoGross + srGross;
    const srRtoCgst  = round2((srRtoGross * gstRate) / 200);
    const srRtoSgst  = srRtoCgst;
    const check      = round2((srRtoGross + srRtoCgst + srRtoSgst) - (rtoTotal + srTotal));

    return { type, srRtoQty, srRtoGross: round2(srRtoGross), srRtoCgst, srRtoSgst, check, hsn2: hsn2Of(r), gstRate };
  };

  // SKU -> FG (skuMap built earlier; only populated on with-inventory runs)
  const fgOf = (r) => {
    if (!withInventory) return '';
    const productId = safeString(r['Product ID'] || r['ProductID'] || r['Product Id']);
    return (productId && skuMap[productId]) ? skuMap[productId] : '';
  };

  const CALC_HEADERS = [
    'Type',
    'SR and RTO Qty',
    'SR and RTO Gross Amount',
    'SR and RTO CGST ',
    'SR and RTO SGST ',
    'Check',
    'HSN Code',
    'GST Rate '
  ];

  const workingHeaders = [];
  {
    let fgInserted = false;
    rawHeaders.forEach(h => {
      workingHeaders.push(h);
      if (withInventory && h === 'Product ID') { workingHeaders.push('FG'); fgInserted = true; }
    });
    if (withInventory && !fgInserted) workingHeaders.push('FG');
    workingHeaders.push(...CALC_HEADERS);
  }

  const workingAoa = [workingHeaders];
  const workingSheetData = []; // plain objects, for the controller's preview summary

  rawData.forEach(r => {
    const c = calcOf(r);
    const fg = fgOf(r);

    const arr = [];
    let fgInserted = false;
    rawHeaders.forEach(h => {
      arr.push(r[h] != null ? r[h] : null);
      if (withInventory && h === 'Product ID') { arr.push(fg); fgInserted = true; }
    });
    if (withInventory && !fgInserted) arr.push(fg);
    arr.push(c.type, c.srRtoQty, c.srRtoGross, c.srRtoCgst, c.srRtoSgst, c.check, c.hsn2, c.gstRate);
    workingAoa.push(arr);

    workingSheetData.push({
      ...r,
      FG: fg,
      'Type': c.type,
      'SR and RTO Qty': c.srRtoQty,
      'SR and RTO Gross Amount': c.srRtoGross,
      'SR and RTO CGST ': c.srRtoCgst,
      'SR and RTO SGST ': c.srRtoSgst,
      'Check': c.check,
      'GST Rate ': c.gstRate
    });
  });

  // ============================================================
  // GSTR PIVOT SHEETS — plain group-by + sum over every raw row, emitted as
  // arrays of arrays. Values rounded to 2dp; grouping keys kept exact.
  // ============================================================
  const keyPart = (v) => (v instanceof Date ? `D${v.getTime()}` : String(v == null ? '' : v));

  const buildPivot = (headerRow, keyGetters, sumGetters) => {
    const map = new Map();
    rawData.forEach(r => {
      const keyVals = keyGetters.map(g => g(r));
      const key = keyVals.map(keyPart).join('||');
      let entry = map.get(key);
      if (!entry) { entry = { keyVals, sums: sumGetters.map(() => 0) }; map.set(key, entry); }
      sumGetters.forEach((g, i) => { entry.sums[i] += num(g(r)); });
    });
    const aoa = [headerRow];
    for (const { keyVals, sums } of map.values()) aoa.push([...keyVals, ...sums.map(round2)]);
    return XLSX.utils.aoa_to_sheet(aoa);
  };

  // GSTR B2B — by Vendor Invoice no. + Shipping Date + GST Rate
  const gstrB2bHeader = ['Vendor Invoice no.', 'Shipping Date', 'GST Rate ',
    'Gross Amount (Sum)', 'CGST Amount (Sum)', 'SGST Amount (Sum)'];
  const gstrB2bSums = [getGross, getCgstAmt, getSgstAmt];
  if (withInventory) {
    gstrB2bHeader.push('Qty', 'base cost');
    gstrB2bSums.push(getQty, getBaseCost);
  }
  const gstrB2bSheet = buildPivot(gstrB2bHeader, [getVendorInv, getShipDate, gstRateOf], gstrB2bSums);

  // GSTR CN — by Debit note no. + GST Rate
  const gstrCnHeader = ['Debit note no.', 'GST Rate ',
    'SR and RTO Gross Amount (Sum)', 'SR and RTO CGST  (Sum)', 'SR and RTO SGST  (Sum)'];
  const gstrCnSums = [
    (r) => calcOf(r).srRtoGross,
    (r) => calcOf(r).srRtoCgst,
    (r) => calcOf(r).srRtoSgst
  ];
  if (withInventory) {
    gstrCnHeader.push('SR Qty');
    gstrCnSums.push(getSrQty);
  }
  const gstrCnSheet = buildPivot(gstrCnHeader, [getDebitNote, gstRateOf], gstrCnSums);

  // GSTR B2B HSN — by HSN Code2 + GST Rate
  const gstrB2bHsnSheet = buildPivot(
    ['HSN Code2', 'GST Rate ', 'Qty (Sum)', 'Gross Amount (Sum)', 'CGST Amount (Sum)', 'SGST Amount (Sum)'],
    [hsn2Of, gstRateOf],
    [getQty, getGross, getCgstAmt, getSgstAmt]
  );

  // GSTR CN HSN — by HSN Code2 + GST Rate
  const gstrCnHsnSheet = buildPivot(
    ['HSN Code2', 'GST Rate ', 'SR and RTO Qty (Sum)', 'SR and RTO Gross Amount (Sum)',
      'SR and RTO CGST  (Sum)', 'SR and RTO SGST  (Sum)'],
    [hsn2Of, gstRateOf],
    [
      (r) => calcOf(r).srRtoQty,
      (r) => calcOf(r).srRtoGross,
      (r) => calcOf(r).srRtoCgst,
      (r) => calcOf(r).srRtoSgst
    ]
  );

  // ============================================================
  // OUTPUT WORKBOOK
  // ============================================================
  const outputWorkbook = XLSX.utils.book_new();

  const processedSheet = XLSX.utils.json_to_sheet(processedData);
  XLSX.utils.book_append_sheet(outputWorkbook, processedSheet, 'Processed Data');

  XLSX.utils.book_append_sheet(outputWorkbook, XLSX.utils.aoa_to_sheet(workingAoa), 'working');
  XLSX.utils.book_append_sheet(outputWorkbook, gstrB2bSheet, 'GSTR B2B');
  XLSX.utils.book_append_sheet(outputWorkbook, gstrCnSheet, 'GSTR CN');
  XLSX.utils.book_append_sheet(outputWorkbook, gstrB2bHsnSheet, 'GSTR B2B HSN');
  XLSX.utils.book_append_sheet(outputWorkbook, gstrCnHsnSheet, 'GSTR CN HSN');

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
