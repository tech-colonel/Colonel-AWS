const express = require('express');
const router = express.Router();
const { amazonController } = require('../controllers/cfoAnalyticsController');
const { authenticateToken, authorize } = require('../middleware/authMiddleware');

/**
 * CFO Analytics Routes
 * All routes require authentication, accessible by admin, cfo, and accountant
 */

// ─── Filters & Metadata ────────────────────────────────────────────────────────
router.get(
  '/brands/:brandId/agents/:agentId/cfo-dashboard/filters',
  authenticateToken,
  authorize('admin', 'cfo', 'accountant'),
  amazonController.getFilters
);

// ─── Complete Dashboard Snapshot ─────────────────────────────────────────────
// Get all metrics at once (optimized for initial dashboard load)
router.get(
  '/brands/:brandId/agents/:agentId/cfo-dashboard',
  authenticateToken,
  authorize('admin', 'cfo', 'accountant'),
  amazonController.getDashboardSnapshot
);

// ─── Summary Metrics ────────────────────────────────────────────────────────
router.get(
  '/brands/:brandId/agents/:agentId/cfo-dashboard/summary',
  authenticateToken,
  authorize('admin', 'cfo', 'accountant'),
  amazonController.getSummary
);

// ─── State-wise Analysis ────────────────────────────────────────────────────
router.get(
  '/brands/:brandId/agents/:agentId/cfo-dashboard/state-wise-sales',
  authenticateToken,
  authorize('admin', 'cfo', 'accountant'),
  amazonController.getStateWiseSales
);

// ─── Top Products ────────────────────────────────────────────────────────────
router.get(
  '/brands/:brandId/agents/:agentId/cfo-dashboard/top-products',
  authenticateToken,
  authorize('admin', 'cfo', 'accountant'),
  amazonController.getTopProducts
);

// ─── Tax Analysis ────────────────────────────────────────────────────────────
router.get(
  '/brands/:brandId/agents/:agentId/cfo-dashboard/tax-analysis',
  authenticateToken,
  authorize('admin', 'cfo', 'accountant'),
  amazonController.getTaxAnalysis
);

// ─── Refund Analysis ────────────────────────────────────────────────────────
router.get(
  '/brands/:brandId/agents/:agentId/cfo-dashboard/refund-analysis',
  authenticateToken,
  authorize('admin', 'cfo', 'accountant'),
  amazonController.getRefundAnalysis
);

// ─── Discount Analysis ────────────────────────────────────────────────────────
router.get(
  '/brands/:brandId/agents/:agentId/cfo-dashboard/discount-analysis',
  authenticateToken,
  authorize('admin', 'cfo', 'accountant'),
  amazonController.getDiscountAnalysis
);

// ─── Payment Methods ────────────────────────────────────────────────────────
router.get(
  '/brands/:brandId/agents/:agentId/cfo-dashboard/payment-methods',
  authenticateToken,
  authorize('admin', 'cfo', 'accountant'),
  amazonController.getPaymentMethods
);

// ─── GST Compliance Status ────────────────────────────────────────────────────
router.get(
  '/brands/:brandId/agents/:agentId/cfo-dashboard/gst-compliance',
  authenticateToken,
  authorize('admin', 'cfo', 'accountant'),
  amazonController.getGSTCompliance
);

// ─── Monthly Trend ────────────────────────────────────────────────────────────
router.get(
  '/brands/:brandId/agents/:agentId/cfo-dashboard/monthly-trend',
  authenticateToken,
  authorize('admin', 'cfo', 'accountant'),
  amazonController.getMonthlyTrend
);

// ─── Detailed Transactions (Drill Down) ─────────────────────────────────────
router.get(
  '/brands/:brandId/agents/:agentId/cfo-dashboard/transactions',
  authenticateToken,
  authorize('admin', 'cfo', 'accountant'),
  amazonController.getDetailedTransactions
);

// ─── Revenue MIS Report (Monthly aggregates) ─────────────────────────────────
router.get(
  '/brands/:brandId/agents/:agentId/cfo-dashboard/revenue-mis',
  authenticateToken,
  authorize('admin', 'cfo', 'accountant'),
  amazonController.getRevenueMIS
);

module.exports = router;
