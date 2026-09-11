/* ──────────────────────────────────────────────────────────────────────────────
   returnPrimeClient.js — Return Prime return/exchange requests (READ-ONLY).

   FINDING THE API TOOK THREE WRONG TURNS, RECORDED SO NOBODY REPEATS THEM
   1. `/v1/requests` LOOKS like the endpoint: it answers 400 "Missing request
      header(s)" while a nonsense path answers a different 404. It is a decoy —
      no combination of 24 header names ever satisfies it. The real path is
      /return-exchange/v2.
   2. The docs at build.returnprime.com render client-side (a Postman
      documenter), so nothing is greppable from the HTML. The collection itself
      is fetchable at /api/collections/18337058/2s9YRDzWCw — that is where the
      endpoint list and the header name actually live.
   3. Auth is `x-rp-token`, the raw key. Not Bearer, not x-api-key.

   WHAT THIS IS FOR
   Display only. D'Chicha's returns come from Velocity and Shopify, which report
   them directly; Return Prime is a different population (its portal) and showing
   only exchanges there is NOT evidence that Velocity's returns are exchanges.
   Nothing here may touch Gross, Return, RTO or Net.

   AN EXCHANGE IS NOT A RETURN. Goods come back and different goods go out; the
   money stays. Deducting one from net sales would understate revenue for a sale
   that was never reversed — which is why the mapper writes its own columns and
   never return_amount.
   ────────────────────────────────────────────────────────────────────────────── */

const BASE_URL = process.env.RETURN_PRIME_BASE_URL || 'https://api.returnprime.co';
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const TIMEOUT_MS = 30_000;
const REQUEST_SPACING_MS = 400;
const MAX_5XX_RETRIES = 3;
const BACKOFF_BASE_MS = 2_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isConfigured() {
  return !!process.env.RETURN_PRIME_API_KEY;
}

/** Brands cleared for the Return Prime path. Empty ⇒ nobody. */
function enabledBrandIds() {
  return String(process.env.RETURN_PRIME_BRAND_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}
function isEnabledForBrand(brandId) {
  return !!brandId && enabledBrandIds().includes(String(brandId)) && isConfigured();
}

async function get(path, { attempt = 0 } = {}) {
  const key = process.env.RETURN_PRIME_API_KEY;
  if (!key) {
    const err = new Error('Return Prime is not configured (RETURN_PRIME_API_KEY).');
    err.status = 500;
    throw err;
  }
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: 'GET',
      headers: { 'x-rp-token': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (attempt < MAX_5XX_RETRIES) {
      await sleep(BACKOFF_BASE_MS * 2 ** attempt);
      return get(path, { attempt: attempt + 1 });
    }
    throw e;
  }
  if (res.status >= 500 && attempt < MAX_5XX_RETRIES) {
    await sleep(BACKOFF_BASE_MS * 2 ** attempt);
    return get(path, { attempt: attempt + 1 });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status === false) {
    const err = new Error(`Return Prime API error (HTTP ${res.status}): ${json.message || 'unknown'}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/**
 * All return/exchange requests.
 *
 * Records carry { request_number, request_type ('return'|'exchange'), status,
 *                 payment_details{amount,currency,gateway,status}, order{id,name} }.
 * `order.name` is "#113696" — the same order number the report keys on.
 *
 * Paging stops on a short page or when a page adds nothing new; the API's
 * pagination contract is undocumented, so a page that silently repeats itself
 * must not spin forever.
 */
async function fetchRequests({ maxPages = MAX_PAGES } = {}) {
  const seen = new Map();
  for (let page = 1; page <= maxPages; page++) {
    if (page > 1) await sleep(REQUEST_SPACING_MS);
    const json = await get(`/return-exchange/v2?page=${page}&limit=${PAGE_SIZE}`);
    const list = (json.data && json.data.list) || [];
    const before = seen.size;
    for (const r of list) if (r && r.id) seen.set(r.id, r);
    if (!list.length || seen.size === before || list.length < PAGE_SIZE) break;
  }
  return [...seen.values()];
}

/** Cheap credential check — the webhook list is the smallest authenticated call. */
async function ping() {
  const j = await get('/v2/webhook/');
  return { ok: true, webhooks: ((j.data || []).length) || 0 };
}

module.exports = {
  BASE_URL, PAGE_SIZE,
  isConfigured, isEnabledForBrand, enabledBrandIds,
  fetchRequests, ping,
};
