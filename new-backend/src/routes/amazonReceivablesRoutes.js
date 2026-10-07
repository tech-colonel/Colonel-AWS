const express = require('express');
const multer = require('multer');
const { authenticateToken } = require('../middleware/authMiddleware');
const c = require('../controllers/agents/amazon-receivables/amazonReceivablesController');

const router = express.Router();

/* A month of order lines plus an MTR runs to a few megabytes; the unified
   transaction report for a month is about half a megabyte. 60 MB is generous
   for a three-month upload in one go and still well short of anything that
   would trouble the backend. */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

const base = '/brands/:brandId/agents/:agentId/amazon-receivables';

/* what is in hand, and what has been run */
router.get(`${base}/status`, authenticateToken, c.getStatus);

/* sources: MTR and settlement are uploaded (the MTR report type needs the Tax
   Invoicing role, which is not granted); order reports come from the API */
router.post(`${base}/upload/:kind`, authenticateToken, upload.array('files', 40), c.uploadSources);
router.post(`${base}/fetch-orders`, authenticateToken, c.fetchOrders);

/* the reconciliation itself — run once, then read */
router.post(`${base}/run`, authenticateToken, c.runReco);
router.get(`${base}/run`, authenticateToken, c.getRun);
router.delete(`${base}/run`, authenticateToken, c.deleteRun);

/* the report as a formatted workbook — built on the backend, where the only
   spreadsheet library that keeps its styling lives */
router.get(`${base}/export`, authenticateToken, c.exportWorkbook);
router.post(`${base}/export/drill`, authenticateToken, c.exportDrill);

module.exports = router;
