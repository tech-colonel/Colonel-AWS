const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const { streamChat } = require('../controllers/chatController');
const {
  listConversations, getConversation, createConversation,
  updateConversation, deleteConversation,
} = require('../controllers/conversationController');
const { listMcp, addMcp, deleteMcp } = require('../controllers/mcpController');

// Colonel AI chat (streaming SSE)
router.post('/chat', authenticateToken, streamChat);

// Conversation history — strictly per-user-private (scoped in the controller)
router.get('/conversations', authenticateToken, listConversations);
router.post('/conversations', authenticateToken, createConversation);
router.get('/conversations/:id', authenticateToken, getConversation);
router.patch('/conversations/:id', authenticateToken, updateConversation);
router.delete('/conversations/:id', authenticateToken, deleteConversation);

// MCP server registry (visual connect)
router.get('/mcp', authenticateToken, listMcp);
router.post('/mcp', authenticateToken, addMcp);
router.delete('/mcp/:id', authenticateToken, deleteMcp);

module.exports = router;
