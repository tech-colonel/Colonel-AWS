/* ──────────────────────────────────────────────────────────────────────────────
   returnPrimeExchanges.js — Return Prime requests → two display-only columns.

   DISPLAY ONLY, DELIBERATELY.
   This writes `exchange_status` and `exchange_topup` and nothing else. It must
   never touch sales_amount, return_amount, rto_amount or net_amount:

     • An exchange returns goods and sends different goods out. The money stays.
       Deducting it from net sales would understate revenue for a sale that was
       never reversed.
     • D'Chicha's actual returns already come from Velocity and Shopify, which
       report them directly. Return Prime is a different population — its portal.
       Its silence about a return is not evidence that the return did not happen.

   THE TOP-UP IS REAL MONEY WE OTHERWISE CANNOT SEE
   payment_details on an exchange records a customer paying the price difference,
   and the gateway is RAZORPAY — which no feed in this report pulls. So the
   top-up column is the only place that revenue appears at all. It is shown, not
   added to settlements, because we have no Razorpay settlement data to prove it
   reached the bank; asserting receipt from a gateway's own "successful" flag
   would repeat the Velocity remittance_date mistake.
   ────────────────────────────────────────────────────────────────────────────── */

const norm = (v) => String(v ?? '').replace(/^#/, '').trim();
const num = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; };

/** Index requests by the order number our rows are keyed on. */
function buildLookup(requests = []) {
    const byOrder = {};
    const stats = { total: 0, exchanges: 0, returns: 0, withTopup: 0, topupValue: 0, gateways: {}, statuses: {} };

    for (const r of requests) {
        if (!r) continue;
        stats.total++;
        const type = String(r.request_type || '').toLowerCase();
        if (type === 'exchange') stats.exchanges++;
        else if (type === 'return') stats.returns++;
        stats.statuses[r.status || '(none)'] = (stats.statuses[r.status || '(none)'] || 0) + 1;

        const orderNo = norm(r.order && r.order.name);
        if (!orderNo) continue;

        const pd = r.payment_details || {};
        // Only a successful payment is a top-up. A pending or failed one is a
        // customer who has not paid, and showing it as money would be a lie of
        // the same shape as counting unremitted COD.
        const paid = String(pd.status || '').toLowerCase() === 'successful';
        const topup = paid ? num(pd.amount) : 0;
        if (topup > 0) {
            stats.withTopup++;
            stats.topupValue += topup;
            const gw = String(pd.gateway || 'unknown').toLowerCase();
            stats.gateways[gw] = (stats.gateways[gw] || 0) + topup;
        }

        // One order can carry several requests; keep them all rather than
        // letting the last one silently win.
        (byOrder[orderNo] ||= []).push({
            requestNumber: r.request_number || null,
            type: type || 'unknown',
            status: r.status || null,
            topup,
            gateway: paid ? (pd.gateway || null) : null,
        });
    }

    stats.topupValue = Math.round(stats.topupValue * 100) / 100;
    return { byOrder, stats };
}

/**
 * Write the two display columns onto master rows.
 *
 * Returns counts only — no money field is read or written here, which is what
 * makes this safe to run regardless of how the rest of the report is computed.
 */
function applyToMasterRows(masterRows = [], lookup) {
    const applied = { matched: 0, exchanges: 0, returns: 0, topupRows: 0, topupValue: 0 };
    if (!lookup) return applied;

    for (const row of masterRows) {
        const reqs = lookup.byOrder[String(row.sale_order_number || '').trim()];
        if (!reqs || !reqs.length) continue;
        applied.matched++;

        // "exchange (approved)" or, when an order has several, "exchange ×2 (approved, requested)"
        const types = [...new Set(reqs.map((r) => r.type))];
        const statuses = [...new Set(reqs.map((r) => r.status).filter(Boolean))];
        const label = reqs.length > 1
            ? `${types.join('/')} ×${reqs.length}`
            : types[0];
        row.exchange_status = statuses.length ? `${label} (${statuses.join(', ')})` : label;
        row.exchange_ref = reqs.map((r) => r.requestNumber).filter(Boolean).join(', ') || null;

        const topup = reqs.reduce((s, r) => s + r.topup, 0);
        row.exchange_topup = topup > 0 ? Math.round(topup * 100) / 100 : 0;
        row.exchange_gateway = reqs.find((r) => r.gateway)?.gateway || null;

        if (types.includes('exchange')) applied.exchanges++;
        if (types.includes('return')) applied.returns++;
        if (topup > 0) { applied.topupRows++; applied.topupValue += topup; }
    }
    applied.topupValue = Math.round(applied.topupValue * 100) / 100;
    return applied;
}

module.exports = { buildLookup, applyToMasterRows };
