const express = require('express');
const router = express.Router();
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const { getDriveConfig, putDriveConfig } = require('../controllers/driveConfigController');

// Per-brand central Drive folder config — admin only.
const adminOnly = [authenticateToken, authorize('admin')];

router.get('/brands/:brandId/drive-config', ...adminOnly, getDriveConfig);
router.put('/brands/:brandId/drive-config', ...adminOnly, putDriveConfig);

module.exports = router;
