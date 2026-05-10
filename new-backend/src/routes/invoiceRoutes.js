const express = require('express');
const router = express.Router();
const invoiceController = require('../controllers/agents/invoice-process/invoiceController');
const { feedInvoicesFromN8n } = require('../controllers/agents/invoice-process/n8n-invoice-feed-db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { addSseClient, removeSseClient, getState } = require('../utils/invoiceEvents');

const { processInvoice, getInvoices, getSheetUrl, updateInvoice } = invoiceController;

router.post('/brands/:brandId/agents/:agentId/invoice/process',          authenticateToken, processInvoice);
router.get('/brands/:brandId/agents/:agentId/invoices',                  authenticateToken, getInvoices);
router.get('/brands/:brandId/agents/:agentId/invoice/sheet-url',         authenticateToken, getSheetUrl);
router.patch('/brands/:brandId/agents/:agentId/invoices/:invoiceId',     authenticateToken, updateInvoice);

// ─── SSE: Real-time invoice processing status ──────────────────────────────
// GET /api/brands/:brandId/agents/:agentId/invoice/status
router.get('/brands/:brandId/agents/:agentId/invoice/status', authenticateToken, (req, res) => {
  const { brandId, agentId } = req.params;

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // for nginx proxies
  res.flushHeaders();

  // Register this client
  addSseClient(brandId, agentId, res);

  // Immediately send the last known state so the client is in sync
  const currentState = getState(brandId, agentId);
  res.write(`data: ${JSON.stringify(currentState)}\n\n`);

  // Keep-alive ping every 25 seconds
  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(keepAlive); }
  }, 25000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(keepAlive);
    removeSseClient(brandId, agentId, res);
  });
});

// n8n webhook db feed (no auth — called by n8n directly)
router.post('/n8n/feed', feedInvoicesFromN8n);

module.exports = router;

