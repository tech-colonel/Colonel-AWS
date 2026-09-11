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
const eshopboxTracking = require('../eshopboxTracking');
const eshopboxCod = require('../eshopboxCod');
const returnPrimeExchanges = require('../returnPrimeExchanges');

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

/**
 * COD vs PREPAID, normalised from whatever the master file called it.
 *
 * Returns '' when the source said nothing — deliberately NOT a guess. A blank
 * is filled in Step 12b from evidence (courier COD collected / gateway settled)
 * and the remark says which, so the accountant can tell a stated payment type
 * from an inferred one.
 */
function normalizePaymentType(v) {
    const t = safeStr(v).toUpperCase().replace(/[^A-Z]/g, '');
    if (!t) return '';
    if (/^(COD|CASHONDELIVERY|CASHONDELIVERYCOD|PAYONDELIVERY)$/.test(t)) return 'COD';
    if (/^(PREPAID|PREPAY|ONLINE|PAID)$/.test(t)) return 'PREPAID';
    return safeStr(v).trim();
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
    // Cashfree settlement/recon rows are nested objects, not flat spreadsheet
    // rows — event_details/payment_details identify them unambiguously.
    if (f && f.event_details && f.payment_details) return 'cashfree';
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
        // "Order value" is the correct settled amount for Snapmint — Settlement
        // Value/Amount doesn't reliably reflect what was actually paid out.
        const orderValue = safeNum(getCol(row, 'Order value'));
        (byOrder[orderNo] ||= []).push({
            order_value: orderValue,
            settlement_date: safeDate(getCol(row, 'Merchant Settlement Date', 'Settlement Date', 'settled_at')),
            settlement_amount: orderValue,
        });
    }
    return byOrder;
}

function buildBharatXLookup(rows) {
    // A single BharatX loan spans several ledger rows (TRANSACTION, TRANSACTION_MDR,
    // TRANSACTION_REFUND, ...) sharing one Merchant Transaction Id and the same
    // "Transaction Amount" — group those first so each transaction becomes one
    // candidate, not one candidate per ledger line. "Transaction Amount" is the
    // correct settled amount; it's read once per transaction (not summed across
    // its ledger rows).
    const byTxn = {};
    for (const row of rows) {
        // "Order id by Vlook" = numeric Shopify order number; "Merchant Transaction Id" = receipt hash
        const orderNo = normalizeOrderNum(getCol(row, 'Order id by Vlook', 'Order ID'));
        if (!orderNo) continue;
        const txnId = safeStr(getCol(row, 'Merchant Transaction Id'));
        const key = `${orderNo}|${txnId}`;
        if (!byTxn[key]) {
            const transactionAmount = safeNum(getCol(row, 'Transaction Amount'));
            byTxn[key] = {
                order_no: orderNo,
                order_value: transactionAmount,
                // Settlement Timestamp = payout date; Ledger Timestamp = transaction date (earlier)
                settlement_date: safeDate(getCol(row, 'Settlement Timestamp', 'Ledger Timestamp')),
                settlement_amount: transactionAmount,
            };
        }
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
    const unresolved = [];
    for (const candidate of candidates) {
        const matches = rowsForOrder.filter(row => !claimed.has(row) && amountsCorrespond(candidate.order_value, row.sales_amount));
        if (matches.length === 1) {
            claimed.add(matches[0]);
            apply(matches[0], candidate);
        } else if (matches.length === 0) {
            unresolved.push(candidate);
        } else {
            matches.forEach(row => issues.push({ gateway: gatewayName, orderNo: row.sale_order_number, reason: 'ambiguous', invoice: row.invoice_number }));
        }
    }

    // A single settlement can legitimately cover an order that was split across
    // several invoices (e.g. partial shipment from two warehouses) — no single
    // invoice's own amount will correspond to the payment, but the SUM of the
    // order's still-unclaimed invoices will (verified case: order 266284, invoices
    // 12090.10 + 1014.42 = 13104.52, matching one Razorpay payment exactly). Split
    // the settlement across those invoices proportional to each one's own sales
    // amount so the total attributed matches what was actually received, instead
    // of leaving the whole order unmatched.
    for (const candidate of unresolved) {
        const unclaimedRows = rowsForOrder.filter(row => !claimed.has(row));
        const total = unclaimedRows.reduce((sum, row) => sum + row.sales_amount, 0);
        if (unclaimedRows.length > 1 && amountsCorrespond(candidate.order_value, total)) {
            for (const row of unclaimedRows) {
                claimed.add(row);
                const share = total > 0 ? row.sales_amount / total : 1 / unclaimedRows.length;
                apply(row, { settlement_date: candidate.settlement_date, settlement_amount: candidate.settlement_amount * share });
            }
        } else {
            issues.push({ gateway: gatewayName, orderNo: rowsForOrder[0].sale_order_number, reason: 'no-amount-match', invoice: null });
        }
    }
}

/**
 * Build a map from Razorpay receipt hash → Shopify order number
 * using the Combined SO "Payment References" column as the bridge.
 * Combined SO col "Payment References" contains the same receipt hash as Razorpay's "order_receipt".
 */
/**
 * Find which Sales Order column actually holds the gateway payment reference,
 * by intersecting each column's values with the references the gateway file
 * itself reports. Header-independent by design.
 *
 * WHY: the Combined SO export ships with its header row one column out of step
 * with its data from ~col 47 — `Cancelled at` holds payment methods, and the
 * receipt hash sits under `Payment Method` while the column actually named
 * `Payment References` is empty in every row. Measured on the 24-25 file:
 * 69,980 Razorpay receipts, 0 matched by name, 24,927 matched one column left.
 * That produced 52,178 "Settlement Without Sales Record" exceptions — 89% of
 * the entire report — and it failed silently, because an empty join key is
 * indistinguishable from a period with no settlements.
 *
 * A name lookup cannot survive that. Matching on content can: whichever column
 * contains the gateway's own receipts IS the reference column, whatever the
 * header calls it and however far the file has drifted.
 */
function detectPaymentRefColumn(salesOrderRows, knownRefs) {
    if (!knownRefs || !knownRefs.size || !salesOrderRows.length) return null;
    const sample = salesOrderRows.slice(0, 2000);
    const scores = {};
    for (const row of sample) {
        for (const key of Object.keys(row)) {
            const v = safeStr(row[key]);
            if (v.length < 8) continue;
            if (knownRefs.has(v)) scores[key] = (scores[key] || 0) + 1;
        }
    }
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    // Require a real signal, not one coincidental collision.
    if (!best || best[1] < 5) return null;
    console.log(`[OrderCycleProcessor] payment reference column detected by content: "${best[0]}" (${best[1]} of ${sample.length} sampled rows matched gateway receipts)`);
    return best[0];
}

function buildPaymentRefLookup(salesOrderRows, detectedKey = null) {
    const map = {};
    for (const row of salesOrderRows) {
        // "Payment References" (col ~74) contains the Razorpay receipt hash for prepaid orders
        // Prefer the column proven to contain the gateway's own receipts; fall
        // back to the documented header names when detection found nothing.
        const ref = safeStr(detectedKey ? row[detectedKey] : getCol(row, 'Payment References', 'Payment ID'));
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

/**
 * Map Cashfree cf_payment_id → Shopify order number.
 *
 * Deliberately NOT reusing buildPaymentRefLookup: that one rejects any ref where
 * `!isNaN(parseFloat(ref))`, which is correct for Razorpay's alphanumeric receipt
 * hashes but silently drops every Cashfree id, because those are pure numerics
 * (e.g. "6427749309"). Verified: 1,196 of 1,198 D'Chicha orders carry one.
 *
 * The reference arrives on the Sales Order rows as 'Payment References' — the
 * Shopify note attribute `Cashfree_txn_id`, supplied by shopifyCombinedSO.
 */
/**
 * Which gateways report a per-order fee breakdown we can trust.
 *
 * NOT all of them do. Snapmint and BharatX ledgers carry no fee columns at all,
 * and Razorpay's settlement file reports fee/tax only intermittently — treating
 * a missing fee as zero there would silently understate the cost of collection
 * and, worse, make an unsettled order look reconciled. So this is an allowlist:
 * a gateway contributes fees only once it is proven to report them per order.
 *
 * Cashfree's settlement/recon returns event_service_charge and event_service_tax
 * on every PAYMENT event — verified across 1,205 payments.
 */
const GATEWAY_REPORTS_FEES = { cashfree: true };

function buildCashfreeRefLookup(salesOrderRows) {
    const map = {};
    for (const row of salesOrderRows) {
        const ref = safeStr(getCol(row, 'Payment References', 'Payment ID'));
        const orderNo = normalizeOrderNum(getCol(row, 'Order No', 'Order No_2', 'Order Number'));
        if (ref && orderNo) map[ref] = orderNo;
    }
    return map;
}

/**
 * Build the Cashfree settlement lookup: order number → { date, amount }.
 *
 * Only PAYMENT events settle an order. The other event types Cashfree returns —
 * INSTANT_SETTLEMENT_CHARGE / _TAX, sweep initiations and their reversals,
 * BALANCE_CARRY_OVER — are account-level costs and movements, not per-order
 * receipts, so folding them in here would misstate what each order actually
 * settled for. REFUND events are handled by the returns steps, not this one.
 *
 * event_settlement_amount is the figure that lands in the bank (gross less the
 * service charge and the GST on it). The flat `amount_settled` field the docs
 * mention comes back null on live data — event_details carries the real values.
 */
function buildCashfreeLookup(reconRows, refLookup = {}) {
    const map = {};
    for (const rec of reconRows) {
        const ev = rec.event_details || {};
        if (String(ev.event_type || '').toUpperCase() !== 'PAYMENT') continue;

        const txnId = safeStr((rec.payment_details || {}).cf_payment_id);
        if (!txnId) continue;
        const orderNo = refLookup[txnId];
        if (!orderNo) continue;   // no bridge to a Shopify order — cannot attribute

        const net = safeNum(ev.event_settlement_amount);
        if (net <= 0) continue;

        if (!map[orderNo]) {
            map[orderNo] = {
                settlement_date: safeDate((rec.settlement_details || {}).settlement_date),
                settlement_amount: 0,
                fee: 0,
                fee_gst: 0,
            };
        }
        map[orderNo].settlement_amount += net;
        // Cost of collection: gross − fee − GST-on-fee = what reached the bank.
        // Recording it is what stops a fully settled order reading as an unpaid
        // receivable, and it surfaces the GST as claimable input credit.
        map[orderNo].fee     += safeNum(ev.event_service_charge);
        map[orderNo].fee_gst += safeNum(ev.event_service_tax);
    }
    return map;
}

/**
 * Cashfree money PAID BACK OUT, keyed by Shopify order number.
 *
 * These events arrive in the same settlement payload as the payments and were
 * being dropped by the `!== 'PAYMENT'` guard above — so a prepaid order that was
 * refunded still read as fully collected. Over the August 2026 window the feed
 * carried 15 REFUND events worth ₹17,648, plus CHARGEBACK and CORRECTION_DEBIT
 * events that move money the same direction.
 *
 * WHY THIS IS NOT A "RETURN"
 * A return is goods coming back (Velocity's lane, which reduces gross sales).
 * A refund is cash going back. The SAME order usually appears in both, so
 * adding the refund to return_amount would count one reversal twice. It belongs
 * against settlement instead: money that reached the bank and then left it.
 *
 * `sale_type: "DEBIT"` on these events is the API's own confirmation of
 * direction. Amounts are accumulated positive here and subtracted by the caller.
 */
const CASHFREE_DEBIT_EVENTS = new Set(['REFUND', 'CHARGEBACK', 'CORRECTION_DEBIT']);

function buildCashfreeRefundLookup(reconRows, refLookup = {}) {
    const map = {};
    for (const rec of reconRows) {
        const ev = rec.event_details || {};
        const type = String(ev.event_type || '').toUpperCase();
        if (!CASHFREE_DEBIT_EVENTS.has(type)) continue;

        const txnId = safeStr((rec.payment_details || {}).cf_payment_id);
        if (!txnId) continue;
        const orderNo = refLookup[txnId];
        if (!orderNo) continue;   // no bridge to a Shopify order — cannot attribute

        // Settlement amount is what actually left the account; fall back to the
        // event amount when the settlement leg has not been booked yet.
        const amt = Math.abs(safeNum(ev.event_settlement_amount) || safeNum(ev.event_amount));
        if (amt <= 0) continue;

        if (!map[orderNo]) map[orderNo] = { refund_amount: 0, refund_date: null, types: new Set() };
        map[orderNo].refund_amount += amt;
        map[orderNo].types.add(type);
        const d = safeDate((rec.settlement_details || {}).settlement_date) || safeDate(ev.event_time);
        if (d && !map[orderNo].refund_date) map[orderNo].refund_date = d;
    }
    return map;
}

/**
 * Velocity COD remittance keyed by AWB.
 *
 * Velocity is the shipping PLATFORM, not the carrier — Delhivery delivers the
 * parcel and hands the cash to Velocity, which remits to the brand. So this is
 * keyed on AWB (which both sides share) and written to the generic courier_*
 * columns rather than delhivery_*.
 *
 * ⚠️ `remittance_date` is populated even when NOTHING has been paid — the API
 * defines it as "settlement date if already remitted; otherwise the next
 * scheduled date". Verified live: 25 of 25 D'Chicha AWBs returned today's date
 * with utr_no null, i.e. ₹39,838 not yet received. `utr_no` is therefore the
 * only trustworthy signal that money actually arrived, and `settled` below is
 * what Step 10 is allowed to count.
 */
function buildVelocityLookup(rows) {
    const map = {};
    for (const rec of rows || []) {
        if (rec.error) continue;                      // prepaid order, or AWB not in account
        const awb = normalizeAWB(rec.tracking_number);
        if (!awb) continue;
        const cod = safeNum(rec.cod_amount);
        if (cod <= 0) continue;
        map[awb] = {
            cod_amount: cod,
            delivery_date: safeDate(rec.delivery_date),
            remittance_date: safeDate(rec.remittance_date),
            utr: safeStr(rec.utr_no) || null,
            settled: !!safeStr(rec.utr_no),           // the discriminator
        };
    }
    return map;
}

/* ── Remittance-state helpers ────────────────────────────────────────────────
   An empty UTR is NOT proof of non-payment — it is absence of proof either way.
   The courier reports cod_amount as collected and remittance_date as a FORECAST
   until the transfer happens, so a blank UTR means "collected, transfer
   unconfirmed". Measured on D'Chicha, Velocity's cycle runs 4-6 days from
   delivery to payout, so a blank UTR well past that is a question to ask rather
   than a balance to trust. */
const REMITTANCE_OVERDUE_DAYS = 18;   // ~3x the observed 4-6 day cycle

function codCollectedNotRemitted(row) {
    return safeNum(row.courier_cod_amount) > 0 && !row.courier_utr;
}

function daysSince(d) {
    const dt = safeDate(d);
    if (!dt) return null;
    return Math.floor((Date.now() - dt.getTime()) / 86400000);
}

function fmtMoney(v) {
    const n = safeNum(v);
    return '\u20B9' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
    const dt = safeDate(d);
    return dt ? dt.toISOString().slice(0, 10) : 'an unknown date';
}

// ── Workbook styling helpers ──────────────────────────────────────────────────

/* Two different feeds, deliberately separate — a platform can give us one and
   not the other, and conflating them produced a remark that told the accountant
   delivery could not be confirmed on rows where we had just confirmed it.
     REMITTANCE_FEEDS — reports COD money collected and remitted (UTR).
     STATUS_FEEDS     — reports what happened to the parcel (delivered / RTO / lost).
   Eshopbox is status-only: it is the sole source that can say a parcel came back,
   but it tells us nothing about COD cash. */
const REMITTANCE_FEEDS = ['Velocity'];
const STATUS_FEEDS = ['Eshopbox'];

/* Money to 2dp. Subtracting floats leaves residue — a fully settled order was
   showing a balance of 5.4e-13 instead of 0, which looks like a defect in a
   report an accountant reads and breaks any downstream total formatting. */
function round2(v) {
    const n = safeNum(v);
    return Math.round(n * 100) / 100;
}

/* Status fills. Green/red match the Validation Summary sheet already in this
   workbook; amber and orange are new and sit deliberately between them — a
   collected-but-unconfirmed COD is neither settled nor a shortfall. */
const STATUS_FILL = {
    'RECONCILED':             'FF92D050',  // green  — matched
    'AWAITING REMITTANCE':    'FFFFD966',  // amber  — collected, transfer unconfirmed
    'UNREMITTED - QUERY':     'FFED7D31',  // orange — unconfirmed well past the cycle
    'PENDING RECEIVABLE':     'FFD9D9D9',  // grey   — nothing collected yet
    'OVERPAID / INVESTIGATE': 'FFFF4444',  // red    — more received than due
    'ADVANCE':                'FFB4C7E7',  // blue   — returned yet money moved
    'REFUNDED - NO RETURN RECORD': 'FFCC99FF', // purple — cash reversed, goods lane silent
};

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
/**
 * @param {object} opts
 *   opts.extended — OPT-IN, ONE BRAND AT A TIME. When false (every brand except
 *   the enabled one) this function must produce a byte-identical report to the
 *   one it produced before the D'Chicha work: 34 columns, and Net = Gross −
 *   Return with cancelled orders left inside Gross. 19 brands share this agent
 *   and their accountants have signed off on those numbers; changing them
 *   silently because one brand needed more detail is not a refactor, it is a
 *   restatement of someone else's books.
 */
async function orderCycleShopifyProcessor(
    gstJson = [],
    returnGSTJson = [],
    salesOrderJson = [],
    gatewayData = {},
    logisticsData = {},
    brandName = '',
    period = '',
    opts = {}
) {
    const EXT = !!opts.extended;   // see the note above — default OFF
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
                // The platform that booked the shipment and remits its COD —
                // distinct from the carrier that delivers it.
                shipping_platform: safeStr(getCol(row, 'Shipping Platform')),
                // COD vs PREPAID. Shopify-primary supplies this directly from
                // payment_gateway_names; a Tally/Unicommerce master usually does
                // not, so a blank here is filled by inference in Step 12b rather
                // than being reported as fact.
                payment_type: normalizePaymentType(getCol(row, 'Payment Method', 'Payment Type', 'Payment Mode')),
                dispatch_date: safeDate(getCol(row, 'Dispatch Date/Cancellation Date', 'Date', 'Dispatch Date', 'Invoice Date')),
                sales_amount: 0,
                // Step 2
                return_date: null, srn: '', return_amount: 0, net_amount: 0,
                // Set in Step 12c. RTO deducts alongside Return; cancelled is
                // pulled out of Gross entirely (see the accountant's rule there).
                rto_amount: 0, cancelled_amount: 0,
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
                cashfree_settlement_date: null, cashfree_settlement_amount: 0,
                // Populated only by fee-reporting gateways (GATEWAY_REPORTS_FEES).
                gateway_fee: 0, gateway_fee_gst: 0, gateway_fee_source: null,
                // Cash paid BACK OUT through the gateway (refund/chargeback).
                // Reduces settlement received; never touches return_amount, which
                // is the goods lane — see buildCashfreeRefundLookup.
                gateway_refund: 0, gateway_refund_date: null,
                // COD from the shipping platform. courier_cod_amount is only
                // treated as RECEIVED when courier_utr is present.
                eshopbox_cod_basis: null,
                // Display only — see returnPrimeExchanges.js. Never part of the money math.
                exchange_status: '', exchange_ref: null, exchange_topup: 0, exchange_gateway: null,
                courier_cod_amount: 0, courier_delivery_date: null,
                courier_remittance_date: null, courier_utr: null, courier_source: null,
                // Steps 10-12 (internal — not in output sheet but stored in DB for dashboard)
                total_settlement_received: 0, balance_amount_receivable: 0, reconciliation_status: '', remark: ''
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

    // ── STEP 2b: Split-invoice return re-attribution ─────────────────────────
    // A return note can cover TWO units that were actually invoiced as two
    // SEPARATE qty-1 invoices/AWBs (dispatched seconds apart — verified across
    // every case in this data) while naming only ONE of those invoices as its
    // "Original Invoice No" — its own Total spans both units, not just that
    // invoice's own share. Left as-is, Step 2 dumps the entire return onto that
    // one invoice (false OVERPAID/INVESTIGATE) while its twin gets zero return
    // credit (false PENDING RECEIVABLE), even though the twin's own sale amount
    // exactly reconstructs the "excess" (return minus the holder's own share).
    //
    // Sale Order Number recycles across unrelated transactions over time (see
    // buildSnapmintLookup/buildBharatXLookup comments above) — verified case:
    // order 229728 carries 7 invoices across 3 different dispatch dates, only
    // one of which is the genuine twin. So this doesn't trust the whole order
    // group; it looks for the SPECIFIC sibling invoice(s) under that order
    // number whose own sale amount corresponds to the excess (the same
    // amount-correspondence check already used for gateway settlements,
    // amountsCorrespond).
    //
    // Amount alone can still tie: a recycled order number can carry a LATER
    // unrelated invoice that happens to land within the 2% band too (verified
    // cases: order 226260, 235176, 241498, 248126, 250702, 253042 each had 2-3
    // amount-matching candidates). Dispatch timing breaks the tie safely — every
    // verified genuine twin was dispatched within ~16 hours of its holder, while
    // every false amount-match sat 27+ days away, an enormous, clean separation.
    // A cutoff of 48 hours (with margin) picks the genuine twin only when it's
    // truly the sole close-in-time candidate; anything left ambiguous even after
    // that is genuinely unresolvable and flagged instead of guessed at — same
    // caution assignGatewayCandidates uses for its own ambiguous case.
    const TWIN_TIME_WINDOW_MS = 48 * 3600 * 1000;
    const returnRedistributions = [];
    const returnSplitIssues = [];
    const masterByOrderForReturn = {};
    for (const row of masterRows) {
        if (row.sale_order_number) (masterByOrderForReturn[row.sale_order_number] ||= []).push(row);
    }
    for (const rowsForOrder of Object.values(masterByOrderForReturn)) {
        if (rowsForOrder.length < 2) continue;

        for (const holder of rowsForOrder) {
            if (holder.return_amount <= 0) continue;
            if (amountsCorrespond(holder.return_amount, holder.sales_amount)) continue; // already correct

            const excess = holder.return_amount - holder.sales_amount;
            if (excess <= 0) continue; // return is less than its own sale — ordinary partial return, leave alone

            let candidates = rowsForOrder.filter(r =>
                r !== holder && r.return_amount <= 0 && amountsCorrespond(r.sales_amount, excess)
            );
            let tieBroken = false;

            if (candidates.length > 1 && holder.dispatch_date) {
                const withinWindow = candidates
                    .filter(c => c.dispatch_date)
                    .map(c => ({ row: c, gapMs: Math.abs(c.dispatch_date.getTime() - holder.dispatch_date.getTime()) }))
                    .filter(c => c.gapMs <= TWIN_TIME_WINDOW_MS)
                    .sort((a, b) => a.gapMs - b.gapMs);
                if (withinWindow.length === 1) {
                    candidates = [withinWindow[0].row];
                    tieBroken = true;
                }
            }

            if (candidates.length === 1) {
                const sibling = candidates[0];
                const total = holder.sales_amount + sibling.sales_amount;
                const totalReturn = holder.return_amount;
                const holderShare = total > 0 ? totalReturn * (holder.sales_amount / total) : totalReturn / 2;
                const siblingShare = total > 0 ? totalReturn * (sibling.sales_amount / total) : totalReturn / 2;

                sibling.return_amount = siblingShare;
                sibling.return_date = holder.return_date;
                sibling.srn = holder.srn;
                sibling.net_amount = sibling.sales_amount - sibling.return_amount;

                holder.return_amount = holderShare;
                holder.net_amount = holder.sales_amount - holder.return_amount;

                returnRedistributions.push({
                    orderNo: holder.sale_order_number, srn: holder.srn,
                    holderInvoice: holder.invoice_number, siblingInvoice: sibling.invoice_number, totalReturn,
                    viaTimeProximity: tieBroken,
                });
            } else if (candidates.length > 1) {
                returnSplitIssues.push({
                    orderNo: holder.sale_order_number, invoice: holder.invoice_number,
                    reason: 'ambiguous', candidateCount: candidates.length,
                });
            }
            // candidates.length === 0 → no matching twin found; leave as-is (still
            // surfaced by the existing Overpaid Order exception below).
        }
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

    // ── STEP 3b: Eshopbox delivery status (RTO / LOST) ───────────────────────
    // Runs AFTER Step 3 deliberately. Step 3 sets delivery_status from the Sales
    // Order source, which in Shopify-primary mode is fulfillment_status — and
    // that still says "fulfilled" for a parcel that has since come back.
    // Applying Eshopbox first would let Shopify overwrite RTO with DELIVERED,
    // which is precisely the defect this data exists to correct.
    // Belt and braces: the controller already refuses to pull Eshopbox for a
    // brand that isn't enabled, so this array should always be empty elsewhere.
    // Gating here too means an uploaded file that happens to be named "Eshopbox"
    // cannot start rewriting another brand's delivery statuses.
    const eshopboxRows = EXT ? (logisticsData.Eshopbox || logisticsData.eshopbox || []) : [];
    let eshopboxStats = null;
    if (eshopboxRows.length) {
        const lookup = eshopboxTracking.buildLookup(eshopboxRows);
        const applied = eshopboxTracking.applyToMasterRows(masterRows, lookup);
        eshopboxStats = { ...applied, feed: lookup.stats };
        console.log('[OrderCycleProcessor] Eshopbox status applied —', JSON.stringify(applied));
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
        { snapmint: 'snapmint', bharatx: 'bharatx', bharat: 'bharatx', razorpay: 'razorpay', cashfree: 'cashfree' },
        detectGatewayType
    );

    const snapmintLookup = buildSnapmintLookup(gatewayTyped.snapmint || []);
    const bharatxLookup = buildBharatXLookup(gatewayTyped.bharatx || []);

    // Razorpay joins via Combined SO: order_receipt → Payment References → Order No
    // Razorpay's own receipts tell us which Combined SO column really holds them,
    // regardless of what its header row claims (see detectPaymentRefColumn).
    const razorpayReceipts = new Set(
        (gatewayTyped.razorpay || [])
            .map((r) => safeStr(getCol(r, 'order_receipt', 'Order Receipt')))
            .filter(Boolean)
    );
    const refKey = detectPaymentRefColumn(salesOrderJson, razorpayReceipts);
    const paymentRefLookup = buildPaymentRefLookup(salesOrderJson, refKey);
    const razorpayLookup = buildRazorpayLookup(gatewayTyped.razorpay || [], paymentRefLookup);

    // Cashfree joins on its own numeric-safe reference map (see buildCashfreeRefLookup).
    const cashfreeRefLookup = buildCashfreeRefLookup(salesOrderJson);
    const cashfreeLookup = buildCashfreeLookup(gatewayTyped.cashfree || [], cashfreeRefLookup);
    const cashfreeRefundLookup = buildCashfreeRefundLookup(gatewayTyped.cashfree || [], cashfreeRefLookup);

    // Shipping-platform COD (Velocity). Arrives via logisticsData under the
    // platform's name, alongside any uploaded per-carrier files.
    const velocityRows = logisticsData.Velocity || logisticsData.velocity || [];
    const velocityLookup = buildVelocityLookup(velocityRows);

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

    // Cashfree refunds/chargebacks — money that reached the bank and then left it.
    // Applied per ORDER, and when an order spans several invoices the refund lands
    // on the first row only: splitting it pro-rata would invent a precision the
    // gateway never reported, and the order-level total stays correct either way.
    for (const [orderNo, rowsForOrder] of Object.entries(masterByOrderForGateway)) {
        const rf = cashfreeRefundLookup[orderNo];
        if (!rf || !rowsForOrder.length) continue;
        rowsForOrder[0].gateway_refund = round2(rf.refund_amount);
        rowsForOrder[0].gateway_refund_date = rf.refund_date;
    }

    // Cashfree — same shape as Razorpay: one gateway payment per order, split
    // across invoices only when the order itself was split across invoices.
    for (const [orderNo, rowsForOrder] of Object.entries(masterByOrderForGateway)) {
        const cf = cashfreeLookup[orderNo];
        if (!cf) continue;
        const applyCashfree = (row, c) => {
            row.cashfree_settlement_date = c.settlement_date;
            row.cashfree_settlement_amount = c.settlement_amount;
            if (GATEWAY_REPORTS_FEES.cashfree) {
                row.gateway_fee = safeNum(c.fee);
                row.gateway_fee_gst = safeNum(c.fee_gst);
                row.gateway_fee_source = 'Cashfree';
            }
        };
        if (rowsForOrder.length === 1) {
            applyCashfree(rowsForOrder[0], cf);
        } else {
            assignGatewayCandidates(rowsForOrder,
                [{ order_value: cf.settlement_amount, settlement_date: cf.settlement_date,
                   settlement_amount: cf.settlement_amount, fee: cf.fee, fee_gst: cf.fee_gst }],
                applyCashfree, 'Cashfree', gatewayIssues);
        }
    }

    // ── Shipping-platform COD, matched on AWB ─────────────────────────────────
    // Written for every matched AWB so the delivery date and the forecast are
    // visible, but Step 10 only counts it once a UTR exists.
    for (const row of masterRows) {
        const awb = normalizeAWB(row.awb_number);
        if (!awb) continue;
        const v = velocityLookup[awb];
        if (!v) continue;
        row.courier_cod_amount = v.cod_amount;
        row.courier_delivery_date = v.delivery_date;
        row.courier_remittance_date = v.remittance_date;
        row.courier_utr = v.utr;
        row.courier_source = 'Velocity';
    }

    // ── STEP 10: Total Settlement Received ────────────────────────────────────
    for (const row of masterRows) {
        row.total_settlement_received =
            row.ekart_cod_amount +
            row.delhivery_cod_amount +
            row.xpressbees_net_payment +
            row.snapmint_settlement_amount +
            row.bharatx_settlement_amount +
            row.razorpay_settlement_amount +
            row.cashfree_settlement_amount +
            // Unremitted COD is money still owed, not money received — counting it
            // on the forecast date would invert the receivables position.
            (row.courier_utr ? safeNum(row.courier_cod_amount) : 0) -
            // Refunded/charged-back cash was received and then returned. Netting it
            // here is what stops a refunded prepaid order reading as fully collected.
            safeNum(row.gateway_refund);
    }

    // ── STEP 11: Balance Amount Receivable ────────────────────────────────────
    // A gateway fee is a COST OF COLLECTION, not an unpaid receivable: the customer
    // paid in full and the gateway kept its cut before remitting. Subtracting it
    // here is what makes a fully settled order reconcile to zero instead of sitting
    // as PENDING RECEIVABLE forever (D'Chicha: ~₹8,678 of phantom receivable per
    // fortnight, on 1,205 orders, none of it actually owed).
    //
    // Safe for every other brand: gateway_fee/_gst are 0 unless a gateway on the
    // GATEWAY_REPORTS_FEES allowlist populated them, so this evaluates to exactly
    // `net_amount - total_settlement_received` — the previous behaviour — for
    // Snapmint, BharatX, Razorpay and all courier-COD settlements.
    for (const row of masterRows) {
        const costOfCollection = safeNum(row.gateway_fee) + safeNum(row.gateway_fee_gst);
        row.balance_amount_receivable =
            row.net_amount - row.total_settlement_received - costOfCollection;
    }

    // ── STEP 11b: Payment type ───────────────────────────────────────────────
    // Stated by the master file where it says so (Shopify gives it directly).
    // Otherwise inferred from evidence, and the row records WHICH so a reader is
    // never left treating a guess as a fact:
    //   COD     — a courier collected cash against this AWB
    //   PREPAID — a payment gateway settled it, and no courier COD exists
    // Anything with neither is left UNKNOWN rather than defaulted; defaulting to
    // PREPAID would silently classify every unshipped order as money collected.
    for (const row of masterRows) {
        if (!EXT) { row.payment_type = ''; row.payment_type_source = null; continue; }
        if (row.payment_type) { row.payment_type_source = 'stated'; continue; }

        const courierCollected = safeNum(row.courier_cod_amount) > 0 ||
            safeNum(row.ekart_cod_amount) > 0 || safeNum(row.delhivery_cod_amount) > 0;
        const gatewaySettled = safeNum(row.cashfree_settlement_amount) > 0 ||
            safeNum(row.razorpay_settlement_amount) > 0 || safeNum(row.snapmint_settlement_amount) > 0 ||
            safeNum(row.bharatx_settlement_amount) > 0 || safeNum(row.xpressbees_net_payment) > 0;

        if (courierCollected)      { row.payment_type = 'COD';     row.payment_type_source = 'inferred'; }
        else if (gatewaySettled)   { row.payment_type = 'PREPAID'; row.payment_type_source = 'inferred'; }
        else                       { row.payment_type = 'UNKNOWN'; row.payment_type_source = 'none'; }
    }

    // ── STEP 11c: Eshopbox COD money ─────────────────────────────────────────
    // Sits here, not with the other logistics steps, because it needs
    // payment_type (Step 11b) to know which rows are COD at all — and because it
    // writes courier_* columns that Step 10 already consumed, the settlement
    // total and balance are recomputed immediately below rather than left stale.
    const eshopboxCodRows = logisticsData.EshopboxCod || [];
    const eshopboxPayoutRows = logisticsData.EshopboxPayouts || [];
    let eshopboxCodStats = null;
    if (EXT && (eshopboxCodRows.length || eshopboxPayoutRows.length)) {
        const lookup = eshopboxCod.buildLookup(eshopboxCodRows, eshopboxPayoutRows);
        const applied = eshopboxCod.applyToMasterRows(masterRows, lookup);
        eshopboxCodStats = { ...applied, payout: lookup.payout, awaiting: lookup.stats };

        // Recompute both figures the lines above just invalidated.
        for (const row of masterRows) {
            row.total_settlement_received =
                row.ekart_cod_amount + row.delhivery_cod_amount + row.xpressbees_net_payment +
                row.snapmint_settlement_amount + row.bharatx_settlement_amount +
                row.razorpay_settlement_amount + row.cashfree_settlement_amount +
                (row.courier_utr ? safeNum(row.courier_cod_amount) : 0) -
                safeNum(row.gateway_refund);
            const costOfCollection = safeNum(row.gateway_fee) + safeNum(row.gateway_fee_gst);
            row.balance_amount_receivable = round2(
                row.net_amount - row.total_settlement_received - costOfCollection
            );
        }
        console.log('[OrderCycleProcessor] Eshopbox COD applied —', JSON.stringify(applied));
    }

    // ── STEP 12: Reconciliation Status ───────────────────────────────────────
    // Courier settlement files report COD amounts rounded to the nearest whole rupee,
    // so a genuinely fully-settled order can differ from its own (paise-precise) net
    // amount by up to ~₹1 with no real discrepancy — verified against this data: real
    // rounding noise tops out at ₹0.50, and the smallest genuine gap starts at ₹1.62.
    const RECONCILIATION_TOLERANCE = 1;
    for (const row of masterRows) {
        const hasSettlement =
            row.ekart_cod_amount !== 0 || row.delhivery_cod_amount !== 0 || row.xpressbees_net_payment !== 0 ||
            row.snapmint_settlement_amount !== 0 || row.bharatx_settlement_amount !== 0 || row.razorpay_settlement_amount !== 0 ||
            row.cashfree_settlement_amount !== 0 ||
            (!!row.courier_utr && safeNum(row.courier_cod_amount) !== 0);

        if (row.delivery_status === 'RTO') {
            row.reconciliation_status = 'RTO';
        } else if (row.delivery_status === 'CANCELLED') {
            row.reconciliation_status = 'CANCELLED';
        } else if (row.return_amount > 0 && hasSettlement) {
            // Sold (Tally GST) then returned (Return GST), yet a courier or gateway still
            // shows money moving against this order — that cash isn't "still receivable" on
            // a live sale (there is no live sale, it was returned), it's an advance that
            // needs its own recovery/investigation track instead of being read as ordinary
            // pending/overpaid.
            row.reconciliation_status = 'ADVANCE';
        } else if (Math.abs(row.balance_amount_receivable) <= RECONCILIATION_TOLERANCE) {
            row.reconciliation_status = 'RECONCILED';
        } else if (EXT && safeNum(row.gateway_refund) > 0 && row.return_amount <= 0) {
            // The gateway paid the customer back, but no return reached the goods
            // lane (Velocity/Return GST), so net_amount still carries the full sale
            // and the balance reads as money owed TO US. It is the opposite: this
            // sale was reversed in cash and the goods side simply has not caught up.
            // Calling it PENDING RECEIVABLE would put a refunded order on a
            // collections list.
            row.reconciliation_status = 'REFUNDED - NO RETURN RECORD';
            row.remark = `${fmtMoney(row.gateway_refund)} refunded via the payment gateway on `
                       + `${fmtDate(row.gateway_refund_date)}, but no matching return was found in the `
                       + `logistics feed — confirm whether the goods came back.`;
        } else if (codCollectedNotRemitted(row)) {
            // COD was collected from the customer but the platform has not
            // confirmed remitting it. Asserting "unpaid" here would be as wrong
            // as asserting "paid" — the money exists, its transfer is unproven.
            // So we withhold the verdict and say which it is and how old.
            const days = daysSince(row.courier_remittance_date);
            const overdue = days !== null && days > REMITTANCE_OVERDUE_DAYS;
            row.reconciliation_status = overdue ? 'UNREMITTED - QUERY' : 'AWAITING REMITTANCE';
            row.remark = overdue
                ? `COD ${fmtMoney(row.courier_cod_amount)} collected but no UTR ${days} days after the expected remittance date — query ${row.courier_source || 'the courier'}.`
                : `COD ${fmtMoney(row.courier_cod_amount)} collected; ${row.courier_source || 'courier'} remittance not yet confirmed (no UTR). Expected ${fmtDate(row.courier_remittance_date)}.`;
        } else if (row.balance_amount_receivable > 0) {
            row.reconciliation_status = 'PENDING RECEIVABLE';
        } else {
            row.reconciliation_status = 'OVERPAID / INVESTIGATE';
        }

        // Explain any blank the reader would otherwise have to ask about. A
        // missing delivery status or COD figure is nearly always a coverage gap,
        // not a data error, and saying which is cheaper than being asked.
        if (!row.remark) {
            const platform = row.shipping_platform;
            const noMoney  = platform && !REMITTANCE_FEEDS.includes(platform);
            // Only the enabled brand has a status feed; for everyone else the
            // original single-feed wording is still the truthful one.
            const noStatus = !EXT || (platform && !STATUS_FEEDS.includes(platform) && !row.eshopbox_status);
            if (!row.awb_number && !row.dispatch_date) {
                row.remark = 'Not yet shipped — no AWB assigned.';
            } else if (EXT && row.delivery_status === 'RTO') {
                row.remark = `Returned to origin — ${platform || 'the courier'} reports the parcel came back undelivered`
                           + `${row.eshopbox_status ? ` (status "${row.eshopbox_status}")` : ''}. `
                           + `No money is due on this order; the goods are back with the brand.`;
            } else if (EXT && row.delivery_status === 'LOST') {
                row.remark = `Lost or damaged in transit per ${platform || 'the courier'} — neither the goods nor the cash `
                           + `will arrive. Raise a claim with the carrier.`;
            } else if (noMoney && noStatus) {
                row.remark = `Shipped via ${platform}, which has no feed connected — `
                           + `delivery status and COD collection cannot be confirmed for this order.`;
            } else if (EXT && row.eshopbox_cod_basis === 'settled_payout_level') {
                // Deliberately explicit: Eshopbox proves this at payout level,
                // not per order. Saying "COD received" flat would imply a receipt
                // we cannot produce if the accountant is ever asked for one.
                row.remark = `COD settled by Eshopbox. Evidence is payout-level, not per order — `
                           + `Eshopbox no longer lists this order as outstanding and its COD payouts are `
                           + `paid up to ${fmtDate(row.courier_remittance_date)}`
                           + `${row.courier_utr && row.courier_utr !== 'PAYOUT-LEVEL' ? ` (latest bank ref ${row.courier_utr})` : ''}.`;
            } else if (EXT && row.eshopbox_cod_basis === 'awaiting') {
                row.remark = `COD ${fmtMoney(row.courier_cod_amount)} collected on delivery; Eshopbox still lists it as `
                           + `AWAITING PAYMENT${row.courier_remittance_date ? `, expected ${fmtDate(row.courier_remittance_date)}` : ''}. `
                           + `Not yet received.`;
            } else if (noMoney) {
                // Status is known (Eshopbox), money is not. Say only what is true.
                row.remark = `Delivery confirmed by ${platform}, but it reports no COD remittance — `
                           + `any cash collected on this order cannot be traced to a payout.`;
            } else if (!row.delivery_status && row.awb_number) {
                row.remark = 'Shipped; carrier has not reported delivery yet.';
            } else if (row.reconciliation_status === 'PENDING RECEIVABLE') {
                // This branch PRE-DATES the D'Chicha work — it must keep firing for
                // every brand. Only the COD-specific wording is new; gating the
                // whole branch blanked the Remark on other brands' reports.
                row.remark = (EXT && row.payment_type === 'COD')
                    ? 'COD order, delivered — no collection reported by the courier yet.'
                    : 'Delivered but no settlement found against this order yet.';
            } else if (EXT && row.reconciliation_status === 'RECONCILED') {
                row.remark = row.payment_type === 'COD'
                    ? 'COD collected and remitted in full.'
                    : 'Prepaid and settled in full.';
            } else if (EXT && row.reconciliation_status === 'CANCELLED') {
                row.remark = 'Order cancelled — counted in gross sales, no money expected.';
            } else if (EXT && row.reconciliation_status === 'OVERPAID / INVESTIGATE') {
                row.remark = `Received ${fmtMoney(row.total_settlement_received)} against a net of `
                           + `${fmtMoney(row.net_amount)} — more than due; check for a duplicate settlement.`;
            } else if (EXT && row.reconciliation_status === 'ADVANCE') {
                row.remark = 'Returned, yet money still moved against this order — treat as an advance to recover, not a live sale.';
            }
        }

        // Last resort: a row must never reach the accountant with an empty
        // Remark. A blank reads as "nothing to say"; in practice it always
        // meant "nobody wrote a branch for this case", and the question came
        // back to us anyway.
        if (EXT && !row.remark) {
            row.remark = `${row.reconciliation_status} — ${fmtMoney(row.net_amount)} net, `
                       + `${fmtMoney(row.total_settlement_received)} received.`;
        }

        // Say so when COD/PREPAID was deduced rather than stated, so an inferred
        // classification is never mistaken for one the source system asserted.
        if (EXT && row.payment_type_source === 'inferred') {
            row.remark += ` (Payment type inferred from ${row.payment_type === 'COD' ? 'courier cash collection' : 'gateway settlement'}, not stated by the source.)`;
        } else if (EXT && row.payment_type_source === 'none') {
            row.remark += ' (Payment type unknown — no gateway settlement or courier collection to deduce it from.)';
        }
    }

    // ── STEP 12c: Sales basis ────────────────────────────────────────────────
    // The accountant's rule, stated plainly:
    //     Gross INCLUDES returned and RTO orders, EXCLUDES cancelled ones.
    //     Net = Gross − (Return + RTO)
    //
    // Two things were leaking into Net before this:
    //   • an RTO parcel is back in the warehouse and nobody paid — but the sale
    //     was still counted in full;
    //   • a cancelled order never shipped, yet sat inside Gross.
    // Measured on August 2026: ₹21,077 of RTO and ₹13,587 of cancelled, so Net
    // overstated real sales by ₹34,664.
    //
    // RTO deducts the REMAINING value (net after any return already recorded),
    // never the gross — an RTO row that also carries a partial return would
    // otherwise be deducted twice for the same goods.
    for (const row of masterRows) {
        if (!EXT) { row.rto_amount = 0; row.cancelled_amount = 0; continue; }
        if (row.reconciliation_status === 'CANCELLED' || row.delivery_status === 'CANCELLED') {
            // Never a sale. Dropped from Gross rather than deducted, so the
            // Return column keeps meaning "goods that came back".
            row.cancelled_amount = round2(row.sales_amount);
            row.sales_amount = 0;
            row.return_amount = 0;
            row.net_amount = 0;
            row.rto_amount = 0;
        } else if (row.delivery_status === 'RTO') {
            row.rto_amount = round2(row.net_amount);
            row.net_amount = 0;
            row.cancelled_amount = 0;
        } else {
            row.rto_amount = 0;
            row.cancelled_amount = 0;
        }
    }

    // Balance must be recomputed: it was derived from net_amount in Step 11, and
    // the lines above just changed net for RTO and cancelled rows. Leaving the
    // old balance would show money receivable against a sale we no longer count.
    if (EXT) for (const row of masterRows) {
        const costOfCollection = safeNum(row.gateway_fee) + safeNum(row.gateway_fee_gst);
        row.balance_amount_receivable = round2(
            row.net_amount - row.total_settlement_received - costOfCollection
        );
    }

    // ── STEP 12d: Return Prime exchanges (DISPLAY ONLY) ──────────────────────
    // Runs last, after the sales basis is already final, so it is structurally
    // incapable of altering Gross, Return, RTO or Net. An exchange swaps goods
    // and keeps the money; deducting it would understate revenue for a sale that
    // was never reversed.
    const returnPrimeRows = logisticsData.ReturnPrime || [];
    let returnPrimeStats = null;
    if (EXT && returnPrimeRows.length) {
        const lookup = returnPrimeExchanges.buildLookup(returnPrimeRows);
        const applied = returnPrimeExchanges.applyToMasterRows(masterRows, lookup);
        returnPrimeStats = { ...applied, feed: lookup.stats };

        // The remark is appended HERE, not in Step 12. Step 12 runs before this
        // one, so exchange_topup was still 0 there and the sentence never fired.
        for (const row of masterRows) {
            if (safeNum(row.exchange_topup) <= 0) continue;
            const via = row.exchange_gateway ? ` via ${row.exchange_gateway}` : '';
            const sentence = `Customer paid ${fmtMoney(row.exchange_topup)} as an exchange top-up${via}`
                           + ` — not counted in settlements, as this report has no feed from that gateway.`;
            row.remark = row.remark ? `${row.remark} ${sentence}` : sentence;
        }
        console.log('[OrderCycleProcessor] Return Prime exchanges —', JSON.stringify(applied));
    }

    // ── STEPS 13-14: Validations & Exceptions ────────────────────────────────
    const exceptions = [];
    const validations = [];

    // V1: Total Sales Amount
    const totalSales = masterRows.reduce((s, r) => s + r.sales_amount, 0);
    validations.push({ check: 'Total Sales Amount', value: totalSales.toFixed(2), status: 'INFO' });

    // V2: Net Amount integrity
    const netMismatch = masterRows.filter(r =>
        Math.abs((r.sales_amount - r.return_amount - safeNum(r.rto_amount)) - r.net_amount) > 0.01).length;
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

    // V3c: Split-invoice returns re-attributed to their genuine twin (Step 2b)
    returnRedistributions.forEach(r => exceptions.push({
        type: 'Split-Invoice Return Redistributed',
        reference: r.orderNo,
        detail: `SRN ${r.srn || '(none)'}, return ${r.totalReturn.toFixed(2)} originally tagged to invoice ${r.holderInvoice} — split with twin invoice ${r.siblingInvoice} under the same order`
            + (r.viaTimeProximity ? ' (disambiguated by dispatch-time proximity — multiple invoices matched the return amount)' : '')
    }));
    validations.push({ check: 'Split-Invoice Return Redistributions', value: returnRedistributions.length, status: 'INFO' });

    // V3d: Split-invoice return whose excess matched more than one sibling —
    // not auto-attributed, needs manual review.
    returnSplitIssues.forEach(i => exceptions.push({
        type: 'Ambiguous Split-Invoice Return',
        reference: i.orderNo,
        detail: `Invoice ${i.invoice}: return excess matches ${i.candidateCount} sibling invoices under order ${i.orderNo} — not auto-attributed`
    }));
    validations.push({ check: 'Ambiguous Split-Invoice Returns', value: returnSplitIssues.length, status: returnSplitIssues.length === 0 ? 'PASS' : 'FAIL' });

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
    validations.push({ check: 'Advance (Returned but Settled)', value: masterRows.filter(r => r.reconciliation_status === 'ADVANCE').length, status: 'INFO' });
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
        'Return Date', 'SRN', 'Return amount', ...(EXT ? ['RTO amount'] : []), 'Net amount',
        'Ekart remittance date', 'Ekart Actual Date of Remittance', 'Ekart COD amount',
        'Delhivery delivery date', 'Delhivery COD amount',
        'Xpressbees delivery date', 'Xpressbees transaction date', 'Xpressbees net payment',
        'Snapmint merchant settlement date', 'Snapmint settlement value',
        'BharatX settlement timestamp', 'BharatX ledger amount',
        'Razorpay settlement date', 'Razorpay settlement amount',
        // Appended, never inserted — anything keyed on an existing column
        // position (a downstream VLOOKUP, a saved filter) keeps working.
        'Courier COD amount', 'Courier delivery date', 'Courier remittance date', 'Courier UTR',
        ...(EXT ? ['Gateway refund', 'Gateway refund date', 'Payment type'] : []),
        'Delivery status', 'Total settlement received', 'Balance receivable', 'Status', 'Remark',
        // Appended AFTER Remark: display-only columns must not push any existing
        // column sideways for anyone keying on position.
        ...(EXT ? ['Exchange', 'Exchange top-up'] : []),
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
        ...(EXT ? ['Logistics (RTO)'] : []),
        EXT ? '(G)-(J)-(K)' : '(G)-(J)',
        `Ekart settlement report - ${fyLabel}`, '', '',
        `Delhivery settlement report - ${fyLabel}`, '',
        `Xpressbees settlement report - ${fyLabel}`, '', '',
        `Snapmint settlement report - ${fyLabel}`, '',
        `BharatX settlement report - ${fyLabel}`, '',
        `Razorpay settlement report - ${fyLabel}`, '',
        'Courier COD remittance (API)', '', '', '',
        ...(EXT ? ['Cashfree refunds (API)', '', ''] : []),
        'Computed', '', '', '', '',
        ...(EXT ? ['Return Prime', ''] : []),
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
            r.return_date, r.srn, r.return_amount || '', ...(EXT ? [r.rto_amount || ''] : []), r.net_amount,
            r.ekart_remittance_date, r.ekart_actual_remittance_date, r.ekart_cod_amount || '',
            r.delhivery_delivery_date, r.delhivery_cod_amount || '',
            r.xpressbees_delivery_date, r.xpressbees_transaction_date, r.xpressbees_net_payment || '',
            r.snapmint_settlement_date, r.snapmint_settlement_amount || '',
            r.bharatx_settlement_date, r.bharatx_settlement_amount || '',
            r.razorpay_settlement_date, r.razorpay_settlement_amount || '',
            r.courier_cod_amount || '', r.courier_delivery_date, r.courier_remittance_date, r.courier_utr || '',
            ...(EXT ? [r.gateway_refund || '', r.gateway_refund_date, r.payment_type || ''] : []),
            r.delivery_status || '',
            round2(r.total_settlement_received), round2(r.balance_amount_receivable),
            r.reconciliation_status, r.remark || '',
            ...(EXT ? [r.exchange_status || '', r.exchange_topup || ''] : []),
        ];
        if (rowData.length !== HEADERS.length) {
            throw new Error(
                `Order Cycle row/header mismatch — row has ${rowData.length} values, ` +
                `HEADERS has ${HEADERS.length}. A column was added to HEADERS without ` +
                `adding its value to rowData (or vice versa).`
            );
        }
        const added = mainSheet.addRow(rowData);

        // Colour the Status cell so the sheet is scannable. AWAITING REMITTANCE
        // is deliberately amber rather than red or green: the money is collected
        // but its transfer is unconfirmed, and the row asserts neither.
        const fill = STATUS_FILL[r.reconciliation_status];
        if (fill) {
            const statusCell = added.getCell(HEADERS.indexOf('Status') + 1);
            statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
            if (r.reconciliation_status === 'UNREMITTED - QUERY') statusCell.font = { bold: true };
        }
    }

    // Column widths (32 cols: 25 original + 7 appended)
    const colMeta = [
        18, 20, 22, 22, 20, // A-E  (SaleOrderNo, Shopify, Invoice, AWB, ShippingPartner)
        22, 16,              // F-G  (DispatchDate, SumOfTotal)
        18, 20, 16, ...(EXT ? [14] : []), 16,  // ReturnDate, SRN, ReturnAmt, [RTOAmt], NetAmt
        22, 26, 16,          // L-N  (EkartRemitDate, EkartActualDate, EkartCOD)
        22, 16,              // O-P  (DelhiveryDate, DelhiveryCOD)
        22, 24, 16,          // Q-S  (XpressbeesDeliveryDate, XpressbeesTransDate, XpressbeesNetPay)
        22, 16,              // T-U  (SnapmintDate, SnapmintValue)
        22, 16,              // V-W  (BharatXTimestamp, BharatXLedger)
        22, 16,              // X-Y  (RazorpayDate, RazorpayAmount)
        16, 22, 22, 20,      // Z-AC (CourierCOD, CourierDelivDate, CourierRemitDate, CourierUTR)
        ...(EXT ? [16, 22, 14] : []),   // GatewayRefund, GatewayRefundDate, PaymentType
        18, 20, 18, 22, 70,  // AG-AK(DeliveryStatus, TotalSettled, Balance, Status, Remark)
        ...(EXT ? [26, 16] : []),      // Exchange, Exchange top-up
    ];
    // ── COLUMN ALIGNMENT GUARD ───────────────────────────────────────────────
    // Four things must stay the same length and order: the band labels, the
    // headers, the widths, and the per-row value array. Historically they drifted
    // one at a time and the workbook still built — the data just landed one column
    // to the left from that point on, which looks like a data bug, not a code bug,
    // and is invisible until an accountant queries a number. Fail loudly here
    // instead: a wrong report is worse than no report.
    if (SOURCE_ROW.length !== HEADERS.length || colMeta.length !== HEADERS.length) {
        throw new Error(
            `Order Cycle column mismatch — HEADERS ${HEADERS.length}, ` +
            `SOURCE_ROW ${SOURCE_ROW.length}, colMeta ${colMeta.length}. ` +
            `All three must match; a column was added to one and not the others.`
        );
    }

    mainSheet.columns.forEach((col, i) => { col.width = colMeta[i] || 18; });

    // Date format for date columns (1-based, offset by 1 for the source row)
    // These are column indices in the sheet
    // Formats are resolved BY COLUMN NAME, never by hardcoded index. Every time a
    // column was appended here, these arrays were the thing that silently went
    // stale — the sheet still built, it just formatted the wrong columns, which
    // no test catches and no error reports. Naming them means inserting a column
    // can no longer shift a format onto its neighbour.
    const DATE_COLS = [
        'Dispatch Date/Cancellation Date', 'Return Date',
        'Ekart remittance date', 'Ekart Actual Date of Remittance',
        'Delhivery delivery date', 'Xpressbees delivery date', 'Xpressbees transaction date',
        'Snapmint merchant settlement date', 'BharatX settlement timestamp', 'Razorpay settlement date',
        'Courier delivery date', 'Courier remittance date', 'Gateway refund date',
    ];
    const MONEY_COLS = [
        'Sum of Total', 'Return amount', 'RTO amount', 'Net amount',
        'Ekart COD amount', 'Delhivery COD amount', 'Xpressbees net payment',
        'Snapmint settlement value', 'BharatX ledger amount', 'Razorpay settlement amount',
        'Courier COD amount', 'Gateway refund', 'Exchange top-up',
        'Total settlement received', 'Balance receivable',
    ];
    const EXT_ONLY_COLS = new Set(['RTO amount', 'Gateway refund', 'Gateway refund date', 'Payment type', 'Exchange', 'Exchange top-up']);
    const applyFmt = (names, fmt) => {
        for (const name of names) {
            const idx = HEADERS.indexOf(name);
            // A renamed-away column is a bug worth seeing, not worth crashing on.
            // EXT-only columns are legitimately absent for other brands, so they
            // are skipped silently — a warning that fires on every ordinary run
            // teaches people to ignore the one that matters.
            if (idx === -1) {
                if (!EXT_ONLY_COLS.has(name)) console.warn(`[OrderCycleProcessor] format target "${name}" not in HEADERS`);
                continue;
            }
            mainSheet.getColumn(idx + 1).numFmt = fmt;
        }
    };
    applyFmt(DATE_COLS, 'dd-mmm-yyyy');
    applyFmt(MONEY_COLS, '#,##0.00');

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
        eshopboxStats,
        eshopboxCodStats,
        returnPrimeStats,
        parseStats
    };
}

module.exports = { orderCycleShopifyProcessor, parseExcelBuffer };
