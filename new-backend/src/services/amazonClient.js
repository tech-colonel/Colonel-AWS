/* ──────────────────────────────────────────────────────────────────────────────
   amazonClient.js — the single door every SP-API call goes through.

   Sibling of shopifyClient.js. Responsibilities, and nothing else:
     • resolve a brand → its stored connection (refresh token, marketplace, region)
     • swap the refresh token for a cached access token
     • issue the request against the right regional host
     • survive Amazon's rate limits

   Rate limiting is the part that matters. SP-API limits are PER OPERATION and
   fairly tight (createReport is 0.0167 rps — one call a minute — while getOrders
   is 0.0167 rps with a burst of 20). Amazon returns 429 with a Retry-After we
   honour; when it is absent we back off exponentially with jitter. Without this
   a report loop looks like it "sometimes works", which is far harder to debug
   than a clean failure.

   Everything here is read-only in practice: the six roles this app holds
   (Finance and Accounting, Inventory and Order Tracking, Amazon Fulfillment,
   Selling Partner Insights, Brand Analytics, AWD) grant reporting and retrieval,
   not mutation. Nothing in this module writes to a seller's account.
   ────────────────────────────────────────────────────────────────────────────── */

const auth = require('./amazonAuth');
const tokenStore = require('./amazonTokenStore');

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Full jitter, capped. Keeps parallel brand jobs from retrying in lockstep. */
function backoffMs(attempt) {
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.floor(Math.random() * ceiling);
}

function notConnected(brandId) {
  const err = new Error('This brand is not connected to Amazon yet.');
  err.status = 409;
  err.code = 'AMAZON_NOT_CONNECTED';
  err.brandId = brandId;
  return err;
}

/**
 * Resolve a brand's connection once, so a caller making several calls in a row
 * (the report loop does) is not hitting the DB for each one.
 */
async function resolve(brandId) {
  const conn = await tokenStore.getRefreshToken(brandId);
  if (!conn) throw notConnected(brandId);
  return conn;
}

/**
 * Core request. `conn` may be passed in to reuse a resolved connection.
 *
 * Returns parsed JSON. Throws an Error carrying .status and, where Amazon gave
 * one, .code — SP-API error payloads are `{ errors: [{ code, message, details }] }`
 * and the message is usually the useful half.
 */
async function request(brandId, path, {
  method = 'GET', query = null, body = null, conn = null, headers = {}, expectJson = true,
} = {}) {
  const c = conn || await resolve(brandId);
  const host = auth.hostFor(c.region);

  let url = `${host}${path}`;
  if (query && Object.keys(query).length) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }

  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const accessToken = await auth.getAccessToken(c.refreshToken);

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          'x-amz-access-token': accessToken,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (netErr) {
      // Transport failure (DNS, socket). Worth retrying; a persistent outage
      // still terminates after MAX_RETRIES rather than hanging a request.
      lastErr = Object.assign(new Error(`Could not reach Amazon: ${netErr.message}`), { status: 502 });
      if (attempt === MAX_RETRIES) throw lastErr;
      await sleep(backoffMs(attempt));
      continue;
    }

    /* 429 — the expected, normal case under load. Honour Retry-After when given;
       Amazon sends it in seconds. */
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoffMs(attempt);
      lastErr = Object.assign(new Error('Amazon rate limit reached.'), { status: 429, code: 'AMAZON_THROTTLED' });
      if (attempt === MAX_RETRIES) throw lastErr;
      await sleep(Math.min(waitMs, MAX_BACKOFF_MS));
      continue;
    }

    /* 401/403 — the cached access token may be stale, or the grant changed.
       Drop the cache and try once more before believing it. */
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      auth.forgetAccessToken(c.refreshToken);
      continue;
    }

    if (res.status === 204) return null;

    const text = await res.text();
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch (_) { /* non-JSON body */ } }

    if (!res.ok) {
      const first = json?.errors?.[0];
      const err = new Error(
        first?.message
          ? `Amazon: ${first.message}`
          : `Amazon returned HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`
      );
      err.status = res.status;
      err.code = first?.code || `AMAZON_HTTP_${res.status}`;
      err.details = first?.details;
      // 5xx is worth another go; 4xx means the request itself is wrong.
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        lastErr = err;
        await sleep(backoffMs(attempt));
        continue;
      }
      throw err;
    }

    return expectJson ? json : text;
  }

  throw lastErr || Object.assign(new Error('Amazon request failed.'), { status: 502 });
}

/* ── ping ───────────────────────────────────────────────────────────────────── */
/**
 * Does the stored connection actually work?
 *
 * getMarketplaceParticipations is the right probe: it needs no role beyond a
 * valid token, so a failure here is unambiguously an auth problem rather than a
 * missing permission. It also tells us which marketplaces this seller is in,
 * which is how we confirm the stored marketplace_id is one they actually sell on.
 */
async function ping(brandId) {
  const conn = await resolve(brandId);
  const json = await request(brandId, '/sellers/v1/marketplaceParticipations', { conn });
  const list = json?.payload || [];
  const marketplaces = list.map((p) => ({
    id: p.marketplace?.id,
    name: p.marketplace?.name,
    country: p.marketplace?.countryCode,
    currency: p.marketplace?.defaultCurrencyCode,
    participating: p.participation?.isParticipating,
  }));
  return {
    marketplaces,
    configuredMarketplaceId: conn.marketplaceId,
    region: conn.region,
    sellingPartnerId: conn.sellingPartnerId,
    // A mismatch here is the classic "why is everything empty" cause: the token
    // is fine, but we are asking about a marketplace this seller is not in.
    marketplaceMatches: marketplaces.some((m) => m.id === conn.marketplaceId && m.participating),
  };
}

module.exports = { request, resolve, ping };
