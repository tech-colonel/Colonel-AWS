const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');
const { markProcessing, markDone } = require('../../../utils/invoiceEvents');

// ─── Helper: parse dates in DD/MM/YYYY or DD-MM-YYYY format ─────────────────
const parseDate = (dString) => {
  if (!dString) return null;
  const parts = dString.split(/[-/]/);
  if (parts.length === 3 && parts[2].length === 4) {
    // DD-MM-YYYY or DD/MM/YYYY
    return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
  }
  return new Date(dString); // fallback (ISO format etc.)
};

// ─── POST /api/brands/:brandId/agents/:agentId/invoice/process ───────────────
const processInvoice = async (req, res, next) => {
  try {
    const brandId = req.body.brandId || req.params.brandId;
    const agentId = req.body.agentId || req.params.agentId;

    const brand = await Brand.findByPk(brandId);
    const agent = await Agent.findByPk(agentId);

    if (!brand || !agent) {
      return res.status(404).json({ error: 'Brand or Agent not found' });
    }

    // Read the webhook URL from .env as: {brandname}_invoice_url
    // Checks lowercase, UPPERCASE and exact casing
    const webhookUrl =
      process.env[`${brand.name.toLowerCase()}_invoice_url`] ||
      process.env[`${brand.name.toUpperCase()}_invoice_url`] ||
      process.env[`${brand.name}_invoice_url`];

    if (!webhookUrl) {
      return res.status(400).json({
        error: `Webhook URL not configured in .env for brand "${brand.name}". Expected key: ${brand.name.toLowerCase()}_invoice_url`
      });
    }

    // Signal to SSE clients that processing has started
    markProcessing(brandId, agentId);

    // Call the n8n webhook using native fetch
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brandId: brand.id,
          brandName: brand.name,
          agentId: agent.id,
          timestamp: new Date().toISOString()
        }),
        signal: AbortSignal.timeout(30000) // 30s timeout
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      // We rely ENTIRELY on n8n calling the /n8n/feed endpoint to store data and call markDone()
      return res.json({ success: true, message: 'Processing started. Invoices will appear once n8n finishes.', pending: true });

    } catch (apiError) {
      if (apiError.name === 'TimeoutError' || apiError.name === 'AbortError') {
        // Webhook took too long — but we are relying on /api/n8n/feed anyway.
        console.log('[Invoice] n8n webhook timed out — waiting for n8n to push via /api/n8n/feed');
        return res.json({ success: true, message: 'Processing started. Invoices will appear once n8n finishes.', pending: true });
      }
      console.error('[Invoice] n8n webhook error:', apiError.message);
      return res.status(502).json({ error: 'Failed to communicate with invoice processing webhook.' });
    }

  } catch (error) {
    next(error);
  }
};

// ─── GET /api/brands/:brandId/agents/:agentId/invoices ───────────────────────
const getInvoices = async (req, res, next) => {
  try {
    const { brandId, agentId } = req.params;

    const brand = await Brand.findByPk(brandId);
    const agent = await Agent.findByPk(agentId);

    if (!brand || !agent) {
      return res.status(404).json({ error: 'Brand or Agent not found' });
    }

    const brandDb = getBrandConnection(brand.db_name);
    const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const InvoiceModel = getDynamicModel(brandDb, tableName, agent.columns);

    // Ensure table exists silently before querying
    await InvoiceModel.sync({ alter: false }).catch(() => { });

    try {
      const invoices = await InvoiceModel.findAll({
        order: [['processed_on', 'DESC']]
      });
      res.json(invoices);
    } catch (err) {
      // Table may not exist yet on first load — return empty gracefully
      if (err.name === 'SequelizeDatabaseError') {
        return res.json([]);
      }
      throw err;
    }

  } catch (error) {
    next(error);
  }
};

// ─── GET /api/brands/:brandId/agents/:agentId/invoice/sheet-url ──────────────
const getSheetUrl = async (req, res, next) => {
  try {
    const { brandId } = req.params;

    const brand = await Brand.findByPk(brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const sheetUrl =
      process.env[`${brand.name.toLowerCase()}_invoice_sheet`] ||
      process.env[`${brand.name.toUpperCase()}_invoice_sheet`] ||
      process.env[`${brand.name}_invoice_sheet`] ||
      null;

    res.json({ sheetUrl });
  } catch (error) {
    next(error);
  }
};

// ─── PATCH /api/brands/:brandId/agents/:agentId/invoices/:invoiceId ──────────
const updateInvoice = async (req, res, next) => {
  try {
    const { brandId, agentId, invoiceId } = req.params;

    const brand = await Brand.findByPk(brandId);
    const agent = await Agent.findByPk(agentId);

    if (!brand || !agent) {
      return res.status(404).json({ error: 'Brand or Agent not found' });
    }

    const brandDb = getBrandConnection(brand.db_name);
    const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const InvoiceModel = getDynamicModel(brandDb, tableName, agent.columns);

    const invoice = await InvoiceModel.findByPk(invoiceId);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Whitelist of updatable fields
    const allowed = [
      'buyer_gstin', 'category', 'product_name',
      'hsn_code', 'quantity', 'unit', 'rate',
      'cgst_rate', 'sgst_rate', 'igst_rate',
      'cgst_amount', 'sgst_amount', 'igst_amount',
      'gst_amount', 'taxable_value', 'invoice_link', 'status'
    ];

    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        // Parse dates if needed
        if ((key === 'invoice_date' || key === 'due_date') && req.body[key]) {
          updates[key] = parseDate(req.body[key]);
        } else {
          updates[key] = req.body[key];
        }
      }
    }

    await invoice.update(updates);

    res.json({ success: true, message: 'Invoice updated successfully', data: invoice });

  } catch (error) {
    next(error);
  }
};

module.exports = {
  processInvoice,
  getInvoices,
  getSheetUrl,
  updateInvoice
};
