const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const { runReco, exportReco, openInSheets, checkHealth, getLedgerStatus, deleteRecoJob } = require('../controllers/recoController');

// In-memory storage — files forwarded directly to Python
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
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

// Health check (no auth needed)
router.get('/reco/health', checkHealth);

// Run reconciliation — supports demo mode
router.post(
  '/reco/run',
  flexibleAuth,
  flexibleAuthorize,
  upload.any(),
  runReco
);

// Export Excel result — supports demo mode
router.get(
  '/reco/export/:jobId',
  flexibleAuth,
  flexibleAuthorize,
  exportReco
);

// Open the output as a Google Sheet (service account upload + share link)
router.post(
  '/reco/open-in-sheets/:jobId',
  flexibleAuth,
  flexibleAuthorize,
  openInSheets
);

// Check if ledger master exists in DB for a brand
router.get(
  '/reco/ledger-status/:brandId',
  flexibleAuth,
  flexibleAuthorize,
  getLedgerStatus
);

// Reset — purge a single reco job (+ CASCADE result rows) from the brand DB
router.delete(
  '/reco/job/:brandId/:jobId',
  flexibleAuth,
  flexibleAuthorize,
  deleteRecoJob
);

module.exports = router;
