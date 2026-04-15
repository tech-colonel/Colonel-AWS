const express = require('express');
const router = express.Router();
const agentController = require('../controllers/agentController');
const { authenticateToken, authorize } = require('../middleware/authMiddleware');

// Public/Authenticated routes
router.get('/agents', authenticateToken, agentController.getAllAgents);
router.get('/brands/:brandId/agents', authenticateToken, agentController.getBrandAgents);
router.post('/agents/proxy-webhook', authenticateToken, agentController.proxyWebhook);

// Admin only routes
router.post('/agents', authenticateToken, authorize('admin'), agentController.createAgent);
router.post('/agents/assign', authenticateToken, authorize('admin'), agentController.assignAgentToBrand);

module.exports = router;
