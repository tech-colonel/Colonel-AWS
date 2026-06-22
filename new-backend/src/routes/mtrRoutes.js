const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const { runMtr, streamMtr, statusMtr, downloadMtr, configMtr, resetMtr } = require('../controllers/mtrController');

/**
 * Auth that also accepts a `?token=` query param — required for the SSE stream,
 * because the browser EventSource API can't send Authorization headers.
 * Mirrors the demo-mode allowance used by recoRoutes.
 */
function flexibleAuth(req, res, next) {
  const headerToken = (req.headers['authorization'] || '').split(' ')[1];
  const token = headerToken || req.query.token;

  if (token === 'demo-mode-token') {
    req.user = { id: 'demo', role: 'accountant', name: 'Demo User' };
    return next();
  }
  if (req.query.token && !headerToken) {
    // Verify the query token directly (SSE path).
    try {
      jwt.verify(req.query.token, process.env.JWT_SECRET);
      req.user = { id: 'sse', role: 'accountant', name: 'SSE' };
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  }
  return authenticateToken(req, res, next);
}

function flexibleAuthorize(req, res, next) {
  if (req.user?.id === 'demo' || req.user?.id === 'sse') return next();
  return authorize('accountant', 'admin')(req, res, next);
}

// Is Drive configured? (no auth — UI uses it to show setup hints)
router.get('/mtr/config', configMtr);

// Start a consolidation run
router.post('/mtr/run', flexibleAuth, flexibleAuthorize, runMtr);

// Live progress (SSE) — token via query param
router.get('/mtr/stream/:jobId', flexibleAuth, flexibleAuthorize, streamMtr);

// Job status (polling fallback)
router.get('/mtr/status/:jobId', flexibleAuth, flexibleAuthorize, statusMtr);

// Download the consolidated workbook
router.get('/mtr/download/:jobId', flexibleAuth, flexibleAuthorize, downloadMtr);

// Reset — delete the workbook from disk + drop the in-memory job
router.delete('/mtr/reset/:jobId', flexibleAuth, flexibleAuthorize, resetMtr);

module.exports = router;
