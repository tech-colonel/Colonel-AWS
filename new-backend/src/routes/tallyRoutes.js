const express = require('express');
const router = express.Router();
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const c = require('../controllers/tallyController');
const r = require('../controllers/tallyReportsController');

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
router.post('/tally/connector/sync/masters',   c.connectorAuth, c.syncMasters);
router.post('/tally/connector/sync/bills',     c.connectorAuth, c.syncBills);
router.post('/tally/connector/sync/vouchers',  c.connectorAuth, c.syncVouchers);
router.post('/tally/connector/sync/finish',    c.connectorAuth, c.syncFinish);

// ── Admin Tally page ─────────────────────────────────────────────────────────
router.get('/tally/overview',                  ...adminOnly, c.getOverview);
router.get('/tally/companies/:id/ledgers',     ...adminOnly, validId, c.getLedgers);
router.get('/tally/companies/:id/vouchers',    ...adminOnly, validId, c.getVouchers);
router.get('/tally/companies/:id/runs',        ...adminOnly, validId, c.getRuns);
router.delete('/tally/connectors/:id',         ...adminOnly, validId, c.revokeConnector);

// "Tally Connector" agent (brand side): only the companies linked to the brand.
const brandUser = [authenticateToken, authorize('admin', 'accountant')];
const validBrand = (req, res, next) =>
  (UUID_RE.test(req.params.brandId) ? next() : res.status(400).json({ error: 'Invalid brand id' }));
const ofBrand = [...brandUser, validBrand, validId, c.brandCompany];

router.get('/brands/:brandId/tally/overview',                 ...brandUser, validBrand, c.getBrandOverview);
router.get('/brands/:brandId/tally/companies/:id/ledgers',    ...ofBrand, c.getLedgers);
router.get('/brands/:brandId/tally/companies/:id/vouchers',   ...ofBrand, c.getVouchers);
router.get('/brands/:brandId/tally/companies/:id/runs',       ...ofBrand, c.getRuns);
// Tally Dashboard reports — the same handlers behind both doors: every company for
// an admin, and a brand's own companies (checked by c.brandCompany) on the brand side.
const REPORTS = [
  ['overview', r.getOverview], ['books', r.getBooks], ['ledger-statement', r.getLedgerStatement],
  ['vouchers/:vid', r.getVoucher], ['outstanding', r.getOutstanding], ['inventory', r.getInventory],
  ['gst', r.getGst], ['masters', r.getMasters],
];
for (const [path, handler] of REPORTS) {
  router.get(`/tally/companies/:id/${path}`, ...adminOnly, validId, handler);
  router.get(`/brands/:brandId/tally/companies/:id/${path}`, ...ofBrand, handler);
}

router.post('/tally/auto-link', ...adminOnly, c.autoLinkAll);
router.put('/brands/:brandId/tally/companies/:id/link',       ...adminOnly, validBrand, validId, c.linkCompany);
router.delete('/brands/:brandId/tally/companies/:id/link',    ...adminOnly, validBrand, validId, c.unlinkCompany);

module.exports = router;
