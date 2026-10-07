/* ──────────────────────────────────────────────────────────────────────────────
   eshopboxTracking.js — Eshopbox tracking records → delivery status + returns.

   Kept separate from eshopboxClient.js on purpose: the client speaks HTTP and
   knows nothing about reports, this maps its output into the shapes the Order
   Cycle processor already understands. That split is what will let a future
   nightly job store raw tracking rows and have this mapper read them from the DB
   instead of the API, with no change here.

   THE POINT OF THIS FILE
   The processor has always had the branch:

       if (row.delivery_status === 'RTO') row.reconciliation_status = 'RTO';

   It had simply never fired, because nothing could set 'RTO'. Shopify's
   fulfillment_status only says fulfilled/unfulfilled, and Velocity's COD feed
   carries no status at all. So the RTO tile read 0 — not because there were no
   RTOs, but because the report had no way to learn about one. This is the data
   that makes an existing branch work; it is not new reconciliation logic.
   ────────────────────────────────────────────────────────────────────────────── */

const SYNTHETIC_INVOICE_PREFIX = 'SH/';

/** Statuses meaning the parcel is coming back / came back undelivered.
    Compared lowercase: the API returns "rto" while the docs print "RTO", and a
    case-sensitive check against the documented spelling matches nothing. */
const RTO_STATUSES = new Set(['rto', 'rto_delivered', 'rto_intransit', 'rto_in_transit']);

/** Delivered to the customer. */
const DELIVERED_STATUSES = new Set(['delivered']);

/** Lost/damaged in transit — the goods are gone and no money is coming. */
const LOST_STATUSES = new Set(['lost', 'damaged']);

/** A delivery attempt failed. NOT yet an RTO — it becomes one in a few days if
    unresolved. Surfaced as an early warning rather than folded into RTO, because
    calling it RTO now would write off money that may still be collected. */
const FAILED_STATUSES = new Set(['failed_delivery', 'undelivered']);

const norm = (s) => String(s || '').trim().toLowerCase();

/** "#113334" → "113334". The API prefixes the order number with a hash; our
    master rows do not. */
function normalizeOrderNo(v) {
    return String(v ?? '').replace(/^#/, '').trim();
}

function classify(status) {
    const s = norm(status);
    if (RTO_STATUSES.has(s)) return 'RTO';
    if (DELIVERED_STATUSES.has(s)) return 'DELIVERED';
    if (LOST_STATUSES.has(s)) return 'LOST';
    if (FAILED_STATUSES.has(s)) return 'FAILED_DELIVERY';
    return null;   // in transit, packed, picked up — nothing to assert yet
}

/**
 * Index tracking records by AWB and by order number.
 *
 * Two keys because both are usable and neither is complete: an AWB can be missing
 * from our master while the order number is present, and vice versa. AWB is tried
 * first — it is the more precise key, since one order can carry several shipments.
 *
 * `journeyType: 'return'` rows are indexed separately: those describe a parcel
 * travelling BACK, so their trackingId is a reverse waybill and must never be
 * matched against a forward AWB.
 */
function buildLookup(trackingRows = []) {
    const byAwb = {};
    const byOrder = {};
    const returns = [];
    const stats = { total: 0, forward: 0, reverse: 0, rto: 0, delivered: 0, lost: 0, failed: 0, statuses: {} };

    for (const t of trackingRows) {
        if (!t) continue;
        stats.total++;
        const status = norm(t.currentStatus);
        stats.statuses[status || '(none)'] = (stats.statuses[status || '(none)'] || 0) + 1;

        const kind = classify(status);
        if (kind === 'RTO') stats.rto++;
        else if (kind === 'DELIVERED') stats.delivered++;
        else if (kind === 'LOST') stats.lost++;
        else if (kind === 'FAILED_DELIVERY') stats.failed++;

        const rec = {
            awb: String(t.trackingId || '').trim(),
            rtoAwb: String(t.rtoTrackingId || '').trim() || null,
            orderNo: normalizeOrderNo(t.customerOrderNumber),
            status,
            kind,
            journeyType: norm(t.journeyType) || 'forward',
            date: t.dateTime || null,
            courier: t.courierPartnerName || '',
        };

        if (rec.journeyType === 'return') {
            stats.reverse++;
            returns.push(rec);
            continue;                     // reverse waybill — never index as forward
        }
        stats.forward++;
        if (rec.awb) byAwb[rec.awb] = rec;
        if (rec.orderNo && !byOrder[rec.orderNo]) byOrder[rec.orderNo] = rec;
    }

    return { byAwb, byOrder, returns, stats };
}

/**
 * Apply Eshopbox delivery status onto master rows.
 *
 * Only fills a status the row does not already have from a more authoritative
 * source, EXCEPT for RTO/LOST — those always win. A parcel Shopify marked
 * "fulfilled" and Eshopbox says came back is an RTO; deferring to Shopify there
 * is exactly the bug this exists to fix.
 *
 * @returns {object} counts of what changed, for the preview warnings
 */
function applyToMasterRows(masterRows = [], lookup) {
    const applied = { rto: 0, lost: 0, delivered: 0, failed: 0, matched: 0, unmatched: 0 };
    if (!lookup) return applied;

    for (const row of masterRows) {
        const rec = (row.awb_number && lookup.byAwb[row.awb_number])
            || (row.sale_order_number && lookup.byOrder[String(row.sale_order_number).trim()]);
        if (!rec) { applied.unmatched++; continue; }
        applied.matched++;

        row.eshopbox_status = rec.status;
        row.eshopbox_journey = rec.journeyType;

        if (rec.kind === 'RTO') {
            // Overrides whatever Shopify said — see the note above.
            row.delivery_status = 'RTO';
            applied.rto++;
        } else if (rec.kind === 'LOST') {
            row.delivery_status = 'LOST';
            applied.lost++;
        } else if (rec.kind === 'DELIVERED') {
            if (!row.delivery_status) row.delivery_status = 'DELIVERED';
            applied.delivered++;
        } else if (rec.kind === 'FAILED_DELIVERY') {
            applied.failed++;   // recorded, not asserted as a delivery outcome
        }
    }
    return applied;
}

/**
 * Reverse journeys → Return-GST-shaped rows, same shape as velocityReturns and
 * shopifyPrimaryMaster so the processor's invoice-first matching handles them
 * with no processor change.
 *
 * 'AWB num' is deliberately blank: the trackingId on a return row is the REVERSE
 * waybill, and the processor's returnCandidateMatches() rejects a candidate whose
 * AWB contradicts the master row's forward AWB — writing it in would make every
 * Eshopbox return silently vanish. Same trap as the Velocity mapper.
 *
 * Value is NOT invented here. Eshopbox tracking carries no amount, so the return
 * row is emitted with Total 0 and the processor keeps the sale at full value;
 * these rows mark THAT a return happened, and the amount must come from a feed
 * that actually reports money (Return Prime, or the Eshopbox returns API).
 */
function toReturnRows(lookup) {
    if (!lookup || !lookup.returns.length) return [];
    const out = [];
    for (const r of lookup.returns) {
        if (!r.orderNo) continue;
        out.push({
            'Date': r.date || '',
            'Original Invoice No': `${SYNTHETIC_INVOICE_PREFIX}${r.orderNo}`,
            'Invoice number': `ESB/R${r.orderNo}`,
            'Channel Ledger': 'Shopify',
            'Total': 0,
            'AWB num': '',
        });
    }
    return out;
}

module.exports = {
    SYNTHETIC_INVOICE_PREFIX,
    RTO_STATUSES, DELIVERED_STATUSES, LOST_STATUSES, FAILED_STATUSES,
    normalizeOrderNo, classify, buildLookup, applyToMasterRows, toReturnRows,
};
