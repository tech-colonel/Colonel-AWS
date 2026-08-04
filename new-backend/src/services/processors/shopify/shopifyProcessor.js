// shopifyProcessor.js
const ExcelJS = require('exceljs');
const { Readable } = require('stream');
const { getStateCodeFromName, getStateAbbr } = require('../../../utils/gstStateCodes');

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
        // READ FILE (ExcelJS — XLSX or CSV)
        // =========================
        const workbook = new ExcelJS.Workbook();
        // XLSX files are ZIPs and start with PK magic bytes (0x50 0x4B)
        const isXLSX = fileBuffer[0] === 0x50 && fileBuffer[1] === 0x4B;
        if (isXLSX) {
            await workbook.xlsx.load(fileBuffer);
        } else {
            const readable = new Readable();
            readable.push(fileBuffer);
            readable.push(null);
            await workbook.csv.read(readable);
        }

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
            const baseInvoice = stateObj.invoice || '';
            const invoiceNumber = baseInvoice
                ? `${baseInvoice}-${String(month).padStart(2, '0')}`
                : '';

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

        // 4. X2Beta working — same 108-column Tally e-invoice import template
        // used by the other marketplace processors.
        buildX2betaSheet(outputWorkbook, workingSheetData, month, year);

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

// ============================================================
// X2BETA WORKING SHEET
// Same 108-column Tally "X2Beta" e-invoice import template used by the
// other marketplace processors. Built from workingSheetData (one row per
// line item, already carrying a resolved Tally Ledger / Sales Ledger /
// Invoice Number from the ledger master, keyed by "Billing region" — the
// same field the rest of this processor already uses as its state
// dimension for ledger lookup and the intra/inter-state GST split).
// Shopify's report has no per-row date beyond a "Day" field and no HSN
// column, so both are handled with a best-effort fallback.
// ============================================================
function buildX2betaSheet(outputWorkbook, workingSheetData, month, year) {
    function rowVchDate(row) {
        const day = Number(row['Day']);
        if (month && year && day >= 1 && day <= 31) {
            const d = new Date(year, month - 1, day);
            if (!isNaN(d.getTime())) return d;
        }
        if (month && year) return new Date(year, month, 0);
        return new Date();
    }

    function sellerStateAbbr(row) {
        const billingRegion = row['Billing region'] || '';
        const code = getStateCodeFromName(billingRegion);
        return (code && getStateAbbr(code)) || normalizeState(billingRegion).toUpperCase();
    }

    const uniqueRates = [...new Set(workingSheetData.map(r => Number(r['gst rate'] || 0)))].filter(r => r > 0);
    const sortedStateCodes = [...new Set(workingSheetData.map(r => sellerStateAbbr(r)))].filter(Boolean).sort();

    const x2betaColumns = [
        { header: 'Vch. Date* ', get: r => rowVchDate(r) },
        { header: 'Vch. Type*', get: r => `Sales-${sellerStateAbbr(r)}` },
        { header: 'Vch. No.*', get: r => r['Invoice Number'] || '' },
        { header: 'Ref. No.', get: r => r['Invoice Number'] || '' },
        { header: 'Ref. Date', get: r => rowVchDate(r) },
        { header: 'Is CN?', get: () => null },
        { header: 'Is Vch?', get: () => null },
        { header: 'Party Ledger*', get: r => r['Tally Ledger'] || '' },
        { header: 'Sales Ledger*', get: r => r['Sales ledger'] || '' },
        { header: 'Stock Item', get: r => r['FG'] || '' },
        { header: 'Description', get: r => r['Product title'] || r['Product Title'] || '' },
        { header: 'Godown', get: r => r['shipping states'] || r['Shipping states'] || '' },
        { header: 'Quantity', get: r => Number(r['Final Qty'] || 0) },
        {
            header: 'Rate',
            get: r => {
                const qty = Number(r['Final Qty'] || 0);
                return qty !== 0 ? Math.abs(Number(r['taxable value'] || 0) / qty) : 0;
            }
        },
        { header: 'Unit', get: () => 'Pcs' },
        { header: 'Discount', get: () => null },
        { header: 'Amount*', get: r => Number(r['taxable value'] || 0) },
        { header: 'Discount', get: () => null }
    ];

    uniqueRates.forEach(rate => {
        const halfRate = Math.round((rate / 2) * 100) / 100;
        sortedStateCodes.forEach(sc => {
            x2betaColumns.push({
                header: `Output IGST ${rate}%-${sc}`,
                get: row => (Number(row['gst rate'] || 0) === rate && sellerStateAbbr(row) === sc) ? Number(row['igst'] || 0) : 0
            });
            x2betaColumns.push({
                header: `Output CGST ${halfRate}%-${sc}`,
                get: row => (Number(row['gst rate'] || 0) === rate && sellerStateAbbr(row) === sc) ? Number(row['cgst'] || 0) : 0
            });
            x2betaColumns.push({
                header: `Output SGST ${halfRate}%-${sc}`,
                get: row => (Number(row['gst rate'] || 0) === rate && sellerStateAbbr(row) === sc) ? Number(row['sgst'] || 0) : 0
            });
        });
    });

    x2betaColumns.push(
        { header: null, get: () => null },
        { header: null, get: () => null },
        { header: 'Narration', get: () => `Shopify-${month || ''}-${year || ''}` },
        { header: 'Taxability', get: () => null },
        { header: 'GST Nature', get: () => null },
        { header: 'GST Rate', get: r => Number(r['gst rate'] || 0) },
        { header: 'Cess', get: () => null },
        { header: 'RCM?', get: () => null },
        // Shopify's source report carries no HSN column — left blank rather than fabricated.
        { header: 'HSN', get: () => null },
        { header: 'HSN Desc', get: () => null },
        { header: 'Supply Type', get: () => null },
        { header: 'Cost Category', get: () => null },
        { header: 'Cost Centre', get: () => null },
        { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
        { header: 'State', get: r => r['shipping states'] || r['Shipping states'] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
        { header: 'Place of Supply', get: r => r['shipping states'] || r['Shipping states'] || '' }, { header: 'GST Type', get: () => null }, { header: 'GSTIN', get: () => null },
        { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
        { header: 'State', get: r => r['shipping states'] || r['Shipping states'] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
        { header: 'Place', get: () => null }, { header: 'GSTIN', get: () => null },
        { header: 'Name', get: () => null }, { header: 'Address 1', get: () => null }, { header: 'Address 2', get: () => null },
        { header: 'State', get: r => r['shipping states'] || r['Shipping states'] || '' }, { header: 'Country', get: () => 'India' }, { header: 'PIN Code', get: () => null },
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

    const x2betaSheet = outputWorkbook.addWorksheet('x2beta working');
    x2betaSheet.addRow(x2betaColumns.map(c => c.header));
    workingSheetData.forEach(row => {
        x2betaSheet.addRow(x2betaColumns.map(c => c.get(row)));
    });
    x2betaSheet.getColumn(1).numFmt = 'dd/mm/yyyy';
    x2betaSheet.getColumn(5).numFmt = 'dd/mm/yyyy';
}

module.exports = {
    shopifyProcessor
};