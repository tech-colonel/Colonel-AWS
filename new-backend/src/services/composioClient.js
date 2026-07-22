/* ──────────────────────────────────────────────────────────────────────────────
   composioClient.js — thin wrapper around @composio/core (v0.13.x).

   Composio is a hosted tool/auth layer: one API key unlocks 1000+ downstream
   toolkits (Gmail, Slack, GitHub, Notion, QuickBooks …). We use it to:
     • showcase the full catalog as integration cards  → listToolkits()
     • let each logged-in user connect a toolkit         → connect()
     • show which toolkits a user has connected          → listConnections()

   Credentials for the downstream apps live inside Composio, never in our DB.
   This module is self-contained and additive — it does not touch any existing
   integration logic. If COMPOSIO_API_KEY is unset every call fails softly with
   a clear error so the rest of the app keeps working.
   ────────────────────────────────────────────────────────────────────────────── */

let _composio = null;

/** Lazily build (and cache) the SDK client. Throws a friendly error if unconfigured. */
function getClient() {
  if (_composio) return _composio;
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    const err = new Error('Composio is not configured on this server (missing COMPOSIO_API_KEY).');
    err.status = 400;
    throw err;
  }
  // Require lazily so a missing dependency never crashes app boot.
  const { Composio } = require('@composio/core');
  _composio = new Composio({ apiKey });
  return _composio;
}

/** True when a key is present — lets the controller answer /status without throwing. */
function isConfigured() {
  return !!process.env.COMPOSIO_API_KEY;
}

/* ── Toolkit catalog (cached in-memory; changes rarely) ─────────────────────── */
let _catalogCache = null;
let _catalogAt = 0;
const CATALOG_TTL_MS = 60 * 60 * 1000; // 1 hour

function normalizeToolkit(t) {
  const meta = t.meta || t.metadata || {};
  const categories = (meta.categories || t.categories || [])
    .map((c) => (typeof c === 'string' ? { slug: c, name: c } : { slug: c.slug, name: c.name }))
    .filter((c) => c && c.slug);

  // Auth capability — decides HOW the card connects.
  //   composioManagedAuthSchemes non-empty → Composio hosts the OAuth app → one-click OAuth.
  //   API_KEY / BEARER_TOKEN / BASIC → the user pastes their own credentials (a form).
  //   OAUTH2/OAUTH1 without managed creds → needs a developer-provided OAuth app.
  //   noAuth → nothing to connect.
  const managed = Array.isArray(t.composioManagedAuthSchemes) ? t.composioManagedAuthSchemes : [];
  const schemes = (Array.isArray(t.authSchemes) ? t.authSchemes : []).map((s) => String(s).toUpperCase());
  const oneClick = managed.length > 0;
  let authType;
  if (t.noAuth) authType = 'none';
  else if (oneClick) authType = 'oauth';
  else if (schemes.includes('API_KEY')) authType = 'api_key';
  else if (schemes.includes('BEARER_TOKEN')) authType = 'bearer';
  else if (schemes.includes('BASIC') || schemes.includes('BASIC_WITH_JWT')) authType = 'basic';
  else if (schemes.includes('OAUTH2') || schemes.includes('OAUTH1')) authType = 'oauth_custom';
  else authType = 'custom';

  return {
    slug: t.slug || t.key || t.name,
    name: t.name || t.slug,
    logo: meta.logo || t.logo || null,
    description: meta.description || t.description || '',
    categories,
    toolsCount: meta.toolsCount ?? t.toolsCount ?? null,
    oneClick,          // true → Composio-managed OAuth (one click)
    authType,          // 'oauth' | 'api_key' | 'bearer' | 'basic' | 'oauth_custom' | 'none' | 'custom'
    // Can an end-user connect this themselves (OAuth click or a credential form)?
    userConnectable: oneClick || ['api_key', 'bearer', 'basic', 'none'].includes(authType),
  };
}

// Map a toolkit auth scheme → the AuthScheme.* factory + a UI hint.
const CREDENTIAL_SCHEMES = {
  API_KEY: 'APIKey',
  BEARER_TOKEN: 'BearerToken',
  BASIC: 'Basic',
  BASIC_WITH_JWT: 'BasicWithJWT',
  NO_AUTH: 'NoAuth',
};

/**
 * Return the full toolkit catalog (normalized). Cached for CATALOG_TTL_MS.
 * @param {boolean} force  bypass cache
 */
async function listToolkits(force = false) {
  const now = Date.now();
  if (!force && _catalogCache && now - _catalogAt < CATALOG_TTL_MS) return _catalogCache;

  const composio = getClient();
  const res = await composio.toolkits.get({});
  // Response is a paginated object { items: [...] } (be defensive about shape).
  const items = Array.isArray(res) ? res : (res.items || res.data || []);
  const list = items.map(normalizeToolkit).filter((t) => t.slug);
  // Stable alphabetical order so the grid doesn't jump around.
  list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  _catalogCache = list;
  _catalogAt = now;
  return list;
}

/* ── Auth configs — ensure a Composio-managed config exists for a toolkit ────── */
/**
 * Composio needs an "auth config" per toolkit before a user can connect.
 * - No authScheme  → Composio-managed OAuth (one-click apps).
 * - With authScheme → a custom-auth config for a credential scheme (API_KEY /
 *   BEARER_TOKEN / BASIC). Credentials themselves are supplied per-user later.
 * We reuse a matching existing config, else create one. Returns the config id.
 */
async function ensureAuthConfig(slug, opts = {}) {
  const composio = getClient();
  const scheme = opts.authScheme ? String(opts.authScheme).toUpperCase() : null;

  try {
    const existing = await composio.authConfigs.list({ toolkit: slug });
    const items = existing.items || existing.data || [];
    const match = scheme
      ? items.find((a) => String(a.authScheme).toUpperCase() === scheme)
      : items.find((a) => a.isComposioManaged) || items[0];
    if (match) return match.id || match.nanoid;
  } catch (_) { /* fall through to create */ }

  if (scheme) {
    const created = await composio.authConfigs.create(slug, { type: 'use_custom_auth', authScheme: scheme, credentials: {} });
    return created.id || created.nanoid || (created.authConfig && created.authConfig.id);
  }
  const created = await composio.authConfigs.create(slug, { type: 'use_composio_managed_auth' });
  return created.id || created.nanoid || (created.authConfig && created.authConfig.id);
}

/**
 * The credential fields a toolkit expects (for the connect form).
 * Reads the toolkit detail → authConfigDetails → connectedAccountInitiation.
 */
async function getAuthFields(slug) {
  const composio = getClient();
  const tk = await composio.toolkits.get(slug);
  const managed = Array.isArray(tk.composioManagedAuthSchemes) ? tk.composioManagedAuthSchemes : [];
  const det = (tk.authConfigDetails || [])[0] || {};
  const init = (det.fields && det.fields.connectedAccountInitiation) || {};
  const toField = (f, required) => ({ name: f.name, label: f.displayName || f.name, type: f.type || 'string', required });
  const fields = [
    ...((init.required || []).map((f) => toField(f, true))),
    ...((init.optional || []).map((f) => toField(f, false))),
  ];
  return {
    authScheme: det.mode || (Array.isArray(tk.authSchemes) && tk.authSchemes[0]) || null,
    oneClick: managed.length > 0,
    fields,
  };
}

/**
 * Connect a user to a non-OAuth toolkit using credentials they supply
 * (API key / bearer token / basic auth). Returns { connectedAccountId, status }.
 */
async function connectWithCredentials(userId, slug, authScheme, credentials) {
  const { AuthScheme } = require('@composio/core');
  const composio = getClient();
  const scheme = String(authScheme || 'API_KEY').toUpperCase();
  const factory = CREDENTIAL_SCHEMES[scheme] || 'APIKey';
  const authConfigId = await ensureAuthConfig(slug, { authScheme: scheme });
  const config = AuthScheme[factory](credentials || {});
  const request = await composio.connectedAccounts.initiate(userId, authConfigId, { config });
  // Credential schemes usually validate immediately — confirm the real status.
  let status = request.status;
  try {
    const acct = await composio.connectedAccounts.get(request.id);
    status = acct.status || status;
  } catch (_) { /* keep initiate status */ }
  return { connectedAccountId: request.id, status };
}

/* ── Connect / disconnect / status (per user) ───────────────────────────────── */
/**
 * Start a connection for `userId` to `slug`. Returns { redirectUrl, connectedAccountId }.
 * For OAuth toolkits redirectUrl points at the provider consent page; after the
 * user authorizes, Composio redirects the browser to `callbackUrl`.
 */
async function connect(userId, slug, callbackUrl) {
  const composio = getClient();
  const authConfigId = await ensureAuthConfig(slug);
  const request = await composio.connectedAccounts.link(userId, authConfigId, { callbackUrl });
  return {
    connectedAccountId: request.id || null,
    redirectUrl: request.redirectUrl || null,
    status: request.status || 'INITIATED',
  };
}

/**
 * List a user's *completed* connected accounts (status ACTIVE only).
 * Composio creates an INITIATED/INITIALIZING stub the moment an OAuth flow
 * starts; if the user abandons consent it lingers in that pending state. Those
 * are NOT real connections, so we filter them out (both server-side via the
 * `statuses` param and client-side for safety) — otherwise the UI would show a
 * false "Connected" badge.
 */
async function listConnections(userId) {
  const composio = getClient();
  const res = await composio.connectedAccounts.list({ userIds: [userId], statuses: ['ACTIVE'] });
  const items = res.items || res.data || [];
  return items
    .filter((c) => String(c.status || '').toUpperCase() === 'ACTIVE')
    .map((c) => ({
      id: c.id || c.nanoid,
      slug: (c.toolkit && (c.toolkit.slug || c.toolkit)) || c.toolkitSlug || c.appName || null,
      status: c.status || 'ACTIVE',
    }))
    .filter((c) => c.slug && c.id);
}

/** Remove a connected account by its id (works for ACTIVE and pending stubs). */
async function disconnect(connectedAccountId) {
  const composio = getClient();
  return composio.connectedAccounts.delete(connectedAccountId);
}

/* ── Tool execution (fetch real data through a user's connected account) ─────── */
/**
 * Execute a Composio tool/action for `userId`'s connected account.
 * @param {string} userId  the Composio entity bucket (we use the app user id)
 * @param {string} slug    action slug, e.g. 'GOOGLECALENDAR_EVENTS_LIST'
 * @param {object} args    the action arguments
 * @returns {Promise<{successful?:boolean, data?:any, error?:any}>}
 */
async function executeTool(userId, slug, args = {}) {
  const composio = getClient();
  // dangerouslySkipVersionCheck: use the toolkit's "latest" version (required for
  // manual execution; else @composio/core throws ComposioToolVersionRequiredError).
  return composio.tools.execute(slug, { userId, arguments: args, dangerouslySkipVersionCheck: true });
}

/** True when `userId` has an ACTIVE connection to `toolkitSlug` (e.g. 'googlecalendar'). */
async function hasConnection(userId, toolkitSlug) {
  const want = String(toolkitSlug || '').toLowerCase();
  const conns = await listConnections(userId);
  return conns.some((c) => String(c.slug || '').toLowerCase() === want);
}

/* ── Google account identity ─────────────────────────────────────────────────
   Composio stores OAuth tokens but not the account email on the connection
   record, so we resolve it once via the Gmail profile tool and cache it
   (short TTL) per userId. Returns null if it can't be resolved (e.g. no gmail
   connection or the tool errors) — callers fall back to a generic label. */
const _emailCache = new Map(); // userId -> { email, at }
const EMAIL_TTL_MS = 10 * 60 * 1000; // 10 min

async function getGoogleEmail(userId, force = false) {
  const now = Date.now();
  const hit = _emailCache.get(userId);
  if (!force && hit && now - hit.at < EMAIL_TTL_MS) return hit.email;
  let email = null;
  try {
    // GMAIL_GET_PROFILE returns { emailAddress, ... } for the connected account.
    const res = await executeTool(userId, 'GMAIL_GET_PROFILE', {});
    const data = (res && (res.data || res)) || {};
    email = data.emailAddress || data.email || (data.response_data && data.response_data.emailAddress) || null;
  } catch (_) { /* leave null — caller uses a fallback label */ }
  _emailCache.set(userId, { email, at: now });
  return email;
}

/** Forget a cached email (call after connect/disconnect so labels refresh). */
function clearGoogleEmail(userId) { _emailCache.delete(userId); }

/** The (Composio-hosted) logo URL for a toolkit slug, from the cached catalog.
    Lets the UI show the real provider logo instead of a hardcoded icon. */
async function getToolkitLogo(slug) {
  try {
    const list = await listToolkits();
    const t = list.find((x) => String(x.slug).toLowerCase() === String(slug).toLowerCase());
    return (t && t.logo) || null;
  } catch (_) { return null; }
}

module.exports = {
  isConfigured,
  listToolkits,
  ensureAuthConfig,
  getAuthFields,
  connect,
  connectWithCredentials,
  listConnections,
  disconnect,
  executeTool,
  hasConnection,
  getGoogleEmail,
  clearGoogleEmail,
  getToolkitLogo,
};
