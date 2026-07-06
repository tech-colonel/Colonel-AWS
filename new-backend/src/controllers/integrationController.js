const { Integration } = require('../models/master');

// The connectors we surface in the UI. Visual connect only — no live OAuth yet.
const CATALOG = [
  {
    type: 'google',
    name: 'Google Workspace',
    blurb: 'Drive, Sheets & Gmail — power invoice exports and the MTR consolidator.',
    category: 'Storage & Docs',
    fields: [{ key: 'account', label: 'Service account email', placeholder: 'svc@project.iam.gserviceaccount.com' }],
  },
  {
    type: 'clickup',
    name: 'ClickUp',
    blurb: 'Sync tasks and reconciliation follow-ups into your ClickUp workspace.',
    category: 'Project & Tasks',
    fields: [{ key: 'apiKey', label: 'API token', placeholder: 'pk_********' }],
  },
  {
    type: 'zoho_books',
    name: 'Zoho Books',
    blurb: 'Pull ledgers & push reconciled entries to Zoho Books.',
    category: 'Accounting',
    fields: [
      { key: 'apiKey', label: 'OAuth client secret / token', placeholder: '1000.xxxxxxxx' },
      { key: 'account', label: 'Organization ID', placeholder: '60012345678' },
    ],
  },
  {
    type: 'tally',
    name: 'Tally (MCP)',
    blurb: 'Connect TallyPrime via the Tally MCP bridge for live ledger sync.',
    category: 'Accounting',
    fields: [{ key: 'account', label: 'Tally MCP endpoint', placeholder: 'http://localhost:9000' }],
  },
  {
    type: 'quickbooks',
    name: 'QuickBooks',
    blurb: 'Sync chart of accounts and journal entries with QuickBooks Online.',
    category: 'Accounting',
    fields: [{ key: 'apiKey', label: 'OAuth access token', placeholder: 'eyJ…' }],
  },
  {
    type: 'slack',
    name: 'Slack',
    blurb: 'Post reconciliation alerts & feedback notifications to a Slack channel.',
    category: 'Communication',
    fields: [{ key: 'apiKey', label: 'Bot token', placeholder: 'xoxb-…' }],
  },
  {
    type: 'gmail',
    name: 'Gmail',
    blurb: 'Auto-fetch invoice attachments straight from a mailbox.',
    category: 'Communication',
    fields: [{ key: 'account', label: 'Mailbox address', placeholder: 'invoices@brand.com' }],
  },
  {
    type: 'fireflies',
    name: 'Fireflies.ai',
    blurb: 'Auto-capture meeting notes & action items from calls.',
    category: 'Communication',
    fields: [{ key: 'apiKey', label: 'API key', placeholder: '••••••••' }],
  },
];

const CATALOG_BY_TYPE = Object.fromEntries(CATALOG.map((c) => [c.type, c]));

// Make sure a row exists for every catalog connector (idempotent).
const ensureCatalog = async () => {
  for (const c of CATALOG) {
    const [row] = await Integration.findOrCreate({
      where: { type: c.type },
      defaults: { type: c.type, name: c.name, status: 'disconnected', config: {} },
    });
    // Pre-connect Fireflies from the env-provided key (kept out of git in .env).
    if (c.type === 'fireflies' && process.env.FIREFLIES_API_KEY) {
      const cfg = row.config || {};
      if (!cfg.apiKey) {
        await row.update({
          status: 'connected',
          config: { ...cfg, apiKey: process.env.FIREFLIES_API_KEY },
        });
      }
    }
    // Pre-connect Zoho Books from the env-provided refresh token (read-only sync).
    if (c.type === 'zoho_books' && process.env.ZOHO_REFRESH_TOKEN) {
      const cfg = row.config || {};
      if (!cfg.refresh_token) {
        await row.update({
          status: 'connected',
          config: { ...cfg, refresh_token: process.env.ZOHO_REFRESH_TOKEN, account: process.env.ZOHO_ORGANIZATION_ID || null },
        });
      }
    }
  }
};

// Never leak secrets back to the client — only whether a key is set.
const publicView = (row) => {
  const cat = CATALOG_BY_TYPE[row.type] || {};
  const cfg = row.config || {};
  return {
    type: row.type,
    name: row.name || cat.name || row.type,
    blurb: cat.blurb || '',
    category: cat.category || 'Other',
    fields: cat.fields || [],
    status: row.status,
    hasKey: !!(cfg.apiKey || cfg.account || cfg.refresh_token),
    account: cfg.account || null,           // non-secret display value
    email: cfg.email || null,               // Google OAuth connected email
    picture: cfg.picture || null,           // Google OAuth profile picture
    connected_by: row.connected_by || null,
    updatedAt: row.updatedAt,
  };
};

/* GET /api/integrations (admin) */
const listIntegrations = async (req, res, next) => {
  try {
    await ensureCatalog();
    const rows = await Integration.findAll();
    const byType = Object.fromEntries(rows.map((r) => [r.type, r]));
    // Return in catalog order so the grid is stable.
    res.json(CATALOG.map((c) => publicView(byType[c.type] || { type: c.type, name: c.name, status: 'disconnected', config: {} })));
  } catch (e) { next(e); }
};

/* POST /api/integrations/:type/connect (admin) — body: { apiKey?, account? } */
const connectIntegration = async (req, res, next) => {
  try {
    const { type } = req.params;
    if (!CATALOG_BY_TYPE[type]) return res.status(404).json({ error: 'Unknown integration' });
    await ensureCatalog();
    const row = await Integration.findOne({ where: { type } });
    const cfg = { ...(row.config || {}) };
    if (req.body?.apiKey !== undefined) cfg.apiKey = req.body.apiKey;
    if (req.body?.account !== undefined) cfg.account = req.body.account;
    await row.update({ status: 'connected', config: cfg, connected_by: req.user.id });
    res.json(publicView(row));
  } catch (e) { next(e); }
};

/* POST /api/integrations/:type/disconnect (admin) */
const disconnectIntegration = async (req, res, next) => {
  try {
    const { type } = req.params;
    if (!CATALOG_BY_TYPE[type]) return res.status(404).json({ error: 'Unknown integration' });
    await ensureCatalog();
    const row = await Integration.findOne({ where: { type } });
    await row.update({ status: 'disconnected', config: {}, connected_by: null });
    res.json(publicView(row));
  } catch (e) { next(e); }
};

/* ── Google OAuth 2.0 ──────────────────────────────────────────────────────────
   Mirrors the AWS flow. URLs are env-driven so localhost and the ngrok/AWS host
   both work — set GOOGLE_REDIRECT_URI / GOOGLE_FRONT_URL in .env per environment.
   The connected user's tokens (incl. refresh_token) are stored on the google
   integration row and reused by googleClient.js for Calendar/Drive. */
const { google } = require('googleapis');

const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:8001/api/auth/google/callback';
const GOOGLE_FRONT_URL    = process.env.GOOGLE_FRONT_URL || 'http://localhost:3000/integrations';

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
  );
}

/* GET /api/integrations/google/oauth/start — returns { url } for the frontend to redirect to. */
const startGoogleOAuth = (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(400).json({ error: 'Google OAuth is not configured on this server (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).' });
  }
  try {
    const oauth2Client = makeOAuth2Client();
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/meetings.space.created',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'openid',
      ],
      state: req.user.id,
    });
    res.json({ url });
  } catch (e) {
    console.error('startGoogleOAuth error:', e.message);
    res.status(500).json({ error: 'Failed to build OAuth URL' });
  }
};

/* GET /api/auth/google/callback — public; Google redirects here after consent. */
const googleOAuthCallback = async (req, res) => {
  const { code, error, state } = req.query;
  if (error || !code) {
    console.error('Google OAuth denied:', error);
    return res.redirect(GOOGLE_FRONT_URL + '?error=oauth_denied');
  }
  try {
    const oauth2Client = makeOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: userInfo } = await oauth2Api.userinfo.get();

    await ensureCatalog();
    const row = await Integration.findOne({ where: { type: 'google' } });
    const existingCfg = row.config || {};
    await row.update({
      status: 'connected',
      config: {
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token || existingCfg.refresh_token,
        token_expiry:  tokens.expiry_date,
        email:   userInfo.email || existingCfg.email || '',
        name:    userInfo.name || existingCfg.name || '',
        picture: userInfo.picture || existingCfg.picture || '',
      },
      connected_by: state || null,
    });

    console.log('Google OAuth connected:', userInfo.email);
    res.redirect(GOOGLE_FRONT_URL + '?connected=true');
  } catch (e) {
    console.error('googleOAuthCallback error:', e.message);
    res.redirect(GOOGLE_FRONT_URL + '?error=oauth_failed');
  }
};

module.exports = { listIntegrations, connectIntegration, disconnectIntegration, startGoogleOAuth, googleOAuthCallback };
