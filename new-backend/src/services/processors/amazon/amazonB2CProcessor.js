const XLSX = require('xlsx-js-style');
const ExcelJS = require('exceljs');

async function amazonB2CProcessor(
  rawFileBuffer,
  skuFileBuffer,
  brandName,
  date,
  sourceSheetData,
  stateConfigData,
  useInventory,
  formMonth,
  formYear
) {
  try {
    if (!rawFileBuffer) {
      throw new Error('Raw file buffer is required');
    }

    // ================================
    // STEP 1: READ RAW FILE → JSON
    // ================================
    const rawWorkbook = XLSX.read(rawFileBuffer, { type: 'buffer' });
    const firstSheetName = rawWorkbook.SheetNames[0];
    const rawSheet = rawWorkbook.Sheets[firstSheetName];

    const rawJson = XLSX.utils.sheet_to_json(rawSheet, {
      defval: null
    });

    if (!rawJson.length) {
      throw new Error('Raw sheet is empty');
    }

    // ================================
    // STEP 2: FIND REQUIRED COLUMNS
    // ================================
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

    // ================================
    // STEP 3: FILTER Shipment & Refund
    // ================================
    const filteredRows = rawJson.filter(row => {
      const type = row[transactionColumn];
      return type === 'Shipment' || type === 'Refund';
    });

    // ================================
    // STEP 4: MAKE REFUND QUANTITY NEGATIVE
    // ================================
    filteredRows.forEach(row => {
      if (row[transactionColumn] === 'Refund') {
        const qty = parseFloat(row[quantityColumn] || 0);
        row[quantityColumn] = -Math.abs(qty);
      }
    });

    // ================================
    // STEP 4.1: INSERT 10 NEW COLUMNS
    // ================================
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

    // Insert new columns after Compensatory Cess Tax
    headers.splice(cessIndex + 1, 0, ...newColumns);

    // Add empty values for new columns in each row
    filteredRows.forEach(row => {
      newColumns.forEach(col => {
        row[col] = null;
      });
    });

    // ================================
    // STEP 4.2: INSERT STATE & INVOICE COLUMNS
    // ================================

    // Find Ship To State index
    const shipToStateIndex = headers.findIndex(
      h => h.toLowerCase().trim() === 'ship to state'
    );

    if (shipToStateIndex === -1) {
      throw new Error('Ship To State column not found');
    }

    // Columns to insert
    const stateInvoiceColumns = [
      'Ship To State Tally Ledger',
      'Final Invoice No.'
    ];

    // Insert after Ship To State
    headers.splice(shipToStateIndex + 1, 0, ...stateInvoiceColumns);

    // Add empty values in each row
    filteredRows.forEach(row => {
      stateInvoiceColumns.forEach(col => {
        row[col] = null;
      });
    });

    // ================================
    // SET Sku COLUMN CONSISTENTLY FOR CONTROLLER MAPPING
    // ================================
    const b2cPossibleSkuCols = ['SKU', 'Sku', 'sku', 'Seller SKU', 'seller sku', 'Item SKU'];
    let b2cDetectedCol = null;
    for (const col of b2cPossibleSkuCols) {
      if (filteredRows[0] && filteredRows[0].hasOwnProperty(col)) {
        b2cDetectedCol = col;
        break;
      }
    }
    if (b2cDetectedCol) {
      filteredRows.forEach(row => {
        row['Sku'] = row[b2cDetectedCol];
      });
    }

    // ================================
    // STEP 4.3: INSERT FG COLUMN IF INVENTORY TRUE
    // ================================

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

    // ================================
    // GET MONTH NUMBER FROM DATE OR FORM
    // ================================

    const monthMapping = {
      "January": "01", "February": "02", "March": "03", "April": "04",
      "May": "05", "June": "06", "July": "07", "August": "08",
      "September": "09", "October": "10", "November": "11", "December": "12"
    };

    const monthNumber = (() => {
      if (formMonth) {
        const mapped = monthMapping[formMonth] || formMonth;
        return String(mapped).padStart(2, '0'); // 01,02,03...
      }
      const d = new Date(date);
      const m = d.getMonth() + 1;
      return String(m).padStart(2, '0');
    })();

    // ================================
    // STEP 4.4: MAP STATE CONFIG DATA
    // ================================

    if (Array.isArray(stateConfigData) && stateConfigData.length > 0) {

      // Create lookup map
      const stateMap = {};

      stateConfigData.forEach(item => {
        const stateVal = item.States || item.State;
        if (stateVal) {
          const key = stateVal.toString().trim().toLowerCase();

          stateMap[key] = {
            ledger: item['Amazon Pay Ledger'] || item['Ledger'] || null,
            invoice: item['Invoice No.'] || item['Invoice No'] || null
          };
        }
      });

      // Map each row
      filteredRows.forEach(row => {

        const shipState = row['Ship To State'];

        if (shipState) {

          const lookupKey = shipState.toString().trim().toLowerCase();

          if (stateMap[lookupKey]) {

            row['Ship To State Tally Ledger'] = stateMap[lookupKey].ledger;

            const baseInvoice = stateMap[lookupKey].invoice;

            if (baseInvoice) {
              row['Final Invoice No.'] = `${baseInvoice}-${monthNumber}`;
            } else {
              row['Final Invoice No.'] = null;
            }

          } else {

            row['Ship To State Tally Ledger'] = null;
            row['Final Invoice No.'] = null;

          }

        } else {

          row['Ship To State Tally Ledger'] = null;
          row['Final Invoice No.'] = null;

        }

      });

    }


    // ==================================
    // STEP 4.5: MAP FG FROM sourceSheetData (DEBUG MODE)
    // ==================================
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

      // Detect SKU Column
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

      // Create SKU Map
      const skuMap = {};
      sourceSheetData.forEach(item => {
        const key = normalizeSKU(item.SKU);
        if (key) skuMap[key] = item.FG || null;
      });

      // Map FG
      let mappedCount = 0;
      let unmappedCount = 0;

      filteredRows.forEach(row => {
        const rawSKU = row[detectedSkuColumn];
        const lookupKey = normalizeSKU(rawSKU);

        let fg = skuMap[lookupKey];

        // Fallback partial matching if strict match fails
        if (!fg && lookupKey) {
          for (const key in skuMap) {
            if (
              lookupKey === key ||
              lookupKey.includes(key) ||
              key.includes(lookupKey)
            ) {
              fg = skuMap[key];
              console.log(`[Amazon B2C] ✅ MATCHED VIA FALLBACK: raw='${rawSKU}' normalized='${lookupKey}' => matched_key='${key}' FG='${fg}'`);
              break;
            }
          }
        }

        if (fg) {
          mappedCount++;
        } else {
          unmappedCount++;
        }

        row['FG'] = fg || null;
      });

      console.log(`[Amazon B2C] FG Mapping Complete: ${mappedCount} rows mapped, ${unmappedCount} rows unmapped.`);

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

    // ================================
    // STEP 5: CREATE UPDATED RAW WORKBOOK WITH FORMULAS
    // ================================
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('updated raw sheet');

    // Set columns
    worksheet.columns = headers.map(header => ({
      header: header,
      key: header,
      width: 22
    }));

    // Helper function to get Excel column letter
    function getColumnLetter(colNumber) {
      let temp, letter = '';
      while (colNumber > 0) {
        temp = (colNumber - 1) % 26;
        letter = String.fromCharCode(temp + 65) + letter;
        colNumber = (colNumber - temp - 1) / 26;
      }
      return letter;
    }

    // Map header → column index
    const headerIndexMap = {};
    headers.forEach((header, index) => {
      headerIndexMap[header] = index + 1;
    });

    // Required columns check
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

    // Add rows with formulas
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

      // 1️⃣ Final Tax Rate
      worksheet.getCell(`${finalTaxRateCol}${excelRowNumber}`).value = {
        formula: `${cgstRateCol}${excelRowNumber}+${sgstRateCol}${excelRowNumber}+${igstRateCol}${excelRowNumber}`
      };

      // 2️⃣ Final Taxable Shipping Value
      worksheet.getCell(`${finalTaxableShippingCol}${excelRowNumber}`).value = {
        formula: `${shipAmtBasisCol}${excelRowNumber}+${giftWrapBasisCol}${excelRowNumber}+${giftWrapPromoBasisCol}${excelRowNumber}+${shipPromoBasisCol}${excelRowNumber}`
      };

      // 3️⃣ Final Taxable Sales Value
      worksheet.getCell(`${finalTaxableSalesCol}${excelRowNumber}`).value = {
        formula: `${taxExclusiveCol}${excelRowNumber}-${finalTaxableShippingCol}${excelRowNumber}`
      };

      // 4️⃣ Final CGST Tax
      worksheet.getCell(`${finalCgstCol}${excelRowNumber}`).value = {
        formula: `IF(${shipFromCol}${excelRowNumber}=${shipToCol}${excelRowNumber},${finalTaxableSalesCol}${excelRowNumber}*${cgstRateCol}${excelRowNumber},0)`
      };

      // 5️⃣ Final SGST Tax
      worksheet.getCell(`${finalSgstCol}${excelRowNumber}`).value = {
        formula: `IF(${shipFromCol}${excelRowNumber}=${shipToCol}${excelRowNumber},${finalTaxableSalesCol}${excelRowNumber}*${sgstRateCol}${excelRowNumber},0)`
      };

      // 6️⃣ Final IGST Tax
      worksheet.getCell(`${finalIgstCol}${excelRowNumber}`).value = {
        formula: `IF(${shipFromCol}${excelRowNumber}<>${shipToCol}${excelRowNumber},${finalTaxableSalesCol}${excelRowNumber}*${igstRateCol}${excelRowNumber},0)`
      };

      // 7️⃣ Final Shipping CGST
      worksheet.getCell(`${finalShipCgstCol}${excelRowNumber}`).value = {
        formula: `IF(${shipFromCol}${excelRowNumber}=${shipToCol}${excelRowNumber},${finalTaxableShippingCol}${excelRowNumber}*${finalTaxRateCol}${excelRowNumber},0)`
      };

      // 8️⃣ Final Shipping SGST
      worksheet.getCell(`${finalShipSgstCol}${excelRowNumber}`).value = {
        formula: `IF(${shipFromCol}${excelRowNumber}=${shipToCol}${excelRowNumber},${finalTaxableShippingCol}${excelRowNumber}*${finalTaxRateCol}${excelRowNumber},0)`
      };

      // 9️⃣ Final Shipping IGST
      worksheet.getCell(`${finalShipIgstCol}${excelRowNumber}`).value = {
        formula: `IF(${shipFromCol}${excelRowNumber}<>${shipToCol}${excelRowNumber},${finalTaxableShippingCol}${excelRowNumber}*${finalTaxRateCol}${excelRowNumber},0)`
      };

      // 🔟 Final Amount Receivable
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

    // ==================================
    // STEP 6: CREATE FINAL PIVOT STRUCTURE (EXCELJS)
    // ==================================
    const pivotSheet = workbook.addWorksheet('amazon-b2c-pivot');
    const pivotData = filteredRows.map(row => ({
      'Seller Gstin': row['Seller Gstin'] || '',
      'Final Invoice No.': row['Final Invoice No.'] || '',
      'Ship To State Tally Ledger': row['Ship To State Tally Ledger'] || '',
      'FG': row['FG'] || '',
      'Quantity': Number(row['Quantity'] || 0),
      'Final Tax rate': Number(row['Cgst Rate'] || 0) + Number(row['Sgst Rate'] || 0) + Number(row['Igst Rate'] || 0),
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

    if (pivotData.length > 0) {
      const pivotHeaders = Object.keys(pivotData[0]);
      pivotSheet.addRow(pivotHeaders);
      pivotData.forEach(row => {
        pivotSheet.addRow(pivotHeaders.map(h => row[h]));
      });
    }

    // ==================================
    // STEP 7: CREATE TALLY READY SHEET (EXCELJS)
    // ==================================
    const tallySheet = workbook.addWorksheet('amazon-b2c-tally-ready');
    function getLastDateOfMonth(dateString) {
      let dYear, dMonth;
      if (formMonth && formYear) {
        dYear = parseInt(formYear);
        dMonth = parseInt(monthMapping[formMonth] || formMonth);
      } else {
        const dateObj = new Date(dateString);
        dYear = dateObj.getFullYear();
        dMonth = dateObj.getMonth() + 1;
      }
      const lastDay = new Date(dYear, dMonth, 0);
      const dd = String(lastDay.getDate()).padStart(2, '0');
      const mm = String(lastDay.getMonth() + 1).padStart(2, '0');
      const yy = String(lastDay.getFullYear()).slice(-2);
      return `${dd}/${mm}/${yy}`;
    }
    const lastDate = getLastDateOfMonth(date);
    const uniqueRates = [...new Set(pivotData.map(row => Number(row['Final Tax rate'] || 0)))].filter(rate => rate > 0);

    const tallyRows = pivotData.map(row => {
      const quantity = Number(row['Quantity'] || 0);
      const taxableValue = Number(row['Final Taxable Sales Value'] || 0);
      const rate = Number(row['Final Tax rate'] || 0);
      const ratePerPiece = quantity !== 0 ? taxableValue / quantity : 0;

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
        baseRow[`CGST ${halfRate}`] = (rate === r) ? Number(row['Final CGST Tax'] || 0) : 0;
        baseRow[`SGST ${halfRate}`] = (rate === r) ? Number(row['Final SGST Tax'] || 0) : 0;
        baseRow[`IGST ${r}`] = (rate === r) ? Number(row['Final IGST Tax'] || 0) : 0;
      });
      return baseRow;
    });

    if (tallyRows.length > 0) {
      const tallyHeaders = Object.keys(tallyRows[0]);
      tallySheet.addRow(tallyHeaders);
      tallyRows.forEach(row => {
        tallySheet.addRow(tallyHeaders.map(h => row[h]));
      });
    }

    // ==================================
    // STEP 8: CREATE SHIPPING TALLY READY SHEET (EXCELJS)
    // ==================================
    const shippingSheet = workbook.addWorksheet('amazon-b2c-shipping-tally-ready');
    const shippingTallyRows = pivotData.map(row => {
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

      uniqueRates.forEach(r => {
        const halfRate = Number((r / 2).toFixed(4));
        shippingRow[`CGST ${halfRate}`] = (rate === r) ? Number(row['Final Shipping CGST Tax'] || 0) : 0;
        shippingRow[`SGST ${halfRate}`] = (rate === r) ? Number(row['Final Shipping SGST Tax'] || 0) : 0;
        shippingRow[`IGST ${r}`] = (rate === r) ? Number(row['Final Shipping IGST Tax'] || 0) : 0;
      });
      return shippingRow;
    });

    if (shippingTallyRows.length > 0) {
      const shipHeaders = Object.keys(shippingTallyRows[0]);
      shippingSheet.addRow(shipHeaders);
      shippingTallyRows.forEach(row => {
        shippingSheet.addRow(shipHeaders.map(h => row[h]));
      });
    }

    // ==================================
    // STEP 9: CREATE GSTR HSN SHEET (EXCELJS)
    // ==================================
    const gstrSheet = workbook.addWorksheet('amazon-b2c-gstr-hsn');
    const gstrMap = {};
    filteredRows.forEach((row) => {
      const sellerGstin = String(row['Seller Gstin'] || '').trim();
      const hsn = String(row['Hsn/sac'] || '').trim();
      const totalRate = Number(row['Cgst Rate'] || 0) + Number(row['Sgst Rate'] || 0) + Number(row['Igst Rate'] || 0);
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
    if (gstrData.length > 0) {
      const gstrHeaders = ['Seller Gstin', 'Hsn/sac', 'Rate', 'Quantity', 'Final Taxable Sales Value', 'Final CGST Tax', 'Final SGST Tax', 'Final IGST Tax'];
      gstrSheet.addRow(gstrHeaders);
      gstrData.forEach(row => {
        gstrSheet.addRow(gstrHeaders.map(h => row[h]));
      });
    }

    // ================================
    // RETURN STRUCTURE EXPECTED BY CONTROLLER
    // ================================
    return {
      workbook,               // ExcelJS with all sheets
      process1Json: filteredRows,
      pivotData: pivotData
    };

  } catch (error) {
    console.error('processMacros Error:', error);
    throw error;
  }
}

module.exports = {
  amazonB2CProcessor
};