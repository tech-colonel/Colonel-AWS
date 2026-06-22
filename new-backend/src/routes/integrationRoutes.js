const express = require('express');
const router = express.Router();
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const { listIntegrations, connectIntegration, disconnectIntegration } = require('../controllers/integrationController');

const adminOnly = [authenticateToken, authorize('admin')];

router.get('/integrations', ...adminOnly, listIntegrations);
router.post('/integrations/:type/connect', ...adminOnly, connectIntegration);
router.post('/integrations/:type/disconnect', ...adminOnly, disconnectIntegration);

module.exports = router;
