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
    hasKey: !!(cfg.apiKey || cfg.account),
    account: cfg.account || null,           // non-secret display value
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

module.exports = { listIntegrations, connectIntegration, disconnectIntegration };
