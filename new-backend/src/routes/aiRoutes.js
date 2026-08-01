const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const { ask, suggestions, reportSheet } = require('../ai/assistantController');

// Colonel AI — "Ask Colonel AI" assistant (streaming SSE). Auth required.
router.post('/ai/ask', authenticateToken, ask);
router.get('/ai/suggestions', authenticateToken, suggestions);
// Export a usage report to a Google Sheet (re-runs role-scoped server-side).
router.post('/ai/report/sheet', authenticateToken, reportSheet);

module.exports = router;
