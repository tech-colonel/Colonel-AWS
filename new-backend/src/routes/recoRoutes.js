const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const { UserAgent, Agent } = require('../models/master');
const { runReco, exportReco, openInSheets, checkHealth, getLedgerStatus, deleteRecoJob, detectZeptoFiles, purgeSessionMaster } = require('../controllers/recoController');
const { routeDriveFiles } = require('../controllers/driveRouteController');
const { listDriveFiles, getDriveFileContent } = require('../controllers/driveFetchController');

// In-memory storage — files forwarded directly to Python
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 } // 150MB — raised from 50MB: real Tally/marketplace exports (e.g. Receivable Cycle's Combine Tally GST / Sales Order Combine) can exceed 50MB
});

// Allow demo-mode token through without DB lookup
const flexibleAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token === 'demo-mode-token') {
    req.user = { id: 'demo', role: 'accountant', name: 'Demo User' };
    return next();
  }
  return authenticateToken(req, res, next);
};

const flexibleAuthorize = (req, res, next) => {
  if (req.user?.id === 'demo') return next();
  return authorize('accountant', 'admin')(req, res, next);
};

// Same as flexibleAuthorize but ALSO lets a restricted 'brand_executive' through.
// Used only on the endpoints a brand_executive legitimately needs (run/scan/export/
// ledger/history) — NOT on mutations like delete-job. The run endpoint pairs this
// with enforceExecAllowlist below so they can still only run their allowlisted agent.
const flexibleAuthorizeExec = (req, res, next) => {
  if (req.user?.id === 'demo') return next();
  return authorize('accountant', 'admin', 'brand_executive')(req, res, next);
};

// For a 'brand_executive', the requested reco_type MUST be one of their allowlisted
// agents (user_agents). This is what keeps "only Zepto" true on the EXECUTION path:
// even a hand-crafted /reco/run body with another reco_type is rejected. Other roles
// pass straight through. Runs AFTER multer so req.body.reco_type is populated.
const enforceExecAllowlist = async (req, res, next) => {
  try {
    if (req.user?.role !== 'brand_executive') return next();
    const recoType = req.body?.reco_type;
    if (!recoType) return res.status(403).json({ error: 'Access denied: no agent specified.' });
    const rows = await UserAgent.findAll({ where: { user_id: req.user.id }, attributes: ['agent_id'] });
    const ids = rows.map((r) => r.agent_id);
    if (ids.length === 0) return res.status(403).json({ error: 'Access denied: no agents assigned to this user.' });
    const allowed = await Agent.findAll({ where: { id: ids }, attributes: ['name'] });
    const names = new Set(allowed.map((a) => a.name));
    if (!names.has(recoType)) {
      return res.status(403).json({ error: `Access denied: you are not permitted to run "${recoType}".` });
    }
    return next();
  } catch (e) { return next(e); }
};

// Health check (no auth needed)
router.get('/reco/health', checkHealth);

// Ephemeral master-data reset for the "Other" catch-all brand (no-op for real brands)
router.post('/brands/:brandId/purge-session-master', authenticateToken, purgeSessionMaster);

// Run reconciliation — supports demo mode. brand_executive allowed, but
// enforceExecAllowlist (after multer) restricts them to their allowlisted agent.
router.post(
  '/reco/run',
  flexibleAuth,
  flexibleAuthorizeExec,
  upload.any(),
  enforceExecAllowlist,
  runReco
);

// Export Excel result — supports demo mode
router.get(
  '/reco/export/:jobId',
  flexibleAuth,
  flexibleAuthorizeExec,
  exportReco
);

// Open the output as a Google Sheet (service account upload + share link)
router.post(
  '/reco/open-in-sheets/:jobId',
  flexibleAuth,
  flexibleAuthorizeExec,
  openInSheets
);

// Check if ledger master exists in DB for a brand
router.get(
  '/reco/ledger-status/:brandId',
  flexibleAuth,
  flexibleAuthorizeExec,
  getLedgerStatus
);

// Reset — purge a single reco job (+ CASCADE result rows) from the brand DB
router.delete(
  '/reco/job/:brandId/:jobId',
  flexibleAuth,
  flexibleAuthorize,
  deleteRecoJob
);

// Preview — scan a Zepto Drive folder and return classified file counts (no download)
router.post('/reco/detect-files', flexibleAuth, flexibleAuthorizeExec, detectZeptoFiles);

// Generic preview — recognize which Drive file maps to which agent slot (no download, no run)
router.post('/drive/route', flexibleAuth, flexibleAuthorize, routeDriveFiles);

// Drive input for CLIENT-SIDE agents (e.g. Marketplace Ticket Generator): plain file
// listing + the bytes, because those agents parse in the browser and detect the
// report type from its headers rather than its filename.
router.post('/drive/list', flexibleAuth, flexibleAuthorize, listDriveFiles);
router.get('/drive/file/:fileId/content', flexibleAuth, flexibleAuthorize, getDriveFileContent);

module.exports = router;
