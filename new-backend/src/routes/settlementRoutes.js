const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticateToken } = require('../middleware/authMiddleware');

const settlementAmazonController = require('../controllers/agents/settlement-amazon/settlementAmazonController');

const upload = multer({ storage: multer.memoryStorage() });

// ─── Settlement Amazon Routes ──────────────────────────────────────────────────

// Imported position for the workspace header (counts + totals).
router.get(
    '/brands/:brandId/agents/:agentId/settlement-amazon/summary',
    authenticateToken,
    settlementAmazonController.getSettlementSummary
);

// Pull settlements straight from Amazon (no file). Same agent, same table —
// only for brands with an Amazon connection; everyone else uploads as before.
router.post(
    '/brands/:brandId/agents/:agentId/settlement-amazon/fetch-amazon',
    authenticateToken,
    settlementAmazonController.fetchSettlementFromAmazon
);

// Upload settlement file (parse + store in DB)
router.post(
    '/brands/:brandId/agents/:agentId/settlement-amazon/upload',
    authenticateToken,
    upload.single('file'),
    settlementAmazonController.uploadSettlement
);

// List all uploaded settlement files (grouped by filename)
router.get(
    '/brands/:brandId/agents/:agentId/settlement-amazon/files',
    authenticateToken,
    settlementAmazonController.getSettlementFiles
);

// Download a settlement file
router.get(
    '/brands/:brandId/agents/:agentId/settlement-amazon/files/:fileId/download',
    authenticateToken,
    settlementAmazonController.downloadSettlementFile
);

// Delete a settlement file
router.delete(
    '/brands/:brandId/agents/:agentId/settlement-amazon/files/:fileId',
    authenticateToken,
    settlementAmazonController.deleteSettlementFile
);

// Get settlement data (optionally filter by filename)
router.get(
    '/brands/:brandId/agents/:agentId/settlement-amazon/data',
    authenticateToken,
    settlementAmazonController.getSettlementData
);

// Generate MIS
router.post(
    '/brands/:brandId/agents/:agentId/settlement-amazon/mis',
    authenticateToken,
    settlementAmazonController.generateSettlementMIS
);

module.exports = router;
