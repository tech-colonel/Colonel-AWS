const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const { authenticateToken } = require('../middleware/authMiddleware');
const {
  processPO, cancelPO, getPOSheetUrl, updatePOSettings, uploadPOFiles,
  listPORows, updatePORow, deletePORow, deleteAllPO,
} = require('../controllers/agents/po-extract/poController');
const { feedPOFromN8n } = require('../controllers/agents/po-extract/n8n-po-feed-db');
const {
  getMaster, saveMasterRow, updateMasterRow, deleteMasterRow, uploadMaster, syncMasters,
} = require('../controllers/agents/po-extract/poMasterController');
const masterUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const { addSseClient, removeSseClient, getState } = require('../utils/invoiceEvents');

// ── Authenticated app endpoints ───────────────────────────────────────────
router.post('/brands/:brandId/agents/:agentId/po/process',      authenticateToken, processPO);
router.post('/brands/:brandId/agents/:agentId/po/upload',       authenticateToken, upload.array('files', 25), uploadPOFiles);
router.post('/brands/:brandId/agents/:agentId/po/cancel',       authenticateToken, cancelPO);
router.get('/brands/:brandId/agents/:agentId/po/sheet-url',     authenticateToken, getPOSheetUrl);
router.patch('/brands/:brandId/po/settings',                    authenticateToken, updatePOSettings);
router.get('/brands/:brandId/agents/:agentId/po-rows',          authenticateToken, listPORows);
router.patch('/brands/:brandId/agents/:agentId/po-rows/:rowId', authenticateToken, updatePORow);
router.delete('/brands/:brandId/agents/:agentId/po-rows/:rowId', authenticateToken, deletePORow);
router.delete('/brands/:brandId/agents/:agentId/po-rows',       authenticateToken, deleteAllPO);

// ── Master data (Vendor: Buyer GSTIN -> Tally name; SKU: Material code -> FG) ──
// `sync` is declared before `:kind` so it is not captured as a kind.
router.post('/brands/:brandId/po/master/sync',               authenticateToken, syncMasters);
router.get('/brands/:brandId/po/master/:kind',               authenticateToken, getMaster);
router.post('/brands/:brandId/po/master/:kind',              authenticateToken, saveMasterRow);
router.post('/brands/:brandId/po/master/:kind/upload',       authenticateToken, masterUpload.single('file'), uploadMaster);
router.patch('/brands/:brandId/po/master/:kind/:id',         authenticateToken, updateMasterRow);
router.delete('/brands/:brandId/po/master/:kind/:id',        authenticateToken, deleteMasterRow);

// ── SSE: live "Scanning X of N" (shares the invoiceEvents store) ───────────
router.get('/brands/:brandId/agents/:agentId/po/status', authenticateToken, (req, res) => {
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

// ── n8n → DB feed (no auth — called by n8n directly). Progress pings reuse
//    the existing POST /api/n8n/progress (mounted by invoiceRoutes).
router.post('/n8n/po/feed', feedPOFromN8n);

module.exports = router;
