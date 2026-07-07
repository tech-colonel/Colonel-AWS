/* ──────────────────────────────────────────────────────────────────────────────
   composioController.js — HTTP handlers for the Composio marketplace.

   Additive feature — separate from integrationController.js (the curated 8
   connectors). Connections are scoped per logged-in user (req.user.id is the
   stable Composio user id). Secrets never touch our DB; Composio holds them.
   ────────────────────────────────────────────────────────────────────────────── */

const composio = require('../services/composioClient');

// Where the user's browser returns after authorizing on the provider.
// Env-driven so localhost, ngrok and AWS all work.
const FRONT_URL = process.env.COMPOSIO_FRONT_URL
  || process.env.GOOGLE_FRONT_URL
  || 'http://localhost:3000/integrations';

// Per-brand identity: a brand's whole team shares one connected account.
// The Composio userId is a string bucket we choose — here `brand_<brandId>`.
// Falls back to the logged-in user's id when no brand is supplied, so the
// endpoint still works if the UI hasn't picked a brand yet.
function resolveUserId(req, brandId) {
  const b = (brandId || '').toString().trim();
  return b ? `brand_${b}` : req.user.id;
}

/* GET /api/composio/status — is the server configured? (no auth-sensitive data) */
const status = (req, res) => {
  res.json({ configured: composio.isConfigured() });
};

/* GET /api/composio/toolkits — the full catalog for the showcase grid. */
const listToolkits = async (req, res, next) => {
  try {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const toolkits = await composio.listToolkits(force);
    res.json({ toolkits, count: toolkits.length });
  } catch (e) { next(e); }
};

/* GET /api/composio/connections — which toolkits the current user has connected. */
const listConnections = async (req, res, next) => {
  try {
    const userId = resolveUserId(req, req.query.brandId);
    const connections = await composio.listConnections(userId);
    res.json({ connections });
  } catch (e) { next(e); }
};

/* GET /api/composio/:slug/fields — credential fields for the connect form. */
const fields = async (req, res, next) => {
  try {
    const { slug } = req.params;
    if (!slug) return res.status(400).json({ error: 'Missing toolkit slug' });
    const info = await composio.getAuthFields(slug);
    res.json(info);
  } catch (e) { next(e); }
};

/* POST /api/composio/:slug/connect
   - OAuth apps: body { brandId } → returns { redirectUrl }.
   - Credential apps: body { brandId, authScheme, credentials } → connects directly. */
const connect = async (req, res, next) => {
  try {
    const { slug } = req.params;
    if (!slug) return res.status(400).json({ error: 'Missing toolkit slug' });
    const brandId = req.body?.brandId;
    const userId = resolveUserId(req, brandId);

    // ── Credential path (API key / bearer / basic) ──────────────────────────
    const { credentials, authScheme } = req.body || {};
    if (credentials && typeof credentials === 'object' && Object.keys(credentials).length) {
      const result = await composio.connectWithCredentials(userId, slug, authScheme, credentials);
      const active = String(result.status || '').toUpperCase() === 'ACTIVE';
      if (!active) {
        // Clean up the failed stub so it doesn't linger.
        if (result.connectedAccountId) { try { await composio.disconnect(result.connectedAccountId); } catch (_) {} }
        return res.status(422).json({ error: 'Those credentials couldn’t be verified — please check the values and try again.', status: result.status });
      }
      return res.json({ connected: true, status: result.status, connectedAccountId: result.connectedAccountId });
    }
    // ── OAuth path ──────────────────────────────────────────────────────────
    // Round-trip back to the integrations page carrying slug + brand so the UI
    // can toast and re-show the right brand's connections after the redirect.
    const brandParam = brandId ? `&brand=${encodeURIComponent(brandId)}` : '';
    const callbackUrl = `${FRONT_URL}?composio_connected=${encodeURIComponent(slug)}${brandParam}`;
    const result = await composio.connect(userId, slug, callbackUrl);
    if (!result.redirectUrl) {
      // Non-OAuth toolkits (API key / basic auth) can't be auto-connected yet.
      return res.status(422).json({
        error: 'This app needs credentials that must be entered manually — not supported in the marketplace yet.',
        connectedAccountId: result.connectedAccountId,
        status: result.status,
      });
    }
    res.json(result);
  } catch (e) {
    // Many toolkits have no Composio-managed OAuth app → they need the customer's
    // own credentials. Turn that raw 400 into a clean, friendly message.
    const raw = [e && e.message, e && e.code, JSON.stringify((e && e.response && e.response.data) || ''), JSON.stringify((e && e.body) || '')].join(' ');
    if (/DefaultAuthConfigNotFound|managed credentials|use_composio_managed_auth|not found for toolkit/i.test(raw)) {
      return res.status(422).json({
        error: 'This app can’t be one-click connected — it needs its own API key or OAuth credentials, which isn’t supported in the marketplace yet.',
        needsCustomAuth: true,
      });
    }
    next(e);
  }
};

/* POST /api/composio/connections/:id/disconnect — remove a connected account. */
const disconnect = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Missing connection id' });
    await composio.disconnect(id);
    res.json({ ok: true });
  } catch (e) {
    const raw = [e && e.message, e && e.code, e && e.status, JSON.stringify((e && e.response && e.response.data) || (e && e.body) || '')].join(' ');
    // Already gone / never existed → the desired end state is reached anyway.
    if (/not found|404|does not exist|no such|NotFound/i.test(raw)) {
      return res.json({ ok: true, alreadyGone: true });
    }
    console.error('[composio disconnect] failed:', raw);
    res.status(502).json({ error: 'Could not disconnect this app — please refresh and try again.' });
  }
};

module.exports = { status, listToolkits, listConnections, fields, connect, disconnect };
