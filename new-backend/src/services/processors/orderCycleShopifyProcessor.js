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
 *  Output: 25 columns matching Order Cycle.xlsx reference format
 *    + Razorpay cols (date + amount) after BharatX
 * ============================================================
 */

'use strict';
const XLSX = require('exceljs');
const { PassThrough } = require('stream');

// ── Utility helpers ───────────────────────────────────────────────────────────

// Unwrap ExcelJS formula cell objects: {formula: '...', result: <value>} → <value>
function unwrap(v) {
    if (typeof v === 'object' && v !== null && !(v instanceof Date) && 'result' in v) return v.result;
    return v;
}

function safeStr(v) {
    v = unwrap(v);
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString();
    return String(v).trim();
}

function safeNum(v) {
    v = unwrap(v);
    if (v === null || v === undefined || v === '') return 0;
    const s = String(v).replace(/[,\s₹$%]/g, '');
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
}

function safeDate(v) {
    v = unwrap(v);
    if (!v) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;

    // Excel serial date numbers (roughly year 2010–2040 → serial 40179–73050)
    if (typeof v === 'number' && v > 40000 && v < 80000) {
        // Excel epoch = 1 Jan 1900 (with a leap-year-1900 bug, serial 60 treated as Feb 29 1900)
        // Unix epoch = 1 Jan 1970 = Excel serial 25569
        const ms = (v - 25569) * 86400 * 1000;
        const d = new Date(ms);
        return isNaN(d.getTime()) ? null : d;
    }

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
        let v = unwrap(row[name]); // unwrap formula cells before checking
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
    if (['DELIVERED', 'DLDELIVERED', 'SHIPMENTDELIVERED', 'FULFILLED'].includes(upper)) return 'DELIVERED';
    if (['RTO', 'DLRTO'].includes(upper)) return 'RTO';
    if (['CANCELLED', 'CANCELED'].includes(upper)) return 'CANCELLED';
    if (upper === 'UNFULFILLED') return null; // not yet delivered — no status
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

// The Return GST Report carries one row per returned SKU, each tagged with the
// *original* invoice it's returning (column "Original Invoice No" — distinct from
// "Invoice number", which is the SRN/credit-note's own number) and that invoice's
// AWB. An order split across several invoices/AWBs gets one Return GST row per
// original invoice, so matching on Original Invoice No (AWB as fallback for rows
// that lack it) — the same precedence reco-engine/recon/receivable_cycle.py's
// parse_srn uses — resolves each return to the correct invoice without ever
// needing to sum entries across different invoices of the same order.
//
// Original Invoice No strings can collide across genuinely unrelated returns
// (verified case: one invoice number pulled in 3 SRNs worth 3.6x its own sale
// amount). Grouping alone can't tell a real multi-SKU/multi-tranche return
// apart from an accidental collision, so this only buckets raw candidates —
// the Step 2 matching loop cross-validates each candidate's own AWB/Channel
// against the invoice it's about to be attributed to before summing it in.
function buildReturnLookup(rows) {
    const byInvoice = {};
    const byAwb = {};
    for (const row of rows) {
        const origInvoice = safeStr(getCol(row, 'Original Invoice No', 'Original Invoice No.1', 'Original Invoice Number'));
        const awb = normalizeAWB(getCol(row, 'AWB num', 'AWB Number', 'AWB', 'Tracking Number'));
        if (!origInvoice && !awb) continue;

        const candidate = {
            srn: safeStr(getCol(row, 'Invoice number', 'Invoice Number', 'SRN')),
            amount: safeNum(getCol(row, 'Total', 'Return Amount', 'Net Amount')),
            date: safeDate(getCol(row, 'Date', 'Return Date')),
            channel: safeStr(getCol(row, 'Channel Ledger', 'Channel entry', 'Channel')),
            awb,
        };

        // Match key precedence mirrors the row itself: invoice number when present,
        // AWB only as a fallback for rows that don't carry an original invoice no.
        const bucket = origInvoice ? byInvoice : byAwb;
        const key = origInvoice || awb;
        (bucket[key] ||= []).push(candidate);
    }
    return { byInvoice, byAwb };
}

// A return candidate only genuinely belongs to `row` if the factors it carries
// that CAN be cross-checked actually agree — AWB (the shipment the return
// physically came back on) and Channel (the marketplace/store the sale was
// made on). A candidate missing one of those fields isn't contradicted by it,
// so it's neither accepted nor rejected on that factor alone.
function returnCandidateMatches(candidate, row) {
    const awbOk = !candidate.awb || !row.awb_number || candidate.awb === row.awb_number;
    const channelOk = !candidate.channel || !row.shopify || candidate.channel.toUpperCase() === row.shopify.toUpperCase();
    return awbOk && channelOk;
}

function buildSalesOrderLookup(rows) {
    const map = {};
    for (const row of rows) {
        // Combined SO uses "Order No" (col 1 = numeric Shopify order number)
        const orderNo = normalizeOrderNum(
            getCol(row, 'Order No', 'Sale Order Number', 'Order Number', 'Order ID', 'SaleOrderNumber')
        );
        if (!orderNo) continue;
        const raw = getCol(row, 'Fulfillment Status', 'Delivery Status', 'Status', 'Order Status',
            'Delivery Status Description', 'delivery_status');
        const normalized = normalizeDeliveryStatus(raw);

        // Also treat orders with a valid "Cancelled at" date as cancelled
        const cancelledAt = safeDate(getCol(row, 'Cancelled at', 'Cancelled At', 'cancelled_at'));
        const status = cancelledAt ? 'CANCELLED' : normalized;

        if (status) map[orderNo] = status;
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

// Shopify Order No. (like Sale Order Number in the Tally files) is reused across
// unrelated transactions over time, including inside the gateway's own file — the
// same order number can carry a completely different customer's loan months apart.
// Every candidate keeps the gateway's own gross order value alongside the settlement
// so the caller (Step 7-9) can verify it actually belongs to the invoice it's about
// to be attributed to, instead of trusting the order number alone.
function buildSnapmintLookup(rows) {
    const byOrder = {};
    for (const row of rows) {
        // Second "Shopify Order No." column is renamed to "Shopify Order No._2" by deduplication
        const orderNo = normalizeOrderNum(
            getCol(row, 'Shopify Order No._2', 'Shopify Order No.', 'Sale Order Number', 'Order No.')
        );
        if (!orderNo) continue;
        (byOrder[orderNo] ||= []).push({
            order_value: safeNum(getCol(row, 'Order value')),
            settlement_date: safeDate(getCol(row, 'Merchant Settlement Date', 'Settlement Date', 'settled_at')),
            settlement_amount: safeNum(getCol(row, 'Settlement Value', 'Amount')),
        });
    }
    return byOrder;
}

function buildBharatXLookup(rows) {
    // A single BharatX loan spans several ledger rows (TRANSACTION, TRANSACTION_MDR,
    // TRANSACTION_REFUND, ...) sharing one Merchant Transaction Id — group those first
    // so each transaction becomes one candidate, not one candidate per ledger line.
    const byTxn = {};
    for (const row of rows) {
        // "Order id by Vlook" = numeric Shopify order number; "Merchant Transaction Id" = receipt hash
        const orderNo = normalizeOrderNum(getCol(row, 'Order id by Vlook', 'Order ID'));
        if (!orderNo) continue;
        const txnId = safeStr(getCol(row, 'Merchant Transaction Id'));
        const key = `${orderNo}|${txnId}`;
        if (!byTxn[key]) {
            byTxn[key] = {
                order_no: orderNo,
                order_value: safeNum(getCol(row, 'Transaction Amount')),
                // Settlement Timestamp = payout date; Ledger Timestamp = transaction date (earlier)
                settlement_date: safeDate(getCol(row, 'Settlement Timestamp', 'Ledger Timestamp')),
                settlement_amount: 0,
            };
        }
        // Ledger Amount: positive for TRANSACTION rows, negative for TRANSACTION_MDR (fee deductions)
        // Summing all lines of the SAME transaction gives its net settlement received
        byTxn[key].settlement_amount += safeNum(getCol(row, 'Ledger Amount'));
    }
    const byOrder = {};
    for (const t of Object.values(byTxn)) {
        (byOrder[t.order_no] ||= []).push({
            order_value: t.order_value,
            settlement_date: t.settlement_date,
            settlement_amount: t.settlement_amount,
        });
    }
    return byOrder;
}

// A gateway file's "order number" match is only trustworthy once its own gross order
// value corresponds to the specific invoice it's being attributed to — validated against
// real data: genuine matches sit at essentially exactly 1.00x, unrelated transactions that
// happen to share a recycled order number land far outside this band (0.5x, 11x, 28x...).
function amountsCorrespond(orderValue, invoiceAmount) {
    if (!orderValue || !invoiceAmount) return false;
    return Math.abs(orderValue - invoiceAmount) <= Math.max(5, invoiceAmount * 0.02);
}

// Assigns each gateway candidate to at most one invoice under this order number.
// Must run per-order (not per-invoice in isolation): when two invoices under the
// same order happen to share an amount (verified case: order 252066, two invoices
// both ₹6,320.6), checking each invoice independently against the same candidate
// lets BOTH pass and both get the same settlement — the same double-attribution
// bug this is meant to fix, just via amount instead of order number. Resolving all
// of an order's invoices against all of its candidates together, and removing a
// candidate from the pool once assigned, is what actually prevents that.
function assignGatewayCandidates(rowsForOrder, candidates, apply, gatewayName, issues) {
    if (!candidates || !candidates.length) return;
    const claimed = new Set();
    for (const candidate of candidates) {
        const matches = rowsForOrder.filter(row => !claimed.has(row) && amountsCorrespond(candidate.order_value, row.sales_amount));
        if (matches.length === 1) {
            claimed.add(matches[0]);
            apply(matches[0], candidate);
        } else if (matches.length === 0) {
            issues.push({ gateway: gatewayName, orderNo: rowsForOrder[0].sale_order_number, reason: 'no-amount-match', invoice: null });
        } else {
            matches.forEach(row => issues.push({ gateway: gatewayName, orderNo: row.sale_order_number, reason: 'ambiguous', invoice: row.invoice_number }));
        }
    }
}

/**
 * Build a map from Razorpay receipt hash → Shopify order number
 * using the Combined SO "Payment References" column as the bridge.
 * Combined SO col "Payment References" contains the same receipt hash as Razorpay's "order_receipt".
 */
function buildPaymentRefLookup(salesOrderRows) {
    const map = {};
    for (const row of salesOrderRows) {
        // "Payment References" (col ~74) contains the Razorpay receipt hash for prepaid orders
        const ref = safeStr(getCol(row, 'Payment References', 'Payment ID'));
        if (!ref || ref.length < 10 || !isNaN(parseFloat(ref))) continue;
        const orderNo = normalizeOrderNum(getCol(row, 'Order No', 'Order No_2', 'Order Number'));
        if (ref && orderNo) map[ref] = orderNo;
    }
    return map;
}

/**
 * Build Razorpay settlement lookup.
 * Joins via: Razorpay.order_receipt → Combined SO.Payment References → Combined SO.Order No
 * Only processes rows with type = 'payment' (individual order settlements).
 */
function buildRazorpayLookup(rows, paymentRefLookup = {}) {
    const map = {};
    for (const row of rows) {
        // Only process individual payment rows (not refunds, adjustments, or settlement summaries)
        const type = safeStr(getCol(row, 'type', 'Type', 'entity_type')).toLowerCase();
        if (type && type !== 'payment') continue;

        // order_receipt = Shopify payment receipt hash (matches Combined SO "Payment References")
        const receipt = safeStr(getCol(row, 'order_receipt', 'Order Receipt'));
        if (!receipt) continue;

        const orderNo = paymentRefLookup[receipt];
        if (!orderNo) continue; // Cannot link to an order without the Combined SO bridge

        // "credit" = amount settled into merchant account for this payment
        const credit = safeNum(getCol(row, 'credit', 'Credit', 'amount', 'Amount'));
        if (credit <= 0) continue;

        if (!map[orderNo]) {
            map[orderNo] = {
                settlement_date: safeDate(getCol(row, 'settled_at', 'Settlement Date', 'settlement_date')),
                settlement_amount: 0
            };
        }
        map[orderNo].settlement_amount += credit;
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
 * @param {string}   period          e.g. "Oct-2024" or "10-2024"
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
                // Step 3 (internal — not in output sheet but stored in DB for dashboard)
                delivery_status: null,
                // Steps 4-6 (logistics)
                ekart_remittance_date: null, ekart_actual_remittance_date: null, ekart_cod_amount: 0,
                delhivery_delivery_date: null, delhivery_cod_amount: 0,
                xpressbees_delivery_date: null, xpressbees_transaction_date: null, xpressbees_net_payment: 0,
                // Steps 7-9 (gateways)
                snapmint_settlement_date: null, snapmint_settlement_amount: 0,
                bharatx_settlement_date: null, bharatx_settlement_amount: 0,
                razorpay_settlement_date: null, razorpay_settlement_amount: 0,
                // Steps 10-12 (internal — not in output sheet but stored in DB for dashboard)
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
    // Match precedence: Original Invoice No first, AWB as fallback — never Sale Order
    // Number, since one order can have several invoices/AWBs and matching on the order
    // alone would apply one invoice's return to every invoice under that order.
    const { byInvoice: returnByInvoice, byAwb: returnByAwb } = buildReturnLookup(returnGSTJson);
    const claimedInvoices = new Set();
    const claimedAwbs = new Set();
    // A candidate sharing this invoice's Original Invoice No / AWB key but whose OWN
    // AWB or Channel contradicts this invoice's is excluded from its return amount/SRN
    // — its Original Invoice No collided with an unrelated return, it doesn't belong here.
    const returnMismatches = [];

    for (const row of masterRows) {
        let candidates = null;
        if (row.invoice_number && returnByInvoice[row.invoice_number]) {
            candidates = returnByInvoice[row.invoice_number];
            claimedInvoices.add(row.invoice_number);
        } else if (row.awb_number && returnByAwb[row.awb_number]) {
            candidates = returnByAwb[row.awb_number];
            claimedAwbs.add(row.awb_number);
        }

        if (candidates) {
            const accepted = candidates.filter(c => returnCandidateMatches(c, row));
            const rejected = candidates.filter(c => !returnCandidateMatches(c, row));

            if (accepted.length) {
                row.return_date = (accepted.find(c => c.date) || {}).date || null;
                row.srn = [...new Set(accepted.map(c => c.srn).filter(Boolean))].join(', ');
                row.return_amount = accepted.reduce((s, c) => s + c.amount, 0);
            }
            rejected.forEach(c => returnMismatches.push({
                invoice: row.invoice_number, expectedAwb: row.awb_number, expectedChannel: row.shopify,
                candidateAwb: c.awb, candidateChannel: c.channel, srn: c.srn, amount: c.amount,
            }));
        }
        row.net_amount = row.sales_amount - row.return_amount;
    }

    // Return entries that never matched any invoice/AWB in the GST report would
    // otherwise be silently dropped — flag them instead.
    const sumCandidates = (list) => ({
        srn: [...new Set(list.map(c => c.srn).filter(Boolean))].join(', '),
        amount: list.reduce((s, c) => s + c.amount, 0),
    });
    const unmatchedReturns = [
        ...Object.entries(returnByInvoice).filter(([inv]) => !claimedInvoices.has(inv))
            .map(([inv, list]) => ({ key: `Invoice ${inv}`, ...sumCandidates(list) })),
        ...Object.entries(returnByAwb).filter(([awb]) => !claimedAwbs.has(awb))
            .map(([awb, list]) => ({ key: `AWB ${awb}`, ...sumCandidates(list) })),
    ];

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

    // Razorpay joins via Combined SO: order_receipt → Payment References → Order No
    const paymentRefLookup = buildPaymentRefLookup(salesOrderJson);
    const razorpayLookup = buildRazorpayLookup(gatewayTyped.razorpay || [], paymentRefLookup);

    // Sale Order Number is reused across unrelated invoices/transactions — including
    // inside the gateway files themselves — so a matching order number alone doesn't
    // prove a settlement belongs to this invoice. Snapmint/BharatX candidates are
    // additionally validated against their own gross order value before attribution.
    // Razorpay's receipt-hash bridge rules out colliding with an UNRELATED order, but
    // it doesn't rule out the order legitimately having more than one invoice (split
    // fulfillment) — applying the one Razorpay payment to every invoice under that
    // order (instead of just the one it actually paid for) double- or triple-counts
    // the same cash received, which is what falsely pushes those invoices into
    // OVERPAID/INVESTIGATE ("more received" than was actually settled).
    const gatewayIssues = [];
    const masterByOrderForGateway = {};
    for (const row of masterRows) {
        if (row.sale_order_number) (masterByOrderForGateway[row.sale_order_number] ||= []).push(row);
    }

    for (const [orderNo, rowsForOrder] of Object.entries(masterByOrderForGateway)) {
        assignGatewayCandidates(rowsForOrder, snapmintLookup[orderNo],
            (row, c) => { row.snapmint_settlement_date = c.settlement_date; row.snapmint_settlement_amount = c.settlement_amount; },
            'Snapmint', gatewayIssues);
        assignGatewayCandidates(rowsForOrder, bharatxLookup[orderNo],
            (row, c) => { row.bharatx_settlement_date = c.settlement_date; row.bharatx_settlement_amount = c.settlement_amount; },
            'BharatX', gatewayIssues);

        const rp = razorpayLookup[orderNo];
        if (!rp) continue;
        if (rowsForOrder.length === 1) {
            // Only one invoice under this order — no ambiguity, attribute directly.
            rowsForOrder[0].razorpay_settlement_date = rp.settlement_date;
            rowsForOrder[0].razorpay_settlement_amount = rp.settlement_amount;
        } else {
            // Order split across multiple invoices — this single Razorpay payment
            // covers the whole order, so attribute it to whichever invoice's own
            // sales amount actually corresponds to it, same as Snapmint/BharatX,
            // instead of copying it onto every invoice under the order.
            assignGatewayCandidates(rowsForOrder, [{ order_value: rp.settlement_amount, settlement_date: rp.settlement_date, settlement_amount: rp.settlement_amount }],
                (row, c) => { row.razorpay_settlement_date = c.settlement_date; row.razorpay_settlement_amount = c.settlement_amount; },
                'Razorpay', gatewayIssues);
        }
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
    // Courier settlement files report COD amounts rounded to the nearest whole rupee,
    // so a genuinely fully-settled order can differ from its own (paise-precise) net
    // amount by up to ~₹1 with no real discrepancy — verified against this data: real
    // rounding noise tops out at ₹0.50, and the smallest genuine gap starts at ₹1.62.
    const RECONCILIATION_TOLERANCE = 1;
    for (const row of masterRows) {
        if (row.delivery_status === 'RTO') {
            row.reconciliation_status = 'RTO';
        } else if (row.delivery_status === 'CANCELLED') {
            row.reconciliation_status = 'CANCELLED';
        } else if (Math.abs(row.balance_amount_receivable) <= RECONCILIATION_TOLERANCE) {
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

    // V3b: Return entries with no matching invoice/AWB in the GST report
    unmatchedReturns.forEach(u => exceptions.push({
        type: 'Unmatched Return Entry',
        reference: u.key,
        detail: `SRN ${u.srn || '(none)'}, amount ${u.amount.toFixed(2)} — no matching invoice/AWB found in GST report`
    }));
    validations.push({ check: 'Unmatched Return Entries', value: unmatchedReturns.length, status: unmatchedReturns.length === 0 ? 'PASS' : 'FAIL' });

    // V3c: Return candidate that shared this invoice's Original Invoice No / AWB key
    // but whose own AWB or Channel contradicted it — excluded from the invoice's
    // return amount/SRN (its Original Invoice No collided with an unrelated return).
    returnMismatches.forEach(m => exceptions.push({
        type: 'Return Invoice/AWB Mismatch',
        reference: m.invoice,
        detail: `SRN ${m.srn || '(none)'} (amount ${m.amount.toFixed(2)}) shares this invoice's Original Invoice No but its own AWB "${m.candidateAwb || '(none)'}"/channel "${m.candidateChannel || '(none)'}" doesn't match the invoice's AWB "${m.expectedAwb || '(none)'}"/channel "${m.expectedChannel || '(none)'}" — excluded, likely belongs to a different return`
    }));
    validations.push({ check: 'Return Invoice/AWB Mismatches', value: returnMismatches.length, status: returnMismatches.length === 0 ? 'PASS' : 'FAIL' });

    // V4: Duplicate AWBs in master
    const awbCount = {};
    masterRows.forEach(r => { if (r.awb_number) awbCount[r.awb_number] = (awbCount[r.awb_number] || 0) + 1; });
    Object.entries(awbCount).filter(([, c]) => c > 1).forEach(([awb]) =>
        exceptions.push({ type: 'Duplicate AWB', reference: awb, detail: 'Multiple invoices share this AWB' })
    );

    // V5: Settlement without sales record
    const masterOrderNos = new Set(masterRows.map(r => r.sale_order_number).filter(Boolean));
    const masterAWBs = new Set(masterRows.map(r => r.awb_number).filter(Boolean));

    [...new Set([...Object.keys(snapmintLookup), ...Object.keys(bharatxLookup), ...Object.keys(razorpayLookup)])]
        .filter(o => o && !masterOrderNos.has(o))
        .forEach(o => exceptions.push({ type: 'Settlement Without Sales Record', reference: o, detail: 'Gateway order not found in GST report' }));

    [...new Set([...Object.keys(ekartLookup), ...Object.keys(delhiveryLookup), ...Object.keys(xpressbeesLookup)])]
        .filter(a => a && !masterAWBs.has(a))
        .forEach(a => exceptions.push({ type: 'Missing AWB Match', reference: a, detail: 'Logistics AWB not found in GST report' }));

    masterRows.filter(r => r.total_settlement_received < -0.01).forEach(r =>
        exceptions.push({ type: 'Negative Settlement Amount', reference: r.invoice_number || r.sale_order_number, detail: `Settlement: ${r.total_settlement_received.toFixed(2)}` })
    );

    // Derived from reconciliation_status (not re-thresholded here) so this never drifts
    // from Step 12's own rounding-tolerant classification.
    masterRows.filter(r => r.reconciliation_status === 'OVERPAID / INVESTIGATE').forEach(r =>
        exceptions.push({ type: 'Overpaid Order', reference: r.invoice_number || r.sale_order_number, detail: `Balance: ${r.balance_amount_receivable.toFixed(2)}` })
    );

    // V5b: Gateway candidates that matched this Sale Order Number but failed the order-value
    // check (a different transaction reusing the number) or tied with another invoice on it
    gatewayIssues.forEach(g => exceptions.push({
        type: g.reason === 'ambiguous' ? 'Ambiguous Gateway Settlement' : 'Gateway Order Value Mismatch',
        reference: g.invoice || g.orderNo,
        detail: g.reason === 'ambiguous'
            ? `${g.gateway}: more than one invoice under order ${g.orderNo} matches this settlement's order value — not auto-attributed`
            : `${g.gateway}: settlement found for order ${g.orderNo} but its order value doesn't match any invoice under that order — likely a different transaction reusing the order number`
    }));

    validations.push({ check: 'Settlement Without Sales Record', value: exceptions.filter(e => e.type === 'Settlement Without Sales Record').length, status: 'INFO' });
    validations.push({ check: 'Missing AWB Matches', value: exceptions.filter(e => e.type === 'Missing AWB Match').length, status: 'INFO' });
    validations.push({ check: 'Gateway Order Value Mismatches', value: gatewayIssues.filter(g => g.reason === 'no-amount-match').length, status: gatewayIssues.some(g => g.reason === 'no-amount-match') ? 'FAIL' : 'PASS' });
    validations.push({ check: 'Ambiguous Gateway Settlements', value: gatewayIssues.filter(g => g.reason === 'ambiguous').length, status: gatewayIssues.some(g => g.reason === 'ambiguous') ? 'FAIL' : 'PASS' });
    validations.push({ check: 'Overpaid Orders', value: masterRows.filter(r => r.reconciliation_status === 'OVERPAID / INVESTIGATE').length, status: 'INFO' });
    validations.push({ check: 'RTO Orders', value: masterRows.filter(r => r.reconciliation_status === 'RTO').length, status: 'INFO' });
    validations.push({ check: 'Reconciled Orders', value: masterRows.filter(r => r.reconciliation_status === 'RECONCILED').length, status: 'INFO' });
    validations.push({ check: 'Pending Receivable', value: masterRows.filter(r => r.reconciliation_status === 'PENDING RECEIVABLE').length, status: 'INFO' });
    validations.push({ check: 'Total Output Rows', value: masterRows.length, status: 'INFO' });

    // ── Build Output Workbook ─────────────────────────────────────────────────
    const outputWorkbook = new XLSX.Workbook();
    outputWorkbook.creator = 'Colonel Automation';
    outputWorkbook.created = new Date();

    // ── Sheet 1: Reconciliation Report ───────────────────────────────────────
    // 25 columns: matching Order Cycle.xlsx reference format + Razorpay cols after BharatX
    const HEADERS = [
        'Sale Order Number', 'Shopify', 'Invoice number', 'AWB num', 'Shipping partner',
        'Dispatch Date/Cancellation Date', 'Sum of Total',
        'Return Date', 'SRN', 'Return amount', 'Net amount',
        'Ekart remittance date', 'Ekart Actual Date of Remittance', 'Ekart COD amount',
        'Delhivery delivery date', 'Delhivery COD amount',
        'Xpressbees delivery date', 'Xpressbees transaction date', 'Xpressbees net payment',
        'Snapmint merchant settlement date', 'Snapmint settlement value',
        'BharatX settlement timestamp', 'BharatX ledger amount',
        'Razorpay settlement date', 'Razorpay settlement amount',
    ];

    // Source file labels for Row 0 (matches Order Cycle.xlsx reference format)
    const periodStr = String(period || '');
    const yearPart = periodStr.split('-').find(p => /^\d{4}$/.test(p)) || String(new Date().getFullYear());
    const year = parseInt(yearPart);
    // Determine FY: Indian FY runs April–March; if month >= April the FY started this year
    const monthPart = periodStr.split('-').find(p => /^\d{1,2}$/.test(p));
    const monthNum = monthPart ? parseInt(monthPart)
        : /^(oct|nov|dec)/i.test(periodStr) ? 10
        : /^(jul|aug|sep)/i.test(periodStr) ? 7
        : /^(apr|may|jun)/i.test(periodStr) ? 4
        : /^(jan|feb|mar)/i.test(periodStr) ? 1
        : 4;
    const fyStartYear = monthNum >= 4 ? year : year - 1;
    const fyLabel = `${String(fyStartYear).slice(-2)}-${String(fyStartYear + 1).slice(-2)}`;

    const SOURCE_ROW = [
        `Export-Tally GST Report 3.0 ${period}`, '', '', '', '', '', '',
        `Return GST Report ${period}`, '', '',
        '(G)-(J)',
        `Ekart settlement report - ${fyLabel}`, '', '',
        `Delhivery settlement report - ${fyLabel}`, '',
        `Xpressbees settlement report - ${fyLabel}`, '', '',
        `Snapmint settlement report - ${fyLabel}`, '',
        `BharatX settlement report - ${fyLabel}`, '',
        `Razorpay settlement report - ${fyLabel}`, '',
    ];

    const mainSheet = outputWorkbook.addWorksheet('Reconciliation Report');

    // Row 1: source file group labels
    const sourceRow = mainSheet.addRow(SOURCE_ROW);
    sourceRow.font = { italic: true, color: { argb: 'FF595959' } };
    sourceRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };

    // Row 2: column headers
    mainSheet.addRow(HEADERS);
    styleHeader(mainSheet.getRow(2));

    for (const r of masterRows) {
        const rowData = [
            r.sale_order_number, r.shopify, r.invoice_number, r.awb_number, r.shipping_partner,
            r.dispatch_date, r.sales_amount,
            r.return_date, r.srn, r.return_amount || '', r.net_amount,
            r.ekart_remittance_date, r.ekart_actual_remittance_date, r.ekart_cod_amount || '',
            r.delhivery_delivery_date, r.delhivery_cod_amount || '',
            r.xpressbees_delivery_date, r.xpressbees_transaction_date, r.xpressbees_net_payment || '',
            r.snapmint_settlement_date, r.snapmint_settlement_amount || '',
            r.bharatx_settlement_date, r.bharatx_settlement_amount || '',
            r.razorpay_settlement_date, r.razorpay_settlement_amount || '',
        ];
        mainSheet.addRow(rowData);
    }

    // Column widths (25 cols)
    const colMeta = [
        18, 20, 22, 22, 20, // A-E  (SaleOrderNo, Shopify, Invoice, AWB, ShippingPartner)
        22, 16,              // F-G  (DispatchDate, SumOfTotal)
        18, 20, 16, 16,      // H-K  (ReturnDate, SRN, ReturnAmt, NetAmt)
        22, 26, 16,          // L-N  (EkartRemitDate, EkartActualDate, EkartCOD)
        22, 16,              // O-P  (DelhiveryDate, DelhiveryCOD)
        22, 24, 16,          // Q-S  (XpressbeesDeliveryDate, XpressbeesTransDate, XpressbeesNetPay)
        22, 16,              // T-U  (SnapmintDate, SnapmintValue)
        22, 16,              // V-W  (BharatXTimestamp, BharatXLedger)
        22, 16               // X-Y  (RazorpayDate, RazorpayAmt)
    ];
    mainSheet.columns.forEach((col, i) => { col.width = colMeta[i] || 18; });

    // Date format for date columns (1-based, offset by 1 for the source row)
    // These are column indices in the sheet
    [6, 8, 12, 13, 15, 17, 18, 20, 22, 24].forEach(idx =>
        mainSheet.getColumn(idx).numFmt = 'dd-mmm-yyyy'
    );
    // Number format for amount columns
    [7, 10, 11, 14, 16, 19, 21, 23, 25].forEach(idx =>
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
