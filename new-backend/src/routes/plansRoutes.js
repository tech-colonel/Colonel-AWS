const express = require('express');
const router = express.Router();
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const { getPlans, getPlan, createPlan, updatePlan, deletePlan, createPlanFromTask } = require('../controllers/plansController');

const auth = authenticateToken;
const adminOnly = [authenticateToken, authorize('admin')];
// Developers (engineers) can author/edit plans too — e.g. from a feedback task.
const builders = [authenticateToken, authorize('admin', 'developer')];

router.get('/plans', auth, getPlans);            // admin: all · others: shared with them
router.get('/plans/:id', auth, getPlan);
router.post('/plans/from-task/:taskId', ...builders, createPlanFromTask);
router.post('/plans', ...builders, createPlan);
router.put('/plans/:id', ...builders, updatePlan);
router.delete('/plans/:id', ...adminOnly, deletePlan);

module.exports = router;
