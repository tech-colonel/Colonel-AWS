const XLSX = require('xlsx-js-style');
const ExcelJS = require('exceljs');

async function processMacrosB2B(
  rawFileBuffer,
  skuFileBuffer,
  brandName,
  date,
  sourceSheetData,
  stateConfigData,
  useInventory
) {
  try {
    if (!rawFileBuffer) {
      throw new Error('Raw file buffer is required');
    }

    const rawWorkbook = XLSX.read(rawFileBuffer, { type: 'buffer' });
    const firstSheetName = rawWorkbook.SheetNames[0];
    const rawSheet = rawWorkbook.Sheets[firstSheetName];

    const rawJson = XLSX.utils.sheet_to_json(rawSheet, {
      defval: null
    });

    if (!rawJson.length) {
      throw new Error('Raw sheet is empty');
    }

    const headers = Object.keys(rawJson[0]);

    const transactionColumn = headers.find(
      h => h.toLowerCase().trim() === 'transaction type'
    );

    const quantityColumn = headers.find(
      h => h.toLowerCase().trim() === 'quantity'
    );

    const sellerGstinColumn = headers.find(
      h => h.toLowerCase().trim() === 'seller gstin'
    );

    if (!transactionColumn) throw new Error('Transaction Type column not found');
    if (!quantityColumn) throw new Error('Quantity column not found');
    if (!sellerGstinColumn) throw new Error('Seller Gstin column not found');

    const filteredRows = rawJson.filter(row => {
      const type = row[transactionColumn];
      return type === 'Shipment' || type === 'Refund';
    });

    filteredRows.forEach(row => {
      if (row[transactionColumn] === 'Refund') {
        const qty = parseFloat(row[quantityColumn] || 0);
        row[quantityColumn] = -Math.abs(qty);
      }
    });

    const cessIndex = headers.findIndex(
      h => h.toLowerCase().trim() === 'compensatory cess tax'
    );

    if (cessIndex === -1) {
      throw new Error('Compensatory Cess Tax column not found');
    }

    const newColumns = [
      'Final Tax rate',
      'Final Taxable Sales Value',
      'Final Taxable Shipping Value',
      'Final CGST Tax',
      'Final SGST Tax',
      'Final IGST Tax',
      'Final Shipping CGST Tax',
      'Final Shipping SGST Tax',
      'Final Shipping IGST Tax',
      'Final Amount Receivable'
    ];

    headers.splice(cessIndex + 1, 0, ...newColumns);

    filteredRows.forEach(row => {
      newColumns.forEach(col => {
        row[col] = null;
      });
    });

    const shipToStateIndex = headers.findIndex(
      h => h.toLowerCase().trim() === 'ship to state'
    );

    if (shipToStateIndex === -1) {
      throw new Error('Ship To State column not found');
    }

    const stateInvoiceColumns = [
      'Ship To State Tally Ledger',
      'Final Invoice No.'
    ];

    headers.splice(shipToStateIndex + 1, 0, ...stateInvoiceColumns);

    filteredRows.forEach(row => {
      stateInvoiceColumns.forEach(col => {
        row[col] = null;
      });
    });

    if (useInventory === true) {
      const skuIndex = headers.findIndex(
        h => h.toLowerCase().trim() === 'sku'
      );

      if (skuIndex === -1) {
        throw new Error('Sku column not found while adding FG');
      }

      headers.splice(skuIndex + 1, 0, 'FG');

      filteredRows.forEach(row => {
        row['FG'] = null;
      });
    }

    const monthNumber = (() => {
      const d = new Date(date);
      const m = d.getMonth() + 1;
      return String(m).padStart(2, '0');
    })();

    filteredRows.forEach(row => {
      const shipFrom = (row["Ship From State"] || "")
        .toString()
        .trim()
        .toLowerCase();

      const shipTo = (row["Ship To State"] || "")
        .toString()
        .trim()
        .toLowerCase();

      if (!shipFrom || !shipTo) {
        row["Ship To State Tally Ledger"] = null;
        row["Final Invoice No."] = null;
        return;
      }

      const isIntraState = shipFrom === shipTo;

      if (isIntraState) {
        row["Ship To State Tally Ledger"] = "Amazon B2B Intra-State";
        row["Final Invoice No."] = `AMZ-INTRA-${monthNumber}`;
      } else {
        row["Ship To State Tally Ledger"] = "Amazon B2B Inter-State";
        row["Final Invoice No."] = `AMZ-INTER-${monthNumber}`;
      }
    });

    if (useInventory === true && Array.isArray(sourceSheetData)) {
      const normalizeSKU = (sku) => {
        if (!sku) return '';
        return sku
          .toString()
          .replace(/"/g, '')
          .replace(/\r\n|\n|\r/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
      };

      const possibleSkuColumns = [
        'SKU',
        'Sku',
        'sku',
        'Seller SKU',
        'seller sku',
        'Item SKU'
      ];

      let detectedSkuColumn = null;
      const sampleRow = filteredRows[0];

      for (let col of possibleSkuColumns) {
        if (sampleRow.hasOwnProperty(col)) {
          detectedSkuColumn = col;
          break;
        }
      }

      if (!detectedSkuColumn) {
        console.log("❌ SKU Column Not Found in Sheet");
        return;
      }

      console.log("✅ Using SKU Column:", detectedSkuColumn);

      const skuMap = {};
      sourceSheetData.forEach(item => {
        const key = normalizeSKU(item.SKU);
        if (key) skuMap[key] = item.FG || null;
      });

      filteredRows.forEach(row => {
        const rawSKU = row[detectedSkuColumn];
        const lookupKey = normalizeSKU(rawSKU);
        row['FG'] = skuMap[lookupKey] || null;
      });
    }

    filteredRows.forEach(row => {
      const cgstRate = Number(row['Cgst Rate'] || 0);
      const igstRate = Number(row['Igst Rate'] || 0);
      const sgstRate = Number(row['Sgst Rate'] || 0);

      const finalTaxRate = cgstRate + igstRate;

      const shippingValue =
        Number(row['Shipping Amount Basis'] || 0) +
        Number(row['Gift Wrap Amount Basis'] || 0) +
        Number(row['Gift Wrap Promo Discount Basis'] || 0) +
        Number(row['Shipping Promo Discount Basis'] || 0);

      const taxableSales =
        Number(row['Tax Exclusive Gross'] || 0) - shippingValue;

      const isIntraState =
        row['Ship From State'] === row['Ship To State'];

      row['Final Tax rate'] = finalTaxRate;
      row['Final Taxable Shipping Value'] = shippingValue;
      row['Final Taxable Sales Value'] = taxableSales;

      row['Final CGST Tax'] =
        isIntraState ? taxableSales * cgstRate : 0;

      row['Final SGST Tax'] =
        isIntraState ? taxableSales * sgstRate : 0;

      row['Final IGST Tax'] =
        !isIntraState ? taxableSales * igstRate : 0;

      row['Final Shipping CGST Tax'] =
        isIntraState ? shippingValue * cgstRate : 0;

      row['Final Shipping SGST Tax'] =
        isIntraState ? shippingValue * sgstRate : 0;

      row['Final Shipping IGST Tax'] =
        !isIntraState ? shippingValue * igstRate : 0;

      const tcsTotal =
        Number(row['Tcs Cgst Amount'] || 0) +
        Number(row['Tcs Sgst Amount'] || 0) +
        Number(row['Tcs Igst Amount'] || 0);

      row['Final Amount Receivable'] =
        taxableSales +
        shippingValue +
        row['Final CGST Tax'] +
        row['Final SGST Tax'] +
        row['Final IGST Tax'] +
        row['Final Shipping CGST Tax'] +
        row['Final Shipping SGST Tax'] +
        row['Final Shipping IGST Tax'] -
        tcsTotal;
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('updated raw sheet');

    worksheet.columns = headers.map(header => ({
      header: header,
      key: header,
      width: 22
    }));

    function getColumnLetter(colNumber) {
      let temp, letter = '';
      while (colNumber > 0) {
        temp = (colNumber - 1) % 26;
        letter = String.fromCharCode(temp + 65) + letter;
        colNumber = (colNumber - temp - 1) / 26;
      }
      return letter;
    }

    const headerIndexMap = {};
    headers.forEach((header, index) => {
      headerIndexMap[header] = index + 1;
    });

    const requiredColumns = [
      'Cgst Rate',
      'Igst Rate',
      'Shipping Amount Basis',
      'Gift Wrap Amount Basis',
      'Gift Wrap Promo Discount Basis',
      'Shipping Promo Discount Basis',
      'Tax Exclusive Gross',
      'Ship From State',
      'Ship To State',
      'Tcs Cgst Amount',
      'Tcs Sgst Amount',
      'Tcs Igst Amount'
    ];

    requiredColumns.forEach(col => {
      if (!headerIndexMap[col]) {
        throw new Error(`${col} column not found`);
      }
    });

    filteredRows.forEach((rowData, rowIndex) => {
      const row = worksheet.addRow(rowData);
      const excelRowNumber = row.number;

      const col = name => getColumnLetter(headerIndexMap[name]);

      const finalTaxRateCol = col('Final Tax rate');
      const finalTaxableShippingCol = col('Final Taxable Shipping Value');
      const finalTaxableSalesCol = col('Final Taxable Sales Value');
      const finalCgstCol = col('Final CGST Tax');
      const finalSgstCol = col('Final SGST Tax');
      const finalIgstCol = col('Final IGST Tax');
      const finalShipCgstCol = col('Final Shipping CGST Tax');
      const finalShipSgstCol = col('Final Shipping SGST Tax');
      const finalShipIgstCol = col('Final Shipping IGST Tax');
      const finalReceivableCol = col('Final Amount Receivable');

      const cgstRateCol = col('Cgst Rate');
      const sgstRateCol = col('Sgst Rate');
      const igstRateCol = col('Igst Rate');
      const shipAmtBasisCol = col('Shipping Amount Basis');
      const giftWrapBasisCol = col('Gift Wrap Amount Basis');
      const giftWrapPromoBasisCol = col('Gift Wrap Promo Discount Basis');
      const shipPromoBasisCol = col('Shipping Promo Discount Basis');
      const taxExclusiveCol = col('Tax Exclusive Gross');
      const shipFromCol = col('Ship From State');
      const shipToCol = col('Ship To State');
      const tcsCgstCol = col('Tcs Cgst Amount');
      const tcsSgstCol = col('Tcs Sgst Amount');
      const tcsIgstCol = col('Tcs Igst Amount');

      worksheet.getCell(`${finalTaxRateCol}${excelRowNumber}`).value = {
        formula: `${cgstRateCol}${excelRowNumber}+${sgstRateCol}${excelRowNumber}+${igstRateCol}${excelRowNumber}`
      };

      worksheet.getCell(`${finalTaxableShippingCol}${excelRowNumber}`).value = {
        formula: `${shipAmtBasisCol}${excelRowNumber}+${giftWrapBasisCol}${excelRowNumber}+${giftWrapPromoBasisCol}${excelRowNumber}+${shipPromoBasisCol}${excelRowNumber}`
      };

      worksheet.getCell(`${finalTaxableSalesCol}${excelRowNumber}`).value = {
        formula: `${taxExclusiveCol}${excelRowNumber}-${finalTaxableShippingCol}${excelRowNumber}`
      };

      worksheet.getCell(`${finalCgstCol}${excelRowNumber}`).value = {
        formula: `IF(${shipFromCol}${excelRowNumber}=${shipToCol}${excelRowNumber},${finalTaxableSalesCol}${excelRowNumber}*${cgstRateCol}${excelRowNumber},0)`
      };

      worksheet.getCell(`${finalSgstCol}${excelRowNumber}`).value = {
        formula: `IF(${shipFromCol}${excelRowNumber}=${shipToCol}${excelRowNumber},${finalTaxableSalesCol}${excelRowNumber}*${sgstRateCol}${excelRowNumber},0)`
      };

      worksheet.getCell(`${finalIgstCol}${excelRowNumber}`).value = {
        formula: `IF(${shipFromCol}${excelRowNumber}<>${shipToCol}${excelRowNumber},${finalTaxableSalesCol}${excelRowNumber}*${igstRateCol}${excelRowNumber},0)`
      };

      worksheet.getCell(`${finalShipCgstCol}${excelRowNumber}`).value = {
        formula: `IF(${shipFromCol}${excelRowNumber}=${shipToCol}${excelRowNumber},${finalTaxableShippingCol}${excelRowNumber}*${finalTaxRateCol}${excelRowNumber},0)`
      };

      worksheet.getCell(`${finalShipSgstCol}${excelRowNumber}`).value = {
        formula: `IF(${shipFromCol}${excelRowNumber}=${shipToCol}${excelRowNumber},${finalTaxableShippingCol}${excelRowNumber}*${finalTaxRateCol}${excelRowNumber},0)`
      };

      worksheet.getCell(`${finalShipIgstCol}${excelRowNumber}`).value = {
        formula: `IF(${shipFromCol}${excelRowNumber}<>${shipToCol}${excelRowNumber},${finalTaxableShippingCol}${excelRowNumber}*${finalTaxRateCol}${excelRowNumber},0)`
      };

      worksheet.getCell(`${finalReceivableCol}${excelRowNumber}`).value = {
        formula: `
          ${finalTaxableSalesCol}${excelRowNumber}
          +${finalTaxableShippingCol}${excelRowNumber}
          +${finalCgstCol}${excelRowNumber}
          +${finalSgstCol}${excelRowNumber}
          +${finalIgstCol}${excelRowNumber}
          +${finalShipCgstCol}${excelRowNumber}
          +${finalShipSgstCol}${excelRowNumber}
          +${finalShipIgstCol}${excelRowNumber}
          -${tcsCgstCol}${excelRowNumber}
          -${tcsSgstCol}${excelRowNumber}
          -${tcsIgstCol}${excelRowNumber}
        `.replace(/\s+/g, '')
      };
    });

    const pivotWorkbook = XLSX.utils.book_new();

    const pivotData = filteredRows.map(row => ({
      'Seller Gstin': row['Seller Gstin'] || '',
      'Final Invoice No.': row['Final Invoice No.'] || '',
      'Ship To State Tally Ledger': row['Ship To State Tally Ledger'] || '',
      'FG': row['FG'] || '',
      'Quantity': Number(row['Quantity'] || 0),
      'Final Tax rate':
        Number(row['Cgst Rate'] || 0) +
        Number(row['Sgst Rate'] || 0) +
        Number(row['Igst Rate'] || 0),
      'Final Taxable Sales Value': Number(row['Final Taxable Sales Value'] || 0),
      'Final Taxable Shipping Value': Number(row['Final Taxable Shipping Value'] || 0),
      'Final CGST Tax': Number(row['Final CGST Tax'] || 0),
      'Final SGST Tax': Number(row['Final SGST Tax'] || 0),
      'Final IGST Tax': Number(row['Final IGST Tax'] || 0),
      'Final Shipping CGST Tax': Number(row['Final Shipping CGST Tax'] || 0),
      'Final Shipping SGST Tax': Number(row['Final Shipping SGST Tax'] || 0),
      'Final Shipping IGST Tax': Number(row['Final Shipping IGST Tax'] || 0),
      'Tcs Cgst Amount': Number(row['Tcs Cgst Amount'] || 0),
      'Tcs Sgst Amount': Number(row['Tcs Sgst Amount'] || 0),
      'Tcs Igst Amount': Number(row['Tcs Igst Amount'] || 0),
      'Final Amount Receivable': Number(row['Final Amount Receivable'] || 0)
    }));

    console.log("Pivot Records Created:", pivotData.length);

    const pivotSheet = XLSX.utils.json_to_sheet(pivotData);

    XLSX.utils.book_append_sheet(
      pivotWorkbook,
      pivotSheet,
      'amazon-b2b-pivot'
    );

    function getLastDateOfMonth(dateString) {
      const dateObj = new Date(dateString);
      const lastDay = new Date(
        dateObj.getFullYear(),
        dateObj.getMonth() + 1,
        0
      );
      const dd = String(lastDay.getDate()).padStart(2, '0');
      const mm = String(lastDay.getMonth() + 1).padStart(2, '0');
      const yy = String(lastDay.getFullYear()).slice(-2);
      return `${dd}/${mm}/${yy}`;
    }

    const lastDate = getLastDateOfMonth(date);

    const uniqueRates = [
      ...new Set(
        pivotData.map(row => Number(row['Final Tax rate'] || 0))
      )
    ].filter(rate => rate > 0);

    const tallyRows = [];

    pivotData.forEach(row => {
      const quantity = Number(row['Quantity'] || 0);
      const taxableValue = Number(row['Final Taxable Sales Value'] || 0);
      const rate = Number(row['Final Tax rate'] || 0);

      const ratePerPiece = quantity !== 0
        ? taxableValue / quantity
        : 0;

      const baseRow = {
        'Vch Date': lastDate,
        'Vch Type': row['Seller Gstin'] || '',
        'Vch No.': row['Final Invoice No.'] || '',
        'Ref No.': row['Final Invoice No.'] || '',
        'Ref Date': lastDate,
        'Party Ledger': row['Ship To State Tally Ledger'] || '',
        'Sales Ledger': 'Amazon Pay Ledger',
        'Stock Item': row['FG'] || '',
        'Quantity': quantity,
        'Rate': rate,
        'Amount': taxableValue,
        'Rate Per Piece': ratePerPiece
      };

      uniqueRates.forEach(r => {
        const halfRate = r / 2;
        baseRow[`CGST ${halfRate}`] = 0;
        baseRow[`SGST ${halfRate}`] = 0;
        baseRow[`IGST ${r}`] = 0;
      });

      if (rate > 0) {
        const halfRate = rate / 2;
        baseRow[`CGST ${halfRate}`] = Number(row['Final CGST Tax'] || 0);
        baseRow[`SGST ${halfRate}`] = Number(row['Final SGST Tax'] || 0);
        baseRow[`IGST ${rate}`] = Number(row['Final IGST Tax'] || 0);
      }

      tallyRows.push(baseRow);
    });

    const tallySheet = XLSX.utils.json_to_sheet(tallyRows);

    XLSX.utils.book_append_sheet(
      pivotWorkbook,
      tallySheet,
      'amazon-b2b-tally-ready'
    );

    const shippingUniqueRates = [
      ...new Set(
        pivotData.map(row => Number(row['Final Tax rate'] || 0))
      )
    ].filter(rate => rate > 0);

    const shippingTallyRows = [];

    pivotData.forEach(row => {
      const shippingValue = Number(row['Final Taxable Shipping Value'] || 0);
      const rate = Number(row['Final Tax rate'] || 0);

      const shippingRow = {
        'Vch Date': lastDate,
        'Vch Type': row['Seller Gstin'] || '',
        'Vch No.': row['Final Invoice No.'] || '',
        'Ref No.': row['Final Invoice No.'] || '',
        'Ref Date': lastDate,
        'Party Ledger': row['Ship To State Tally Ledger'] || '',
        'Sales Ledger': 'Amazon Pay Ledger',
        'Rate': rate,
        'Amount': shippingValue
      };

      shippingUniqueRates.forEach(r => {
        const halfRate = Number((r / 2).toFixed(4));
        shippingRow[`CGST ${halfRate}`] = 0;
        shippingRow[`SGST ${halfRate}`] = 0;
        shippingRow[`IGST ${r}`] = 0;
      });

      if (rate > 0) {
        const halfRate = Number((rate / 2).toFixed(4));
        shippingRow[`CGST ${halfRate}`] +=
          Number(row['Final Shipping CGST Tax'] || 0);
        shippingRow[`SGST ${halfRate}`] +=
          Number(row['Final Shipping SGST Tax'] || 0);
        shippingRow[`IGST ${rate}`] +=
          Number(row['Final Shipping IGST Tax'] || 0);
      }

      shippingTallyRows.push(shippingRow);
    });

    const shippingSheet = XLSX.utils.json_to_sheet(shippingTallyRows);

    XLSX.utils.book_append_sheet(
      pivotWorkbook,
      shippingSheet,
      'amazon-b2b-shipping-tally-ready'
    );

    const gstrMap = {};

    filteredRows.forEach((row) => {
      const sellerGstin = String(row['Seller Gstin'] || '').trim();
      const hsn = String(row['Hsn/sac'] || '').trim();

      const totalRate =
        Number(row['Cgst Rate'] || 0) +
        Number(row['Sgst Rate'] || 0) +
        Number(row['Igst Rate'] || 0);

      const normalizedRate = Number(totalRate.toFixed(2));

      const key = `${sellerGstin}|${hsn}|${normalizedRate}`;

      if (!gstrMap[key]) {
        gstrMap[key] = {
          'Seller Gstin': sellerGstin,
          'Hsn/sac': hsn,
          'Rate': normalizedRate,
          'Quantity': 0,
          'Final Taxable Sales Value': 0,
          'Final CGST Tax': 0,
          'Final SGST Tax': 0,
          'Final IGST Tax': 0
        };
      }

      gstrMap[key]['Quantity'] += Number(row['Quantity'] || 0);
      gstrMap[key]['Final Taxable Sales Value'] += Number(row['Final Taxable Sales Value'] || 0);
      gstrMap[key]['Final CGST Tax'] += Number(row['Final CGST Tax'] || 0);
      gstrMap[key]['Final SGST Tax'] += Number(row['Final SGST Tax'] || 0);
      gstrMap[key]['Final IGST Tax'] += Number(row['Final IGST Tax'] || 0);
    });

    const gstrData = Object.values(gstrMap);

    console.log("GSTR HSN Records:", gstrData.length);

    const gstrSheet = XLSX.utils.json_to_sheet(gstrData);

    const columnOrder = [
      'Seller Gstin',
      'Hsn/sac',
      'Rate',
      'Quantity',
      'Final Taxable Sales Value',
      'Final CGST Tax',
      'Final SGST Tax',
      'Final IGST Tax'
    ];

    XLSX.utils.sheet_add_aoa(gstrSheet, [columnOrder], { origin: "A1" });

    XLSX.utils.book_append_sheet(
      pivotWorkbook,
      gstrSheet,
      'amazon-b2b-gstr-hsn'
    );

    return {
      workbook,
      outputWorkbook: pivotWorkbook,
      process1Json: filteredRows,
      pivotData: pivotData
    };

  } catch (error) {
    console.error('processMacrosB2B Error:', error);
    throw error;
  }
}

module.exports = {
  processMacrosB2B
};
