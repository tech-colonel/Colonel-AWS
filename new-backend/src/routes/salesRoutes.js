const express = require('express');
const router = express.Router();
const multer = require('multer');
const { amazon, flipkart, getWorkingFiles, deleteWorkingFile, downloadWorkingFile } = require('../controllers/salesController');
const { authenticateToken } = require('../middleware/authMiddleware');

const upload = multer({ storage: multer.memoryStorage() });

// ─── Shared / Generic Working File Routes ─────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/working-files', authenticateToken, getWorkingFiles);
router.delete('/brands/:brandId/agents/:agentId/working-files/:fileId', authenticateToken, deleteWorkingFile);
router.get('/brands/:brandId/agents/:agentId/working-files/:fileId/download', authenticateToken, downloadWorkingFile);

// ─── Amazon Routes ─────────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/amazon/master', authenticateToken, amazon.getMasterData);
router.post('/brands/:brandId/agents/:agentId/amazon/master/sku', authenticateToken, upload.single('file'), amazon.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/amazon/master/ledger', authenticateToken, upload.single('file'), amazon.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/amazon/generate', authenticateToken, upload.single('file'), amazon.generate);

// ─── Flipkart Routes ───────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/flipkart/master', authenticateToken, flipkart.getMasterData);
router.post('/brands/:brandId/agents/:agentId/flipkart/master/sku', authenticateToken, upload.single('file'), flipkart.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/flipkart/master/ledger', authenticateToken, upload.single('file'), flipkart.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/flipkart/generate', authenticateToken, upload.single('file'), flipkart.generate);

module.exports = router;
