const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');
const { markProcessing, markDone, resetRun, getState } = require('../../../utils/invoiceEvents');
const { setExecution, getExecution, clearExecution } = require('../../../utils/executionStore');

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
    const brandId = req.params.brandId || (req.body && req.body.brandId);
    const agentId = req.params.agentId || (req.body && req.body.agentId);

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

    // ─── Concurrency guard ──────────────────────────────────────────────────
    // Refuse to fire the n8n webhook again while a run is already in flight, so
    // repeated Process clicks can't spawn multiple overlapping executions. A run
    // older than 3 min is treated as stale (self-heal) and allowed to re-trigger.
    const state = getState(brandId, agentId);
    if (state && state.status === 'processing') {
      const age = Date.now() - new Date(state.timestamp || 0).getTime();
      if (age < 3 * 60 * 1000) {
        return res.status(409).json({ error: 'A run is already in progress. Please wait for it to finish.', busy: true });
      }
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
      
      try {
        const n8nRes = await fetch('https://colonel1234.app.n8n.cloud/api/v1/executions?status=running&limit=1', {
          headers: { 'X-N8N-API-KEY': process.env.n8n_api_key }
        });
        const n8nData = await n8nRes.json();
        const executionId = n8nData?.data?.[0]?.id || null;
        if (executionId) setExecution(brandId, agentId, executionId);
        return res.json({ success: true, message: 'Processing started. Invoices will appear once n8n finishes.', pending: true, executionId });
      } catch (err) {
        console.error('[Invoice] Could not fetch execution ID:', err.message);
        return res.json({ success: true, message: 'Processing started. Invoices will appear once n8n finishes.', pending: true, executionId: null });
      }

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
      'company', 'seller_gstin', 'invoice_number', 'invoice_date', 'due_date',
      'buyer_gstin', 'category', 'product_name',
      'hsn_code', 'quantity', 'unit', 'rate',
      'cgst_rate', 'sgst_rate', 'igst_rate',
      'cgst_amount', 'sgst_amount', 'igst_amount',
      'gst_amount', 'taxable_value', 'invoice_link', 'status',
      'tds_section', 'tds_rate', 'tds_amount'
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

// ─── POST /api/brands/:brandId/agents/:agentId/invoice/cancel ────────────────
const cancelInvoice = async (req, res, next) => {
  try {
    const brandId = req.params.brandId;
    const agentId = req.params.agentId;

    const execution = getExecution(brandId, agentId);

    // Step 1 — Find the n8n execution to stop. Prefer the one captured at start;
    // otherwise look up whatever is running right now.
    let execId = execution && execution.executionId ? execution.executionId : null;
    if (!execId) {
      try {
        const r = await fetch('https://colonel1234.app.n8n.cloud/api/v1/executions?status=running&limit=1', {
          headers: { 'X-N8N-API-KEY': process.env.n8n_api_key }
        });
        const j = await r.json();
        execId = (j && j.data && j.data[0] && j.data[0].id) || null;
      } catch (err) {
        console.error('[Cancel] Could not look up running execution:', err.message);
      }
    }

    // Step 2 — Really stop the n8n workflow (best effort)
    let stopped = false;
    if (execId) {
      try {
        const stopRes = await fetch(`https://colonel1234.app.n8n.cloud/api/v1/executions/${execId}/stop`, {
          method: 'POST',
          headers: { 'X-N8N-API-KEY': process.env.n8n_api_key }
        });
        stopped = stopRes.ok;
      } catch (err) {
        console.error('[Cancel] Could not stop n8n execution:', err.message);
      }
    }

    // Step 3 — Rollback: delete invoice rows saved in this run
    if (execution && execution.invoiceIds && execution.invoiceIds.length > 0) {
      try {
        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);
        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const InvoiceModel = getDynamicModel(brandDb, tableName, agent.columns);
        await InvoiceModel.destroy({ where: { id: execution.invoiceIds } });
      } catch (err) {
        console.error('[Cancel] Rollback failed:', err.message);
      }
    }

    // Step 4 — Reset state + notify clients (always, even if nothing was tracked)
    clearExecution(brandId, agentId);
    resetRun(brandId, agentId);

    res.json({
      success: true,
      message: 'Processing cancelled',
      stopped,
      rolledBack: (execution && execution.invoiceIds) ? execution.invoiceIds.length : 0
    });

  } catch (error) {
    next(error);
  }
};

module.exports = {
  processInvoice,
  getInvoices,
  getSheetUrl,
  updateInvoice,
  cancelInvoice
};
