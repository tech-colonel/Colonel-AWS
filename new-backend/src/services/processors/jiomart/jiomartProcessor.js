const XLSX = require('xlsx-js-style');
const { getStateAbbr } = require('../../../utils/gstStateCodes');
const { createMissingMasterTracker } = require('../../../utils/missingMasterTracker');

const num = v => Number(v || 0);

function getSellerStateAbbr(gstin) {
  const code = String(gstin || '').trim().substring(0, 2);
  return getStateAbbr(code) || code;
}

// ============================================================
// X2BETA WORKING SHEET
// Same 108-column Tally "X2Beta" e-invoice import template used by the
// other marketplace processors. Built directly from `working` rows (one
// row per line item, already carrying a per-row 'Buyer Invoice ID' /
// 'Invoice Number' from the source report — no synthesized invoice-
// numbering scheme needed). No ledger master is wired into this processor,
// so Party/Sales Ledger names are synthesized as "Jiomart Debtor-<state>" /
// "Sales Jiomart-<state> <rate>%", matching the naming convention already
// used by the other channels' Tally ledgers.
// ============================================================
function buildX2betaSheet(working, date) {
  let x2betaVchDate;
  if (date) {
    const parsed = new Date(date);
    if (!isNaN(parsed.getTime())) x2betaVchDate = new Date(parsed.getFullYear(), parsed.getMonth() + 1, 0);
  }
  if (!x2betaVchDate) x2betaVchDate = new Date();

  const uniqueRates = [...new Set(working.map(r => Number(r['Final GST Rate'] || 0)))].filter(r => r > 0);
  const sortedStateCodes = [...new Set(working.map(r => getSellerStateAbbr(r['Seller GSTIN'])))].filter(Boolean).sort();

  const x2betaColumns = [
    { header: 'Vch. Date* ', get: () => x2betaVchDate },
    { header: 'Vch. Type*', get: r => `${Number(r['Taxable Value (Final Invoice Amount -Taxes)'] || 0) < 0 ? 'CN-' : ''}Sales-${getSellerStateAbbr(r['Seller GSTIN']) || ''}` },
    { header: 'Vch. No.*', get: r => r['Buyer Invoice ID'] || r['Invoice Number'] || '' },
    { header: 'Ref. No.', get: r => r['Buyer Invoice ID'] || r['Invoice Number'] || '' },
    { header: 'Ref. Date', get: () => x2betaVchDate },
    { header: 'Is CN?', get: r => (Number(r['Taxable Value (Final Invoice Amount -Taxes)'] || 0) < 0 ? 'Yes' : null) },
    { header: 'Is Vch?', get: () => null },
    { header: 'Party Ledger*', get: r => `Jiomart Debtor-${getSellerStateAbbr(r['Seller GSTIN']) || ''}` },
    { header: 'Sales Ledger*', get: r => `Sales Jiomart-${getSellerStateAbbr(r['Seller GSTIN']) || ''} ${Number(r['Final GST Rate'] || 0)}%` },
    { header: 'Stock Item', get: r => r['FG'] || r['Product Name'] || r['Item Name'] || '' },
    { header: 'Description', get: r => r['Product Name'] || r['Item Name'] || '' },
    { header: 'Godown', get: r => r['Shipped From State'] || r['Billed From State'] || '' },
    { header: 'Quantity', get: r => Number(r['Item Quantity'] || 0) },
    {
      header: 'Rate',
      get: r => {
        const qty = Number(r['Item Quantity'] || 0);
        return qty !== 0 ? Math.abs(Number(r['Taxable Value (Final Invoice Amount -Taxes)'] || 0) / qty) : 0;
      }
    },
    { header: 'Unit', get: () => 'Pcs' },
    { header: 'Discount', get: () => null },
    { header: 'Amount*', get: r => Number(r['Taxable Value (Final Invoice Amount -Taxes)'] || 0) },
    { header: 'Discount', get: () => null }
  ];

  uniqueRates.forEach(rate => {
    const halfRate = Math.round((rate / 2) * 100) / 100;
    sortedStateCodes.forEach(sc => {
      x2betaColumns.push({
        header: `Output IGST ${rate}%-${sc}`,
        get: row => (Number(row['Final GST Rate'] || 0) === rate && getSellerStateAbbr(row['Seller GSTIN']) === sc) ? Number(row['IGST Amount'] || 0) : 0
      });
      x2betaColumns.push({
        header: `Output CGST ${halfRate}%-${sc}`,
        get: row => (Number(row['Final GST Rate'] || 0) === rate && getSellerStateAbbr(row['Seller GSTIN']) === sc) ? Number(row['CGST Amount'] || 0) : 0
      });
      x2betaColumns.push({
        header: `Output SGST ${halfRate}%-${sc}`,
        get: row => (Number(row['Final GST Rate'] || 0) === rate && getSellerStateAbbr(row['Seller GSTIN']) === sc) ? Number(row['SGST Amount (Or UTGST as applicable)'] || 0) : 0
      });
    });
  });

  x2betaColumns.push(
    { header: null, get: () => null },
    { header: null, get: () => null },
    { header: 'Narration', get: () => `Jiomart-${date || ''}` },
    { header: 'Taxability', get: () => null },
    { header: 'GST Nature', get: () => null },
    { header: 'GST Rate', get: r => Number(r['Final GST Rate'] || 0) },
    { header: 'Cess', get: () => null },
    { header: 'RCM?', get: () => null },
    { header: 'HSN', get: r => r['HSN Code'] || '' },
    { header: 'HSN Desc', get: () => null },
    { header: 'Supply Type', get: () => null },
    { header: 'Cost Category', get: () => null },
    { header: 'Cost Centre', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: r => r["Customer's Delivery State"] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: r => r['Delivery Pincode'] || null },
    { header: 'Place of Supply', get: r => r["Customer's Delivery State"] || '' }, { header: 'GST Type', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: r => r["Customer's Delivery State"] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: r => r['Delivery Pincode'] || null },
    { header: 'Place', get: () => null }, { header: 'GSTIN', get: () => null },
    { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
    { header: 'State', get: r => r["Customer's Delivery State"] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: r => r['Delivery Pincode'] || null },
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
  const aoa = [headers, ...working.map(row => x2betaColumns.map(c => c.get(row)))];
  return XLSX.utils.aoa_to_sheet(aoa);
}

function groupBy(arr, keys) {

  const map = {};

  arr.forEach(r => {

    const key = keys.map(k => r[k]).join('|');

    if (!map[key]) map[key] = { ...r };

    else {

      map[key]['Item Quantity'] += num(r['Item Quantity']);
      map[key]['Taxable Value (Final Invoice Amount -Taxes)'] += num(r['Taxable Value (Final Invoice Amount -Taxes)']);
      map[key]['IGST Amount'] += num(r['IGST Amount']);
      map[key]['CGST Amount'] += num(r['CGST Amount']);
      map[key]['SGST Amount (Or UTGST as applicable)'] += num(r['SGST Amount (Or UTGST as applicable)']);

    }

  });

  return Object.values(map);

}

async function jiomartProcessor(
  rawJson,
  skuJson = [],
  brandName,
  date,
  withInventory = true
) {

  const wb = XLSX.utils.book_new();

  // Track raw SKU values that aren't found in this brand's SKU master
  const missingMasterTracker = createMissingMasterTracker();

  /* -------------------------
     STEP 1 RAW SHEET
  -------------------------- */

  const rawSheet = XLSX.utils.json_to_sheet(rawJson);
  XLSX.utils.book_append_sheet(wb, rawSheet, 'raw');

  /* -------------------------
     SKU MAP
  -------------------------- */

  const skuMap = {};
  skuJson.forEach(s => {
    skuMap[String(s.SKU).trim()] = s.FG;
  });

  /* -------------------------
     STEP 2 FILTER + RETURNS
  -------------------------- */

  let working = rawJson.filter(r => {
    const t = (r['Type'] || '').toLowerCase();
    return t === 'shipment' || t === 'return';
  });

  working = working.map(r => {

    const row = { ...r };

    if (String(row['Type']).toLowerCase() === 'return') {
      row['Item Quantity'] = -Math.abs(num(row['Item Quantity']));
    }

    return row;
  });

  /* -------------------------
     STEP 3 FINAL GST RATE
  -------------------------- */

  working = working.map(r => {

    r['Final GST Rate'] =
      num(r['IGST Rate']) +
      num(r['CGST Rate']) +
      num(r['SGST Rate (or UTGST as applicable)']);

    return r;
  });

  /* -------------------------
     STEP 4 FG MAP
  -------------------------- */

  if (withInventory) {

    working = working.map(r => {

      const sku = r['SKU'];
      const fg = skuMap[sku];

      if (!fg && sku) {
        missingMasterTracker.track({ masterType: 'sku', matchField: 'SKU', value: sku });
      }

      r['FG'] = fg || '';

      return r;

    });

  }

  /* -------------------------
     STEP 5 WORKING SHEET
  -------------------------- */

  const workingSheet = XLSX.utils.json_to_sheet(working);
  XLSX.utils.book_append_sheet(wb, workingSheet, 'working');

  /* -------------------------
     STEP 6 GSTR B2C
  -------------------------- */

  const b2cData = working.map(r => ({

    'Final GST Rate': r['Final GST Rate'],
    'Customer\'s Delivery State': r["Customer's Delivery State"],
    'Item Quantity': num(r['Item Quantity']),
    'Taxable Value (Final Invoice Amount -Taxes)': num(r['Taxable Value (Final Invoice Amount -Taxes)']),
    'IGST Amount': num(r['IGST Amount']),
    'CGST Amount': num(r['CGST Amount']),
    'SGST Amount (Or UTGST as applicable)': num(r['SGST Amount (Or UTGST as applicable)'])
  }));

  const gstrB2C = groupBy(
    b2cData,
    ['Final GST Rate', "Customer's Delivery State"]
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(gstrB2C),
    'GSTR B2C'
  );

  /* -------------------------
     STEP 7 GSTR HSN
  -------------------------- */

  const hsnData = working.map(r => ({

    'HSN Code': r['HSN Code'],
    'Final GST Rate': r['Final GST Rate'],
    'Item Quantity': num(r['Item Quantity']),
    'Taxable Value (Final Invoice Amount -Taxes)': num(r['Taxable Value (Final Invoice Amount -Taxes)']),
    'IGST Amount': num(r['IGST Amount']),
    'CGST Amount': num(r['CGST Amount']),
    'SGST Amount (Or UTGST as applicable)': num(r['SGST Amount (Or UTGST as applicable)'])

  }));

  const gstrHSN = groupBy(
    hsnData,
    ['HSN Code', 'Final GST Rate']
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(gstrHSN),
    'GSTR HSN'
  );

  /* -------------------------
     STEP 8 GSTR HSN BY SELLER GSTIN
  -------------------------- */

  const hsnBySellerMap = {};
  working.forEach(r => {
    const sellerGstin = String(r['Seller GSTIN'] || '').trim();
    const hsn = String(r['HSN Code'] || '').trim();
    const rate = num(r['Final GST Rate']);
    const key = `${sellerGstin}|${hsn}|${rate}`;
    if (!hsnBySellerMap[key]) {
      hsnBySellerMap[key] = {
        'Seller Gstin': sellerGstin,
        'Hsn/sac': hsn,
        'Rate': rate,
        'Quantity': 0,
        'Final Taxable Sales Value': 0,
        'Final CGST Tax': 0,
        'Final SGST Tax': 0,
        'Final IGST Tax': 0
      };
    }
    hsnBySellerMap[key]['Quantity'] += num(r['Item Quantity']);
    hsnBySellerMap[key]['Final Taxable Sales Value'] += num(r['Taxable Value (Final Invoice Amount -Taxes)']);
    hsnBySellerMap[key]['Final CGST Tax'] += num(r['CGST Amount']);
    hsnBySellerMap[key]['Final SGST Tax'] += num(r['SGST Amount (Or UTGST as applicable)']);
    hsnBySellerMap[key]['Final IGST Tax'] += num(r['IGST Amount']);
  });
  const gstrHsnBySellerGstin = Object.values(hsnBySellerMap);

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(gstrHsnBySellerGstin),
    'jiomart-gstr-hsn'
  );

  /* -------------------------
     STEP 9 X2BETA WORKING SHEET
  -------------------------- */

  const x2betaSheet = buildX2betaSheet(working, date);
  XLSX.utils.book_append_sheet(wb, x2betaSheet, 'x2beta working');

  return {

    outputWorkbook: wb,
    processedData: working,
    workingSheetData: working,
    gstrB2C: gstrB2C,
    gstrHSN: gstrHSN,
    gstrHsnBySellerGstin: gstrHsnBySellerGstin,
    uniqueProductIds: [],
    missingMasterValues: missingMasterTracker.list()

  };

}

module.exports = {
  jiomartProcessor
};