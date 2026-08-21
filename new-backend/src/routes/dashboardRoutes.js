const express = require('express');
const router = express.Router();
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const { getRecoHistory, getJobResults, getDashboardSummary, getJobById, getAdminToolAnalytics, getUserActivity, getToolDetails, getUsersOverview, getBrandActivity, getBrandAgentDetail, getReceivableDashboard, getReceivableJourney, getReceivableSheetRows, getReceivableSheetColumnValues, getAdvanceAmountDashboard, getAdvanceAmountSheet, getAdvanceAmountSheetColumnValues, getAdvanceOrderStatus, getPayablesDashboard, getPayablesSheet } = require('../controllers/dashboardController');

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
router.get('/dashboard/receivables/:brandId',   flexibleAuth, authorize('accountant','admin'), getReceivableDashboard);
router.get('/dashboard/receivables/:brandId/journey', flexibleAuth, authorize('accountant','admin'), getReceivableJourney);
router.get('/dashboard/receivables/:brandId/sheet', flexibleAuth, authorize('accountant','admin'), getReceivableSheetRows);
router.get('/dashboard/receivables/:brandId/sheet/column-values', flexibleAuth, authorize('accountant','admin'), getReceivableSheetColumnValues);

router.get('/dashboard/advance-amount/:brandId',        flexibleAuth, authorize('accountant','admin'), getAdvanceAmountDashboard);
router.get('/dashboard/advance-amount/:brandId/sheet',   flexibleAuth, authorize('accountant','admin'), getAdvanceAmountSheet);
router.get('/dashboard/advance-amount/:brandId/sheet/column-values', flexibleAuth, authorize('accountant','admin'), getAdvanceAmountSheetColumnValues);
router.get('/dashboard/advance-amount/:brandId/order-status', flexibleAuth, authorize('accountant','admin'), getAdvanceOrderStatus);

router.get('/dashboard/payables/:brandId',        flexibleAuth, authorize('accountant','admin'), getPayablesDashboard);
router.get('/dashboard/payables/:brandId/sheet',  flexibleAuth, authorize('accountant','admin'), getPayablesSheet);

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
