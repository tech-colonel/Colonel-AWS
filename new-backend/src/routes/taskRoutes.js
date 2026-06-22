const express = require('express');
const router = express.Router();
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const {
  getTasks, getTask, createTask, updateTask,
  deleteTask, addMessage, getTaskStats, createFeedback,
} = require('../controllers/taskController');

const auth = authenticateToken;
const adminOnly = [authenticateToken, authorize('admin')];

// Any logged-in user can raise feedback on a reco result → becomes a feedback task.
router.post('/feedback', auth, createFeedback);

router.get('/tasks/stats', ...adminOnly, getTaskStats);
router.get('/tasks', auth, getTasks);
router.get('/tasks/:id', auth, getTask);
router.post('/tasks', ...adminOnly, createTask);
router.put('/tasks/:id', auth, updateTask);
router.delete('/tasks/:id', ...adminOnly, deleteTask);
router.post('/tasks/:id/messages', auth, addMessage);

module.exports = router;
