/* ──────────────────────────────────────────────────────────────────────────────
   amazonController.js — HTTP surface for the Amazon SP-API integration.

   Additive and self-contained, exactly like shopifyController.js. Connections
   are per BRAND: Koparo's Amazon account and D'Chicha's Shopify store are
   independent rows on independent brands, and the same code serves both — a new
   brand needs a connection, never a code change.

   Two ways to connect, both landing in amazon_connections:
     • POST :brandId/connect   — paste a self-authorization refresh token
       (what a private app does; the seller generates it in Seller Central)
     • POST :brandId/install   — start the OAuth consent flow, for when our app
       is public and a client authorises us from their own account

   The callback route is deliberately UNAUTHENTICATED: Amazon redirects the
   seller's browser to it with no session of ours. Trust comes from the
   single-use state nonce checked in amazonAuth.consumeNonce().
   ────────────────────────────────────────────────────────────────────────────── */

const auth = require('../services/amazonAuth');
const tokenStore = require('../services/amazonTokenStore');
const client = require('../services/amazonClient');
const reports = require('../services/amazonReports');

// Where the seller's browser lands after we finish the handshake.
const FRONT_URL = process.env.AMAZON_FRONT_URL
  || process.env.SHOPIFY_FRONT_URL
  || process.env.COMPOSIO_FRONT_URL
  || 'http://localhost:3000/integrations';

/* GET /api/amazon/status — what is configured on this server? */
const status = (req, res) => res.json({
  configured: auth.isConfigured(),
  oauthConfigured: auth.isOAuthConfigured(),
  sandbox: String(process.env.AMAZON_USE_SANDBOX) === 'true',
  defaultMarketplaceId: tokenStore.DEFAULT_MARKETPLACE_ID,
  defaultRegion: tokenStore.DEFAULT_REGION,
});

/* GET /api/amazon/:brandId/connection — connection info, never the token. */
const getConnection = async (req, res, next) => {
  try {
    const conn = await tokenStore.getConnection(req.params.brandId);
    res.json({ connection: conn, connected: !!conn });
  } catch (e) { next(e); }
};

/* ── POST /api/amazon/:brandId/connect ────────────────────────────────────────
   Self-authorization: the seller generated a refresh token in Seller Central /
   Solution Provider Portal and pasted it in.

   The token is VALIDATED before it is stored — one LWA exchange proves it is
   real and belongs to our app. Storing an unverified paste would leave a brand
   looking connected until the first report run failed hours later. */
const connect = async (req, res, next) => {
  try {
    const { brandId } = req.params;
    const { refreshToken, sellingPartnerId, marketplaceId, region } = req.body || {};

    if (!refreshToken || !String(refreshToken).trim()) {
      return res.status(400).json({ error: 'Paste the refresh token from Seller Central.' });
    }
    const token = String(refreshToken).trim();
    if (!token.startsWith('Atzr|')) {
      // Amazon refresh tokens always carry this prefix. Catching it here turns a
      // baffling 400 from LWA into a sentence the user can act on.
      return res.status(400).json({
        error: 'That does not look like an Amazon refresh token — they begin with "Atzr|".',
      });
    }

    try {
      await auth.getAccessToken(token);            // proves the token works
    } catch (e) {
      return res.status(400).json({
        error: e.code === 'AMAZON_REAUTH_REQUIRED'
          ? 'Amazon rejected that refresh token. Generate a fresh one and try again.'
          : e.message,
      });
    }

    const saved = await tokenStore.saveConnection(brandId, {
      refreshToken: token,
      sellingPartnerId: sellingPartnerId || null,
      marketplaceId, region,
      authMethod: 'self',
      installedBy: req.user?.id || null,
    });
    res.json({ ok: true, connection: saved });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
};

/* POST /api/amazon/:brandId/install → { url } — OAuth consent (public app path) */
const install = async (req, res, next) => {
  try {
    const { brandId } = req.params;
    const { marketplaceId, draft } = req.body || {};
    const { url } = auth.buildConsentUrl(brandId, {
      marketplaceId, userId: req.user?.id, draft,
    });
    res.json({ url });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
};

/* ── GET /api/amazon/callback — Amazon redirects here. No auth by design. ──────
   The spapi_oauth_code is good for five minutes, so it is exchanged inline. */
const callback = async (req, res) => {
  try {
    const { spapi_oauth_code: code, selling_partner_id: spid, state } = req.query || {};
    const entry = auth.consumeNonce(state);
    if (!entry) throw Object.assign(new Error('This Amazon connection link has expired or was already used.'), { status: 400 });
    if (!code) throw Object.assign(new Error('Amazon did not return an authorization code.'), { status: 400 });

    const { refreshToken } = await auth.exchangeCode(code);
    await tokenStore.saveConnection(entry.brandId, {
      refreshToken,
      sellingPartnerId: spid || null,
      authMethod: 'oauth',
      installedBy: entry.userId || null,
    });

    const qs = new URLSearchParams({ amazon_connected: spid || 'ok', brand: entry.brandId });
    res.redirect(`${FRONT_URL}?${qs}`);
  } catch (e) {
    console.error('[amazon callback]', e.message);
    const qs = new URLSearchParams({ amazon_error: e.message.slice(0, 200) });
    res.redirect(`${FRONT_URL}?${qs}`);
  }
};

/* POST /api/amazon/:brandId/disconnect */
const disconnect = async (req, res, next) => {
  try {
    await tokenStore.revokeConnection(req.params.brandId);
    res.json({ ok: true });
  } catch (e) { next(e); }
};

/* GET /api/amazon/:brandId/ping — does the stored connection still work? */
const ping = async (req, res) => {
  try {
    const out = await client.ping(req.params.brandId);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(e.status || 502).json({ ok: false, error: e.message, code: e.code });
  }
};

/* GET /api/amazon/:brandId/reports/types — the catalogue, with role gating. */
const reportTypes = (req, res) => {
  const out = Object.entries(reports.REPORT_TYPES).map(([key, r]) => ({
    key, type: r.type, label: r.label, role: r.role,
    restricted: !!r.restricted, scheduledOnly: !!r.scheduledOnly,
  }));
  res.json({ types: out });
};

/* ── GET /api/amazon/:brandId/settlements/preview ─────────────────────────────
   The first thing worth looking at: Amazon's own settlement reports, unmodified.
   Read-only, and nothing is written to the database. */
const previewSettlements = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 1, 5);
    const rowLimit = Math.min(Number(req.query.rows) || 20, 500);
    const days = Math.min(Number(req.query.days) || 90, 365);
    const out = await reports.fetchSettlementReports(req.params.brandId, {
      since: new Date(Date.now() - days * 24 * 3600 * 1000),
      limit, rowLimit,
    });
    res.json(out);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, code: e.code });
  }
};

/* ── GET /api/amazon/:brandId/orders/preview ──────────────────────────────────
   Builds an orders report for a window and returns the first rows. Amazon caps
   the window at ~30 days for this type, so the default is deliberately short. */
const previewOrders = async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days) || 7, 30);
    const rowLimit = Math.min(Number(req.query.rows) || 20, 500);
    const out = await reports.fetchReport(
      req.params.brandId,
      reports.REPORT_TYPES.ORDERS_BY_ORDER_DATE.type,
      {
        dataStartTime: new Date(Date.now() - days * 24 * 3600 * 1000),
        dataEndTime: new Date(),
        limit: rowLimit,
      }
    );
    res.json({ reportId: out.reportId, headers: out.headers, rows: out.rows, count: out.rows.length });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, code: e.code });
  }
};

module.exports = {
  status, getConnection, connect, install, callback, disconnect,
  ping, reportTypes, previewSettlements, previewOrders,
};
