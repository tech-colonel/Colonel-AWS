const express = require('express');
const multer = require('multer');
const router = express.Router();

const { authenticateToken } = require('../middleware/authMiddleware');
const { processEInvoices, cancelEInvoice, listEInvoices, getEInvoicePdf, deleteEInvoice, deleteAllEInvoices } = require('../controllers/agents/einvoice-extract/einvoiceController');
const { addSseClient, removeSseClient, getState } = require('../utils/einvoiceEvents');

// e-invoice PDFs are small; allow generous multi-file uploads
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

// an <iframe> can't send an Authorization header — accept ?token=… for the PDF stream
const tokenFromQuery = (req, _res, next) => {
  if (!req.headers.authorization && req.query && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
};

router.post('/brands/:brandId/agents/:agentId/einvoice/process', authenticateToken, upload.any(), processEInvoices);
router.post('/brands/:brandId/agents/:agentId/einvoice/cancel',  authenticateToken, cancelEInvoice);
router.get('/brands/:brandId/agents/:agentId/einvoices',              authenticateToken, listEInvoices);
router.delete('/brands/:brandId/agents/:agentId/einvoices/:id',       authenticateToken, deleteEInvoice);
router.delete('/brands/:brandId/agents/:agentId/einvoices',           authenticateToken, deleteAllEInvoices);
router.get('/brands/:brandId/agents/:agentId/einvoice/pdf/:id',       tokenFromQuery, authenticateToken, getEInvoicePdf);

// ─── SSE: live "Processing X of N" status ──────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/einvoice/status', authenticateToken, (req, res) => {
  const { brandId, agentId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  addSseClient(brandId, agentId, res);
  res.write(`data: ${JSON.stringify(getState(brandId, agentId))}\n\n`);

  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(keepAlive); }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    removeSseClient(brandId, agentId, res);
  });
});

module.exports = router;
