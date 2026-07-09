const express = require('express');
const router = express.Router();
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const { getSchema } = require('../controllers/databaseController');

// Admin-only DB Explorer
router.get('/database/schema', authenticateToken, authorize('admin'), getSchema);

module.exports = router;
