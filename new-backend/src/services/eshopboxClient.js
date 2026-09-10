/* ──────────────────────────────────────────────────────────────────────────────
   eshopboxClient.js — Eshopbox shipment tracking (RTO + reverse journeys).

   Eshopbox is the OTHER fulfilment platform D'Chicha ships through. Velocity
   covers one lane; Eshopbox covers the rest — and until now that rest was
   invisible. Measured on the August 2026 report: 1,754 rows carry a CAPITALISED
   carrier name ("Delhivery", "DTDC"), which is the tell that the name came from
   Shopify's tracking_company with no tracking-URL host to identify the platform.
   Every one of those rows has an empty COD amount and an empty UTR.

   WHY THIS MATTERS MORE THAN THE MONEY
   Shopify's fulfillment_status only ever says fulfilled/unfulfilled, so a parcel
   that came back still reads as a live sale. Proven on order 113353 (AWB
   8476713898215): Eshopbox says `rto`, the report said PENDING RECEIVABLE
   ₹1,034.10 — money recorded as owed to us for goods sitting in the warehouse.

   READ-ONLY. The token carries write scopes (write:orders, write:returns,
   write:payouts) because Eshopbox issues them by default; nothing here uses
   them. Only /generateToken and GET /trackingDetails are ever called.

   ── Quirks found by probing; none of these are in the docs ──────────────────
   1. `trackingDetailList` is the response key — not `data`, not `trackingDetails`.
   2. currentStatus is LOWERCASE ("rto", "delivered"). The published docs list it
      uppercase ("RTO", "DELIVERED"), so a case-sensitive comparison against the
      documented values matches nothing, silently.
   3. Max 50 trackingIds per call.
   4. The orders endpoint (/api/v1/orders/erp) is 1-INDEXED — page=0 returns
      {"hasNext":false} with HTTP 200, indistinguishable from "no data". Not used
      here, but noted because it is the kind of thing that costs an afternoon.
   5. This endpoint returns customerOrderNumber as "#113334" — the Shopify order
      NUMBER (what our report keys on), unlike /orders/erp which returns the
      13-digit Shopify order id. Two usable join keys from one call.

   Verified live: 298 of 300 report AWBs resolved.
   ────────────────────────────────────────────────────────────────────────────── */

const AUTH_URL = process.env.ESHOPBOX_AUTH_URL || 'https://auth.myeshopbox.com/api/v1/generateToken';
const WMS_URL = process.env.ESHOPBOX_WMS_URL || 'https://wms.eshopbox.com';
const MAX_AWBS_PER_CALL = 50;        // hard API limit
const REQUEST_SPACING_MS = 900;      // no published rate limit; measured safe
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;  // token lives 30 days; refresh daily anyway
const TIMEOUT_MS = 60_000;
const MAX_5XX_RETRIES = 3;
const BACKOFF_BASE_MS = 3_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isConfigured() {
  return !!(process.env.ESHOPBOX_CLIENT_ID
    && process.env.ESHOPBOX_CLIENT_SECRET
    && process.env.ESHOPBOX_REFRESH_TOKEN);
}

/** Brands cleared for the Eshopbox API path. Empty ⇒ nobody; every other brand
    keeps uploading courier files exactly as before. */
function enabledBrandIds() {
  return String(process.env.ESHOPBOX_BRAND_IDS || '')
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

  const client_id = process.env.ESHOPBOX_CLIENT_ID;
  const client_secret = process.env.ESHOPBOX_CLIENT_SECRET;
  const refresh_token = process.env.ESHOPBOX_REFRESH_TOKEN;
  if (!client_id || !client_secret || !refresh_token) {
    const err = new Error('Eshopbox is not configured (ESHOPBOX_CLIENT_ID / _SECRET / _REFRESH_TOKEN).');
    err.status = 500;
    throw err;
  }

  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id, client_secret, grant_type: 'refresh_token', refresh_token }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const err = new Error(`Eshopbox authentication failed (HTTP ${res.status}): ${json.error_description || json.error || 'no access_token returned'}`);
    err.status = res.status === 401 ? 401 : 502;
    err.code = 'ESHOPBOX_AUTH_FAILED';
    throw err;
  }
  _token = json.access_token;
  _tokenAt = Date.now();
  return _token;
}

/* ── one GET, retrying an expired token once and 5xx a few times ────────────── */
async function get(path, { retryOnAuth = true, attempt = 0 } = {}) {
  const token = await getToken();
  let res;
  try {
    res = await fetch(`${WMS_URL}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (attempt < MAX_5XX_RETRIES) {
      await sleep(BACKOFF_BASE_MS * 2 ** attempt);
      return get(path, { retryOnAuth, attempt: attempt + 1 });
    }
    throw e;
  }

  if (res.status === 401 && retryOnAuth) {
    await getToken(true);
    return get(path, { retryOnAuth: false, attempt });
  }
  if (res.status === 429) {
    const err = new Error('Eshopbox rate limit hit.');
    err.status = 429;
    err.code = 'ESHOPBOX_RATE_LIMITED';
    throw err;
  }
  if (res.status >= 500 && attempt < MAX_5XX_RETRIES) {
    await sleep(BACKOFF_BASE_MS * 2 ** attempt);
    return get(path, { retryOnAuth, attempt: attempt + 1 });
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json.errors && json.errors[0] && json.errors[0].message) || json.message || 'unknown';
    const err = new Error(`Eshopbox API error (HTTP ${res.status}): ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/**
 * Shipment tracking for a set of AWBs.
 *
 * Rows carry { journeyType, customerOrderNumber, trackingId, rtoTrackingId,
 *              currentStatus, dateTime, expectedDeliveryDate, courierPartnerName,
 *              statusLogList[] }.
 *
 * An AWB Eshopbox doesn't know is simply absent from the response — normal for
 * the Velocity-carried half of the book, not a failure. A batch that fails after
 * retries is recorded in `failedAwbs` and skipped: losing 50 AWBs of status is
 * recoverable, losing the whole period is not.
 *
 * @param {string[]} awbs
 * @param {object} opts { onProgress }
 */
async function fetchTracking(awbs, { onProgress } = {}) {
  const unique = [...new Set((awbs || []).map((a) => String(a || '').trim()).filter(Boolean))];
  if (!unique.length) return [];

  const out = [];
  const failedAwbs = [];
  for (let i = 0; i < unique.length; i += MAX_AWBS_PER_CALL) {
    if (i > 0) await sleep(REQUEST_SPACING_MS);
    const batch = unique.slice(i, i + MAX_AWBS_PER_CALL);
    try {
      const json = await get(`/api/v1/shipping/trackingDetails?trackingIds=${batch.map(encodeURIComponent).join(',')}`);
      out.push(...(json.trackingDetailList || []));
    } catch (e) {
      failedAwbs.push(...batch);
      console.warn(`[eshopbox] tracking batch ${i / MAX_AWBS_PER_CALL + 1} failed after retries (${e.message}) — ${batch.length} AWBs skipped`);
    }
    if (onProgress) onProgress(Math.min(i + MAX_AWBS_PER_CALL, unique.length), unique.length);
  }
  if (failedAwbs.length) out.failedAwbs = failedAwbs;   // surfaced, never silent
  return out;
}

/** Cheap credential check — auth only, no data pulled. */
async function ping() {
  await getToken(true);
  return { ok: true, tokenAcquired: true };
}

module.exports = {
  WMS_URL, MAX_AWBS_PER_CALL, REQUEST_SPACING_MS,
  isConfigured, isEnabledForBrand, enabledBrandIds,
  getToken, fetchTracking, ping,
};
