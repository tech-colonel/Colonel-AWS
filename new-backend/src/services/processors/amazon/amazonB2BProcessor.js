const XLSX = require('xlsx-js-style');
const ExcelJS = require('exceljs');
const { getStateCodeFromName, getStateAbbr } = require('../../../utils/gstStateCodes');

async function amazonB2BProcessor(
  rawFileBuffer,
  skuFileBuffer,
  brandName,
  date,
  sourceSheetData,
  stateConfigData,
  useInventory,
  formMonth,
  formYear,
  multiStateSale
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

    // IGST/CGST/SGST split (and everything derived from it — invoice numbering,
    // Tally ledger naming, the tax formulas below) uses Ship From State vs
    // Bill To State; fall back to Bill From / Ship To State when the report
    // doesn't carry those columns.
    const findHeader = name => headers.find(h => h.toLowerCase().trim() === name);

    const fromStateCol = findHeader('ship from state') || findHeader('bill from state');
    const toStateCol = findHeader('bill to state') || findHeader('ship to state');

    if (!fromStateCol) throw new Error('Ship From State / Bill From State column not found');
    if (!toStateCol) throw new Error('Bill To State / Ship To State column not found');

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
    const b2bPossibleSkuCols = ['SKU', 'Sku', 'sku', 'Seller SKU', 'seller sku', 'Item SKU'];
    let b2bDetectedCol = null;
    for (const col of b2bPossibleSkuCols) {
      if (filteredRows[0] && filteredRows[0].hasOwnProperty(col)) {
        b2bDetectedCol = col;
        break;
      }
    }
    if (b2bDetectedCol) {
      filteredRows.forEach(row => {
        row['Sku'] = row[b2bDetectedCol];
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

    // ================================
    // STEP 4.4: MAP STATE CONFIG DATA
    // ================================

    // Builds the "-{sellerGstinPrefix}-{monthNumber}" (single-state) or
    // "-{stateNumber}-{monthNumber}" (multi-state) invoice suffix.
    const getInvoiceSuffix = (row) => {
      if (!multiStateSale) {
        const gstinPrefix = String(row[sellerGstinColumn] || '').trim().slice(0, 2);
        return gstinPrefix ? `${gstinPrefix}-${monthNumber}` : monthNumber;
      }
      const stateCode = getStateCodeFromName(row[fromStateCol]);
      if (!stateCode) {
        console.warn(`[Amazon B2B] Multi-state sale: no GST state code match for "${fromStateCol}" value "${row[fromStateCol]}"`);
        return monthNumber;
      }
      return `${stateCode}-${monthNumber}`;
    };

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

        const billFrom = (row[fromStateCol] || "")
          .toString()
          .trim()
          .toLowerCase();

        const billTo = (row[toStateCol] || "")
          .toString()
          .trim()
          .toLowerCase();

        // ❌ Missing values
        if (!billFrom || !billTo) {
          row["Ship To State Tally Ledger"] = null;
          row["Final Invoice No."] = null;
          return;
        }

        const isIntraState = billFrom === billTo;

        if (isIntraState) {
          row["Ship To State Tally Ledger"] = "Amazon B2B Intra-State";
          row["Final Invoice No."] = `AMZ-INTRA-${getInvoiceSuffix(row)}`;
        } else {
          row["Ship To State Tally Ledger"] = "Amazon B2B Inter-State";
          row["Final Invoice No."] = `AMZ-INTER-${getInvoiceSuffix(row)}`;
        }

      });

    } else {
      // ============================
      // FALLBACK B2B STATE LOGIC
      // ============================

      filteredRows.forEach(row => {

        const billFrom = (row[fromStateCol] || "")
          .toString()
          .trim()
          .toLowerCase();

        const billTo = (row[toStateCol] || "")
          .toString()
          .trim()
          .toLowerCase();

        if (!billFrom || !billTo) {

          row["Ship To State Tally Ledger"] = null;
          row["Final Invoice No."] = null;

          return;
        }

        const isIntraState = billFrom === billTo;

        if (isIntraState) {

          row["Ship To State Tally Ledger"] = "Amazon B2B Intra-State";
          row["Final Invoice No."] = `AMZ-INTRA-${getInvoiceSuffix(row)}`;

        } else {

          row["Ship To State Tally Ledger"] = "Amazon B2B Inter-State";
          row["Final Invoice No."] = `AMZ-INTER-${getInvoiceSuffix(row)}`;

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
        row[fromStateCol] === row[toStateCol];

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
      fromStateCol,
      toStateCol,
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
      const billFromCol = col(fromStateCol);
      const billToCol = col(toStateCol);
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
        formula: `IF(${billFromCol}${excelRowNumber}=${billToCol}${excelRowNumber},${finalTaxableSalesCol}${excelRowNumber}*${cgstRateCol}${excelRowNumber},0)`
      };

      // 5️⃣ Final SGST Tax
      worksheet.getCell(`${finalSgstCol}${excelRowNumber}`).value = {
        formula: `IF(${billFromCol}${excelRowNumber}=${billToCol}${excelRowNumber},${finalTaxableSalesCol}${excelRowNumber}*${sgstRateCol}${excelRowNumber},0)`
      };

      // 6️⃣ Final IGST Tax
      worksheet.getCell(`${finalIgstCol}${excelRowNumber}`).value = {
        formula: `IF(${billFromCol}${excelRowNumber}<>${billToCol}${excelRowNumber},${finalTaxableSalesCol}${excelRowNumber}*${igstRateCol}${excelRowNumber},0)`
      };

      // 7️⃣ Final Shipping CGST
      worksheet.getCell(`${finalShipCgstCol}${excelRowNumber}`).value = {
        formula: `IF(${billFromCol}${excelRowNumber}=${billToCol}${excelRowNumber},${finalTaxableShippingCol}${excelRowNumber}*${finalTaxRateCol}${excelRowNumber},0)`
      };

      // 8️⃣ Final Shipping SGST
      worksheet.getCell(`${finalShipSgstCol}${excelRowNumber}`).value = {
        formula: `IF(${billFromCol}${excelRowNumber}=${billToCol}${excelRowNumber},${finalTaxableShippingCol}${excelRowNumber}*${finalTaxRateCol}${excelRowNumber},0)`
      };

      // 9️⃣ Final Shipping IGST
      worksheet.getCell(`${finalShipIgstCol}${excelRowNumber}`).value = {
        formula: `IF(${billFromCol}${excelRowNumber}<>${billToCol}${excelRowNumber},${finalTaxableShippingCol}${excelRowNumber}*${finalTaxRateCol}${excelRowNumber},0)`
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
    const pivotSheet = workbook.addWorksheet('amazon-b2b-pivot');
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
    const tallySheet = workbook.addWorksheet('amazon-b2b-tally-ready');
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

    function getSellerStateAbbr(gstin) {
      const code = String(gstin || '').trim().substring(0, 2);
      return getStateAbbr(code) || code;
    }
    const uniqueStateCodes = [...new Set(pivotData.map(row => getSellerStateAbbr(row['Seller Gstin'])))].filter(Boolean);

    const tallyRows = pivotData.map(row => {
      const quantity = Number(row['Quantity'] || 0);
      const taxableValue = Number(row['Final Taxable Sales Value'] || 0);
      const rate = Number(row['Final Tax rate'] || 0);
      const ratePerPiece = quantity !== 0 ? taxableValue / quantity : 0;
      const invoiceNo = row['Final Invoice No.'] || '';
      const isCreditNote = taxableValue < 0;
      const vchNo = isCreditNote ? `${invoiceNo}-cn` : invoiceNo;
      const rowStateAbbr = getSellerStateAbbr(row['Seller Gstin']);

      const baseRow = {
        'Vch Date': lastDate,
        'Seller GSTIN': row['Seller Gstin'] || '',
        'Vch Type': isCreditNote ? 'Credit Note' : 'Sales',
        'Vch No.': vchNo,
        'Ref No.': vchNo,
        'Ref Date': lastDate,
        'Party Ledger': row['Ship To State Tally Ledger'] || '',
        'Sales Ledger': 'Sales Amazon',
        'Stock Item': row['FG'] || '',
        'Quantity': quantity,
        'Rate': rate,
        'Amount': taxableValue,
        'Rate Per Piece': ratePerPiece
      };

      uniqueRates.forEach(r => {
        const halfRate = r / 2;
        uniqueStateCodes.forEach(sc => {
          baseRow[`Output CGST ${halfRate} ${sc}`] = (rate === r && rowStateAbbr === sc) ? Number(row['Final CGST Tax'] || 0) : 0;
          baseRow[`Output SGST ${halfRate} ${sc}`] = (rate === r && rowStateAbbr === sc) ? Number(row['Final SGST Tax'] || 0) : 0;
          baseRow[`Output IGST ${r} ${sc}`] = (rate === r && rowStateAbbr === sc) ? Number(row['Final IGST Tax'] || 0) : 0;
        });
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
    const shippingSheet = workbook.addWorksheet('amazon-b2b-shipping-tally-ready');
    const shippingTallyRows = pivotData.map(row => {
      const shippingValue = Number(row['Final Taxable Shipping Value'] || 0);
      const rate = Number(row['Final Tax rate'] || 0);
      const invoiceNo = row['Final Invoice No.'] || '';
      const isCreditNote = shippingValue < 0;
      const vchNo = isCreditNote ? `${invoiceNo}-cn` : invoiceNo;
      const rowStateAbbr = getSellerStateAbbr(row['Seller Gstin']);
      const shippingRow = {
        'Vch Date': lastDate,
        'Seller GSTIN': row['Seller Gstin'] || '',
        'Vch Type': isCreditNote ? 'Credit Note' : 'Sales',
        'Vch No.': vchNo,
        'Ref No.': vchNo,
        'Ref Date': lastDate,
        'Party Ledger': row['Ship To State Tally Ledger'] || '',
        'Sales Ledger': 'Sales Amazon',
        'Rate': rate,
        'Amount': shippingValue
      };

      uniqueRates.forEach(r => {
        const halfRate = Number((r / 2).toFixed(4));
        uniqueStateCodes.forEach(sc => {
          shippingRow[`Output CGST ${halfRate} ${sc}`] = (rate === r && rowStateAbbr === sc) ? Number(row['Final Shipping CGST Tax'] || 0) : 0;
          shippingRow[`Output SGST ${halfRate} ${sc}`] = (rate === r && rowStateAbbr === sc) ? Number(row['Final Shipping SGST Tax'] || 0) : 0;
          shippingRow[`Output IGST ${r} ${sc}`] = (rate === r && rowStateAbbr === sc) ? Number(row['Final Shipping IGST Tax'] || 0) : 0;
        });
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
    const gstrSheet = workbook.addWorksheet('amazon-b2b-gstr-hsn');
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

    // ==================================
    // STEP 9.5: CREATE GSTR1 WORKING SHEET (EXCELJS)
    // Same grouping as the GSTR HSN sheet above, but state-wise: the Quantity
    // column is replaced with Ship To State (added to the group key too, so
    // rows for the same HSN/rate but different destination states don't get
    // merged). B2B uses Bill To State (toStateCol already prefers Bill over
    // Ship per this processor's convention) rather than the raw Ship To State.
    // ==================================
    const gstr1Sheet = workbook.addWorksheet('gstr1-working');
    const gstr1Map = {};
    filteredRows.forEach((row) => {
      const sellerGstin = String(row['Seller Gstin'] || '').trim();
      const hsn = String(row['Hsn/sac'] || '').trim();
      const totalRate = Number(row['Cgst Rate'] || 0) + Number(row['Sgst Rate'] || 0) + Number(row['Igst Rate'] || 0);
      const normalizedRate = Number(totalRate.toFixed(2));
      const shipToState = String(row[toStateCol] || '').trim();
      const key = `${sellerGstin}|${hsn}|${normalizedRate}|${shipToState}`;
      if (!gstr1Map[key]) {
        gstr1Map[key] = {
          'Seller Gstin': sellerGstin,
          'Hsn/sac': hsn,
          'Rate': normalizedRate,
          'Ship To State': shipToState,
          'Final Taxable Sales Value': 0,
          'Final CGST Tax': 0,
          'Final SGST Tax': 0,
          'Final IGST Tax': 0
        };
      }
      gstr1Map[key]['Final Taxable Sales Value'] += Number(row['Final Taxable Sales Value'] || 0);
      gstr1Map[key]['Final CGST Tax'] += Number(row['Final CGST Tax'] || 0);
      gstr1Map[key]['Final SGST Tax'] += Number(row['Final SGST Tax'] || 0);
      gstr1Map[key]['Final IGST Tax'] += Number(row['Final IGST Tax'] || 0);
    });
    const gstr1Data = Object.values(gstr1Map);
    if (gstr1Data.length > 0) {
      const gstr1Headers = ['Seller Gstin', 'Hsn/sac', 'Rate', 'Ship To State', 'Final Taxable Sales Value', 'Final CGST Tax', 'Final SGST Tax', 'Final IGST Tax'];
      gstr1Sheet.addRow(gstr1Headers);
      gstr1Data.forEach(row => {
        gstr1Sheet.addRow(gstr1Headers.map(h => row[h]));
      });
    }

    // ==================================
    // STEP 10: CREATE X2BETA WORKING SHEET (EXCELJS)
    // Matches the real Tally "X2Beta" e-invoice import template (verified against the
    // accountant's own "Excel to tally" reference sheet, 108 columns).
    // ==================================
    const x2betaSheet = workbook.addWorksheet('x2beta working');

    function getLastDateObj() {
      let dYear, dMonth;
      if (formMonth && formYear) {
        dYear = parseInt(formYear);
        dMonth = parseInt(monthMapping[formMonth] || formMonth);
      } else {
        const dateObj = new Date(date);
        dYear = dateObj.getFullYear();
        dMonth = dateObj.getMonth() + 1;
      }
      return new Date(dYear, dMonth, 0);
    }
    const x2betaVchDate = getLastDateObj();

    // The row-level 'Final Tax rate' field (set earlier as cgstRate + igstRate, deliberately
    // skipping sgstRate) is only correct for inter-state rows; for intra-state rows it's half
    // the true rate. pivotData's own 'Final Tax rate' sums all three correctly — recompute the
    // same way here instead of trusting the row-level field.
    const getRowGstRate = row => Number(row['Cgst Rate'] || 0) + Number(row['Sgst Rate'] || 0) + Number(row['Igst Rate'] || 0);

    // Intra/Inter-State for the Debtor ledger name and Vch No must match Ship From/To State
    // (place of supply for goods), not Ship From/Bill To State (this processor's `fromStateCol` /
    // `toStateCol` — used for the CGST/SGST/IGST split) — verified against the reference file:
    // rows with matching Ship states but a differing Bill To state are still "Intra-State" here.
    const x2betaShipFromCol = findHeader('ship from state');
    const x2betaShipToCol = findHeader('ship to state');
    const isRowIntraState = row => row[x2betaShipFromCol] === row[x2betaShipToCol];

    // State-rank: alphabetical position (1-indexed) of a seller-state-abbr among all seller
    // states seen this run — verified against the reference file (HR=1, KA=2, MH=3, UP=4,
    // i.e. alphabetical order), used to build the AMZ-Intra/Inter-{rank} voucher number series.
    const sortedStateCodes = [...uniqueStateCodes].sort();
    const getStateRank = stateAbbr => sortedStateCodes.indexOf(stateAbbr) + 1;

    const x2betaColumns = [
      { header: 'Vch. Date* ', get: () => x2betaVchDate },
      { header: 'Vch. Type*', get: r => `${Number(r['Final Taxable Sales Value'] || 0) < 0 ? 'CN-' : ''}Sales-${getSellerStateAbbr(r['Seller Gstin']) || ''}` },
      {
        header: 'Vch. No.*',
        get: r => {
          const isCN = Number(r['Final Taxable Sales Value'] || 0) < 0;
          const rank = getStateRank(getSellerStateAbbr(r['Seller Gstin']));
          return `AMZ-${isRowIntraState(r) ? 'Intra' : 'Inter'}-${isCN ? 'CN-' : ''}${rank}`;
        }
      },
      {
        header: 'Ref. No.',
        get: r => {
          const isCN = Number(r['Final Taxable Sales Value'] || 0) < 0;
          const rank = getStateRank(getSellerStateAbbr(r['Seller Gstin']));
          return `AMZ-${isRowIntraState(r) ? 'Intra' : 'Inter'}-${isCN ? 'CN-' : ''}${rank}`;
        }
      },
      { header: 'Ref. Date', get: () => x2betaVchDate },
      { header: 'Is CN?', get: r => (Number(r['Final Taxable Sales Value'] || 0) < 0 ? 'Yes' : null) },
      { header: 'Is Vch?', get: () => null },
      {
        header: 'Party Ledger*',
        get: r => `Amazon B2B ${isRowIntraState(r) ? 'Intra' : 'Inter'}-State (Debtor)-${getSellerStateAbbr(r['Seller Gstin']) || ''}`
      },
      { header: 'Sales Ledger*', get: r => `Sales Amazon-${getSellerStateAbbr(r['Seller Gstin']) || ''} ${Math.round(getRowGstRate(r) * 10000) / 100}%` },
      { header: 'Stock Item', get: r => r['FG'] || r['Item Description'] || '' },
      { header: 'Description', get: r => r['FG'] || r['Item Description'] || '' },
      { header: 'Godown', get: r => r['Ship From State'] || '' },
      { header: 'Quantity', get: r => (r[transactionColumn] === 'Refund' ? Math.abs(Number(r[quantityColumn] || 0)) : Number(r[quantityColumn] || 0)) },
      {
        // Unit rate is always positive — sign lives in Amount*, not Rate.
        header: 'Rate',
        get: r => {
          const qty = r[transactionColumn] === 'Refund' ? Math.abs(Number(r[quantityColumn] || 0)) : Number(r[quantityColumn] || 0);
          return qty !== 0 ? Math.abs(Number(r['Final Taxable Sales Value'] || 0) / qty) : 0;
        }
      },
      // 'Pcs' is a fixed default — Amazon MTR reports carry no unit-of-measure column, and every
      // row in the accountant's reference file uses 'Pcs'. Revisit if a brand ever needs another UOM.
      { header: 'Unit', get: () => 'Pcs' },
      { header: 'Discount', get: () => null },
      { header: 'Amount*', get: r => Number(r['Final Taxable Sales Value'] || 0) },
      { header: 'Discount', get: () => null }
    ];

    // Dynamic Output IGST/CGST/SGST columns — one triplet per (rate, seller-state) combination
    // actually present in this run's data, states sorted alphabetically (matches the reference
    // file's fixed HR/KA/MH/UP column order and the AMZ-Intra/Inter-{rank} numbering above).
    uniqueRates.forEach(r => {
      const ratePercent = Math.round(r * 10000) / 100;
      const halfRatePercent = Math.round((ratePercent / 2) * 100) / 100;
      sortedStateCodes.forEach(sc => {
        x2betaColumns.push({
          header: `Output IGST ${ratePercent}%-${sc}`,
          get: row => (getRowGstRate(row) === r && getSellerStateAbbr(row['Seller Gstin']) === sc) ? Number(row['Final IGST Tax'] || 0) : 0
        });
        x2betaColumns.push({
          header: `Output CGST ${halfRatePercent}%-${sc}`,
          get: row => (getRowGstRate(row) === r && getSellerStateAbbr(row['Seller Gstin']) === sc) ? Number(row['Final CGST Tax'] || 0) : 0
        });
        x2betaColumns.push({
          header: `Output SGST ${halfRatePercent}%-${sc}`,
          get: row => (getRowGstRate(row) === r && getSellerStateAbbr(row['Seller Gstin']) === sc) ? Number(row['Final SGST Tax'] || 0) : 0
        });
      });
    });

    x2betaColumns.push(
      { header: null, get: () => null },
      { header: null, get: () => null },
      { header: 'Narration', get: () => `Amz-B2B-${formMonth || ''}` },
      { header: 'Taxability', get: () => null },
      { header: 'GST Nature', get: () => null },
      { header: 'GST Rate', get: () => null },
      { header: 'Cess', get: () => null },
      { header: 'RCM?', get: () => null },
      { header: 'HSN', get: r => r['Hsn/sac'] || '' },
      { header: 'HSN Desc', get: () => null },
      { header: 'Supply Type', get: () => null },
      { header: 'Cost Category', get: () => null },
      { header: 'Cost Centre', get: () => null },
      // Party/Consignee/Buyer ledger-master block (Name/Address/PIN/GSTIN still blank pending a
      // confirmed master-data source). State/Country are now populated per user request:
      // State = the row's destination state (Bill To State, falling back to Ship To State),
      // Country = fixed 'India' (this business only operates domestically).
      { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
      { header: 'State', get: r => r[toStateCol] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
      { header: 'Place of Supply', get: r => r[toStateCol] || '' }, { header: 'GST Type', get: () => 'Regular' }, { header: 'GSTIN', get: () => null },
      { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
      { header: 'State', get: r => r[toStateCol] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
      { header: 'Place', get: () => null }, { header: 'GSTIN', get: () => null },
      { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
      { header: 'State', get: r => r[toStateCol] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
      { header: 'Place', get: () => null }, { header: 'GSTIN', get: () => null },
      // Dispatch / e-way-bill / transport fields — always blank in the reference file, not used by this business.
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
    x2betaSheet.addRow(x2betaHeaders);
    filteredRows.forEach(row => {
      x2betaSheet.addRow(x2betaColumns.map(c => c.get(row)));
    });
    x2betaSheet.getColumn(1).numFmt = 'dd/mm/yyyy';
    x2betaSheet.getColumn(5).numFmt = 'dd/mm/yyyy';

    // ==================================
    // VALIDATION: x2beta sheet totals must reconcile with the pivot/tally-ready totals
    // ==================================
    const x2betaOutputCols = x2betaColumns.filter(c => typeof c.header === 'string' && c.header.startsWith('Output '));
    const sumX2betaOutput = prefix => filteredRows.reduce((acc, row) => {
      return acc + x2betaOutputCols
        .filter(c => c.header.startsWith(prefix))
        .reduce((rowAcc, c) => rowAcc + Number(c.get(row) || 0), 0);
    }, 0);
    const sumPivot = key => pivotData.reduce((acc, r) => acc + Number(r[key] || 0), 0);

    const reconciliationChecks = [
      ['Amount* (taxable value)', filteredRows.reduce((acc, r) => acc + Number(r['Final Taxable Sales Value'] || 0), 0), sumPivot('Final Taxable Sales Value')],
      ['IGST', sumX2betaOutput('Output IGST'), sumPivot('Final IGST Tax')],
      ['CGST', sumX2betaOutput('Output CGST'), sumPivot('Final CGST Tax')],
      ['SGST', sumX2betaOutput('Output SGST'), sumPivot('Final SGST Tax')]
    ];
    const RECONCILIATION_TOLERANCE = 0.01;
    reconciliationChecks.forEach(([label, x2betaTotal, mainTotal]) => {
      if (Math.abs(x2betaTotal - mainTotal) > RECONCILIATION_TOLERANCE) {
        console.warn(`[Amazon B2B] x2beta working sheet ${label} mismatch: x2beta=${x2betaTotal.toFixed(2)}, main=${mainTotal.toFixed(2)}`);
      }
    });

    // ==================================
    // STEP 11: CREATE X2BETA-SHIPPING WORKING SHEET (EXCELJS)
    // Same 108-column X2Beta template as "x2beta working" above, but sourced
    // from the shipping-charge amounts — mirrors how "amazon-b2b-shipping-
    // tally-ready" is derived from "amazon-b2b-tally-ready". No Stock Item /
    // Quantity / Rate / Unit / Godown: freight is a ledger-only line, matching
    // the shipping tally-ready sheet's own column set (no stock movement).
    // ==================================
    const x2betaShippingSheet = workbook.addWorksheet('x2beta-shipping');

    const x2betaShippingColumns = [
      { header: 'Vch. Date* ', get: () => x2betaVchDate },
      { header: 'Vch. Type*', get: r => `${Number(r['Final Taxable Shipping Value'] || 0) < 0 ? 'CN-' : ''}Sales-${getSellerStateAbbr(r['Seller Gstin']) || ''}` },
      {
        header: 'Vch. No.*',
        get: r => {
          const isCN = Number(r['Final Taxable Shipping Value'] || 0) < 0;
          const rank = getStateRank(getSellerStateAbbr(r['Seller Gstin']));
          return `AMZ-${isRowIntraState(r) ? 'Intra' : 'Inter'}-${isCN ? 'CN-' : ''}${rank}`;
        }
      },
      {
        header: 'Ref. No.',
        get: r => {
          const isCN = Number(r['Final Taxable Shipping Value'] || 0) < 0;
          const rank = getStateRank(getSellerStateAbbr(r['Seller Gstin']));
          return `AMZ-${isRowIntraState(r) ? 'Intra' : 'Inter'}-${isCN ? 'CN-' : ''}${rank}`;
        }
      },
      { header: 'Ref. Date', get: () => x2betaVchDate },
      { header: 'Is CN?', get: r => (Number(r['Final Taxable Shipping Value'] || 0) < 0 ? 'Yes' : null) },
      { header: 'Is Vch?', get: () => null },
      {
        header: 'Party Ledger*',
        get: r => `Amazon B2B ${isRowIntraState(r) ? 'Intra' : 'Inter'}-State (Debtor)-${getSellerStateAbbr(r['Seller Gstin']) || ''}`
      },
      { header: 'Sales Ledger*', get: r => `Sales Amazon-${getSellerStateAbbr(r['Seller Gstin']) || ''} ${Math.round(getRowGstRate(r) * 10000) / 100}%` },
      { header: 'Stock Item', get: () => null },
      { header: 'Description', get: () => null },
      { header: 'Godown', get: () => null },
      { header: 'Quantity', get: () => null },
      { header: 'Rate', get: () => null },
      { header: 'Unit', get: () => null },
      { header: 'Discount', get: () => null },
      { header: 'Amount*', get: r => Number(r['Final Taxable Shipping Value'] || 0) },
      { header: 'Discount', get: () => null }
    ];

    uniqueRates.forEach(r => {
      const ratePercent = Math.round(r * 10000) / 100;
      const halfRatePercent = Math.round((ratePercent / 2) * 100) / 100;
      sortedStateCodes.forEach(sc => {
        x2betaShippingColumns.push({
          header: `Output IGST ${ratePercent}%-${sc}`,
          get: row => (getRowGstRate(row) === r && getSellerStateAbbr(row['Seller Gstin']) === sc) ? Number(row['Final Shipping IGST Tax'] || 0) : 0
        });
        x2betaShippingColumns.push({
          header: `Output CGST ${halfRatePercent}%-${sc}`,
          get: row => (getRowGstRate(row) === r && getSellerStateAbbr(row['Seller Gstin']) === sc) ? Number(row['Final Shipping CGST Tax'] || 0) : 0
        });
        x2betaShippingColumns.push({
          header: `Output SGST ${halfRatePercent}%-${sc}`,
          get: row => (getRowGstRate(row) === r && getSellerStateAbbr(row['Seller Gstin']) === sc) ? Number(row['Final Shipping SGST Tax'] || 0) : 0
        });
      });
    });

    x2betaShippingColumns.push(
      { header: null, get: () => null },
      { header: null, get: () => null },
      { header: 'Narration', get: () => `Amz-B2B-Shipping-${formMonth || ''}` },
      { header: 'Taxability', get: () => null },
      { header: 'GST Nature', get: () => null },
      { header: 'GST Rate', get: () => null },
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
      { header: 'State', get: r => r[toStateCol] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
      { header: 'Place of Supply', get: r => r[toStateCol] || '' }, { header: 'GST Type', get: () => 'Regular' }, { header: 'GSTIN', get: () => null },
      { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
      { header: 'State', get: r => r[toStateCol] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
      { header: 'Place', get: () => null }, { header: 'GSTIN', get: () => null },
      { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
      { header: 'State', get: r => r[toStateCol] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
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

    const x2betaShippingHeaders = x2betaShippingColumns.map(c => c.header);
    x2betaShippingSheet.addRow(x2betaShippingHeaders);
    filteredRows.forEach(row => {
      x2betaShippingSheet.addRow(x2betaShippingColumns.map(c => c.get(row)));
    });
    x2betaShippingSheet.getColumn(1).numFmt = 'dd/mm/yyyy';
    x2betaShippingSheet.getColumn(5).numFmt = 'dd/mm/yyyy';

    // ==================================
    // VALIDATION: x2beta-shipping sheet totals must reconcile with the pivot totals
    // ==================================
    const x2betaShippingOutputCols = x2betaShippingColumns.filter(c => typeof c.header === 'string' && c.header.startsWith('Output '));
    const sumX2betaShippingOutput = prefix => filteredRows.reduce((acc, row) => {
      return acc + x2betaShippingOutputCols
        .filter(c => c.header.startsWith(prefix))
        .reduce((rowAcc, c) => rowAcc + Number(c.get(row) || 0), 0);
    }, 0);

    const shippingReconciliationChecks = [
      ['Amount* (shipping taxable value)', filteredRows.reduce((acc, r) => acc + Number(r['Final Taxable Shipping Value'] || 0), 0), sumPivot('Final Taxable Shipping Value')],
      ['Shipping IGST', sumX2betaShippingOutput('Output IGST'), sumPivot('Final Shipping IGST Tax')],
      ['Shipping CGST', sumX2betaShippingOutput('Output CGST'), sumPivot('Final Shipping CGST Tax')],
      ['Shipping SGST', sumX2betaShippingOutput('Output SGST'), sumPivot('Final Shipping SGST Tax')]
    ];
    shippingReconciliationChecks.forEach(([label, x2betaTotal, mainTotal]) => {
      if (Math.abs(x2betaTotal - mainTotal) > RECONCILIATION_TOLERANCE) {
        console.warn(`[Amazon B2B] x2beta-shipping sheet ${label} mismatch: x2beta=${x2betaTotal.toFixed(2)}, main=${mainTotal.toFixed(2)}`);
      }
    });

    // ================================
    // RETURN STRUCTURE EXPECTED BY CONTROLLER
    // ================================
    return {
      workbook,               // ExcelJS with all sheets
      process1Json: filteredRows,
      pivotData: pivotData,
      x2betaData: {
        headers: x2betaHeaders,
        rows: filteredRows.map(row => x2betaColumns.map(c => c.get(row)))
      }
    };

  } catch (error) {
    console.error('processMacros Error:', error);
    throw error;
  }
}

module.exports = {
  amazonB2BProcessor
};