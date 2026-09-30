const express = require('express');
const router = express.Router();
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const c = require('../controllers/tallyController');

// Tally data is admin-only for now.
const adminOnly = [authenticateToken, authorize('admin')];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validId = (req, res, next) =>
  (UUID_RE.test(req.params.id) ? next() : res.status(400).json({ error: 'Invalid id' }));

// ── Colonel Tally Connector (runs on the client's Tally PC) ──────────────────
// Login is by admin email/password; everything after uses the connector token.
router.post('/tally/connector/login',          c.connectorLogin);
router.post('/tally/connector/heartbeat',      c.connectorAuth, c.heartbeat);
router.post('/tally/connector/sync/start',     c.connectorAuth, c.syncStart);
router.post('/tally/connector/sync/ledgers',   c.connectorAuth, c.syncLedgers);
router.post('/tally/connector/sync/vouchers',  c.connectorAuth, c.syncVouchers);
router.post('/tally/connector/sync/finish',    c.connectorAuth, c.syncFinish);

// ── Admin Tally page ─────────────────────────────────────────────────────────
router.get('/tally/overview',                  ...adminOnly, c.getOverview);
router.get('/tally/companies/:id/ledgers',     ...adminOnly, validId, c.getLedgers);
router.get('/tally/companies/:id/vouchers',    ...adminOnly, validId, c.getVouchers);
router.get('/tally/companies/:id/runs',        ...adminOnly, validId, c.getRuns);
router.delete('/tally/connectors/:id',         ...adminOnly, validId, c.revokeConnector);

module.exports = router;
