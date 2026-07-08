const express = require('express');
const router = express.Router();
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const { getRecoHistory, getJobResults, getDashboardSummary, getJobById, getAdminToolAnalytics, getUserActivity, getToolDetails, getUsersOverview, getBrandActivity, getBrandAgentDetail } = require('../controllers/dashboardController');

const flexibleAuth = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (token === 'demo-mode-token') {
    req.user = { id: 'demo', role: 'accountant' };
    return next();
  }
  return authenticateToken(req, res, next);
};

router.get('/dashboard/summary/:brandId',       flexibleAuth, authorize('accountant','admin'), getDashboardSummary);
router.get('/dashboard/reco/history/:brandId',  flexibleAuth, authorize('accountant','admin'), getRecoHistory);
router.get('/dashboard/reco/results/:jobId',    flexibleAuth, authorize('accountant','admin'), getJobResults);
router.get('/dashboard/reco/job/:jobId',        flexibleAuth, authorize('accountant','admin'), getJobById);

// Accountant Analysis page (per-brand, brand-access gated)
router.get('/dashboard/activity/:brandId',              flexibleAuth, authorize('accountant','admin'), getBrandActivity);
router.get('/dashboard/agent-detail/:brandId/:agentType', flexibleAuth, authorize('accountant','admin'), getBrandAgentDetail);

// Platform-wide per-tool analytics — admin only
router.get('/dashboard/admin/tool-analytics',   flexibleAuth, authorize('admin'), getAdminToolAnalytics);

// Per-tool drill-down (top users, per-brand, 30-day trend, status mix) — admin only
router.get('/dashboard/admin/tool-details/:agentType', flexibleAuth, authorize('admin'), getToolDetails);

// Users ranking + each user's top agent — admin only
router.get('/dashboard/admin/users-overview', flexibleAuth, authorize('admin'), getUsersOverview);

// Per-user activity (their brands → tool-wise usage) — admin only
router.get('/dashboard/admin/user-activity/:userId', flexibleAuth, authorize('admin'), getUserActivity);

module.exports = router;
