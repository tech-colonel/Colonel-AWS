const express = require('express');
const router = express.Router();
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const c = require('../controllers/complianceController');

const auth = authenticateToken;

// Static sub-paths first, then the collection, then :id mutations.
router.get('/brands/:brandId/compliance/categories', auth, c.listCategories);
router.post('/brands/:brandId/compliance/categories', auth, c.createCategory);
router.get('/brands/:brandId/compliance/months', auth, c.listMonths);
router.post('/brands/:brandId/compliance/seed', auth, authorize('admin'), c.seedBrandUser);

router.get('/brands/:brandId/compliance', auth, c.listTasks);
router.post('/brands/:brandId/compliance', auth, c.createTask);

router.patch('/compliance/:id', auth, c.updateTask);
router.delete('/compliance/:id', auth, c.deleteTask);

// Chat-with-admin
router.get('/admin-chat/threads', auth, authorize('admin'), c.listChatThreads);
router.get('/brands/:brandId/admin-chat', auth, c.listChat);
router.post('/brands/:brandId/admin-chat', auth, c.postChat);

module.exports = router;
