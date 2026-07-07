const express = require('express');
const router = express.Router();
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const { status, listToolkits, listConnections, fields, connect, disconnect } = require('../controllers/composioController');

// Same access policy as the curated integrations page: accountants + admins.
const allowManage = [authenticateToken, authorize('admin', 'accountant')];

router.get('/composio/status',       ...allowManage, status);
router.get('/composio/toolkits',     ...allowManage, listToolkits);
router.get('/composio/connections',  ...allowManage, listConnections);
router.get('/composio/:slug/fields', ...allowManage, fields);
router.post('/composio/:slug/connect', ...allowManage, connect);
router.post('/composio/connections/:id/disconnect', ...allowManage, disconnect);

module.exports = router;
