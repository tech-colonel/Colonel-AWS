/* ──────────────────────────────────────────────────────────────────────────────
   velocityReturns.js — Velocity reverse-logistics returns → Return-GST rows.

   WHY THIS EXISTS
   D'Chicha's returns were being read from Shopify refunds alone (see
   shopifyPrimaryMaster.toReturnRow). That only sees a return if somebody also
   clicked Refund inside Shopify. Measured on August 2026: Shopify carried 7
   refunds worth ₹11,478 while Velocity's own returns feed held 285 returns.
   The accountant's description of reality — "direct returns show on Shopify,
   the rest sit with the logistics and payment partners" — is exactly right, and
   this module is the logistics lane.

   THE JOIN
   Velocity's `display_id` is "<order number>-R<n>" ("111770-R1"), so the order
   number joins straight onto the synthetic invoice the master row already
   carries (`SH/111770`). Verified against the live August report: 7 of 10
   sampled display_ids matched; the 3 that didn't were 113xxx orders placed
   after the window closed, which is correct behaviour, not a miss.

   TWO TRAPS, BOTH LOAD-BEARING
   1. `shipment.tracking_number` on a return is the REVERSE waybill, not the
      forward one. The processor's returnCandidateMatches() rejects a candidate
      whose AWB contradicts the row's, so writing it into 'AWB num' would make
      every Velocity return silently vanish. The field is deliberately left
      blank — `awbOk = !candidate.awb || …` passes on empty — and matching runs
      on the invoice number, which is the precise key anyway.
   2. An EXCHANGE returns goods but no money. Counting it as a return would
      understate net sales for an order that was, in cash terms, never
      reversed. Exchanges are parsed and reported separately, never summed into
      the return amount.
   ────────────────────────────────────────────────────────────────────────────── */

const SYNTHETIC_INVOICE_PREFIX = 'SH/';

/** Return statuses that represent goods genuinely coming back to the warehouse.
    A cancelled or rejected return reverses nothing and must not reduce sales.
    Anything unrecognised is treated as live (counted) and surfaced in the
    summary — a new Velocity status should show up as a number to explain, not
    silently drop money out of the reconciliation. */
const DEAD_RETURN_STATUSES = new Set([
    'cancelled', 'canceled', 'rejected', 'declined', 'expired', 'closed_unfulfilled',
]);

function isLive(status) {
    return !DEAD_RETURN_STATUSES.has(String(status || '').trim().toLowerCase());
}

/** "111770-R1" → { orderNo: '111770', seq: 1 }. Returns null when the shape
    isn't recognised, so an unexpected id is skipped and counted rather than
    joined onto the wrong order.

    Three id shapes appear in live D'Chicha data and all three are real, so the
    pattern covers each rather than assuming the documented one:
      "111770-R1"     the common form
      "#109638-R1"    leading hash
      "109613-R1-1"   a re-attempt suffix after a failed pickup
    A regex anchored on only the first shape dropped 3 returns silently, one of
    them live and worth ₹1,149. */
function parseDisplayId(displayId) {
    const m = /^#?(\d+)-R(\d+)(?:-(\d+))?$/i.exec(String(displayId || '').trim());
    if (!m) return null;
    return { orderNo: m[1], seq: Number(m[2]), attempt: m[3] ? Number(m[3]) : null };
}

function money(v) {
    const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
}

/**
 * One Velocity return → one Return-GST-shaped row, or null when it should not
 * reduce sales (unparseable id, exchange, dead status, zero value).
 *
 * Shaped to match shopifyPrimaryMaster.toReturnRow exactly so both lanes feed
 * the processor's existing invoice-first matching with no processor changes.
 */
function toReturnRow(ret) {
    const a = (ret && ret.attributes) || {};
    const parsed = parseDisplayId(a.display_id);
    if (!parsed) return null;
    if (a.is_exchange) return null;
    if (!isLive(a.status)) return null;

    const amount = money(a.total_price);
    if (amount <= 0) return null;

    return {
        'Date': a.request_date || a.created_at || '',
        'Original Invoice No': `${SYNTHETIC_INVOICE_PREFIX}${parsed.orderNo}`,
        // Velocity's own display_id is a real SRN — better than a synthesised one,
        // because the accountant can paste it into the Velocity portal.
        'Invoice number': String(a.display_id).trim(),
        'Channel Ledger': 'Shopify',
        'Total': amount,
        // Deliberately blank — see trap 1 in the header.
        'AWB num': '',
    };
}

/**
 * Merge Velocity returns with the Shopify refund rows.
 *
 * An order refunded in Shopify AND returned through Velocity is ONE reversal,
 * not two. Velocity wins on collision: it is the system the goods physically
 * move through, it carries a real SRN, and its value is the returned goods
 * rather than whatever partial refund was keyed into Shopify.
 *
 * @param {Array} shopifyReturnRows rows from shopifyPrimaryMaster
 * @param {Array} velocityReturns   raw Velocity return records
 * @returns {{ rows: Array, summary: object }}
 */
function mergeWithShopifyReturns(shopifyReturnRows = [], velocityReturns = []) {
    const velRows = [];
    const summary = {
        velocityTotal: velocityReturns.length,
        mapped: 0, exchanges: 0, deadStatus: 0, unparseable: 0, zeroValue: 0,
        supersededShopify: 0, shopifyKept: 0, velocityValue: 0,
        statuses: {},
    };

    for (const ret of velocityReturns) {
        const a = (ret && ret.attributes) || {};
        const st = String(a.status || '(none)').trim();
        summary.statuses[st] = (summary.statuses[st] || 0) + 1;

        const row = toReturnRow(ret);
        if (row) {
            velRows.push(row);
            summary.mapped++;
            summary.velocityValue += row.Total;
            continue;
        }
        if (!parseDisplayId(a.display_id)) summary.unparseable++;
        else if (a.is_exchange) summary.exchanges++;
        else if (!isLive(a.status)) summary.deadStatus++;
        else summary.zeroValue++;
    }

    // Collision key is the original invoice, which is what the processor matches on.
    const velInvoices = new Set(velRows.map(r => r['Original Invoice No']));
    const keptShopify = shopifyReturnRows.filter(r => {
        const dup = velInvoices.has(r['Original Invoice No']);
        if (dup) summary.supersededShopify++;
        return !dup;
    });
    summary.shopifyKept = keptShopify.length;

    return { rows: [...keptShopify, ...velRows], summary };
}

module.exports = {
    SYNTHETIC_INVOICE_PREFIX,
    DEAD_RETURN_STATUSES,
    isLive,
    parseDisplayId,
    toReturnRow,
    mergeWithShopifyReturns,
};
