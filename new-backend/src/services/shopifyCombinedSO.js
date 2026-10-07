/* ──────────────────────────────────────────────────────────────────────────────
   shopifyCombinedSO.js — build "Sales Order Combined" rows from the Shopify API.

   Drop-in replacement for the Combined SO spreadsheet upload, for brands with a
   live Shopify connection. Emits plain objects keyed by the SAME header names
   parseExcelBuffer produces, so orderCycleShopifyProcessor is untouched — it
   cannot tell the difference between these rows and parsed spreadsheet rows.

   WHY this exists: the FLO Combined SO export has its header row shifted one
   column left of the data from ~col 47 — `Cancelled at` holds payment methods,
   `Payment Method` holds the gateway receipt hash, and `Payment References`
   (which the processor reads for the settlement join) is empty in every row.
   Measured on that file: 0 of 69,980 Razorpay receipts matched, where 24,927
   should have. Building these rows from typed API fields makes that class of
   bug structurally impossible — there is no header row to drift.

   The processor reads salesOrderJson in exactly two places:
     • buildSalesOrderLookup  → 'Order No', 'Fulfillment Status', 'Cancelled at'
     • buildPaymentRefLookup  → 'Payment References', 'Order No'
   So those four keys are the entire contract. Everything else is for humans
   reading a debug dump.
   ────────────────────────────────────────────────────────────────────────────── */

const shopifyData = require('./shopifyData');

/* Note-attribute keys that carry a payment-gateway reference. D'chica settles
   through Cashfree and its checkout writes `Cashfree_txn_id`; the regex keeps
   this working if a brand switches gateway or the app renames the key. */
const REF_KEY_RE = /(txn|transaction|payment)[_-]?id$|receipt/i;

/** Pull the gateway reference out of an order's note attributes. */
function paymentReferenceOf(order) {
  for (const a of order.note_attributes || []) {
    if (REF_KEY_RE.test(a.name || '') && a.value) return String(a.value).trim();
  }
  return '';
}

/**
 * Map one Shopify order → one Combined SO row.
 *
 * `Cancelled at` carries the REAL cancellation timestamp here. In the broken
 * spreadsheet that column held payment-method names, which is why the
 * processor's cancelled-order detection could never have fired on that file.
 */
function toSalesOrderRow(order) {
  return {
    // ── the four keys the processor actually reads ──────────────────────────
    'Order No':           String(order.order_number ?? '').trim(),
    'Fulfillment Status': order.fulfillment_status || 'unfulfilled',
    'Cancelled at':       order.cancelled_at || '',
    'Payment References': paymentReferenceOf(order),

    // ── context for debug dumps; the processor ignores these ────────────────
    'Name':               order.name || '',
    'Payment Method':     (order.payment_gateway_names || []).join(', '),
    'Financial Status':   order.financial_status || '',
    'Created at':         order.created_at || '',
    'Total':              order.total_price ?? '',
    'Currency':           order.currency || '',
  };
}

/**
 * Build the full Combined SO row set for a brand.
 *
 * @param {string} brandId
 * @param {object} opts.since  ISO date (created_at_min)
 * @param {object} opts.until  ISO date (created_at_max)
 * @returns {Promise<{rows: object[], stats: object}>}
 */
async function buildSalesOrderRows(brandId, { since, until, maxPages = 1000 } = {}) {
  // status:'any' so cancelled orders arrive — they are exactly what the
  // delivery-status step needs to see, and dropping them would silently
  // reclassify cancelled orders as merely unfulfilled.
  const orders = await shopifyData.fetchOrders(brandId, { since, until, status: 'any', maxPages });
  const rows = orders.map(toSalesOrderRow);

  const withRef = rows.filter((r) => r['Payment References']).length;
  const cancelled = rows.filter((r) => r['Cancelled at']).length;

  return {
    rows,
    stats: {
      orders: rows.length,
      withPaymentReference: withRef,
      cancelled,
      fulfilled: rows.filter((r) => r['Fulfillment Status'] === 'fulfilled').length,
      // Surfaced so a caller can spot the failure mode that started all this:
      // a join key that is empty everywhere means settlements will match nothing.
      paymentReferenceCoverage: rows.length ? +(withRef / rows.length * 100).toFixed(1) : 0,
      window: { since: since || null, until: until || null },
    },
  };
}

module.exports = { buildSalesOrderRows, toSalesOrderRow, paymentReferenceOf };
