/* ──────────────────────────────────────────────────────────────────────────────
   cashfreeClient.js — Cashfree Payment Gateway settlement reconciliation.

   Answers the question the Order Cycle agent exists to answer: a single bank
   credit arrives, the books hold hundreds of invoices — which orders are inside
   that credit, and what was deducted on the way?

   Scope is deliberately narrow: ONE read-only endpoint, POST /pg/settlement/recon.
   Nothing here can move money, create an order, or issue a refund.

   BRAND GATING — this is enabled per brand, not globally. A brand is eligible
   only if its id appears in CASHFREE_BRAND_IDS. Every other brand behaves
   exactly as it does today, with settlement files uploaded by hand. Today that
   list holds D'Chicha alone; FLO and the rest are untouched.

   Field names below follow what the API actually returns, which differs from the
   published summary: the payload is nested under event_details / order_details /
   payment_details / settlement_details, and the flat `payment_amount` and
   `amount_settled` fields come back null. The populated figures live on
   event_details as event_amount / event_settlement_amount.
   ────────────────────────────────────────────────────────────────────────────── */

const BASE_URL = process.env.CASHFREE_BASE_URL || 'https://api.cashfree.com/pg';
const API_VERSION = process.env.CASHFREE_API_VERSION || '2026-01-01';
const PAGE_LIMIT = 1000;          // API maximum
const MAX_PAGES = 50;             // 50k events — well past a month for any brand
const TIMEOUT_MS = 30_000;

/** Brands allowed to use the Cashfree API, from env. Empty ⇒ nobody. */
function enabledBrandIds() {
  return String(process.env.CASHFREE_BRAND_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

/** Is this brand cleared for the Cashfree API path? */
function isEnabledForBrand(brandId) {
  return !!brandId && enabledBrandIds().includes(String(brandId)) && isConfigured();
}

function isConfigured() {
  return !!(process.env.CASHFREE_APP_ID && process.env.CASHFREE_SECRET_KEY);
}

function credentials() {
  const appId = process.env.CASHFREE_APP_ID;
  const secret = process.env.CASHFREE_SECRET_KEY;
  if (!appId || !secret) {
    const err = new Error('Cashfree is not configured on this server (CASHFREE_APP_ID / CASHFREE_SECRET_KEY).');
    err.status = 500;
    throw err;
  }
  return { appId, secret };
}

const isoUtc = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Fetch settlement reconciliation events for a date window.
 *
 * Cashfree pages with an opaque cursor. We stop on a missing cursor, an empty
 * page, or MAX_PAGES — whichever comes first — so a runaway window can never
 * spin forever inside a request.
 *
 * @param {object} opts.since  Date | ISO string (settlement initiated on)
 * @param {object} opts.until  Date | ISO string
 * @returns {Promise<object[]>} raw recon records, nested shape preserved
 */
async function fetchSettlementRecon({ since, until, maxPages = MAX_PAGES } = {}) {
  const { appId, secret } = credentials();
  const filters = {
    start_date_initiated_on: isoUtc(since || Date.now() - 30 * 864e5),
    end_date_initiated_on: isoUtc(until || Date.now()),
  };

  const out = [];
  let cursor = null;

  for (let page = 0; page < maxPages; page++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${BASE_URL}/settlement/recon`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-api-version': API_VERSION,
          'x-client-id': appId,
          'x-client-secret': secret,
        },
        body: JSON.stringify({
          pagination: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
          filters,
        }),
      });
    } finally { clearTimeout(timer); }

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(
        `Cashfree settlement API error (HTTP ${res.status}): ${json.message || json.type || 'unknown'}`
      );
      err.status = res.status;
      // 401/403 here is nearly always a wrong key or an IP that isn't allowlisted.
      if (res.status === 401 || res.status === 403) err.code = 'CASHFREE_UNAUTHORIZED';
      throw err;
    }

    const rows = json.data || [];
    out.push(...rows);
    cursor = json.cursor || null;
    if (!cursor || rows.length === 0) break;
  }
  return out;
}

/** Cheap credential/allowlist check — one small page. */
async function ping() {
  const rows = await fetchSettlementRecon({
    since: Date.now() - 2 * 864e5,
    until: Date.now(),
    maxPages: 1,
  });
  return { ok: true, sampled: rows.length };
}

module.exports = {
  BASE_URL, API_VERSION,
  isConfigured, isEnabledForBrand, enabledBrandIds,
  fetchSettlementRecon, ping,
};
