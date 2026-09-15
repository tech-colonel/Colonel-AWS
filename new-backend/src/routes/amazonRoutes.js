const express = require('express');
const router = express.Router();
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/amazonController');

/* Same access policy as Shopify and the Composio marketplace. */
const allowManage = [authenticateToken, authorize('admin', 'accountant')];

/* ⚠️ UNAUTHENTICATED by design — Amazon redirects the seller's browser here with
   no session of ours. Trust comes from the single-use state nonce verified in
   services/amazonAuth.consumeNonce(). Must be registered BEFORE the :brandId
   routes so "callback" isn't read as a brand id. */
router.get('/amazon/callback', ctrl.callback);

router.get ('/amazon/status',                        ...allowManage, ctrl.status);
router.get ('/amazon/:brandId/connection',           ...allowManage, ctrl.getConnection);
router.post('/amazon/:brandId/connect',              ...allowManage, ctrl.connect);
router.post('/amazon/:brandId/install',              ...allowManage, ctrl.install);
router.post('/amazon/:brandId/disconnect',           ...allowManage, ctrl.disconnect);
router.get ('/amazon/:brandId/ping',                 ...allowManage, ctrl.ping);
router.get ('/amazon/:brandId/reports/types',        ...allowManage, ctrl.reportTypes);
router.get ('/amazon/:brandId/settlements/preview',  ...allowManage, ctrl.previewSettlements);
router.get ('/amazon/:brandId/orders/preview',       ...allowManage, ctrl.previewOrders);

module.exports = router;
