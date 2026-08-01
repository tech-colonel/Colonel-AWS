const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const { ask, suggestions } = require('../ai/assistantController');

// Colonel AI — "Ask Colonel AI" assistant (streaming SSE). Auth required.
router.post('/ai/ask', authenticateToken, ask);
router.get('/ai/suggestions', authenticateToken, suggestions);

module.exports = router;
