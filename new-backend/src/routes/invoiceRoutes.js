const express = require('express');
const router = express.Router();
const invoiceController = require('../controllers/invoiceController');
const { authenticateToken } = require('../middleware/authMiddleware');

const { processInvoice, getInvoices, getSheetUrl, updateInvoice } = invoiceController;

router.post('/brands/:brandId/agents/:agentId/invoice/process',          authenticateToken, processInvoice);
router.get('/brands/:brandId/agents/:agentId/invoices',                  authenticateToken, getInvoices);
router.get('/brands/:brandId/agents/:agentId/invoice/sheet-url',         authenticateToken, getSheetUrl);
router.patch('/brands/:brandId/agents/:agentId/invoices/:invoiceId',     authenticateToken, updateInvoice);

module.exports = router;
