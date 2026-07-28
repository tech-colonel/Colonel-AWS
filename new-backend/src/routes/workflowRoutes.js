const express = require('express');
const router = express.Router();
const wf = require('../controllers/workflowController');
const wfai = require('../controllers/workflowAiController');
const { authenticateToken, authorize } = require('../middleware/authMiddleware');

// Per-agent workflow list (accessible to accountants too)
router.get('/agents/:agentId/workflows', authenticateToken, wf.getWorkflows);

// Master field schema for admin workflow builder (shows available field names)
router.get('/agents/:agentId/master-schema', authenticateToken, authorize('admin'), wf.getMasterSchema);

// Static routes MUST come before parameterised ones (:workflowId) to avoid conflicts

// Global workflow list (every agent) — powers the "Workflows" section on the
// admin + accountant Agents pages.
router.get('/workflows', authenticateToken, wf.getAllWorkflows);

// Extract columns from a sample file (admin, during workflow building)
router.post('/workflows/extract-columns', authenticateToken, authorize('admin'), ...wf.extractColumns);

// AI SOP-to-workflow chat (admin, draft generation)
router.post('/workflows/ai/chat', authenticateToken, authorize('admin'), wfai.aiChat);

// Download generated output file (static segment 'download' before :workflowId)
router.get('/workflows/download/:filename', authenticateToken, wf.downloadWorkflowOutput);

// Single workflow (accessible to accountants too)
router.get('/workflows/:workflowId', authenticateToken, wf.getWorkflow);

// Admin-only: create / update / delete
router.post('/agents/:agentId/workflows', authenticateToken, authorize('admin'), wf.createWorkflow);
router.put('/workflows/:workflowId', authenticateToken, authorize('admin'), wf.updateWorkflow);
router.delete('/workflows/:workflowId', authenticateToken, authorize('admin'), wf.deleteWorkflow);

// Apply a workflow to an uploaded file (accountant)
router.post('/workflows/:workflowId/apply', authenticateToken, ...wf.applyWorkflow);

module.exports = router;
