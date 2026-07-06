/**
 * zohoClient.js — read-only Zoho Books API client (India DC).
 *
 * Auth model: the permanent REFRESH TOKEN (in .env) mints short-lived (1h)
 * access tokens on demand. We cache the access token in memory and refresh it
 * automatically when it's near expiry or a call returns 401. No manual token
 * handling ever again.
 *
 * This client only ever issues GET requests — we never write back to Zoho.
 */

const ACCOUNTS_URL = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.in';
const API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
const CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;

let _token = null;      // cached access token
let _expiry = 0;        // epoch ms when it expires

const isConfigured = () => !!(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN);

async function getAccessToken(force = false) {
  if (!isConfigured()) throw new Error('Zoho is not configured (missing client id/secret/refresh token in .env).');
  if (!force && _token && Date.now() < _expiry - 60000) return _token; // 60s safety margin
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
  });
  const r = await fetch(`${ACCOUNTS_URL}/oauth/v2/token`, { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error(`Zoho token refresh failed: ${JSON.stringify(j)}`);
  _token = j.access_token;
  _expiry = Date.now() + (Number(j.expires_in || 3600) * 1000);
  return _token;
}

/** GET a Books endpoint (auto-auth, one 401 retry). `path` starts with '/'. */
async function zohoGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_DOMAIN}/books/v3${path}${qs ? `?${qs}` : ''}`;
  const call = async (tok) => fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${tok}` } });
  let res = await call(await getAccessToken());
  if (res.status === 401) res = await call(await getAccessToken(true)); // token expired → force refresh once
  if (res.status === 429) { await new Promise((r) => setTimeout(r, 2000)); res = await call(await getAccessToken()); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j.code && j.code !== 0)) throw new Error(`Zoho GET ${path} failed (${res.status}): ${j.message || JSON.stringify(j)}`);
  return j;
}

/** Fetch ALL pages of a list endpoint. Returns the flattened array under listKey. */
async function fetchAll(path, listKey, params = {}) {
  const out = [];
  let page = 1;
  for (;;) {
    const j = await zohoGet(path, { ...params, page, per_page: 200 });
    const rows = j[listKey] || [];
    out.push(...rows);
    const ctx = j.page_context || {};
    if (!ctx.has_more_page || rows.length === 0) break;
    page += 1;
    if (page > 200) break; // hard safety cap
  }
  return out;
}

/** Fetch a single record's full detail (used to pull line items). */
async function fetchOne(path, key, id, orgId) {
  const j = await zohoGet(`${path}/${id}`, { organization_id: orgId });
  return j[key] || null;
}

module.exports = { isConfigured, getAccessToken, zohoGet, fetchAll, fetchOne, API_DOMAIN };
