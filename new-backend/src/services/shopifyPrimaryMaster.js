/* ──────────────────────────────────────────────────────────────────────────────
   shopifyPrimaryMaster.js — build the Order Cycle master from Shopify orders.

   The agent normally builds every row from the Tally GST export, keyed on
   invoice number. D'Chicha has no Tally export, so without this the run
   produces zero rows: Step 1 iterates gstJson and nothing else creates a row.

   Rather than change Step 1, this synthesises rows in exactly the shape the
   GST report has. The processor cannot tell the difference, so Steps 1-14,
   the settlement matching, the status logic and the workbook all work
   untouched — and every other brand's Tally-driven path is unaffected.

   ── WHAT THIS ANSWERS, AND WHAT IT DOES NOT ─────────────────────────────────
   Answers:      what did we sell, what has been collected, what is still owed.
   Does NOT:     tie to a GST return. Shopify has no invoice number, no booked
                 taxable value and no HSN (verified: Receipt Number empty on all
                 399 sampled rows, 0 order metafields). Invoice numbers here are
                 SYNTHETIC (`SH/<order no>`) and must never be treated as tax
                 invoice numbers.

   Returns follow D'Chicha's accountant's own method — read Shopify, subtract the
   returned orders — so refunds become return rows and net_amount falls out of
   the processor's existing Step 2 rather than being computed a second way.
   ────────────────────────────────────────────────────────────────────────────── */

const shopifyData = require('./shopifyData');
const shopifyCombinedSO = require('./shopifyCombinedSO');

/** Marks a row as Shopify-derived rather than accounted. Kept short: it lands in
    the invoice_number column, which people read. */
const SYNTHETIC_INVOICE_PREFIX = 'SH/';

const money = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));

/* Which platform actually shipped it. tracking_company names the CARRIER
   (Delhivery), but the tracking URL host names the platform that booked it and
   therefore collects and remits the COD — velocityshipping.in, eshopbox.com,
   shiperfecto.com. That distinction decides whether we have a money feed. */
function shippingPlatform(fulfillment) {
  if (!fulfillment) return '';
  const url = fulfillment.tracking_url || (fulfillment.tracking_urls || [])[0] || '';
  try {
    const h = new URL(url).hostname.replace(/^www\./, '').split('.').slice(-2).join('.');
    if (/velocity/i.test(h)) return 'Velocity';
    if (/eshopbox/i.test(h)) return 'Eshopbox';
    if (/shiperfecto/i.test(h)) return 'Shiperfecto';
    return h || '';
  } catch { return ''; }
}

/** Total actually refunded on an order: refunded line items plus any order-level
    adjustment (shipping refunds, restocking, goodwill). */
function refundTotal(order) {
  return (order.refunds || []).reduce((sum, r) => {
    const lines = (r.refund_line_items || []).reduce((s, x) => s + money(x.subtotal), 0);
    const adj = (r.order_adjustments || []).reduce((s, x) => s + Math.abs(money(x.amount)), 0);
    return sum + lines + adj;
  }, 0);
}

/** One Shopify order → one GST-report-shaped master row. */
function toMasterRow(order) {
  const f = (order.fulfillments || [])[0] || null;
  const orderNo = String(order.order_number ?? '').trim();
  return {
    'Date': order.created_at || '',
    'Sale Order Number': orderNo,
    // Synthetic — Shopify issues no invoice number. Prefixed so it can never be
    // mistaken for a real one in the output.
    'Invoice number': `${SYNTHETIC_INVOICE_PREFIX}${orderNo}`,
    'Channel Ledger': 'Shopify',
    'Total': money(order.total_price),
    'AWB num': f ? (f.tracking_number || (f.tracking_numbers || [])[0] || '') : '',
    'Shipping Provider': f ? (f.tracking_company || '') : '',
    // Dispatch, or the cancellation date when the order never shipped — the
    // column the processor reads carries both meanings.
    'Dispatch Date/Cancellation Date': f ? (f.created_at || '') : (order.cancelled_at || ''),
    'Payment Method': /cash on delivery|cod/i.test((order.payment_gateway_names || []).join(','))
      ? 'COD' : 'PREPAID',
    'Shipping Platform': shippingPlatform(f),
  };
}

/**
 * One refunded Shopify order → one Return-GST-shaped row.
 *
 * Keyed on the same synthetic invoice number the master row carries, so the
 * processor's existing invoice-first matching finds it without touching the
 * AWB fallback. Channel is set to match, since Step 2 cross-checks it before
 * attributing a return to an invoice.
 */
function toReturnRow(order) {
  const amount = refundTotal(order);
  if (amount <= 0) return null;
  const orderNo = String(order.order_number ?? '').trim();
  const first = (order.refunds || [])[0] || {};
  return {
    'Date': first.created_at || order.updated_at || '',
    'Original Invoice No': `${SYNTHETIC_INVOICE_PREFIX}${orderNo}`,
    'Invoice number': `${SYNTHETIC_INVOICE_PREFIX}R${orderNo}`,   // acts as the SRN
    'Channel Ledger': 'Shopify',
    'Total': amount,
    'AWB num': ((order.fulfillments || [])[0] || {}).tracking_number || '',
  };
}

/**
 * Build both sets from one Shopify pull.
 *
 * status:'any' so cancelled orders arrive — they must appear and be marked
 * CANCELLED rather than silently vanish from the period's sales.
 */
async function buildFromShopify(brandId, { since, until, maxPages = 1000 } = {}) {
  const orders = await shopifyData.fetchOrders(brandId, { since, until, status: 'any', maxPages });

  const master = orders.map(toMasterRow);
  const returns = orders.map(toReturnRow).filter(Boolean);
  // The Sales Order rows come from the SAME orders — deriving them here avoids a
  // second full Shopify pull, which on a month of D'Chicha is ~19 extra paginated
  // requests for data we already hold.
  const salesOrder = orders.map(shopifyCombinedSO.toSalesOrderRow);

  const gross = orders.reduce((s, o) => s + money(o.total_price), 0);
  const returned = returns.reduce((s, r) => s + r['Total'], 0);

  return {
    master,
    returns,
    salesOrder,
    stats: {
      orders: master.length,
      cancelled: orders.filter((o) => o.cancelled_at).length,
      withAwb: master.filter((r) => r['AWB num']).length,
      cod: master.filter((r) => r['Payment Method'] === 'COD').length,
      prepaid: master.filter((r) => r['Payment Method'] === 'PREPAID').length,
      returnedOrders: returns.length,
      // The accountant's own figures: Shopify gross, less returns.
      grossSales: Number(gross.toFixed(2)),
      returnValue: Number(returned.toFixed(2)),
      netSales: Number((gross - returned).toFixed(2)),
      window: { since: since || null, until: until || null },
    },
  };
}

module.exports = { buildFromShopify, toMasterRow, toReturnRow, refundTotal, SYNTHETIC_INVOICE_PREFIX };
