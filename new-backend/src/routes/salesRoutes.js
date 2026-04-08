const express = require('express');
const router = express.Router();
const multer = require('multer');
const { flipkart, getWorkingFiles, deleteWorkingFile, downloadWorkingFile, addSkuMasterSingle, deleteSkuMasterSingle } = require('../controllers/salesController');
const salesAmazonController = require('../controllers/agents/sales-amazon/salesAmazonController');
const salesMyntraController = require('../controllers/agents/sales-myntra/salesMyntraController');
const { authenticateToken } = require('../middleware/authMiddleware');

const upload = multer({ storage: multer.memoryStorage() });

// ─── Shared / Generic Working File Routes ─────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/working-files', authenticateToken, getWorkingFiles);
router.delete('/brands/:brandId/agents/:agentId/working-files/:fileId', authenticateToken, deleteWorkingFile);
router.get('/brands/:brandId/agents/:agentId/working-files/:fileId/download', authenticateToken, downloadWorkingFile);

// ─── Shared SKU Single Entry Routes (agent-agnostic) ──────────────────────────
router.post('/brands/:brandId/agents/:agentId/master/sku/add', authenticateToken, addSkuMasterSingle);
router.delete('/brands/:brandId/agents/:agentId/master/sku/delete', authenticateToken, deleteSkuMasterSingle);

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

const salesBlinkitController = require('../controllers/agents/sales-blinkit/salesBlinkitController');

// ─── Myntra Routes ─────────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/myntra/master', authenticateToken, salesMyntraController.getMasterData);
router.post('/brands/:brandId/agents/:agentId/myntra/master/sku', authenticateToken, upload.single('file'), salesMyntraController.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/myntra/master/ledger', authenticateToken, upload.single('file'), salesMyntraController.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/myntra/generate', authenticateToken, upload.fields([
    { name: 'rtoFile', maxCount: 1 },
    { name: 'packedFile', maxCount: 1 },
    { name: 'rtFile', maxCount: 1 },
    { name: 'file', maxCount: 1 }
]), salesMyntraController.generate);

router.post('/brands/:brandId/agents/:agentId/myntra/generate/preview', authenticateToken, upload.fields([
    { name: 'rtoFile', maxCount: 1 },
    { name: 'packedFile', maxCount: 1 },
    { name: 'rtFile', maxCount: 1 },
    { name: 'file', maxCount: 1 }
]), salesMyntraController.generatePreview);

router.post('/brands/:brandId/agents/:agentId/myntra/generate/commit', authenticateToken, salesMyntraController.generateCommit);
router.post('/brands/:brandId/agents/:agentId/myntra/generate/discard', authenticateToken, salesMyntraController.generateDiscard);

// ─── Blinkit Routes ────────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/blinkit/master', authenticateToken, salesBlinkitController.getMasterData);
router.post('/brands/:brandId/agents/:agentId/blinkit/master/sku', authenticateToken, upload.single('file'), salesBlinkitController.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/blinkit/master/ledger', authenticateToken, upload.single('file'), salesBlinkitController.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/blinkit/generate', authenticateToken, upload.single('file'), salesBlinkitController.generate);

router.post('/brands/:brandId/agents/:agentId/blinkit/generate/preview', authenticateToken, upload.single('file'), salesBlinkitController.generatePreview);
router.post('/brands/:brandId/agents/:agentId/blinkit/generate/commit', authenticateToken, salesBlinkitController.generateCommit);
router.post('/brands/:brandId/agents/:agentId/blinkit/generate/discard', authenticateToken, salesBlinkitController.generateDiscard);

const salesFirstcryController = require('../controllers/agents/sales-firstcry/salesFirstcryController');
const salesJiomartController = require('../controllers/agents/sales-jiomart/salesJiomartController');

// ─── FirstCry Routes ───────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/firstcry/master', authenticateToken, salesFirstcryController.getMasterData);
router.post('/brands/:brandId/agents/:agentId/firstcry/master/sku', authenticateToken, upload.single('file'), salesFirstcryController.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/firstcry/master/ledger', authenticateToken, upload.single('file'), salesFirstcryController.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/firstcry/generate', authenticateToken, upload.single('file'), salesFirstcryController.generate);

router.post('/brands/:brandId/agents/:agentId/firstcry/generate/preview', authenticateToken, upload.single('file'), salesFirstcryController.generatePreview);
router.post('/brands/:brandId/agents/:agentId/firstcry/generate/commit', authenticateToken, salesFirstcryController.generateCommit);
router.post('/brands/:brandId/agents/:agentId/firstcry/generate/discard', authenticateToken, salesFirstcryController.generateDiscard);

// ─── JioMart Routes ───────────────────────────────────────────────────────────
router.get('/brands/:brandId/agents/:agentId/jiomart/master', authenticateToken, salesJiomartController.getMasterData);
router.post('/brands/:brandId/agents/:agentId/jiomart/master/sku', authenticateToken, upload.single('file'), salesJiomartController.uploadSkuMaster);
router.post('/brands/:brandId/agents/:agentId/jiomart/master/ledger', authenticateToken, upload.single('file'), salesJiomartController.uploadLedgerMaster);
router.post('/brands/:brandId/agents/:agentId/jiomart/generate', authenticateToken, upload.single('file'), salesJiomartController.generate);

router.post('/brands/:brandId/agents/:agentId/jiomart/generate/preview', authenticateToken, upload.single('file'), salesJiomartController.generatePreview);
router.post('/brands/:brandId/agents/:agentId/jiomart/generate/commit', authenticateToken, salesJiomartController.generateCommit);
router.post('/brands/:brandId/agents/:agentId/jiomart/generate/discard', authenticateToken, salesJiomartController.generateDiscard);

module.exports = router;
