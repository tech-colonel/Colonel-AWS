const express = require('express');
const router = express.Router();
const multer = require('multer');
const { flipkart, getWorkingFiles, deleteWorkingFile, downloadWorkingFile } = require('../controllers/salesController');
const salesAmazonController = require('../controllers/agents/sales-amazon/salesAmazonController');
const { authenticateToken } = require('../middleware/authMiddleware');

const upload = multer({ storage: multer.memoryStorage() });

// ─── Shared / Generic Working File Routes ─────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/working-files', authenticateToken, getWorkingFiles);
router.delete('/brands/:brandId/agents/:agentId/working-files/:fileId', authenticateToken, deleteWorkingFile);
router.get('/brands/:brandId/agents/:agentId/working-files/:fileId/download', authenticateToken, downloadWorkingFile);

// ─── Amazon Routes ─────────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/amazon/master', authenticateToken, salesAmazonController.getMasterData);
router.post('/brands/:brandId/agents/:agentId/amazon/master/sku', authenticateToken, upload.single('file'), salesAmazonController.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/amazon/master/ledger', authenticateToken, upload.single('file'), salesAmazonController.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/amazon/generate', authenticateToken, upload.single('file'), salesAmazonController.generate);

// Two-phase generation: preview → verify → commit/discard
router.post('/brands/:brandId/agents/:agentId/amazon/generate/preview', authenticateToken, upload.single('file'), salesAmazonController.generatePreview);
router.post('/brands/:brandId/agents/:agentId/amazon/generate/commit',  authenticateToken, salesAmazonController.generateCommit);
router.post('/brands/:brandId/agents/:agentId/amazon/generate/discard', authenticateToken, salesAmazonController.generateDiscard);


// ─── Flipkart Routes ───────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/flipkart/master', authenticateToken, flipkart.getMasterData);
router.post('/brands/:brandId/agents/:agentId/flipkart/master/sku', authenticateToken, upload.single('file'), flipkart.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/flipkart/master/ledger', authenticateToken, upload.single('file'), flipkart.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/flipkart/generate', authenticateToken, upload.single('file'), flipkart.generate);

// Two-phase generation: preview → verify → commit/discard
router.post('/brands/:brandId/agents/:agentId/flipkart/generate/preview', authenticateToken, upload.single('file'), flipkart.generatePreview);
router.post('/brands/:brandId/agents/:agentId/flipkart/generate/commit',  authenticateToken, flipkart.generateCommit);
router.post('/brands/:brandId/agents/:agentId/flipkart/generate/discard', authenticateToken, flipkart.generateDiscard);

module.exports = router;
