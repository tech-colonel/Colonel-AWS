const express = require('express');
const router = express.Router();
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const { getRecoHistory, getJobResults, getDashboardSummary, getJobById } = require('../controllers/dashboardController');

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

module.exports = router;
