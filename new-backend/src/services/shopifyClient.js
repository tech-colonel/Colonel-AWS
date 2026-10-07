/* ──────────────────────────────────────────────────────────────────────────────
   shopifyClient.js — thin Shopify Admin API client (REST + GraphQL).

   One brand = one shop = one token (services/shopifyTokenStore.js). Every call
   is brand-scoped by construction: you pass a brandId, we look up that brand's
   token, and Shopify itself refuses to return another store's data for it. That
   is the outermost of the three isolation layers (Shopify → our token row → RLS).

   Handles the two things that actually bite at 30k+ orders:
     • Pagination — REST uses opaque `page_info` cursors in the Link header; you
       CANNOT pass filters alongside page_info, so filters are sent on page 1 only.
     • Rate limits — REST is a leaky bucket (429 + Retry-After); GraphQL is
       cost-based and returns THROTTLED in errors. Both are retried with backoff.

   Shopify offline tokens do not expire, so there is no refresh path by design.
   ────────────────────────────────────────────────────────────────────────────── */

const tokenStore = require('./shopifyTokenStore');

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 600;
const DEFAULT_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve a brand's credentials, or throw a message the UI can show verbatim. */
async function creds(brandId) {
  const c = await tokenStore.getToken(brandId);
  if (!c) {
    const err = new Error('This brand has no Shopify store connected yet.');
    err.status = 409;
    err.code = 'SHOPIFY_NOT_CONNECTED';
    throw err;
  }
  return c;
}

/* ── REST ───────────────────────────────────────────────────────────────────── */
/**
 * One REST call. `path` is relative to /admin/api/<version>/ — e.g. "orders.json".
 * Returns { body, link } where `link` is the raw Link header (for pagination).
 */
async function restRaw(brandId, path, { method = 'GET', query = {}, body = null } = {}) {
  const { shopDomain, accessToken, apiVersion } = await creds(brandId);
  const qs = new URLSearchParams(
    Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
  ).toString();
  const url = `https://${shopDomain}/admin/api/${apiVersion}/${path}${qs ? (path.includes('?') ? '&' : '?') + qs : ''}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method,
        signal: ctrl.signal,
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      clearTimeout(timer);
      if (attempt === MAX_RETRIES) throw new Error(`Shopify request failed: ${e.message}`);
      await sleep(BASE_BACKOFF_MS * 2 ** attempt);
      continue;
    }
    clearTimeout(timer);

    // Leaky bucket exhausted — Shopify tells us exactly how long to wait.
    if (res.status === 429) {
      const wait = Number(res.headers.get('Retry-After') || 2) * 1000;
      if (attempt === MAX_RETRIES) throw new Error('Shopify rate limit exceeded after retries.');
      await sleep(wait);
      continue;
    }
    // 5xx — transient on Shopify's side.
    if (res.status >= 500) {
      if (attempt === MAX_RETRIES) throw new Error(`Shopify ${res.status} after retries.`);
      await sleep(BASE_BACKOFF_MS * 2 ** attempt);
      continue;
    }

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = json.errors ? JSON.stringify(json.errors) : `HTTP ${res.status}`;
      const err = new Error(`Shopify API error: ${detail}`);
      err.status = res.status;
      // 401/403 nearly always means the merchant uninstalled or a scope is missing.
      if (res.status === 401 || res.status === 403) err.code = 'SHOPIFY_UNAUTHORIZED';
      throw err;
    }
    return { body: json, link: res.headers.get('Link') || '' };
  }
  throw new Error('Shopify request exhausted retries.');
}

/** Convenience: just the parsed body. */
async function rest(brandId, path, opts) {
  return (await restRaw(brandId, path, opts)).body;
}

/** Pull the `page_info` cursor out of a Link header, if there's a next page. */
function nextPageInfo(link) {
  // <https://x.myshopify.com/admin/api/2026-07/orders.json?page_info=abc>; rel="next"
  const m = /<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/.exec(link || '');
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Walk every page of a REST list endpoint.
 * `key` is the response property holding the array ("orders", "products", …).
 *
 * Shopify rejects a request that sends filters together with page_info, so
 * filters go out on the first page only and the cursor carries them forward.
 */
async function restPaginate(brandId, path, key, { query = {}, limit = 250, maxPages = 1000, onPage = null } = {}) {
  const out = [];
  let pageInfo = null;
  for (let page = 0; page < maxPages; page++) {
    const q = pageInfo ? { limit, page_info: pageInfo } : { limit, ...query };
    const { body, link } = await restRaw(brandId, path, { query: q });
    const rows = body[key] || [];
    out.push(...rows);
    if (onPage) await onPage(rows, page);
    pageInfo = nextPageInfo(link);
    if (!pageInfo || rows.length === 0) break;
  }
  return out;
}

/* ── GraphQL ────────────────────────────────────────────────────────────────── */
/**
 * GraphQL Admin API. Needed for anything REST doesn't expose — returns,
 * companies, store credit, markets, publications, order edits.
 * GraphQL reports throttling inside a 200 response, so we inspect the body.
 */
async function graphql(brandId, query, variables = {}) {
  const { shopDomain, accessToken, apiVersion } = await creds(brandId);
  const url = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 429 || res.status >= 500) {
      if (attempt === MAX_RETRIES) throw new Error(`Shopify GraphQL ${res.status} after retries.`);
      await sleep(BASE_BACKOFF_MS * 2 ** attempt);
      continue;
    }

    const json = await res.json().catch(() => ({}));
    const errs = json.errors || [];
    const throttled = errs.some((e) => e?.extensions?.code === 'THROTTLED');
    if (throttled) {
      if (attempt === MAX_RETRIES) throw new Error('Shopify GraphQL throttled after retries.');
      await sleep(BASE_BACKOFF_MS * 2 ** attempt);
      continue;
    }
    if (errs.length) {
      const err = new Error(`Shopify GraphQL error: ${errs.map((e) => e.message).join('; ')}`);
      err.status = 400;
      // A missing scope shows up here, not as an HTTP 403.
      if (/access denied|not approved|required scope/i.test(err.message)) err.code = 'SHOPIFY_SCOPE_MISSING';
      throw err;
    }
    return json.data || {};
  }
  throw new Error('Shopify GraphQL exhausted retries.');
}

/**
 * Walk a GraphQL connection (edges/pageInfo). `pick` maps the response to the
 * connection object, so callers stay declarative.
 */
async function graphqlPaginate(brandId, query, variables, pick, { maxPages = 1000 } = {}) {
  const out = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await graphql(brandId, query, { ...variables, after });
    const conn = pick(data);
    if (!conn) break;
    out.push(...(conn.edges || []).map((e) => e.node));
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

/** Is this brand connected, and does the token still work? */
async function ping(brandId) {
  const body = await rest(brandId, 'shop.json');
  return body.shop || null;
}

module.exports = { rest, restRaw, restPaginate, graphql, graphqlPaginate, ping, nextPageInfo };
