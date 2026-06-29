/**
 * ============================================================
 *  Shopify Order Cycle Processor
 * ============================================================
 *  Implements the Order Cycle Reconciliation SOP:
 *    Step 1:  Build master from Export-Tally GST Report
 *    Step 2:  Add Return information (Return GST Report)
 *    Step 3:  Add Delivery Status (Sales Order Combined)
 *    Steps 4-9: Add settlement data per logistics/gateway partner
 *    Step 10: Total Settlement Received
 *    Step 11: Balance Amount Receivable
 *    Step 12: Reconciliation Status
 *    Steps 13-14: Validation + Exception Report
 *
 *  Input file column mappings (detected from test files):
 *    GST Report   – sheet "Export-Tally GST Report 3.0-flo"
 *                   Sale Order Number | Invoice number | AWB num |
 *                   Shipping Provider | Date | Total | Channel Ledger
 *    Return GST   – sheet "Export-Tally Return GST Report"
 *                   Date | Sale Order Number | Invoice number | Total
 *    Sales Order  – Sale Order Number | Delivery Status
 *    Ekart        – TRACKING_ID | COD_AMOUNT | DUE_DATE_OF_REMITTANCE | ACTUAL_DATE_OF_REMITTANCE
 *    Delhivery    – waybill_num | cod_amount | status_date
 *    Xpressbees   – Shipping Id | Net Payment | Delivery Date | Transaction Date
 *    Snapmint     – Shopify Order No._2 (numeric) | Merchant Settlement Date | Settlement Value
 *    BharatX      – Order id by Vlook | Ledger Timestamp | Ledger Amount
 *    Razorpay     – Order ID | settled_at | Settlement amount
 * ============================================================
 */

'use strict';
const XLSX = require('exceljs');
const { PassThrough } = require('stream');

// ── Utility helpers ───────────────────────────────────────────────────────────

function safeStr(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString();
    return String(v).trim();
}

function safeNum(v) {
    if (v === null || v === undefined || v === '') return 0;
    const s = String(v).replace(/[,\s₹$%]/g, '');
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
}

function safeDate(v) {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    const s = String(v).trim();
    if (!s) return null;
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;
    // Try M/D/YY or DD-MMM-YYYY formats
    const slash = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (slash) {
        const [, a, b, y] = slash;
        const year = y.length === 2 ? 2000 + parseInt(y) : parseInt(y);
        const attempt = new Date(year, parseInt(a) - 1, parseInt(b));
        if (!isNaN(attempt.getTime())) return attempt;
    }
    return null;
}

// Return first non-null/empty value from a row matching any candidate column name
function getCol(row, ...candidates) {
    for (const name of candidates) {
        const v = row[name];
        if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
    return null;
}

function normalizeAWB(v) {
    return safeStr(v).replace(/\s+/g, '').toUpperCase();
}

function normalizeOrderNum(v) {
    return safeStr(v).replace(/^#/, '').trim();
}

function normalizeDeliveryStatus(s) {
    const upper = safeStr(s).toUpperCase().replace(/[-_\s]/g, '');
    if (['DELIVERED', 'DLDELIVERED', 'SHIPMENTDELIVERED'].includes(upper)) return 'DELIVERED';
    if (['RTO', 'DLRTO'].includes(upper)) return 'RTO';
    if (['CANCELLED', 'CANCELED'].includes(upper)) return 'CANCELLED';
    return safeStr(s).trim() || null;
}

// ── parseExcelBuffer ──────────────────────────────────────────────────────────

/**
 * Parse an Excel buffer into an array of plain row objects using ExcelJS streaming.
 * Streaming avoids the "Invalid string length" error on large files (100MB+).
 * Auto-detects the best sheet (most text-like header columns) and header row
 * (first row among the first 5 with >= 3 non-numeric string values).
 * Duplicate header names get a _2, _3 … suffix.
 */
async function parseExcelBuffer(buffer, label = 'file') {
    try {
        const stream = new PassThrough();
        stream.end(buffer);

        const workbookReader = new XLSX.stream.xlsx.WorkbookReader(stream, {
            sharedStrings: 'cache',
            hyperlinks: 'ignore',
            styles: 'ignore',
            worksheets: 'emit',
            entries: 'emit',
        });

        const allSheets = []; // { name, headerCount, rows }

        for await (const worksheetReader of workbookReader) {
            const sheetName = worksheetReader.name || '';
            const sheetRows = [];
            let headers = [];
            let headerFound = false;
            let scanCount = 0;

            for await (const row of worksheetReader) {
                scanCount++;
                const values = row.values.slice(1); // exceljs: index 0 is always null

                if (!headerFound) {
                    if (scanCount <= 5) {
                        const textCount = values.filter(v =>
                            v !== null && v !== undefined &&
                            typeof v === 'string' && v.trim().length > 1 &&
                            isNaN(parseFloat(String(v).replace(/[,\s]/g, '')))
                        ).length;
                        if (textCount >= 3) {
                            headerFound = true;
                            const raw = values.map(v => (v === null || v === undefined ? '' : String(v).trim()));
                            const hCount = {};
                            headers = raw.map(h => {
                                if (!h) return h;
                                hCount[h] = (hCount[h] || 0) + 1;
                                return hCount[h] > 1 ? `${h}_${hCount[h]}` : h;
                            });
                        }
                    }
                    continue; // always skip pre-header rows (including the header row itself)
                }

                const obj = {};
                headers.forEach((h, i) => {
                    if (!h) return;
                    obj[h] = values[i] !== undefined ? values[i] : null;
                });
                const hasData = Object.values(obj).some(v =>
                    v !== null && v !== undefined && String(v).trim() !== ''
                );
                if (hasData) sheetRows.push(obj);
            }

            if (headerFound && sheetRows.length > 0) {
                allSheets.push({ name: sheetName, headerCount: headers.filter(Boolean).length, rows: sheetRows });
            }
        }

        if (allSheets.length === 0) {
            console.warn(`[OrderCycleProcessor] No data found in "${label}"`);
            return [];
        }

        // Pick the sheet with the most distinct header columns
        allSheets.sort((a, b) => b.headerCount - a.headerCount);
        const best = allSheets[0];
        console.log(`[OrderCycleProcessor] "${label}": sheet="${best.name}", rows=${best.rows.length}`);
        return best.rows;

    } catch (err) {
        console.error(`[OrderCycleProcessor] Failed to parse "${label}":`, err.message);
        return [];
    }
}

// ── Partner detection ─────────────────────────────────────────────────────────

function detectLogisticsType(rows) {
    if (!rows || rows.length === 0) return null;
    const f = rows[0];
    if (getCol(f, 'TRACKING_ID', 'MERCHANT_ID', 'MP_ID')) return 'ekart';
    if (getCol(f, 'waybill_num')) return 'delhivery';
    if (getCol(f, 'Shipping Id')) return 'xpressbees';
    return null;
}

function detectGatewayType(rows) {
    if (!rows || rows.length === 0) return null;
    const f = rows[0];
    if (getCol(f, 'LoanApp Id')) return 'snapmint';
    if (getCol(f, 'Order id by Vlook', 'Parter Id')) return 'bharatx';
    if (getCol(f, 'entity_id', 'settled_at', 'settlement_utr')) return 'razorpay';
    return null;
}

function collectPartnerRows(dataMap, nameHints, detectFn) {
    const result = {};
    for (const [name, rows] of Object.entries(dataMap)) {
        const lname = name.toLowerCase();
        let key = null;
        for (const [hint, type] of Object.entries(nameHints)) {
            if (lname.includes(hint)) { key = type; break; }
        }
        if (!key) key = detectFn(rows);
        if (key) {
            if (!result[key]) result[key] = [];
            result[key] = result[key].concat(rows);
        }
    }
    return result;
}

// ── Lookup builders ───────────────────────────────────────────────────────────

function buildReturnLookup(rows) {
    const map = {};
    for (const row of rows) {
        const orderNo = normalizeOrderNum(getCol(row, 'Sale Order Number', 'Order Number', 'Order No'));
        if (!orderNo) continue;
        if (!map[orderNo]) map[orderNo] = { return_date: null, srns: [], return_amount: 0 };
        map[orderNo].return_amount += safeNum(getCol(row, 'Total', 'Return Amount', 'Net Amount'));
        const srn = safeStr(getCol(row, 'Invoice number', 'Invoice Number', 'SRN'));
        if (srn) map[orderNo].srns.push(srn);
        const dt = safeDate(getCol(row, 'Date', 'Return Date'));
        if (dt && !map[orderNo].return_date) map[orderNo].return_date = dt;
    }
    const out = {};
    for (const [k, v] of Object.entries(map)) {
        out[k] = { return_date: v.return_date, srn: [...new Set(v.srns)].join(', '), return_amount: v.return_amount };
    }
    return out;
}

function buildSalesOrderLookup(rows) {
    const map = {};
    for (const row of rows) {
        const orderNo = normalizeOrderNum(
            getCol(row, 'Sale Order Number', 'Order Number', 'Order No', 'Order ID', 'SaleOrderNumber')
        );
        if (!orderNo) continue;
        const raw = getCol(row, 'Delivery Status', 'Status', 'Order Status',
            'Fulfillment Status', 'Delivery Status Description', 'delivery_status');
        const normalized = normalizeDeliveryStatus(raw);
        if (normalized) map[orderNo] = normalized;
    }
    return map;
}

function buildEkartLookup(rows) {
    const map = {};
    for (const row of rows) {
        const awb = normalizeAWB(getCol(row, 'TRACKING_ID', 'SHIPMENT_ID', 'AWB', 'Waybill'));
        if (!awb) continue;
        if (!map[awb]) {
            map[awb] = {
                remittance_date: safeDate(getCol(row, 'DUE_DATE_OF_REMITTANCE', 'REMITTANCE_DATE')),
                actual_remittance_date: safeDate(getCol(row, 'ACTUAL_DATE_OF_REMITTANCE')),
                cod_amount: 0
            };
        }
        map[awb].cod_amount += safeNum(getCol(row, 'COD_AMOUNT', 'TOTAL_AMOUNT_OF_BATCH'));
    }
    return map;
}

function buildDelhiveryLookup(rows) {
    const map = {};
    for (const row of rows) {
        const awb = normalizeAWB(getCol(row, 'waybill_num', 'AWB', 'Waybill'));
        if (!awb) continue;
        if (!map[awb]) {
            map[awb] = {
                delivery_date: safeDate(getCol(row, 'status_date', 'Delivery Date')),
                cod_amount: 0
            };
        }
        map[awb].cod_amount += safeNum(getCol(row, 'cod_amount', 'payable', 'COD Amount'));
    }
    return map;
}

function buildXpressbeesLookup(rows) {
    const map = {};
    for (const row of rows) {
        const awb = normalizeAWB(getCol(row, 'Shipping Id', 'AWB', 'Tracking ID'));
        if (!awb) continue;
        if (!map[awb]) {
            map[awb] = {
                delivery_date: safeDate(getCol(row, 'Delivery Date')),
                transaction_date: safeDate(getCol(row, 'Transaction Date', 'date')),
                net_payment: 0
            };
        }
        map[awb].net_payment += safeNum(getCol(row, 'Net Payment'));
    }
    return map;
}

function buildSnapmintLookup(rows) {
    const map = {};
    for (const row of rows) {
        // Second "Shopify Order No." column is renamed to "Shopify Order No._2" by deduplication
        const orderNo = normalizeOrderNum(
            getCol(row, 'Shopify Order No._2', 'Shopify Order No.', 'Sale Order Number', 'Order No.')
        );
        if (!orderNo) continue;
        if (!map[orderNo]) {
            map[orderNo] = {
                settlement_date: safeDate(getCol(row, 'Merchant Settlement Date', 'Settlement Date', 'settled_at')),
                settlement_amount: 0
            };
        }
        map[orderNo].settlement_amount += safeNum(getCol(row, 'Settlement Value', 'Amount'));
    }
    return map;
}

function buildBharatXLookup(rows) {
    const map = {};
    for (const row of rows) {
        const orderNo = normalizeOrderNum(getCol(row, 'Order id by Vlook', 'Order ID', 'Merchant Transaction Id'));
        if (!orderNo) continue;
        if (!map[orderNo]) {
            map[orderNo] = {
                settlement_date: safeDate(getCol(row, 'Ledger Timestamp', 'Settlement Timestamp')),
                settlement_amount: 0
            };
        }
        map[orderNo].settlement_amount += safeNum(getCol(row, 'Ledger Amount', 'Transaction Amount'));
    }
    return map;
}

function buildRazorpayLookup(rows) {
    const map = {};
    for (const row of rows) {
        const orderNo = normalizeOrderNum(getCol(row, 'Order ID', 'order_receipt'));
        if (!orderNo) continue;
        if (!map[orderNo]) {
            map[orderNo] = {
                settlement_date: safeDate(getCol(row, 'settled_at', 'Settlement Date')),
                settlement_amount: 0
            };
        }
        map[orderNo].settlement_amount += safeNum(getCol(row, 'Settlement amount', 'credit'));
    }
    return map;
}

// ── Workbook styling helpers ──────────────────────────────────────────────────

function styleHeader(row, argb = 'FF1E3A5F') {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb } };
    row.alignment = { vertical: 'middle' };
}

// ── Main Processor ────────────────────────────────────────────────────────────

/**
 * @param {object[]} gstJson         Export-Tally GST Report rows
 * @param {object[]} returnGSTJson   Return GST Report rows
 * @param {object[]} salesOrderJson  Sales Order Combined Report rows
 * @param {object}   gatewayData     { 'Razorpay': [...], 'Snapmint': [...], 'BharatX': [...] }
 * @param {object}   logisticsData   { 'Ekart': [...], 'Delhivery': [...], 'Xpressbees': [...] }
 * @param {string}   brandName
 * @param {string}   period
 */
async function orderCycleShopifyProcessor(
    gstJson = [],
    returnGSTJson = [],
    salesOrderJson = [],
    gatewayData = {},
    logisticsData = {},
    brandName = '',
    period = ''
) {
    console.log(`\n[OrderCycleProcessor] ── brand="${brandName}", period="${period}" ──`);

    const parseStats = {
        gstReport: gstJson.length,
        returnGST: returnGSTJson.length,
        salesOrder: salesOrderJson.length,
        gateways: Object.fromEntries(Object.entries(gatewayData).map(([k, v]) => [k, v.length])),
        logistics: Object.fromEntries(Object.entries(logisticsData).map(([k, v]) => [k, v.length]))
    };

    // ── STEP 1: Build master from GST Report ──────────────────────────────────
    // Primary key = Invoice Number; fallback = SaleOrderNumber_AWB
    const masterMap = {};
    const duplicateInvoices = [];

    for (const row of gstJson) {
        const invoiceNo = safeStr(getCol(row, 'Invoice number', 'Invoice Number', 'Invoice No'));
        const saleOrderNo = normalizeOrderNum(getCol(row, 'Sale Order Number', 'Order ID', 'Order Number'));
        const awbNo = normalizeAWB(getCol(row, 'AWB num', 'AWB Number', 'AWB', 'Tracking Number'));

        const key = invoiceNo || (saleOrderNo && awbNo ? `${saleOrderNo}_${awbNo}` : saleOrderNo);
        if (!key) continue;

        if (!masterMap[key]) {
            masterMap[key] = {
                sale_order_number: saleOrderNo,
                shopify: safeStr(getCol(row, 'Channel Ledger', 'Channel', 'Platform', 'Shopify')),
                invoice_number: invoiceNo,
                awb_number: awbNo,
                shipping_partner: safeStr(getCol(row, 'Shipping Provider', 'Shipping Partner', 'Courier')),
                dispatch_date: safeDate(getCol(row, 'Dispatch Date/Cancellation Date', 'Date', 'Dispatch Date', 'Invoice Date')),
                sales_amount: 0,
                // Step 2
                return_date: null, srn: '', return_amount: 0, net_amount: 0,
                // Step 3
                delivery_status: null,
                // Steps 4-6 (logistics)
                ekart_remittance_date: null, ekart_actual_remittance_date: null, ekart_cod_amount: 0,
                delhivery_delivery_date: null, delhivery_cod_amount: 0,
                xpressbees_delivery_date: null, xpressbees_transaction_date: null, xpressbees_net_payment: 0,
                // Steps 7-9 (gateways)
                snapmint_settlement_date: null, snapmint_settlement_amount: 0,
                bharatx_settlement_date: null, bharatx_settlement_amount: 0,
                razorpay_settlement_date: null, razorpay_settlement_amount: 0,
                // Steps 10-12
                total_settlement_received: 0, balance_amount_receivable: 0, reconciliation_status: ''
            };
        } else if (invoiceNo) {
            // Same invoice key already exists — duplicate invoice number
            duplicateInvoices.push(invoiceNo);
        }

        masterMap[key].sales_amount += safeNum(getCol(row, 'Total', 'Sales Amount', 'Amount'));
    }

    const masterRows = Object.values(masterMap);
    console.log(`[OrderCycleProcessor] Step 1: ${masterRows.length} invoices from ${gstJson.length} GST rows`);

    // ── STEP 2: Return information ────────────────────────────────────────────
    const returnLookup = buildReturnLookup(returnGSTJson);
    for (const row of masterRows) {
        const ret = returnLookup[row.sale_order_number];
        if (ret) {
            row.return_date = ret.return_date;
            row.srn = ret.srn;
            row.return_amount = ret.return_amount;
        }
        row.net_amount = row.sales_amount - row.return_amount;
    }

    // ── STEP 3: Delivery Status ───────────────────────────────────────────────
    const salesOrderLookup = buildSalesOrderLookup(salesOrderJson);
    for (const row of masterRows) {
        const status = salesOrderLookup[row.sale_order_number];
        if (status) row.delivery_status = status;
    }

    // ── STEPS 4-6: Logistics settlements ─────────────────────────────────────
    const logisticsTyped = collectPartnerRows(logisticsData,
        { ekart: 'ekart', delhivery: 'delhivery', xpressbees: 'xpressbees', xpress: 'xpressbees' },
        detectLogisticsType
    );

    const ekartLookup = buildEkartLookup(logisticsTyped.ekart || []);
    const delhiveryLookup = buildDelhiveryLookup(logisticsTyped.delhivery || []);
    const xpressbeesLookup = buildXpressbeesLookup(logisticsTyped.xpressbees || []);

    for (const row of masterRows) {
        const awb = row.awb_number;
        if (!awb) continue;

        const e = ekartLookup[awb];
        if (e) {
            row.ekart_remittance_date = e.remittance_date;
            row.ekart_actual_remittance_date = e.actual_remittance_date;
            row.ekart_cod_amount = e.cod_amount;
        }

        const d = delhiveryLookup[awb];
        if (d) {
            row.delhivery_delivery_date = d.delivery_date;
            row.delhivery_cod_amount = d.cod_amount;
        }

        const x = xpressbeesLookup[awb];
        if (x) {
            row.xpressbees_delivery_date = x.delivery_date;
            row.xpressbees_transaction_date = x.transaction_date;
            row.xpressbees_net_payment = x.net_payment;
        }
    }

    // ── STEPS 7-9: Gateway settlements ───────────────────────────────────────
    const gatewayTyped = collectPartnerRows(gatewayData,
        { snapmint: 'snapmint', bharatx: 'bharatx', bharat: 'bharatx', razorpay: 'razorpay' },
        detectGatewayType
    );

    const snapmintLookup = buildSnapmintLookup(gatewayTyped.snapmint || []);
    const bharatxLookup = buildBharatXLookup(gatewayTyped.bharatx || []);
    const razorpayLookup = buildRazorpayLookup(gatewayTyped.razorpay || []);

    for (const row of masterRows) {
        const orderNo = row.sale_order_number;
        if (!orderNo) continue;

        const s = snapmintLookup[orderNo];
        if (s) { row.snapmint_settlement_date = s.settlement_date; row.snapmint_settlement_amount = s.settlement_amount; }

        const b = bharatxLookup[orderNo];
        if (b) { row.bharatx_settlement_date = b.settlement_date; row.bharatx_settlement_amount = b.settlement_amount; }

        const rp = razorpayLookup[orderNo];
        if (rp) { row.razorpay_settlement_date = rp.settlement_date; row.razorpay_settlement_amount = rp.settlement_amount; }
    }

    // ── STEP 10: Total Settlement Received ────────────────────────────────────
    for (const row of masterRows) {
        row.total_settlement_received =
            row.ekart_cod_amount +
            row.delhivery_cod_amount +
            row.xpressbees_net_payment +
            row.snapmint_settlement_amount +
            row.bharatx_settlement_amount +
            row.razorpay_settlement_amount;
    }

    // ── STEP 11: Balance Amount Receivable ────────────────────────────────────
    for (const row of masterRows) {
        row.balance_amount_receivable = row.net_amount - row.total_settlement_received;
    }

    // ── STEP 12: Reconciliation Status ───────────────────────────────────────
    for (const row of masterRows) {
        if (row.delivery_status === 'RTO') {
            row.reconciliation_status = 'RTO';
        } else if (row.delivery_status === 'CANCELLED') {
            row.reconciliation_status = 'CANCELLED';
        } else if (Math.abs(row.balance_amount_receivable) < 0.01) {
            row.reconciliation_status = 'RECONCILED';
        } else if (row.balance_amount_receivable > 0) {
            row.reconciliation_status = 'PENDING RECEIVABLE';
        } else {
            row.reconciliation_status = 'OVERPAID / INVESTIGATE';
        }
    }

    // ── STEPS 13-14: Validations & Exceptions ────────────────────────────────
    const exceptions = [];
    const validations = [];

    // V1: Total Sales Amount
    const totalSales = masterRows.reduce((s, r) => s + r.sales_amount, 0);
    validations.push({ check: 'Total Sales Amount', value: totalSales.toFixed(2), status: 'INFO' });

    // V2: Net Amount integrity
    const netMismatch = masterRows.filter(r => Math.abs((r.sales_amount - r.return_amount) - r.net_amount) > 0.01).length;
    validations.push({ check: 'Net Amount Integrity', value: netMismatch, status: netMismatch === 0 ? 'PASS' : 'FAIL' });

    // V3: Duplicate invoices
    duplicateInvoices.forEach(inv =>
        exceptions.push({ type: 'Duplicate Invoice', reference: inv, detail: 'Multiple GST rows share this invoice number' })
    );
    validations.push({ check: 'Duplicate Invoices', value: duplicateInvoices.length, status: duplicateInvoices.length === 0 ? 'PASS' : 'FAIL' });

    // V4 Duplicate AWBs in master
    const awbCount = {};
    masterRows.forEach(r => { if (r.awb_number) awbCount[r.awb_number] = (awbCount[r.awb_number] || 0) + 1; });
    Object.entries(awbCount).filter(([, c]) => c > 1).forEach(([awb]) =>
        exceptions.push({ type: 'Duplicate AWB', reference: awb, detail: 'Multiple invoices share this AWB' })
    );

    // V5: Settlement without sales record (gateway order numbers not in master)
    const masterOrderNos = new Set(masterRows.map(r => r.sale_order_number).filter(Boolean));
    const masterAWBs = new Set(masterRows.map(r => r.awb_number).filter(Boolean));

    [...new Set([...Object.keys(snapmintLookup), ...Object.keys(bharatxLookup), ...Object.keys(razorpayLookup)])]
        .filter(o => o && !masterOrderNos.has(o))
        .forEach(o => exceptions.push({ type: 'Settlement Without Sales Record', reference: o, detail: 'Gateway order not found in GST report' }));

    [...new Set([...Object.keys(ekartLookup), ...Object.keys(delhiveryLookup), ...Object.keys(xpressbeesLookup)])]
        .filter(a => a && !masterAWBs.has(a))
        .forEach(a => exceptions.push({ type: 'Missing AWB Match', reference: a, detail: 'Logistics AWB not found in GST report' }));

    // Negative settlement amounts
    masterRows.filter(r => r.total_settlement_received < -0.01).forEach(r =>
        exceptions.push({ type: 'Negative Settlement Amount', reference: r.invoice_number || r.sale_order_number, detail: `Settlement: ${r.total_settlement_received.toFixed(2)}` })
    );

    // Overpaid orders
    masterRows.filter(r => r.balance_amount_receivable < -0.01).forEach(r =>
        exceptions.push({ type: 'Overpaid Order', reference: r.invoice_number || r.sale_order_number, detail: `Balance: ${r.balance_amount_receivable.toFixed(2)}` })
    );

    validations.push({ check: 'Settlement Without Sales Record', value: exceptions.filter(e => e.type === 'Settlement Without Sales Record').length, status: 'INFO' });
    validations.push({ check: 'Missing AWB Matches', value: exceptions.filter(e => e.type === 'Missing AWB Match').length, status: 'INFO' });
    validations.push({ check: 'Overpaid Orders', value: masterRows.filter(r => r.balance_amount_receivable < -0.01).length, status: 'INFO' });
    validations.push({ check: 'RTO Orders', value: masterRows.filter(r => r.reconciliation_status === 'RTO').length, status: 'INFO' });
    validations.push({ check: 'Reconciled Orders', value: masterRows.filter(r => r.reconciliation_status === 'RECONCILED').length, status: 'INFO' });
    validations.push({ check: 'Pending Receivable', value: masterRows.filter(r => r.reconciliation_status === 'PENDING RECEIVABLE').length, status: 'INFO' });
    validations.push({ check: 'Total Output Rows', value: masterRows.length, status: 'INFO' });

    // ── Build Output Workbook ─────────────────────────────────────────────────
    const outputWorkbook = new XLSX.Workbook();
    outputWorkbook.creator = 'Colonel Automation';
    outputWorkbook.created = new Date();

    // ── Sheet 1: Reconciliation Report ───────────────────────────────────────
    const HEADERS = [
        'Sale Order Number', 'Shopify', 'Invoice Number', 'AWB Number', 'Shipping Partner',
        'Dispatch Date / Cancellation Date', 'Sales Amount',
        'Return Date', 'SRN', 'Return Amount', 'Net Amount', 'Delivery Status',
        'Ekart Remittance Date', 'Ekart Actual Remittance Date', 'Ekart COD Amount',
        'Delhivery Delivery Date', 'Delhivery COD Amount',
        'Xpressbees Delivery Date', 'Xpressbees Transaction Date', 'Xpressbees Net Payment',
        'Snapmint Settlement Date', 'Snapmint Settlement Amount',
        'BharatX Settlement Date', 'BharatX Settlement Amount',
        'Razorpay Settlement Date', 'Razorpay Settlement Amount',
        'Total Settlement Received', 'Balance Amount Receivable', 'Reconciliation Status'
    ];

    const mainSheet = outputWorkbook.addWorksheet('Reconciliation Report');
    mainSheet.addRow(HEADERS);
    styleHeader(mainSheet.getRow(1));

    const STATUS_COLORS = {
        'RECONCILED': 'FF92D050',
        'PENDING RECEIVABLE': 'FFFFC000',
        'OVERPAID / INVESTIGATE': 'FFFF4444',
        'RTO': 'FFFFAA00',
        'CANCELLED': 'FFBFBFBF'
    };

    for (const r of masterRows) {
        const rowData = [
            r.sale_order_number, r.shopify, r.invoice_number, r.awb_number, r.shipping_partner,
            r.dispatch_date, r.sales_amount,
            r.return_date, r.srn, r.return_amount || '', r.net_amount,
            r.delivery_status,
            r.ekart_remittance_date, r.ekart_actual_remittance_date, r.ekart_cod_amount || '',
            r.delhivery_delivery_date, r.delhivery_cod_amount || '',
            r.xpressbees_delivery_date, r.xpressbees_transaction_date, r.xpressbees_net_payment || '',
            r.snapmint_settlement_date, r.snapmint_settlement_amount || '',
            r.bharatx_settlement_date, r.bharatx_settlement_amount || '',
            r.razorpay_settlement_date, r.razorpay_settlement_amount || '',
            r.total_settlement_received, r.balance_amount_receivable, r.reconciliation_status
        ];
        const exRow = mainSheet.addRow(rowData);
        const color = STATUS_COLORS[r.reconciliation_status];
        if (color) {
            exRow.getCell(29).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
        }
    }

    // Column widths & formats
    const colMeta = [
        18, 20, 22, 22, 20, // A-E
        22, 16,              // F-G (date, amount)
        18, 20, 16, 16, 20, // H-L
        22, 26, 16,          // M-O (Ekart)
        22, 16,              // P-Q (Delhivery)
        22, 24, 16,          // R-T (Xpressbees)
        22, 16,              // U-V (Snapmint)
        22, 16,              // W-X (BharatX)
        22, 16,              // Y-Z (Razorpay)
        20, 24, 24           // AA-AC
    ];
    mainSheet.columns.forEach((col, i) => { col.width = colMeta[i] || 18; });

    // Date format for date columns (1-based indices)
    [6, 8, 13, 14, 16, 18, 19, 21, 23, 25].forEach(idx =>
        mainSheet.getColumn(idx).numFmt = 'dd-mmm-yyyy'
    );
    // Number format for amount columns
    [7, 10, 11, 15, 17, 20, 22, 24, 26, 27, 28].forEach(idx =>
        mainSheet.getColumn(idx).numFmt = '#,##0.00'
    );

    // ── Sheet 2: Exceptions ───────────────────────────────────────────────────
    const excSheet = outputWorkbook.addWorksheet('Exceptions');
    excSheet.addRow(['Exception Type', 'Reference', 'Detail']);
    styleHeader(excSheet.getRow(1), 'FFC0392B');
    exceptions.forEach(e => excSheet.addRow([e.type, e.reference, e.detail]));
    excSheet.columns = [{ width: 36 }, { width: 30 }, { width: 55 }];

    // ── Sheet 3: Validation Summary ───────────────────────────────────────────
    const valSheet = outputWorkbook.addWorksheet('Validation Summary');
    valSheet.addRow(['Validation Check', 'Value', 'Status']);
    styleHeader(valSheet.getRow(1), 'FF1F497D');
    validations.forEach(v => {
        const row = valSheet.addRow([v.check, v.value, v.status]);
        if (v.status === 'PASS') row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF92D050' } };
        if (v.status === 'FAIL') row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF4444' } };
    });
    valSheet.columns = [{ width: 36 }, { width: 20 }, { width: 16 }];

    console.log(`[OrderCycleProcessor] ── Done: ${masterRows.length} rows, ${exceptions.length} exceptions ──\n`);

    return {
        outputWorkbook,
        summaryRows: masterRows,
        rowCount: masterRows.length,
        parseStats
    };
}

module.exports = { orderCycleShopifyProcessor, parseExcelBuffer };
