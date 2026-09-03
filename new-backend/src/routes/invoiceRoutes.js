const express = require('express');
const router = express.Router();
const invoiceController = require('../controllers/agents/invoice-process/invoiceController');
const { feedInvoicesFromN8n, progressFromN8n } = require('../controllers/agents/invoice-process/n8n-invoice-feed-db');
const { authenticateToken } = require('../middleware/authMiddleware');
const { addSseClient, removeSseClient, getState } = require('../utils/invoiceEvents');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const { processInvoice, getInvoices, getInvoicesGrouped, groupAction, uploadInvoiceFiles, getSheetUrl, updateInvoice, deleteInvoice, cancelInvoice, getRunHistory, retryRun } = invoiceController;
const purchaseInvoice = require('../controllers/agents/invoice-process/purchaseInvoiceController');

router.post('/brands/:brandId/agents/:agentId/invoice/process',          authenticateToken, processInvoice);
router.post('/brands/:brandId/agents/:agentId/invoice/upload',           authenticateToken, upload.array('files', 25), uploadInvoiceFiles);
router.post('/brands/:brandId/agents/:agentId/invoice/cancel',           authenticateToken, cancelInvoice);
router.get('/brands/:brandId/agents/:agentId/invoice/runs',              authenticateToken, getRunHistory);
router.post('/brands/:brandId/agents/:agentId/invoice/retry',            authenticateToken, retryRun);
router.get('/brands/:brandId/agents/:agentId/invoices',                  authenticateToken, getInvoices);
router.get('/brands/:brandId/agents/:agentId/invoices/grouped',          authenticateToken, getInvoicesGrouped);
router.post('/brands/:brandId/agents/:agentId/invoices/group-action',    authenticateToken, groupAction);
router.get('/brands/:brandId/agents/:agentId/invoice/sheet-url',         authenticateToken, getSheetUrl);
router.patch('/brands/:brandId/agents/:agentId/invoices/:invoiceId',     authenticateToken, updateInvoice);
router.delete('/brands/:brandId/agents/:agentId/invoices/:invoiceId',    authenticateToken, deleteInvoice);

// ─── Purchase Invoice mode (Urban Plant) → Tally ───────────────────────────
router.post('/brands/:brandId/purchase-invoice/extract', authenticateToken, upload.array('files', 25), purchaseInvoice.extract);
router.post('/brands/:brandId/purchase-invoice/pick',    authenticateToken, purchaseInvoice.savePick);
router.post('/brands/:brandId/purchase-invoice/master',  authenticateToken, purchaseInvoice.addMaster);
router.get('/brands/:brandId/purchase-invoice/master',   authenticateToken, purchaseInvoice.searchMaster);
router.post('/brands/:brandId/purchase-invoice/build',   authenticateToken, purchaseInvoice.build);

// X2Beta (Tally purchase-import) export of the brand's Invoice Process rows.
// Read-only; one template serves every brand (GST ledger block resolved per run).
const x2beta = require('../controllers/agents/invoice-process/x2betaController');
router.get('/brands/:brandId/invoice/x2beta/preview', authenticateToken, x2beta.preview);
router.get('/brands/:brandId/invoice/x2beta',         authenticateToken, x2beta.build);
router.post('/brands/:brandId/invoice/x2beta',        authenticateToken, x2beta.build);

// ─── Invoice masters (028): fixing an "N/A" and remembering the answer ──────
// The vendor master proper is the Google Sheet n8n reads (shown in the UI as an
// iframe); these endpoints cover only what an accountant taught us on top.
const masters = require('../controllers/agents/invoice-process/invoiceMasterController');
router.post('/brands/:brandId/invoice/master/resolve',        authenticateToken, masters.resolve);
router.get('/brands/:brandId/invoice/category-master',        authenticateToken, masters.listCategoryMaster);
router.patch('/brands/:brandId/invoice/category-master/:id',  authenticateToken, masters.updateCategoryRule);
router.delete('/brands/:brandId/invoice/category-master/:id', authenticateToken, masters.deleteCategoryRule);
router.get('/brands/:brandId/invoice/vendor-master',          authenticateToken, masters.listVendorMaster);
router.delete('/brands/:brandId/invoice/vendor-master/:id',   authenticateToken, masters.deleteVendorEntry);
router.get('/brands/:brandId/invoice/master-corrections',     authenticateToken, masters.listCorrections);
router.get('/brands/:brandId/invoice/na-summary',             authenticateToken, masters.naSummary);

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

// n8n live per-invoice progress ping (no auth — called by n8n during the run)
router.post('/n8n/progress', progressFromN8n);

module.exports = router;

