/* ──────────────────────────────────────────────────────────────────────────────
   amazonAuth.js — Login with Amazon (LWA) token handling for SP-API.

   Two ways a brand's refresh token can arrive, both supported here:

     A) SELF-AUTHORIZATION (what Koparo uses today)
        The seller authorises our app from inside Seller Central / Solution
        Provider Portal and Amazon shows a refresh token on screen. It is pasted
        into the UI once and stored encrypted. No redirect, no consent URL.

     B) OAUTH CONSENT (how every brand after the first will connect)
        buildConsentUrl() → seller approves on Amazon → Amazon redirects to
        AMAZON_REDIRECT_URI with { spapi_oauth_code, selling_partner_id, state }
        → exchangeCode() swaps the code for a refresh token.
        Requires the app to be PUBLIC (listed in the Selling Partner Appstore);
        a draft app only works with &version=beta for our own testing.

   Both paths end in the same place: a refresh token in amazon_connections. Every
   API call then exchanges it for a 1-hour access token, cached here.

   SigV4 note: AWS request signing was retired for SP-API in 2023. An LWA bearer
   token is the whole of the auth — no IAM role, no ARN, no credentials chain.
   ────────────────────────────────────────────────────────────────────────────── */

const crypto = require('crypto');

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

/* SP-API hosts. India is served by the EU endpoint — a frequent and expensive
   surprise, so it is spelled out here rather than inferred from the country. */
const SPAPI_HOSTS = {
  na: 'https://sellingpartnerapi-na.amazon.com',
  eu: 'https://sellingpartnerapi-eu.amazon.com',
  fe: 'https://sellingpartnerapi-fe.amazon.com',
};
const SPAPI_SANDBOX_HOSTS = {
  na: 'https://sandbox.sellingpartnerapi-na.amazon.com',
  eu: 'https://sandbox.sellingpartnerapi-eu.amazon.com',
  fe: 'https://sandbox.sellingpartnerapi-fe.amazon.com',
};

/* Seller Central consent hosts, by marketplace. Only needed for the OAuth path. */
const CONSENT_HOSTS = {
  A21TJRUUN4KGV: 'https://sellercentral.amazon.in',      // India
  ATVPDKIKX0DER: 'https://sellercentral.amazon.com',     // US
  A1F83G8C2ARO7P: 'https://sellercentral.amazon.co.uk',  // UK
  A1PA6795UKMFR9: 'https://sellercentral.amazon.de',     // Germany
  A2VIGQ35RCS4UG: 'https://sellercentral.amazon.ae',     // UAE
};

const NONCE_TTL_MS = 10 * 60 * 1000;

/* ── config ─────────────────────────────────────────────────────────────────── */
function config() {
  const clientId = process.env.AMAZON_LWA_CLIENT_ID;
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const err = new Error(
      'Amazon SP-API is not configured (need AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET).'
    );
    err.status = 500;
    throw err;
  }
  return { clientId, clientSecret };
}

function isConfigured() {
  return !!(process.env.AMAZON_LWA_CLIENT_ID && process.env.AMAZON_LWA_CLIENT_SECRET);
}

/** True when the OAuth (multi-brand) path is usable, not just self-authorization. */
function isOAuthConfigured() {
  return isConfigured() && !!process.env.AMAZON_APP_ID && !!process.env.AMAZON_REDIRECT_URI;
}

/** Base URL for API calls. Sandbox is opt-in via AMAZON_USE_SANDBOX=true. */
function hostFor(region = 'eu') {
  const table = String(process.env.AMAZON_USE_SANDBOX) === 'true' ? SPAPI_SANDBOX_HOSTS : SPAPI_HOSTS;
  return table[String(region).toLowerCase()] || table.eu;
}

/* ── state nonces for the OAuth path (in-memory, mirrors shopifyOAuth) ──────── */
const _nonces = new Map(); // nonce -> { brandId, userId, createdAt }

function issueNonce(brandId, userId) {
  const nonce = crypto.randomBytes(24).toString('base64url');
  _nonces.set(nonce, { brandId, userId, createdAt: Date.now() });
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

/* ── B) OAuth: consent URL ──────────────────────────────────────────────────── */
/**
 * Where to send a seller to authorise us. `version=beta` is REQUIRED while the
 * app is in Draft and must be dropped once it is published to the Appstore —
 * a published app rejects the parameter.
 */
function buildConsentUrl(brandId, { marketplaceId, userId, draft } = {}) {
  const appId = process.env.AMAZON_APP_ID;
  if (!appId) {
    const err = new Error('AMAZON_APP_ID is not set — the OAuth consent flow needs the app id (amzn1.sp.solution.…).');
    err.status = 500;
    throw err;
  }
  const mkt = marketplaceId || process.env.AMAZON_MARKETPLACE_ID || 'A21TJRUUN4KGV';
  const host = CONSENT_HOSTS[mkt] || CONSENT_HOSTS.A21TJRUUN4KGV;
  const state = issueNonce(brandId, userId);
  const qs = new URLSearchParams({ application_id: appId, state });
  // Default to draft:true — an unpublished app is the normal state until the
  // public listing clears, and omitting it there produces a confusing error.
  if (draft !== false) qs.set('version', 'beta');
  return { url: `${host}/apps/authorize/consent?${qs}`, state };
}

/* ── B) OAuth: code → refresh token ─────────────────────────────────────────── */
/**
 * Amazon's spapi_oauth_code expires in FIVE MINUTES, so this must be called from
 * the redirect handler itself — never queued behind a human step.
 */
async function exchangeCode(code) {
  const { clientId, clientSecret } = config();
  const redirectUri = process.env.AMAZON_REDIRECT_URI;
  if (!redirectUri) {
    const err = new Error('AMAZON_REDIRECT_URI is not set.');
    err.status = 500;
    throw err;
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.refresh_token) {
    const err = new Error(
      `Amazon token exchange failed (HTTP ${res.status})${json.error_description ? `: ${json.error_description}` : ''}`
    );
    err.status = 502;
    throw err;
  }
  return { refreshToken: json.refresh_token, accessToken: json.access_token, expiresIn: json.expires_in };
}

/* ── access-token cache ─────────────────────────────────────────────────────── */
/*
 * Keyed by a hash of the refresh token, so the plaintext secret is never a map
 * key and never shows up in a heap dump keyed by value. Cached for slightly less
 * than the hour Amazon grants, so a token is never used in its final seconds.
 */
const _accessTokens = new Map(); // hash -> { token, expiresAt }
const SKEW_MS = 5 * 60 * 1000;   // refresh 5 minutes early

function cacheKey(refreshToken) {
  return crypto.createHash('sha256').update(refreshToken).digest('hex');
}

/**
 * Refresh token → access token, cached. Every SP-API call goes through here.
 * A 400 from LWA means the seller revoked the authorization: surfaced as 401 so
 * callers can tell the user to reconnect rather than retrying forever.
 */
async function getAccessToken(refreshToken) {
  const key = cacheKey(refreshToken);
  const hit = _accessTokens.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.token;

  const { clientId, clientSecret } = config();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));

  if (!res.ok || !json.access_token) {
    const revoked = res.status === 400 || json.error === 'invalid_grant';
    const err = new Error(
      revoked
        ? 'Amazon has rejected this connection — the seller may have revoked access. Reconnect the brand.'
        : `Could not get an Amazon access token (HTTP ${res.status})${json.error_description ? `: ${json.error_description}` : ''}`
    );
    err.status = revoked ? 401 : 502;
    err.code = revoked ? 'AMAZON_REAUTH_REQUIRED' : 'AMAZON_LWA_ERROR';
    throw err;
  }

  const ttlMs = (Number(json.expires_in) || 3600) * 1000;
  _accessTokens.set(key, { token: json.access_token, expiresAt: Date.now() + Math.max(ttlMs - SKEW_MS, 60_000) });
  return json.access_token;
}

/** Drop a cached access token — used after a 403, in case the grant changed. */
function forgetAccessToken(refreshToken) {
  _accessTokens.delete(cacheKey(refreshToken));
}

module.exports = {
  SPAPI_HOSTS, CONSENT_HOSTS,
  isConfigured, isOAuthConfigured, hostFor,
  buildConsentUrl, consumeNonce, exchangeCode,
  getAccessToken, forgetAccessToken,
};
