/* ──────────────────────────────────────────────────────────────────────────────
   shopifyData.js — one reader per scope our Shopify app requests.

   Covers all 30 scopes. Roughly two-thirds are reachable over REST; the rest
   exist ONLY on the GraphQL Admin API (returns, companies, store credit,
   markets, publications, inventory transfers/shipments, order edits) — which is
   precisely the set Composio has no tool for, and the reason this module exists.

   Everything is brand-scoped through shopifyClient, which resolves the brand's
   own token. There is no code path here that can read another brand's store.

   ORDERS are the important one. fetchOrders() returns Shopify's full order
   object — id, name/order_number, line_items, tax_lines, shipping_lines,
   discounts, refunds, fulfillments (AWB + courier), transactions (gateway) —
   because shopify_order_cycle needs the whole order-to-cash chain, not a subset.
   ────────────────────────────────────────────────────────────────────────────── */

const c = require('./shopifyClient');

/* Full field list — Shopify omits anything not named, and a missing field here
   silently becomes a NULL column downstream, so this list is the contract. */
const ORDER_FIELDS = [
  'id', 'name', 'order_number', 'created_at', 'processed_at', 'updated_at',
  'cancelled_at', 'closed_at', 'currency', 'presentment_currency',
  'financial_status', 'fulfillment_status', 'confirmed', 'test',
  'subtotal_price', 'total_price', 'total_tax', 'total_discounts',
  'total_outstanding', 'total_shipping_price_set', 'current_total_price',
  'taxes_included', 'tax_lines', 'shipping_lines', 'discount_codes', 'discount_applications',
  'line_items', 'refunds', 'fulfillments', 'shipping_address', 'billing_address',
  'customer', 'email', 'phone', 'payment_gateway_names', 'gateway',
  'source_name', 'tags', 'note', 'note_attributes', 'cancel_reason',
  'location_id', 'app_id', 'checkout_id', 'landing_site', 'referring_site',
].join(',');

/* ── ORDERS (read_orders + read_all_orders) ─────────────────────────────────── */
/**
 * Every order in a window, fully hydrated.
 * @param {object} opts.since  ISO date — created_at_min
 * @param {object} opts.until  ISO date — created_at_max
 * @param {string} opts.status 'any' (default) so cancelled/closed orders come too
 *                             — a reco that silently drops cancellations is wrong.
 */
async function fetchOrders(brandId, { since, until, status = 'any', limit = 250, maxPages = 1000, onPage } = {}) {
  return c.restPaginate(brandId, 'orders.json', 'orders', {
    limit, maxPages, onPage,
    query: {
      status,
      fields: ORDER_FIELDS,
      created_at_min: since || undefined,
      created_at_max: until || undefined,
    },
  });
}

/** Total order count (cheap — use before a big pull to size the job). */
async function countOrders(brandId, { since, until, status = 'any' } = {}) {
  const b = await c.rest(brandId, 'orders/count.json', {
    query: { status, created_at_min: since || undefined, created_at_max: until || undefined },
  });
  return b.count ?? 0;
}

/** Transactions for one order — gateway, amount, status, settlement reference. */
async function fetchOrderTransactions(brandId, orderId) {
  const b = await c.rest(brandId, `orders/${orderId}/transactions.json`);
  return b.transactions || [];
}

/** Refunds for one order (also embedded in fetchOrders' `refunds`). */
async function fetchOrderRefunds(brandId, orderId) {
  const b = await c.rest(brandId, `orders/${orderId}/refunds.json`);
  return b.refunds || [];
}

/* ── read_order_edits — GraphQL only ────────────────────────────────────────── */
async function fetchOrderEdits(brandId, orderGid) {
  const q = `query($id: ID!) { order(id: $id) {
      id name
      events(first: 50, query: "verb:edit") { edges { node { id message createdAt } } }
    } }`;
  const d = await c.graphql(brandId, q, { id: orderGid });
  return (d.order?.events?.edges || []).map((e) => e.node);
}

/* ── read_draft_orders ──────────────────────────────────────────────────────── */
async function fetchDraftOrders(brandId, { limit = 250, maxPages = 200 } = {}) {
  return c.restPaginate(brandId, 'draft_orders.json', 'draft_orders', { limit, maxPages });
}

/* ── read_returns — GraphQL only, no REST equivalent ────────────────────────── */
/**
 * Returns (RMA) across orders. This is the scope Composio cannot reach at all,
 * and it matters: a return reverses taxable value, so GST reco is wrong without it.
 */
async function fetchReturns(brandId, { first = 100, maxPages = 500 } = {}) {
  const q = `query($first: Int!, $after: String) {
    orders(first: $first, after: $after, query: "return_status:in_progress OR return_status:returned") {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id name createdAt
        returns(first: 20) { edges { node {
          id name status totalQuantity
          returnLineItems(first: 50) { edges { node {
            __typename
            ... on ReturnLineItem {
              id quantity returnReasonNote
              fulfillmentLineItem { lineItem { id sku name quantity } }
            }
          } } }
        } } }
      } }
    } }`;
  return c.graphqlPaginate(brandId, q, { first }, (d) => d.orders, { maxPages });
}

/* ── read_products ──────────────────────────────────────────────────────────── */
async function fetchProducts(brandId, { limit = 250, maxPages = 500 } = {}) {
  return c.restPaginate(brandId, 'products.json', 'products', {
    limit, maxPages,
    query: { fields: 'id,title,handle,vendor,product_type,status,tags,created_at,updated_at,variants,options,image' },
  });
}

/* ── read_customers ─────────────────────────────────────────────────────────── */
async function fetchCustomers(brandId, { limit = 250, maxPages = 500 } = {}) {
  return c.restPaginate(brandId, 'customers.json', 'customers', { limit, maxPages });
}

/* ── read_companies (B2B) — GraphQL only ────────────────────────────────────── */
async function fetchCompanies(brandId, { first = 100, maxPages = 100 } = {}) {
  const q = `query($first: Int!, $after: String) {
    companies(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges { node { id name externalId createdAt
        locations(first: 10) { edges { node { id name taxRegistrationId
          billingAddress { address1 city province zip countryCode } } } } } }
    } }`;
  return c.graphqlPaginate(brandId, q, { first }, (d) => d.companies, { maxPages });
}

/* ── read_payment_terms ─────────────────────────────────────────────────────── */
async function fetchPaymentTerms(brandId) {
  const q = `{ paymentTermsTemplates { id name paymentTermsType dueInDays translatedName } }`;
  const d = await c.graphql(brandId, q);
  return d.paymentTermsTemplates || [];
}

/* ── read_shopify_payments_* (4 scopes) ─────────────────────────────────────── */
/**
 * Shopify Payments endpoints return 404 for shops that don't use Shopify Payments
 * at all — which is most Indian D2C brands (D'chica settles via Cashfree + COD).
 * That is a fact about the merchant, not an error, so we return [] rather than
 * throw; callers can tell "no payouts" from "call failed" via notEnabled.
 */
const payments404 = async (fn) => {
  try { return { rows: await fn(), notEnabled: false }; }
  catch (e) {
    if (e.status === 404) return { rows: [], notEnabled: true };
    throw e;
  }
};

/** Payouts — gross, fees, net, and the date money actually lands in the bank. */
async function fetchPayouts(brandId, { since, until, limit = 250, maxPages = 200 } = {}) {
  return payments404(() => c.restPaginate(brandId, 'shopify_payments/payouts.json', 'payouts', {
    limit, maxPages, query: { date_min: since || undefined, date_max: until || undefined },
  }));
}
/** Per-transaction balance movements behind each payout (the fee detail). */
async function fetchBalanceTransactions(brandId, payoutId, { limit = 250, maxPages = 200 } = {}) {
  return c.restPaginate(brandId, 'shopify_payments/balance/transactions.json', 'transactions', {
    limit, maxPages, query: { payout_id: payoutId || undefined },
  });
}
async function fetchDisputes(brandId, { limit = 250, maxPages = 50 } = {}) {
  return payments404(() => c.restPaginate(brandId, 'shopify_payments/disputes.json', 'disputes', { limit, maxPages }));
}
async function fetchPaymentsAccount(brandId) {
  const q = `{ shopifyPaymentsAccount { id activated country defaultCurrency
      payoutSchedule { interval monthlyAnchor weeklyAnchor }
      bankAccounts(first: 10) { edges { node { id accountNumberLastDigits bankName country status } } } } }`;
  const d = await c.graphql(brandId, q);
  return d.shopifyPaymentsAccount || null;
}

/* ── read_gift_cards + read_gift_card_transactions ──────────────────────────── */
async function fetchGiftCards(brandId, { limit = 250, maxPages = 100 } = {}) {
  return c.restPaginate(brandId, 'gift_cards.json', 'gift_cards', { limit, maxPages });
}

/* ── read_store_credit_* — GraphQL only ─────────────────────────────────────── */
/** Store credit is a LIABILITY until redeemed — it is not revenue. */
async function fetchStoreCredit(brandId, { first = 100, maxPages = 200 } = {}) {
  const q = `query($first: Int!, $after: String) {
    customers(first: $first, after: $after, query: "store_credit_balance:>0") {
      pageInfo { hasNextPage endCursor }
      edges { node { id displayName
        storeCreditAccounts(first: 5) { edges { node { id
          balance { amount currencyCode }
          transactions(first: 50) { edges { node {
            __typename createdAt amount { amount currencyCode }
            balanceAfterTransaction { amount currencyCode } } } }
        } } } } }
    } }`;
  return c.graphqlPaginate(brandId, q, { first }, (d) => d.customers, { maxPages });
}

/* ── read_fulfillments + the 3 fulfillment-order scopes ─────────────────────── */
async function fetchFulfillmentOrders(brandId, orderId) {
  const b = await c.rest(brandId, `orders/${orderId}/fulfillment_orders.json`);
  return b.fulfillment_orders || [];
}

/* ── read_inventory + transfers + shipments ─────────────────────────────────── */
/**
 * Inventory levels. Shopify REJECTS this endpoint with 422 unless you scope it
 * to location_ids or inventory_item_ids, so when the caller gives neither we
 * resolve the shop's locations first and ask for all of them.
 */
async function fetchInventoryLevels(brandId, { locationIds, limit = 250, maxPages = 500 } = {}) {
  let ids = locationIds;
  if (!ids || (Array.isArray(ids) && !ids.length)) {
    ids = (await fetchLocations(brandId)).map((l) => l.id);
  }
  if (!ids.length) return [];
  return c.restPaginate(brandId, 'inventory_levels.json', 'inventory_levels', {
    limit, maxPages, query: { location_ids: Array.isArray(ids) ? ids.join(',') : ids },
  });
}
/** Interstate stock transfers ARE a GST event for multistate brands. GraphQL only. */
async function fetchInventoryTransfers(brandId, { first = 50, maxPages = 100 } = {}) {
  const q = `query($first: Int!, $after: String) {
    inventoryTransfers(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges { node { id name status dateCreated totalQuantity receivedQuantity
        origin { __typename } destination { __typename }
        lineItems(first: 100) { edges { node { id title
          totalQuantity shippedQuantity
          inventoryItem { id sku } } } } } }
    } }`;
  return c.graphqlPaginate(brandId, q, { first }, (d) => d.inventoryTransfers, { maxPages });
}

/* ── read_locations · read_shipping · read_publications · read_markets ──────── */
async function fetchLocations(brandId) {
  const b = await c.rest(brandId, 'locations.json');
  return b.locations || [];
}
async function fetchShippingZones(brandId) {
  const b = await c.rest(brandId, 'shipping_zones.json');
  return b.shipping_zones || [];
}
async function fetchPublications(brandId, { first = 50 } = {}) {
  const q = `query($first: Int!) { publications(first: $first) {
      edges { node { id name supportsFuturePublishing } } } }`;
  const d = await c.graphql(brandId, q, { first });
  return (d.publications?.edges || []).map((e) => e.node);
}
/** Markets — export sales get zero-rated / IGST treatment. */
async function fetchMarkets(brandId, { first = 50 } = {}) {
  const q = `query($first: Int!) { markets(first: $first) {
      edges { node { id name handle enabled
        regions(first: 50) { edges { node { __typename
          ... on MarketRegionCountry { code name } } } } } } } }`;
  const d = await c.graphql(brandId, q, { first });
  return (d.markets?.edges || []).map((e) => e.node);
}

/* ── read_price_rules + read_discounts ──────────────────────────────────────── */
async function fetchPriceRules(brandId, { limit = 250, maxPages = 100 } = {}) {
  return c.restPaginate(brandId, 'price_rules.json', 'price_rules', { limit, maxPages });
}

/* ── shopify_order_cycle mapping ────────────────────────────────────────────── */
const money = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/**
 * Map one Shopify order onto a shopify_order_cycle row.
 *
 * Only the columns Shopify can actually answer are filled. The courier and
 * gateway settlement columns (ekart_*, delhivery_*, xpressbees_*, snapmint_*,
 * bharatx_*, razorpay_*) stay NULL by design — that data lives in courier and
 * payment-gateway reports, not in Shopify, and this agent joins them later.
 *
 * D'chica settles through Cashfree/COD rather than Shopify Payments, so the
 * settlement side genuinely has to come from those reports.
 */
function toOrderCycleRow(order, { brandId, createdBy = null } = {}) {
  const created = order.created_at ? new Date(order.created_at) : null;
  const f = (order.fulfillments || [])[0] || null;
  const refunds = order.refunds || [];

  // A refund's value is the sum of its line items + shipping, net of tax already
  // included in those amounts. Shopify does not hand back a single "refund total".
  const returnAmount = refunds.reduce((sum, r) => {
    const li = (r.refund_line_items || []).reduce((s, x) => s + Number(x.subtotal || 0), 0);
    const adj = (r.order_adjustments || []).reduce((s, x) => s + Math.abs(Number(x.amount || 0)), 0);
    return sum + li + adj;
  }, 0);

  const total = money(order.total_price) ?? 0;

  return {
    brand_id: brandId,
    month: created ? created.getMonth() + 1 : null,
    year: created ? created.getFullYear() : null,
    platform: 'Shopify',
    file_type: 'api',
    filename: `shopify-api:${order.id}`,
    date: created,
    // The order identifier, in both the human form (#113224) and Shopify's id.
    sale_order_number: order.name || String(order.order_number || order.id),
    invoice_number: order.name || String(order.order_number || ''),
    awb_number: f?.tracking_number || (f?.tracking_numbers || [])[0] || null,
    shipping_partner: f?.tracking_company || null,
    dispatch_or_cancellation_date: f?.created_at ? new Date(f.created_at)
                                  : (order.cancelled_at ? new Date(order.cancelled_at) : null),
    return_date: refunds[0]?.created_at ? new Date(refunds[0].created_at) : null,
    total_amount: total,
    return_amount: returnAmount || null,
    net_amount: total - (returnAmount || 0),
    delivery_status: order.fulfillment_status || (order.cancelled_at ? 'cancelled' : 'unfulfilled'),
    reconciliation_status: 'pending',
    created_by: createdBy,
    created_at: new Date(),
  };
}

/** Convenience: pull a window of orders and map them straight to cycle rows. */
async function buildOrderCycleRows(brandId, opts = {}) {
  const orders = await fetchOrders(brandId, opts);
  return orders.map((o) => toOrderCycleRow(o, { brandId, createdBy: opts.createdBy }));
}

module.exports = {
  ORDER_FIELDS,
  fetchOrders, countOrders, fetchOrderTransactions, fetchOrderRefunds, fetchOrderEdits,
  fetchDraftOrders, fetchReturns, fetchProducts, fetchCustomers, fetchCompanies,
  fetchPaymentTerms, fetchPayouts, fetchBalanceTransactions, fetchDisputes, fetchPaymentsAccount,
  fetchGiftCards, fetchStoreCredit, fetchFulfillmentOrders, fetchInventoryLevels,
  fetchInventoryTransfers, fetchLocations, fetchShippingZones, fetchPublications,
  fetchMarkets, fetchPriceRules,
  toOrderCycleRow, buildOrderCycleRows,
};
