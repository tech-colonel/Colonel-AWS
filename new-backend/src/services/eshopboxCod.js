/* ──────────────────────────────────────────────────────────────────────────────
   eshopboxCod.js — Eshopbox COD money → order rows.

   THE EVIDENCE IS ASYMMETRIC, AND THAT SHAPES EVERYTHING HERE
   Eshopbox will tell us, per order, exactly what is STILL OWED. It will not tell
   us, per order, what was PAID — ?status=PAID returns 0 rows, and every
   historical per-order route is 400 or 403 for this token. What it does give is
   a payout ledger: 103 payouts, 85 of them PAID, each with a real bank
   reference.

   So this module makes two different claims, and labels them differently:

     AWAITING  per-order proof. Eshopbox names the order and the amount.
               Treated exactly like a Velocity COD with no UTR: collected, not
               remitted, NOT counted as received.

     SETTLED   payout-level proof only. The order is a COD shipment Eshopbox
               carried, and Eshopbox no longer lists it as owed. The cash left
               with one of those 85 payouts; we cannot say which. Counted as
               received, with a remark that says the proof is aggregate.

   Overstating the second as an order-level receipt would repeat the Velocity
   remittance_date mistake — asserting money arrived because a system stopped
   asking for it.

   NET, NEVER GROSS
   Eshopbox deducts its fees before paying out: ₹11,56,221 collected against
   ₹11,07,503 received, so ₹48,718 never reached the bank. `paymentAmount` is
   the collection; `netAmount` is the money. Only netAmount is real.

   ONLY ESHOPBOX'S OWN SHIPMENTS
   Of 75 COD orders our report called unpaid on this lane, 48 (₹87,095) are
   Shiperfecto, not Eshopbox. Applying Eshopbox's silence to those would clear a
   receivable that Eshopbox was never holding — so rows are matched on
   shipping_platform, and anything else is left exactly as it was.
   ────────────────────────────────────────────────────────────────────────────── */

const PLATFORM = 'Eshopbox';

const norm = (v) => String(v ?? '').replace(/^#/, '').trim();
const num = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; };

/**
 * Index what Eshopbox says it still owes, plus a summary of what it has paid.
 *
 * @param {Array} codOrders  from fetchCodOrders() — awaiting only
 * @param {Array} payouts    from fetchCodPayouts()
 */
function buildLookup(codOrders = [], payouts = []) {
    const awaitingByOrder = {};
    const awaitingByAwb = {};
    let awaitingValue = 0;

    for (const o of codOrders) {
        if (!o) continue;
        const rec = {
            orderNo: norm(o.customerOrderId),
            awb: String(o.forwardTrackingId || '').trim(),
            codAmount: num(o.codAmount),
            status: String(o.status || '').trim(),
            deliveryDate: o.deliveryDate || null,
            expectedPaymentDate: o.paymentDate || null,
        };
        awaitingValue += rec.codAmount;
        if (rec.orderNo) awaitingByOrder[rec.orderNo] = rec;
        if (rec.awb) awaitingByAwb[rec.awb] = rec;
    }

    // A payout only proves anything once it is PAID. While ONGOING its
    // bankReferenceId literally reads "Settlement in progress" — a string, not a
    // reference — and treating it as one would book unpaid money as received.
    const paid = payouts.filter((p) => String(p.status || '').toUpperCase() === 'PAID');
    const paidNet = paid.reduce((s, p) => s + num(p.netAmount), 0);
    const paidGross = paid.reduce((s, p) => s + num(p.paymentAmount), 0);
    const dates = paid.map((p) => p.paymentDate).filter(Boolean).sort();
    const latest = paid
        .filter((p) => p.paymentDate === dates[dates.length - 1])
        .sort((a, b) => num(b.netAmount) - num(a.netAmount))[0] || null;

    return {
        awaitingByOrder,
        awaitingByAwb,
        payout: {
            total: payouts.length,
            paidCount: paid.length,
            ongoingCount: payouts.length - paid.length,
            paidGross: round2(paidGross),
            paidNet: round2(paidNet),
            feesKept: round2(paidGross - paidNet),
            firstPaidDate: dates[0] || null,
            lastPaidDate: dates[dates.length - 1] || null,
            lastBankReference: latest ? String(latest.bankReferenceId || '').trim() : null,
        },
        stats: {
            awaitingOrders: Object.keys(awaitingByOrder).length,
            awaitingValue: round2(awaitingValue),
        },
    };
}

function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

/**
 * Apply COD evidence onto master rows.
 *
 * Writes the same generic courier_* columns Velocity uses, so no new columns and
 * no processor changes beyond calling this. `eshopbox_cod_basis` records which
 * kind of evidence produced the row so the remark can be honest about it.
 *
 * @returns {object} counts for the preview warnings
 */
function applyToMasterRows(masterRows = [], lookup) {
    const out = { awaiting: 0, settled: 0, skippedOtherPlatform: 0, notCod: 0 };
    if (!lookup) return out;

    for (const row of masterRows) {
        // Eshopbox can only speak for shipments it carried.
        if (String(row.shipping_platform || '').trim() !== PLATFORM) { out.skippedOtherPlatform++; continue; }
        if (String(row.payment_type || '').toUpperCase() !== 'COD') { out.notCod++; continue; }

        const rec = (row.awb_number && lookup.awaitingByAwb[row.awb_number])
            || (row.sale_order_number && lookup.awaitingByOrder[String(row.sale_order_number).trim()]);

        if (rec) {
            // Per-order proof that this is still owed. No UTR ⇒ not received,
            // which is exactly how the processor already treats courier COD.
            row.courier_cod_amount = rec.codAmount;
            row.courier_delivery_date = rec.deliveryDate || row.courier_delivery_date;
            row.courier_remittance_date = rec.expectedPaymentDate || null;
            row.courier_utr = null;
            row.courier_source = PLATFORM;
            row.eshopbox_cod_basis = 'awaiting';
            out.awaiting++;
        } else {
            // Eshopbox carried it, it was COD, and Eshopbox does not list it as
            // outstanding — so the cash left inside one of the PAID payouts.
            // Counted as received (the receivable is not real), but flagged as
            // payout-level evidence so nobody mistakes it for a per-order receipt.
            row.courier_cod_amount = round2(row.net_amount);
            row.courier_source = PLATFORM;
            row.courier_utr = lookup.payout.lastBankReference || 'PAYOUT-LEVEL';
            row.courier_remittance_date = lookup.payout.lastPaidDate || null;
            row.eshopbox_cod_basis = 'settled_payout_level';
            out.settled++;
        }
    }
    return out;
}

module.exports = { PLATFORM, buildLookup, applyToMasterRows, round2 };
