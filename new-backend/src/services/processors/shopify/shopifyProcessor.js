// shopifyProcessor.js
const ExcelJS = require('exceljs');

/**
 * Normalize SKU
 */
function normalizeSKU(sku) {
    if (!sku) return '';
    return sku.toString().replace(/"/g, '').replace(/'/g, '').trim().toLowerCase();
}

/**
 * Safe Number
 */
function safeNumber(val) {
    if (val === null || val === undefined || val === '') return 0;
    const num = Number(String(val).replace(/,/g, '').trim());
    return isNaN(num) ? 0 : num;
}

/**
 * Normalize State
 */
function normalizeState(state) {
    return (state || '').toString().trim().toLowerCase();
}

/**
 * Parse Month-Year (April-2026 → {month: 4, year: 2026})
 */
function parseMonthYear(monthYear) {
    if (!monthYear) return {};
    const date = new Date(monthYear);
    if (isNaN(date)) return {};
    return {
        month: date.getMonth() + 1,
        year: date.getFullYear()
    };
}

/**
 * Shopify Processor
 */
const shopifyProcessor = async (
    fileBuffer,
    skuMaster,
    ledgerMaster,
    brandName,
    monthYear,
    useInventory = true
) => {
    try {
        console.log(`Starting Shopify processing for ${brandName} (${monthYear})`);

        const { month, year } = parseMonthYear(monthYear);

        // =========================
        // SKU MAP
        // =========================
        const skuMap = {};

        (skuMaster || []).forEach(item => {
            const sku = normalizeSKU(
                item['Tally New SKU'] ||
                item['Tally new SKU'] ||
                item['tally new sku'] ||
                item['FG'] ||
                item['SKU'] ||
                item['sku']
            );

            if (!sku) return;

            skuMap[sku] = {
                fg: item['Sales Portal SKU'] || item['Sales portal SKU'] || item['sales portal sku'] || '',
                gst: safeNumber(
                    item['gst'] ||
                    item['gst '] ||   // trailing space — common in uploaded Excels
                    item['GST'] ||
                    item['GST Rate'] ||
                    item['GST rate'] ||
                    item['gst_rate'] ||
                    0
                )
            };
        });



        // =========================
        // STATE MAP
        // =========================
        const stateMap = {};
        (ledgerMaster || []).forEach(item => {
            const state = normalizeState(item['States'] || item['State']);

            if (!state) return;

            stateMap[state] = {
                ledger: item['Ledger'] || '',
                invoice: item['Invoice No.'] || item['Invoice Number'] || ''
            };
        });

        // =========================
        // READ FILE (ExcelJS)
        // =========================
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(fileBuffer);

        const worksheet = workbook.worksheets[0];

        const headers = [];
        worksheet.getRow(1).eachCell((cell, colNumber) => {
            headers[colNumber] = cell.value;
        });


        const outputHeaders = [...headers].filter(Boolean);

        const insertAfter = (colName, newCols) => {
            const index = outputHeaders.indexOf(colName);
            if (index !== -1) {
                // Remove if they already exist to prevent duplicates
                newCols.forEach(col => {
                    const idx = outputHeaders.indexOf(col);
                    if (idx !== -1) outputHeaders.splice(idx, 1);
                });
                outputHeaders.splice(outputHeaders.indexOf(colName) + 1, 0, ...newCols);
            } else {
                newCols.forEach(col => {
                    if (!outputHeaders.includes(col)) outputHeaders.push(col);
                });
            }
        };

        insertAfter('Product Variant SKU', ['FG', 'gst rate']);
        insertAfter('Product variant SKU', ['FG', 'gst rate']); // older export format
        insertAfter('Billing region', ['Tally Ledger', 'Sales ledger', 'Invoice Number']);

        insertAfter('Quantity ordered per order', ['Final Qty', 'taxable value', 'igst', 'cgst', 'sgst']);

        const salesReportData = [];
        const workingSheetData = [];

        // =========================
        // PROCESS ROWS
        // =========================
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return;

            const rowObj = {};
            row.eachCell((cell, colNumber) => {
                const header = headers[colNumber];
                if (header) {
                    rowObj[header] = cell.value;
                }
            });

            // -------------------------
            // SKU + FG LooKUP
            // -------------------------
            const rawSku =
                rowObj['Product Variant SKU'] ||
                rowObj['Product variant SKU'] ||
                rowObj['Variant SKU'] ||
                rowObj['variant sku'] ||
                '';

            const rawTitle = rowObj['Product title'] || rowObj['Product Title'] || '';
            const rawVarTitle = rowObj['Product variant title'] || rowObj['Product Variant Title'] || '';
            const rawVarId = rowObj['Product variant ID'] || rowObj['Product Variant ID'] || '';

            // Since the provided SKU Master sometimes maps Product Titles instead of actual SKUs,
            // we check an array of possible identifiers against the skuMap.
            const lookupKeys = [
                normalizeSKU(rawSku),
                normalizeSKU(rawTitle),
                normalizeSKU(rawVarTitle),
                normalizeSKU(rawTitle && rawVarTitle ? `${rawTitle} - ${rawVarTitle}` : ''),
                normalizeSKU(rawVarId)
            ].filter(Boolean);

            let finalFg = '';
            let finalGst = 0;
            let matched = false;

            for (const key of lookupKeys) {
                if (skuMap[key]) {
                    finalFg = skuMap[key].fg;
                    finalGst = skuMap[key].gst;
                    matched = true;
                    break;
                }
            }

            const shippingState = rowObj['shipping states'] || rowObj['Shipping states'];

            if (matched) {
                // Keep the matched values
            } else if (!rawSku) {
                // If it's empty in Shopify (no SKU), it's a shipping row
                finalFg = `11. Shipping Charges (Sales) ${shippingState}`.trim();
                finalGst = 5;
            }

            // -------------------------
            // STATE
            // -------------------------
            const billingRegion = rowObj['Billing region'] || '';
            const normBillingState = normalizeState(billingRegion);
            const normShippingState = normalizeState(shippingState);

            const stateObj = stateMap[normBillingState] || {};

            const tallyLedger = stateObj.ledger || '';
            const invoiceNumber = stateObj.invoice || '';

            // -------------------------
            // SALES LEDGER
            // -------------------------
            let salesLedger = '';
            if (rawSku) {
                salesLedger = 'Sales Shopify';
            } else {
                salesLedger = `11. Shipping Charges (Sales) ${shippingState}`.trim();
            }

            // -------------------------
            // NUMBERS
            // -------------------------
            const qtyOrdered = safeNumber(rowObj['Quantity ordered']);
            const qtyReturned = safeNumber(rowObj['Quantity returned']);
            const totalSales = safeNumber(rowObj['Total sales'] || rowObj['Total Sales'] || 0);

            const finalQty = qtyOrdered - qtyReturned;

            // -------------------------
            // TAX CALCULATION
            // -------------------------
            let taxableValue = 0;
            if (finalGst > 0) {
                taxableValue = totalSales / (1 + (finalGst / 100));
            } else {
                taxableValue = totalSales;
            }

            let cgst = 0, sgst = 0, igst = 0;

            if (normShippingState !== normBillingState) {
                igst = taxableValue * (finalGst / 100);
            } else {
                cgst = taxableValue * (finalGst / 2 / 100);
                sgst = taxableValue * (finalGst / 2 / 100);
            }

            // =========================
            // FINAL OBJECT FOR EXCEL
            // =========================
            const finalRowObj = { ...rowObj };
            finalRowObj['FG'] = finalFg;
            finalRowObj['gst rate'] = finalGst;
            finalRowObj['Tally Ledger'] = tallyLedger;
            finalRowObj['Sales ledger'] = salesLedger;
            finalRowObj['Invoice Number'] = invoiceNumber;
            finalRowObj['Final Qty'] = finalQty;
            finalRowObj['taxable value'] = taxableValue;
            finalRowObj['igst'] = igst;
            finalRowObj['cgst'] = cgst;
            finalRowObj['sgst'] = sgst;

            workingSheetData.push(finalRowObj);

            // =========================
            // FINAL OBJECT (DB FORMAT)
            // =========================
            const finalRow = {
                year,
                month,
                date: rowObj['Day'] || null,
                filename: '',

                day: rowObj['Day'],
                sales: rowObj['Sales'],

                product_variant_sku: rawSku || '',
                fg: finalFg,

                product_variant_id: rowObj['Product variant ID'],
                product_variant_title: rowObj['Product variant title'],

                shipping_region: shippingState,
                billing_region: billingRegion,

                tally_ledger: tallyLedger,
                sales_ledger: salesLedger,
                invoice_number: invoiceNumber,

                customer_name: rowObj['Customer name'],
                order_fulfillment_status: rowObj['Order fulfillment status'],

                product_id: rowObj['Product ID'],
                product_title: rowObj['Product title'],
                order_id: rowObj['Order ID'],

                billing_city: rowObj['Billing city'],
                shipping_city: rowObj['Shipping city'],

                gross_sales: safeNumber(rowObj['Gross sales']),
                discounts: safeNumber(rowObj['Discounts']),
                returns: safeNumber(rowObj['Returns']),
                net_sales: safeNumber(rowObj['Net sales']),

                shipping_charges: safeNumber(rowObj['Shipping charges']),
                return_fees: safeNumber(rowObj['Return fees']),
                taxes: safeNumber(rowObj['Taxes']),
                total_sales: totalSales,

                quantity_returned: qtyReturned,
                quantity_ordered: qtyOrdered,
                quantity_ordered_per_order: safeNumber(rowObj['Quantity ordered per order']),
                final_qty: finalQty,

                gst_rate: finalGst,
                taxable_value: Math.round(taxableValue),

                igst,
                cgst,
                sgst
            };

            salesReportData.push(finalRow);
        });

        console.log(`Processed rows: ${salesReportData.length}`);

        // =========================
        // CREATE OUTPUT WORKBOOK
        // =========================
        const outputWorkbook = new ExcelJS.Workbook();

        // 1. Working Sheet
        const sheet = outputWorkbook.addWorksheet('working-file');
        if (workingSheetData.length > 0) {
            sheet.columns = outputHeaders.map(hdr => ({
                header: hdr,
                key: hdr
            }));
            workingSheetData.forEach(row => {
                sheet.addRow(row);
            });
        }

        // 2. Pivot Sheet
        const pivotSheet = outputWorkbook.addWorksheet('pivot');
        const pivotHeaders = ['Invoice Number', 'Tally Ledger', 'Sales ledger', 'FG', 'Final Qty', 'taxable value', 'igst', 'cgst', 'sgst'];
        pivotSheet.columns = pivotHeaders.map(hdr => ({ header: hdr, key: hdr }));

        // 3. After Pivot Sheet
        const afterPivotSheet = outputWorkbook.addWorksheet('after pivot');
        afterPivotSheet.columns = pivotHeaders.map(hdr => ({ header: hdr, key: hdr }));

        if (workingSheetData.length > 0) {
            workingSheetData.forEach(row => {
                const pivotRow = {};
                pivotHeaders.forEach(hdr => {
                    pivotRow[hdr] = row[hdr] || 0;
                });
                // Ensure strings for text columns
                pivotRow['Invoice Number'] = row['Invoice Number'] || '';
                pivotRow['Tally Ledger'] = row['Tally Ledger'] || '';
                pivotRow['Sales ledger'] = row['Sales ledger'] || '';
                pivotRow['FG'] = row['FG'] || '';

                pivotSheet.addRow(pivotRow);
                afterPivotSheet.addRow(pivotRow);
            });
        }

        console.log('=== SHOPIFY PROCESSOR COMPLETE ===');

        return {
            salesReportData,
            outputWorkbook
        };

    } catch (error) {
        console.error('Error in shopifyProcessor:', error);
        throw error;
    }
};

module.exports = {
    shopifyProcessor
};