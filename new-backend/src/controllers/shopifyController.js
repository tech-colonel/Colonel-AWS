/* ──────────────────────────────────────────────────────────────────────────────
   shopifyController.js — HTTP surface for the first-party Shopify integration.

   Additive and self-contained: separate from composioController.js (which keeps
   brokering the other 1000+ toolkits). Connections are per BRAND, not per user —
   a brand's whole team shares one connected store, matching how the rest of the
   brand-scoped features behave.

   The callback route is deliberately UNAUTHENTICATED: Shopify redirects the
   merchant's browser to it and carries no session. Its trust comes from the
   HMAC signature plus the single-use state nonce, both checked in shopifyOAuth.
   ────────────────────────────────────────────────────────────────────────────── */

const oauth = require('../services/shopifyOAuth');
const tokenStore = require('../services/shopifyTokenStore');
const client = require('../services/shopifyClient');
const data = require('../services/shopifyData');

// Where the merchant's browser lands after we finish the handshake.
const FRONT_URL = process.env.SHOPIFY_FRONT_URL
  || process.env.COMPOSIO_FRONT_URL
  || 'http://localhost:3000/integrations';

/* GET /api/shopify/status — is OAuth configured on this server? */
const status = (req, res) => res.json({ configured: oauth.isConfigured() });

/* GET /api/shopify/:brandId/connection — connection info, never the token. */
const getConnection = async (req, res, next) => {
  try {
    const conn = await tokenStore.getConnection(req.params.brandId);
    res.json({ connection: conn, connected: !!conn });
  } catch (e) { next(e); }
};

/* POST /api/shopify/:brandId/install  { shop: "dchica" } → { url } */
const install = async (req, res, next) => {
  try {
    const { brandId } = req.params;
    const { shop } = req.body || {};
    if (!shop) return res.status(400).json({ error: 'Store name is required (e.g. "dchica").' });
    const { url, shop: domain } = oauth.buildInstallUrl(brandId, shop, req.user?.id);
    res.json({ url, shop: domain });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
};

/* GET /api/shopify/callback — Shopify redirects here. No auth by design. */
const callback = async (req, res) => {
  try {
    const { brandId, shopDomain } = await oauth.handleCallback(req.query);
    const qs = new URLSearchParams({ shopify_connected: shopDomain, brand: brandId });
    res.redirect(`${FRONT_URL}?${qs}`);
  } catch (e) {
    console.error('[shopify callback]', e.message);
    const qs = new URLSearchParams({ shopify_error: e.message.slice(0, 200) });
    res.redirect(`${FRONT_URL}?${qs}`);
  }
};

/* POST /api/shopify/:brandId/disconnect */
const disconnect = async (req, res, next) => {
  try {
    await tokenStore.revokeConnection(req.params.brandId);
    res.json({ ok: true });
  } catch (e) { next(e); }
};

/* GET /api/shopify/:brandId/ping — does the stored token still work? */
const ping = async (req, res) => {
  try {
    const shop = await client.ping(req.params.brandId);
    res.json({
      ok: true,
      shop: shop && {
        name: shop.name, domain: shop.myshopify_domain, plan: shop.plan_name,
        currency: shop.currency, country: shop.country_name, timezone: shop.iana_timezone,
      },
    });
  } catch (e) {
    res.status(e.status || 502).json({ ok: false, error: e.message, code: e.code });
  }
};

/* ── GET /api/shopify/:brandId/coverage ──────────────────────────────────────
   Probes every scope group with a real (tiny) call and reports what actually
   works for THIS store. Scope grants and data availability differ per merchant —
   a store not on Shopify Payments returns nothing for the payouts scopes even
   though the scope was granted — so this answers "what can we really read?"
   rather than "what did we ask for?". */
const coverage = async (req, res) => {
  const { brandId } = req.params;
  const probes = [
    ['read_orders',                    () => data.countOrders(brandId)],
    ['read_all_orders',                () => data.fetchOrders(brandId, { limit: 1, maxPages: 1 })],
    ['read_draft_orders',              () => data.fetchDraftOrders(brandId, { limit: 1, maxPages: 1 })],
    ['read_order_edits',               async () => {
      const [o] = await data.fetchOrders(brandId, { limit: 1, maxPages: 1 });
      return o ? data.fetchOrderEdits(brandId, `gid://shopify/Order/${o.id}`) : [];
    }],
    ['read_returns',                   () => data.fetchReturns(brandId, { first: 1, maxPages: 1 })],
    ['read_products',                  () => data.fetchProducts(brandId, { limit: 1, maxPages: 1 })],
    ['read_inventory',                 () => data.fetchInventoryLevels(brandId, { limit: 1, maxPages: 1 })],
    ['read_inventory_transfers',       () => data.fetchInventoryTransfers(brandId, { first: 1, maxPages: 1 })],
    ['read_publications',              () => data.fetchPublications(brandId, { first: 5 })],
    ['read_customers',                 () => data.fetchCustomers(brandId, { limit: 1, maxPages: 1 })],
    ['read_companies',                 () => data.fetchCompanies(brandId, { first: 1, maxPages: 1 })],
    ['read_payment_terms',             () => data.fetchPaymentTerms(brandId)],
    ['read_shopify_payments_accounts', () => data.fetchPaymentsAccount(brandId)],
    ['read_shopify_payments_payouts',  () => data.fetchPayouts(brandId, { limit: 1, maxPages: 1 })],
    ['read_shopify_payments_disputes', () => data.fetchDisputes(brandId, { limit: 1, maxPages: 1 })],
    ['read_gift_cards',                () => data.fetchGiftCards(brandId, { limit: 1, maxPages: 1 })],
    ['read_store_credit_accounts',     () => data.fetchStoreCredit(brandId, { first: 1, maxPages: 1 })],
    ['read_fulfillments',              async () => {
      const [o] = await data.fetchOrders(brandId, { limit: 1, maxPages: 1 });
      return o ? data.fetchFulfillmentOrders(brandId, o.id) : [];
    }],
    ['read_shipping',                  () => data.fetchShippingZones(brandId)],
    ['read_locations',                 () => data.fetchLocations(brandId)],
    ['read_price_rules',               () => data.fetchPriceRules(brandId, { limit: 1, maxPages: 1 })],
    ['read_markets',                   () => data.fetchMarkets(brandId, { first: 5 })],
  ];

  const results = [];
  for (const [scope, fn] of probes) {
    try {
      const out = await fn();
      // Shopify-Payments readers answer { rows, notEnabled } — a shop not on
      // Shopify Payments is a real answer, not a failure.
      if (out && typeof out === 'object' && 'notEnabled' in out) {
        results.push({ scope, ok: true, rows: out.rows.length,
                       note: out.notEnabled ? 'shop is not on Shopify Payments' : undefined });
      } else {
        const n = Array.isArray(out) ? out.length : (typeof out === 'number' ? out : (out ? 1 : 0));
        results.push({ scope, ok: true, rows: n });
      }
    } catch (e) {
      results.push({ scope, ok: false, error: e.message.slice(0, 160), code: e.code || null });
    }
  }
  res.json({
    brandId,
    working: results.filter((r) => r.ok).length,
    total: results.length,
    results,
  });
};

/* ── POST /api/shopify/:brandId/orders/preview ───────────────────────────────
   Pull a window of orders and return them mapped to shopify_order_cycle shape,
   WITHOUT writing. Lets us eyeball the mapping before any DB write happens. */
const previewOrderCycle = async (req, res) => {
  try {
    const { brandId } = req.params;
    const { since, until, limit } = req.query;
    const orders = await data.fetchOrders(brandId, {
      since, until,
      limit: Math.min(Number(limit) || 5, 250),
      maxPages: 1,
    });
    res.json({
      count: orders.length,
      rows: orders.map((o) => data.toOrderCycleRow(o, { brandId })),
    });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, code: e.code });
  }
};

module.exports = {
  status, getConnection, install, callback, disconnect, ping, coverage, previewOrderCycle,
};
