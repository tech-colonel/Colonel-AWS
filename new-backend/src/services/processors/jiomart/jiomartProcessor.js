const XLSX = require('xlsx-js-style');

const num = v => Number(v || 0);

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

      r['FG'] = skuMap[sku] || '';

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

  return {

    outputWorkbook: wb,
    processedData: working,
    workingSheetData: working,
    gstrB2C: gstrB2C,
    gstrHSN: gstrHSN,
    gstrHsnBySellerGstin: gstrHsnBySellerGstin,
    uniqueProductIds: []

  };

}

module.exports = {
  jiomartProcessor
};