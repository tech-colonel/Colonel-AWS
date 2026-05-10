/**
 * Order Cycle Shopify Routes
 *
 * Registers multer fields 0-9 for each partner/gateway type
 * so any count up to 10 is handled without knowing the count at route definition time.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticateToken } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/agents/order-cycle-shopify/orderCycleShopifyController');

// Build the multer fields array:
//  - unicommerceFile (1)
//  - salesOrderReportFile (1)
//  - paymentGateway_0 … paymentGateway_9  (up to 10 gateways)
//  - logistics_0 … logistics_9            (up to 10 logistics partners)
const PARTNER_SLOTS = 10;
const uploadFields = [
    { name: 'unicommerceFile', maxCount: 1 },
    { name: 'salesOrderReportFile', maxCount: 1 },
    ...Array.from({ length: PARTNER_SLOTS }, (_, i) => ({ name: `paymentGateway_${i}`, maxCount: 1 })),
    ...Array.from({ length: PARTNER_SLOTS }, (_, i) => ({ name: `logistics_${i}`, maxCount: 1 })),
];

const upload = multer({ storage: multer.memoryStorage() });
const uploadMulti = upload.fields(uploadFields);

const BASE = '/brands/:brandId/agents/:agentId/order-cycle-shopify';

// ─── Two-phase generation ─────────────────────────────────────────────────────
router.post(`${BASE}/generate/preview`, authenticateToken, uploadMulti, ctrl.generatePreview);
router.post(`${BASE}/generate/commit`,  authenticateToken, ctrl.generateCommit);
router.post(`${BASE}/generate/discard`, authenticateToken, ctrl.generateDiscard);

// ─── File management ──────────────────────────────────────────────────────────
router.get(`${BASE}/files`,                 authenticateToken, ctrl.getGeneratedFiles);
router.get(`${BASE}/files/:filename/download`, authenticateToken, ctrl.downloadFile);
router.delete(`${BASE}/files`,              authenticateToken, ctrl.deleteFile);

module.exports = router;
