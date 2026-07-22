const express = require('express');
const router = express.Router();
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const { listAccounts, connect, disconnect, status } = require('../controllers/googleAccountsController');

// Same access policy as the integrations page: accountants + admins.
// (Central connect/disconnect is further gated to admin inside the controller.)
const allow = [authenticateToken, authorize('admin', 'accountant')];

router.get('/google/accounts',                 ...allow, listAccounts);
router.get('/google/status',                   ...allow, status);
router.post('/google/connect',                 ...allow, connect);
router.post('/google/accounts/:id/disconnect', ...allow, disconnect);

module.exports = router;
