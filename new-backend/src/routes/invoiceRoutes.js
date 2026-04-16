const express = require('express');
const router = express.Router();
const invoiceController = require('../controllers/agents/invoice-process/invoiceController');
const { feedInvoicesFromN8n } = require('../controllers/agents/invoice-process/n8n-invoice-feed-db');
const { authenticateToken } = require('../middleware/authMiddleware');

const { processInvoice, getInvoices, getSheetUrl, updateInvoice } = invoiceController;

router.post('/brands/:brandId/agents/:agentId/invoice/process',          authenticateToken, processInvoice);
router.get('/brands/:brandId/agents/:agentId/invoices',                  authenticateToken, getInvoices);
router.get('/brands/:brandId/agents/:agentId/invoice/sheet-url',         authenticateToken, getSheetUrl);
router.patch('/brands/:brandId/agents/:agentId/invoices/:invoiceId',     authenticateToken, updateInvoice);

// n8n webhook db feed
router.post('/n8n/feed', feedInvoicesFromN8n);

module.exports = router;
