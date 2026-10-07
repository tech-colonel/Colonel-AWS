/* ──────────────────────────────────────────────────────────────────────────────
   velocityClient.js — Velocity Shipping finance APIs (COD remittance + charges).

   Velocity is the shipping PLATFORM D'Chicha books through; Delhivery and the
   others are the couriers underneath it. The courier delivers the parcel, but
   Velocity is who collects the COD and remits it — so Velocity is the party the
   reconciliation must ask, and the delhivery_ and ekart_ columns are the wrong home
   for this money (see migration 013 for the generic courier_* columns).

   READ-ONLY: only /auth-token, /cod-remittance and /shipping-charges are ever
   called. Nothing here books, cancels or modifies a shipment.

   ── Two constraints from the API that shape this whole module ───────────────
   1. RATE LIMIT — 5 requests/minute per client, HTTP 429 beyond. With 100 AWBs
      per call that is 500 AWBs/minute, so batching alone is not enough; requests
      are spaced by REQUEST_SPACING_MS. A full historical backfill belongs in a
      background job, not a request cycle.
   2. `remittance_date` IS POPULATED EVEN WHEN UNPAID — the docs define it as
      "settlement date if already remitted; otherwise the NEXT SCHEDULED date".
      Reading it as money-received would book pending COD as collected. Verified
      on live D'Chicha data: 25 of 25 AWBs came back dated today with utr_no
      null — ₹39,838 that had NOT been received. **utr_no is the only reliable
      discriminator**: non-null ⇒ settled, null ⇒ still owed.

   Auth is username + password (the portal login; `username` is the PHONE number,
   not the email) exchanged for a 24-hour token, cached in memory here.
   ────────────────────────────────────────────────────────────────────────────── */

const BASE_URL = process.env.VELOCITY_BASE_URL || 'https://shazam.velocity.in';
const MAX_AWBS_PER_CALL = 100;      // hard API limit — 400 beyond it
const MAX_RETURNS_PER_PAGE = 100;   // /returns caps here; asking 500 silently returns 100
const REQUEST_SPACING_MS = 13_000;  // 5 req/min with headroom
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;  // refresh an hour before the 24h expiry
const TIMEOUT_MS = 30_000;
const MAX_5XX_RETRIES = 3;
const BACKOFF_BASE_MS = 4_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isConfigured() {
  return !!(process.env.VELOCITY_USERNAME && process.env.VELOCITY_PASSWORD);
}

/** Brands cleared for the Velocity API path. Empty ⇒ nobody; every other brand
    keeps uploading courier files exactly as before. */
function enabledBrandIds() {
  return String(process.env.VELOCITY_BRAND_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}
function isEnabledForBrand(brandId) {
  return !!brandId && enabledBrandIds().includes(String(brandId)) && isConfigured();
}

/* ── auth ───────────────────────────────────────────────────────────────────── */
let _token = null;
let _tokenAt = 0;

async function getToken(force = false) {
  if (!force && _token && Date.now() - _tokenAt < TOKEN_TTL_MS) return _token;
  const username = process.env.VELOCITY_USERNAME;
  const password = process.env.VELOCITY_PASSWORD;
  if (!username || !password) {
    const err = new Error('Velocity is not configured (VELOCITY_USERNAME / VELOCITY_PASSWORD).');
    err.status = 500;
    throw err;
  }
  const res = await fetch(`${BASE_URL}/custom/api/v1/auth-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.token) {
    const err = new Error(`Velocity authentication failed (HTTP ${res.status}): ${json.error || 'no token returned'}`);
    err.status = res.status === 401 ? 401 : 502;
    err.code = 'VELOCITY_AUTH_FAILED';
    throw err;
  }
  _token = json.token;
  _tokenAt = Date.now();
  return _token;
}

/* ── one POST, with a single retry on an expired token ──────────────────────── */
async function post(path, body, { retryOnAuth = true, attempt = 0 } = {}) {
  const token = await getToken();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        // NOT "Bearer <token>" — the docs' prose says Bearer but every sample
        // sends the raw token, and the raw form is what actually authenticates.
        Authorization: token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } finally { clearTimeout(timer); }

  if (res.status === 401 && retryOnAuth) {
    await getToken(true);                       // token expired mid-run
    return post(path, body, { retryOnAuth: false, attempt });
  }
  if (res.status === 429) {
    const err = new Error('Velocity rate limit hit (5 requests/minute).');
    err.status = 429;
    err.code = 'VELOCITY_RATE_LIMITED';
    throw err;
  }
  // 5xx is transient on their side. Observed live: a single HTTP 504 on one
  // batch of ~36 aborted an eight-minute pull. Back off and retry rather than
  // discard everything already fetched.
  if (res.status >= 500 && attempt < MAX_5XX_RETRIES) {
    await sleep(BACKOFF_BASE_MS * 2 ** attempt);
    return post(path, body, { retryOnAuth, attempt: attempt + 1 });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Velocity API error (HTTP ${res.status}): ${json.error || json.message || 'unknown'}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/**
 * Query an AWB-batched endpoint, spacing requests to stay inside the rate limit.
 * @param {string[]} awbs
 * @param {function} onProgress optional (done, total) — long pulls are slow by design
 */
async function queryByAwbs(path, awbs, { onProgress } = {}) {
  const unique = [...new Set((awbs || []).map((a) => String(a || '').trim()).filter(Boolean))];
  if (!unique.length) return [];

  const out = [];
  const failedAwbs = [];
  for (let i = 0; i < unique.length; i += MAX_AWBS_PER_CALL) {
    if (i > 0) await sleep(REQUEST_SPACING_MS);   // 5/min ceiling
    const batch = unique.slice(i, i + MAX_AWBS_PER_CALL);
    try {
      const json = await post(path, { awbs: batch });
      out.push(...(json.data || []));
    } catch (e) {
      // A batch that still fails after retries is recorded and skipped. Losing
      // 100 AWBs of COD detail is recoverable; losing the whole period is not.
      failedAwbs.push(...batch);
      console.warn(`[velocity] batch ${i / MAX_AWBS_PER_CALL + 1} failed after retries (${e.message}) — ${batch.length} AWBs skipped`);
    }
    if (onProgress) onProgress(Math.min(i + MAX_AWBS_PER_CALL, unique.length), unique.length);
  }
  if (failedAwbs.length) out.failedAwbs = failedAwbs;   // surfaced, never silent
  return out;
}

/**
 * COD remittance per AWB.
 * Rows carry { tracking_number, delivery_date, cod_amount, remittance_date,
 *              utr_no, error }. `error` appears for a prepaid order or an AWB
 * that isn't in this account — both are normal, not failures.
 */
async function fetchCodRemittance(awbs, opts) {
  return queryByAwbs('/custom/api/v1/cod-remittance', awbs, opts);
}

/**
 * Shipment- and order-level charges per AWB: shipment_debit, platform_fee,
 * rto_risk_service_charge, oc_automation_ai_call_service_charge …
 * The cost of fulfilment, and nothing tracks it today.
 */
async function fetchShippingCharges(awbs, opts) {
  return queryByAwbs('/custom/api/v1/shipping-charges', awbs, opts);
}

/**
 * Reverse-logistics returns — the lane Shopify cannot see.
 *
 * Shopify only records a return if somebody also issued a refund there; the
 * goods physically move through Velocity either way. On August 2026 Shopify
 * held 7 refunds against Velocity's 285 returns, which is the whole reason
 * the report's Returns line read ₹11,478.
 *
 * PAGINATION — found by probing, not documented to us:
 *   • `per_page` caps at 100 (asking for 500 silently returns 100).
 *   • The page selector is `page: { number: N }`. A bare `page: 2` 500s with
 *     "Integer does not have #dig method", and `search_after` / the advertised
 *     `meta.next_search_after` cursor both quietly re-serve page 1 — so a
 *     cursor loop looks like it works while reading the same rows forever.
 *     Pages are therefore de-duplicated by id here and the walk stops when a
 *     page adds nothing new, so a silent repeat can never spin.
 *   • No date filter is honoured (`from_date`/`start_date` are ignored), so the
 *     caller filters by request_date after the fact.
 *
 * @param {object} opts { maxPages, onProgress }
 * @returns {Promise<Array>} raw return records ({ id, type, attributes })
 */
async function fetchReturns({ maxPages = 50, onProgress } = {}) {
  const seen = new Map();
  let total = null;

  for (let page = 1; page <= maxPages; page++) {
    if (page > 1) await sleep(REQUEST_SPACING_MS);
    const json = await post('/custom/api/v1/returns',
      { per_page: MAX_RETURNS_PER_PAGE, page: { number: page } });

    const rows = json.data || [];
    if (total === null && json.meta && json.meta.total != null) total = Number(json.meta.total);

    const before = seen.size;
    for (const r of rows) if (r && r.id) seen.set(r.id, r);
    if (onProgress) onProgress(seen.size, total);

    // Stop on a short page, an empty page, or a page that added nothing — the
    // last of those is what a silently-repeating cursor looks like.
    if (!rows.length || seen.size === before || rows.length < MAX_RETURNS_PER_PAGE) break;
    if (total !== null && seen.size >= total) break;
  }

  const out = [...seen.values()];
  if (total !== null && out.length < total) {
    // Surfaced, never silent: a short read here understates returns, which
    // overstates net sales — the exact failure this module exists to prevent.
    out.incomplete = { fetched: out.length, expected: total };
    console.warn(`[velocity] returns: fetched ${out.length} of ${total} — page walk ended early`);
  }
  return out;
}

/** Cheap credential check — one tiny call. */
async function ping() {
  await getToken(true);
  return { ok: true, tokenAcquired: true };
}

module.exports = {
  BASE_URL, MAX_AWBS_PER_CALL, REQUEST_SPACING_MS,
  isConfigured, isEnabledForBrand, enabledBrandIds,
  MAX_RETURNS_PER_PAGE,
  getToken, fetchCodRemittance, fetchShippingCharges, fetchReturns, ping,
};
