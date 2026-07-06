const express = require('express');
const router = express.Router();
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const c = require('../controllers/zohoController');

// Zoho Books data is available to admins, accountants and the developer.
const allow = [authenticateToken, authorize('admin', 'accountant', 'developer')];

router.post('/zoho/sync',                         ...allow, c.syncNow);
router.get('/zoho/status',                        ...allow, c.getStatus);
router.get('/zoho/organizations',                 ...allow, c.getOrganizations);
router.get('/zoho/organizations/:orgId/contacts', ...allow, c.getContacts);
router.get('/zoho/organizations/:orgId/accounts', ...allow, c.getAccounts);
router.get('/zoho/organizations/:orgId/items',    ...allow, c.getItems);
router.get('/zoho/organizations/:orgId/bank-accounts', ...allow, c.getBankAccounts);
router.get('/zoho/bank-accounts/:accountId/transactions', ...allow, c.getBankTransactions);
router.get('/zoho/vouchers',                      ...allow, c.getVouchers);
router.get('/zoho/vouchers/:id',                  ...allow, c.getVoucher);

module.exports = router;
