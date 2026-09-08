const express = require('express');
const router = express.Router();
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/shopifyController');

/* Same access policy as the Composio marketplace: accountants + admins. */
const allowManage = [authenticateToken, authorize('admin', 'accountant')];

/* ⚠️ UNAUTHENTICATED by design — Shopify redirects the merchant's browser here
   with no session of ours. Trust comes from the HMAC signature + single-use
   state nonce verified in services/shopifyOAuth.handleCallback(). Must be
   registered BEFORE the :brandId routes so "callback" isn't read as a brand id. */
router.get('/shopify/callback', ctrl.callback);

router.get ('/shopify/status',                    ...allowManage, ctrl.status);
router.get ('/shopify/:brandId/connection',       ...allowManage, ctrl.getConnection);
router.post('/shopify/:brandId/install',          ...allowManage, ctrl.install);
router.post('/shopify/:brandId/disconnect',       ...allowManage, ctrl.disconnect);
router.get ('/shopify/:brandId/ping',             ...allowManage, ctrl.ping);
router.get ('/shopify/:brandId/coverage',         ...allowManage, ctrl.coverage);
router.get ('/shopify/:brandId/orders/preview',   ...allowManage, ctrl.previewOrderCycle);

module.exports = router;
