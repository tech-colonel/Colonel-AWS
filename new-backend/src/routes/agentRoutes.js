const express = require('express');
const router = express.Router();
const agentController = require('../controllers/agentController');
const { authenticateToken, authorize } = require('../middleware/authMiddleware');

// Public/Authenticated routes
router.get('/agents', authenticateToken, agentController.getAllAgents);
router.get('/brands/:brandId/agents', authenticateToken, agentController.getBrandAgents);
router.post('/agents/proxy-webhook', authenticateToken, agentController.proxyWebhook);
router.post('/agents/request', authenticateToken, agentController.requestAgent);

// Admin only routes
router.post('/agents', authenticateToken, authorize('admin'), agentController.createAgent);
router.post('/agents/assign', authenticateToken, authorize('admin'), agentController.assignAgentToBrand);
router.get('/agents/:agentId/brands', authenticateToken, authorize('admin'), agentController.getAgentBrands);
router.delete('/agents/:agentId', authenticateToken, authorize('admin'), agentController.deleteAgent);
router.delete('/brands/:brandId/agents/:agentId/data', authenticateToken, authorize('admin'), agentController.clearBrandAgentData);

module.exports = router;
