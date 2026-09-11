/**
 * returnPrimeRoutes.js — Return Prime webhook receiver.
 *
 * Deliberately NOT behind authenticateToken: the caller is Return Prime's
 * server, which has no Colonel login. The secret lives in the path and is
 * checked in the controller.
 *
 * Mounted under /api so it sits above the SPA catch-all. Without that, an
 * unmatched /api/webhooks/* path returns the React index.html with HTTP 200 —
 * which a webhook sender reads as a successful delivery while the event goes
 * nowhere. A 404 is recoverable; a false 200 loses data silently.
 */

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/returnPrimeWebhookController');

// Return Prime posts JSON. rawBody is captured so an HMAC can be verified over
// the exact bytes if they ever start signing — re-serialising req.body would
// change key order and break the digest.
const rawJson = express.json({
    limit: '2mb',
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
});

router.post('/webhooks/return-prime/:token', rawJson, ctrl.receive);
router.get('/webhooks/return-prime/:token/health', ctrl.health);

module.exports = router;
