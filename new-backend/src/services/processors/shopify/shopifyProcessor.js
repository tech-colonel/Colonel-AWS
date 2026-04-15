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
                item['Sales portal SKU'] ||
                item['SKU'] ||
                item['sku']
            );

            if (!sku) return;

            skuMap[sku] = {
                fg: item['Tally new SKU'] || item['FG'] || '',
                gst: safeNumber(item['GST Rate'] || item['gst'] || 0)
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
                invoice: item['Invoice No.'] || ''
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

        const salesReportData = [];

        // =========================
        // PROCESS ROWS
        // =========================
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return;

            const rowObj = {};
            row.eachCell((cell, colNumber) => {
                rowObj[headers[colNumber]] = cell.value;
            });

            // -------------------------
            // SKU + FG
            // -------------------------
            const rawSku = rowObj['Product variant SKU'] || '';
            const sku = normalizeSKU(rawSku);

            let fg = '';
            let gstRate = 0;

            if (skuMap[sku]) {
                fg = skuMap[sku].fg;
                gstRate = skuMap[sku].gst;
            } else {
                fg = "11. Shipping Charges (Sales) Haryana";
            }

            // -------------------------
            // STATE
            // -------------------------
            const billingRegion = rowObj['Billing region'] || '';
            const normState = normalizeState(billingRegion);

            const stateObj = stateMap[normState] || {};

            const tallyLedger = stateObj.ledger || '';
            const invoiceNumber = stateObj.invoice || '';

            // -------------------------
            // SALES LEDGER
            // -------------------------
            const salesType = (rowObj['Sales'] || '').toString().toLowerCase();

            let salesLedger = '';

            if (salesType === 'sales') {
                salesLedger = `${billingRegion} Shopify`;
            } else if (salesType === 'shipping') {
                salesLedger = `${billingRegion} 11. Shipping Charges (Sales)`;
            }

            // -------------------------
            // NUMBERS
            // -------------------------
            const qtyOrdered = safeNumber(rowObj['Quantity ordered']);
            const qtyReturned = safeNumber(rowObj['Quantity returned']);
            const totalSales = safeNumber(rowObj['Total sales']);

            const finalQty = qtyOrdered - qtyReturned;

            // -------------------------
            // TAX CALCULATION
            // -------------------------
            let taxableValue = 0;
            if (gstRate > 0) {
                taxableValue = totalSales / (1 + gstRate / 100);
            }

            let cgst = 0, sgst = 0, igst = 0;

            const sellerState = 'haryana'; // TODO: make dynamic if needed

            if (normalizeState(sellerState) === normState) {
                cgst = taxableValue * (gstRate / 2 / 100);
                sgst = taxableValue * (gstRate / 2 / 100);
            } else {
                igst = taxableValue * (gstRate / 100);
            }

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

                product_variant_sku: sku,
                fg: fg,

                product_variant_id: rowObj['Product variant ID'],
                product_variant_title: rowObj['Product variant title'],

                shipping_region: rowObj['Shipping region'],
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

                gst_rate: gstRate,
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
        const sheet = outputWorkbook.addWorksheet('working-file');

        if (salesReportData.length > 0) {
            sheet.columns = Object.keys(salesReportData[0]).map(key => ({
                header: key,
                key: key
            }));

            salesReportData.forEach(row => {
                sheet.addRow(row);
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