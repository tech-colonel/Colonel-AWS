/**
 * ============================================================
 *  Shopify Order Cycle Processor  —  STUB
 * ============================================================
 *
 *  This file is the processing engine for the Order Cycle agent.
 *  It receives all uploaded file buffers and is responsible for:
 *
 *    1. Parsing the Shopify export file
 *    2. Parsing each payment gateway settlement file
 *    3. Parsing each logistics partner file
 *    4. Merging / reconciling the data (your business logic goes here)
 *    5. Returning an ExcelJS workbook + summary rows for DB storage
 *
 *  ⚠️  STUB:  Steps 4 & 5 return empty/placeholder data.
 *             Replace the "TODO" section below with real logic.
 * ============================================================
 */

const XLSX = require('exceljs');

/**
 * Parse any Excel buffer into an array of plain objects.
 * Returns [{col1: val, col2: val, ...}, ...]
 */
async function parseExcelBuffer(buffer, label = 'file') {
    try {
        const wb = new XLSX.Workbook();
        await wb.xlsx.load(buffer);
        const sheet = wb.worksheets[0];
        if (!sheet) {
            console.warn(`[OrderCycleProcessor] No worksheet found in ${label}`);
            return [];
        }

        const rows = [];
        let headers = [];

        sheet.eachRow((row, rowNumber) => {
            const values = row.values.slice(1); // exceljs row.values[0] is always undefined
            if (rowNumber === 1) {
                headers = values.map(v => (v === null || v === undefined ? '' : String(v).trim()));
            } else {
                const obj = {};
                headers.forEach((h, i) => {
                    obj[h] = values[i] !== undefined ? values[i] : null;
                });
                rows.push(obj);
            }
        });

        console.log(`[OrderCycleProcessor] Parsed "${label}": ${rows.length} rows, headers: [${headers.join(', ')}]`);
        return rows;
    } catch (err) {
        console.error(`[OrderCycleProcessor] Failed to parse "${label}":`, err.message);
        return [];
    }
}

/**
 * Main processor function
 *
 * @param {Array}   unicommerceJson       - Parsed Unicommerce rows (Array of objects)
 * @param {Array}   salesOrderJson        - Parsed Sales Order Report rows (Array of objects)
 * @param {Object}  gatewayData           - Parsed Gateway rows { 'Razorpay': [...], ... }
 * @param {Object}  logisticsData         - Parsed Logistics rows { 'Delhivery': [...], ... }
 * @param {string}  brandName             - Brand name for logging / filename
 * @param {string}  period                - 'Month-Year' string e.g. 'April-2026'
 *
 * @returns {Promise<{
 *   outputWorkbook: ExcelJS.Workbook,
 *   summaryRows:    object[],
 *   rowCount:       number,
 *   parseStats:     object
 * }>}
 */
async function orderCycleShopifyProcessor(
    unicommerceJson = [],
    salesOrderJson = [],
    gatewayData = {},
    logisticsData = {},
    brandName = '',
    period = ''
) {
    console.log(`\n[OrderCycleProcessor] ── Starting for brand="${brandName}", period="${period}" ──`);
    console.log(`  Gateways : ${Object.keys(gatewayData).join(', ') || '(none)'}`);
    console.log(`  Logistics: ${Object.keys(logisticsData).join(', ') || '(none)'}`);

    // ─── Parse Stats (for UI preview summary) ────────────────────────────────
    const parseStats = {
        unicommerce: unicommerceJson.length,
        salesOrder: salesOrderJson.length,
        gateways: {},
        logistics: {}
    };
    Object.entries(gatewayData).forEach(([name, rows]) => {
        parseStats.gateways[name] = rows.length;
    });
    Object.entries(logisticsData).forEach(([name, rows]) => {
        parseStats.logistics[name] = rows.length;
    });

    // ─── 4. TODO: Your Business Logic ────────────────────────────────────────
    //
    //  Implement order cycle reconciliation here.
    //  Typical steps:
    //    a) Build a lookup map from Shopify rows by order_id / AWB
    //    b) Match against logistics partner (delivery status, COD amount)
    //    c) Match against payment gateways (settlement dates, amounts)
    //    d) Produce a merged output row per order with all statuses
    //
    //  Example skeleton:
    //
    //  const outputRows = shopifyRows.map(order => {
    //      const orderNo = order['Order ID'] || order['Sale Order Number'];
    //
    //      // Find matching logistics row
    //      let logisticsMatch = null;
    //      for (const [partner, rows] of Object.entries(logisticsData)) {
    //          const match = rows.find(r => r['AWB'] === order['AWB'] || r['Order ID'] === orderNo);
    //          if (match) { logisticsMatch = { partner, ...match }; break; }
    //      }
    //
    //      // Find matching payment gateway row
    //      let gatewayMatch = null;
    //      for (const [gateway, rows] of Object.entries(gatewayData)) {
    //          const match = rows.find(r => r['Order ID'] === orderNo);
    //          if (match) { gatewayMatch = { gateway, ...match }; break; }
    //      }
    //
    //      return {
    //          order_id: orderNo,
    //          // ... spread shopify fields
    //          shipping_partner: logisticsMatch?.partner || '',
    //          delivery_date: logisticsMatch?.['Delivery Date'] || null,
    //          cod_amount: logisticsMatch?.['COD Amount'] || 0,
    //          gateway_name: gatewayMatch?.gateway || '',
    //          settlement_date: gatewayMatch?.['Settlement Date'] || null,
    //          settlement_amount: gatewayMatch?.['Amount'] || 0,
    //      };
    //  });
    //
    // ─────────────────────────────────────────────────────────────────────────

    // STUB: placeholder output rows — replace with real outputRows above
    const outputRows = unicommerceJson.map((order, idx) => ({
        row_index: idx + 1,
        sale_order_number: order['Order ID'] || order['Name'] || order['Sale Order Number'] || '',
        platform: 'Unicommerce',
        invoice_number: order['Invoice Number'] || order['invoice_number'] || '',
        awb_number: order['AWB'] || order['Tracking Number'] || '',
        shipping_partner: '',
        total_amount: order['Total'] || order['Gross Sales'] || 0,
        return_amount: 0,
        net_amount: order['Net Sales'] || 0,
        // Payment gateway fields — populated by matching logic above
        gateway_name: '',
        settlement_date: null,
        settlement_amount: 0,
    }));

    // ─── 5. Build Output Workbook ─────────────────────────────────────────────
    const outputWorkbook = new XLSX.Workbook();
    outputWorkbook.creator = 'Colonel Automation';
    outputWorkbook.created = new Date();

    // Sheet 1 — Order Cycle Report
    const mainSheet = outputWorkbook.addWorksheet('Order Cycle');
    if (outputRows.length > 0) {
        const headers = Object.keys(outputRows[0]);
        mainSheet.addRow(headers);
        outputRows.forEach(row => mainSheet.addRow(Object.values(row)));

        // Style header row
        mainSheet.getRow(1).font = { bold: true };
        mainSheet.getRow(1).fill = {
            type: 'pattern', pattern: 'solid',
            fgColor: { argb: 'FF1E3A5F' }
        };
        mainSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    } else {
        mainSheet.addRow(['No data — implement business logic in orderCycleShopifyProcessor.js']);
    }

    // Sheet 2 — Unicommerce Raw (for reference)
    const unicommerceSheet = outputWorkbook.addWorksheet('Unicommerce Raw');
    if (unicommerceJson.length > 0) {
        unicommerceSheet.addRow(Object.keys(unicommerceJson[0]));
        unicommerceJson.forEach(r => unicommerceSheet.addRow(Object.values(r)));
        unicommerceSheet.getRow(1).font = { bold: true };
    }

    // Sheet 3 — Sales Order Raw (for reference)
    const salesOrderSheet = outputWorkbook.addWorksheet('Sales Order Raw');
    if (salesOrderJson.length > 0) {
        salesOrderSheet.addRow(Object.keys(salesOrderJson[0]));
        salesOrderJson.forEach(r => salesOrderSheet.addRow(Object.values(r)));
        salesOrderSheet.getRow(1).font = { bold: true };
    }

    // Sheet per payment gateway
    for (const [gwName, rows] of Object.entries(gatewayData)) {
        const gwSheet = outputWorkbook.addWorksheet(`GW - ${gwName}`.substring(0, 31));
        if (rows.length > 0) {
            gwSheet.addRow(Object.keys(rows[0]));
            rows.forEach(r => gwSheet.addRow(Object.values(r)));
            gwSheet.getRow(1).font = { bold: true };
        }
    }

    // Sheet per logistics partner
    for (const [lpName, rows] of Object.entries(logisticsData)) {
        const lpSheet = outputWorkbook.addWorksheet(`LP - ${lpName}`.substring(0, 31));
        if (rows.length > 0) {
            lpSheet.addRow(Object.keys(rows[0]));
            rows.forEach(r => lpSheet.addRow(Object.values(r)));
            lpSheet.getRow(1).font = { bold: true };
        }
    }

    console.log(`[OrderCycleProcessor] ── Done. Output rows: ${outputRows.length} ──\n`);

    return {
        outputWorkbook,
        summaryRows: outputRows,
        rowCount: outputRows.length,
        parseStats
    };
}

module.exports = { orderCycleShopifyProcessor, parseExcelBuffer };
