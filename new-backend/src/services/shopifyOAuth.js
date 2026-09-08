/* ──────────────────────────────────────────────────────────────────────────────
   shopifyOAuth.js — our own Shopify OAuth handshake (no Composio in the path).

   Flow:
     1. buildInstallUrl(brandId, shop)  → mint a state nonce bound to the brand,
        return https://<shop>/admin/oauth/authorize?...
     2. merchant approves on Shopify
     3. Shopify redirects to SHOPIFY_REDIRECT_URI with { code, shop, state, hmac }
     4. handleCallback() verifies hmac + state + shop, exchanges code → token,
        and hands the token to shopifyTokenStore for encrypted storage.

   Security notes — all four checks matter and none are optional:
     • hmac       — proves the params came from Shopify (signed with our secret).
       Compared with timingSafeEqual to avoid a byte-by-byte timing oracle.
     • state      — single-use nonce, ties the callback to the brand that started
       it; without it anyone could bind THEIR store to YOUR brand.
     • shop regex — Shopify passes `shop` back to us and we build a URL from it.
       Unvalidated, that is an open redirect / SSRF into any host.
     • token      — never logged, never returned to the client, encrypted at rest.
   ────────────────────────────────────────────────────────────────────────────── */

const crypto = require('crypto');
const tokenStore = require('./shopifyTokenStore');

// The exact scope string our Shopify app is configured with. Shopify grants the
// intersection of this and the app's configured scopes, so keep the two in sync
// (dev dashboard → Agent.Accountant → Versions → Scopes).
const SCOPES = [
  'read_orders', 'read_all_orders', 'read_order_edits', 'read_draft_orders',
  'read_returns', 'read_products', 'read_inventory', 'read_publications',
  'read_inventory_transfers', 'read_inventory_shipments',
  'read_customers', 'read_companies', 'read_payment_terms',
  'read_shopify_payments_accounts', 'read_shopify_payments_payouts',
  'read_shopify_payments_bank_accounts', 'read_shopify_payments_disputes',
  'read_gift_cards', 'read_gift_card_transactions',
  'read_store_credit_accounts', 'read_store_credit_account_transactions',
  'read_fulfillments', 'read_merchant_managed_fulfillment_orders',
  'read_third_party_fulfillment_orders', 'read_assigned_fulfillment_orders',
  'read_shipping', 'read_locations', 'read_price_rules', 'read_discounts',
  'read_markets',
].join(',');

const SHOP_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;
const NONCE_TTL_MS = 10 * 60 * 1000;

/* ── state nonces (in-memory, single pm2 process — same as loginNonceStore) ─── */
const _nonces = new Map(); // nonce -> { brandId, shop, userId, createdAt }

function issueNonce(brandId, shop, userId) {
  const nonce = crypto.randomBytes(24).toString('base64url');
  _nonces.set(nonce, { brandId, shop, userId, createdAt: Date.now() });
  return nonce;
}

/** Validate + consume. Single-use: deleted regardless of outcome, so replays fail. */
function consumeNonce(nonce) {
  const e = _nonces.get(nonce);
  if (!e) return null;
  _nonces.delete(nonce);
  return Date.now() - e.createdAt <= NONCE_TTL_MS ? e : null;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _nonces) if (now - v.createdAt > NONCE_TTL_MS) _nonces.delete(k);
}, NONCE_TTL_MS).unref?.();

/* ── config ─────────────────────────────────────────────────────────────────── */
function config() {
  const key = process.env.SHOPIFY_API_KEY;
  const secret = process.env.SHOPIFY_API_SECRET;
  const redirect = process.env.SHOPIFY_REDIRECT_URI;
  if (!key || !secret || !redirect) {
    const err = new Error(
      'Shopify OAuth is not configured (need SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_REDIRECT_URI).'
    );
    err.status = 500;
    throw err;
  }
  return { key, secret, redirect };
}

function isConfigured() {
  return !!(process.env.SHOPIFY_API_KEY && process.env.SHOPIFY_API_SECRET && process.env.SHOPIFY_REDIRECT_URI);
}

/** Accept "dchica", "dchica.myshopify.com", or a full admin URL → canonical domain. */
function normalizeShop(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');   // strip scheme + path
  if (!s.includes('.')) s = `${s}.myshopify.com`;           // bare store name
  return SHOP_RE.test(s) ? s : null;
}

/* ── step 1: authorize URL ──────────────────────────────────────────────────── */
function buildInstallUrl(brandId, shopInput, userId) {
  const { key, redirect } = config();
  const shop = normalizeShop(shopInput);
  if (!shop) {
    const err = new Error('That does not look like a Shopify store. Use the store name, e.g. "dchica".');
    err.status = 400;
    throw err;
  }
  const state = issueNonce(brandId, shop, userId);
  const qs = new URLSearchParams({
    client_id: key,
    scope: SCOPES,
    redirect_uri: redirect,
    state,
    // Offline token: long-lived, tied to the shop not a staff member. Exactly
    // what a background reconciliation job needs — it must keep working when
    // nobody is logged in.
    'grant_options[]': '',
  });
  return { url: `https://${shop}/admin/oauth/authorize?${qs}`, shop, state };
}

/* ── step 3: verify Shopify's signature on the callback ─────────────────────── */
/**
 * Shopify signs every OAuth callback and webhook-ish redirect with HMAC-SHA256
 * over the sorted query string, excluding `hmac` itself.
 */
function verifyHmac(query, secret) {
  const { hmac, signature, ...rest } = query || {};
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`)
    .join('&');
  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(String(hmac), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ── step 4: code → token, then persist ─────────────────────────────────────── */
async function handleCallback(query) {
  const { secret } = config();
  const { code, shop, state } = query || {};

  if (!verifyHmac(query, secret)) {
    const err = new Error('Shopify callback failed signature verification.');
    err.status = 401;
    throw err;
  }
  const entry = consumeNonce(state);
  if (!entry) {
    const err = new Error('This Shopify connection link has expired or was already used. Please try again.');
    err.status = 400;
    throw err;
  }
  const shopDomain = normalizeShop(shop);
  if (!shopDomain || shopDomain !== entry.shop) {
    const err = new Error('Shopify callback shop did not match the store this connection started for.');
    err.status = 400;
    throw err;
  }

  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: config().key, client_secret: secret, code }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const err = new Error(`Shopify token exchange failed (HTTP ${res.status}).`);
    err.status = 502;
    throw err;
  }

  const saved = await tokenStore.saveConnection(entry.brandId, {
    shopDomain,
    accessToken: json.access_token,
    scopes: json.scope || SCOPES,
    apiVersion: process.env.SHOPIFY_API_VERSION || '2026-07',
    installedBy: entry.userId || null,
  });

  return { brandId: entry.brandId, shopDomain, scopes: json.scope || SCOPES, connection: saved };
}

/** Verify a webhook body signature (base64 HMAC over the RAW body bytes). */
function verifyWebhook(rawBody, hmacHeader) {
  const { secret } = config();
  const digest = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(String(hmacHeader || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  SCOPES, isConfigured, normalizeShop, buildInstallUrl, handleCallback,
  verifyHmac, verifyWebhook,
};
