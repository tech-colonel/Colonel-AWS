const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticateToken } = require('../middleware/authMiddleware');

const c = require('../controllers/agents/receivables-summary/receivablesSummaryController');

/* The client's own payment reconciliations run to 68 MB — March 2026 is 68.5,
   March's 62.4, December's 63.8 — so a 60 MB cap rejected three of the ten
   months outright with "File too large" and there was no way to load the year
   by upload at all. Raised to 150 MB, which clears the largest file the client
   has produced with room for the year to grow. */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } });

const base = '/brands/:brandId/agents/:agentId/receivables-summary';

router.post(`${base}/upload`, authenticateToken, upload.array('files', 20), c.uploadFiles);
router.get(`${base}/files`, authenticateToken, c.listFiles);
router.delete(`${base}/files/:filename`, authenticateToken, c.deleteFile);
/* clear everything held, so the next run starts from nothing */
router.post(`${base}/reset`, authenticateToken, c.resetAll);
router.get(`${base}/summary`, authenticateToken, c.getSummary);
/* the year on one screen — SERVED from the stored statement, never built here */
router.get(`${base}/overview`, authenticateToken, c.getOverview);
/* the only path that computes: builds the year and every month, and stores them */
router.post(`${base}/build`, authenticateToken, c.buildStatements);
/* the reports produced so far — metadata only, what the agent opens on */
router.get(`${base}/statements`, authenticateToken, c.listStatements);
router.delete(`${base}/statements/:scope/:period`, authenticateToken, c.deleteStatement);
router.delete(`${base}/statements/:scope`, authenticateToken, c.deleteStatement);
router.get(`${base}/ledger`, authenticateToken, c.getLedger);
router.post(`${base}/workbook`, authenticateToken, c.generateWorkbook);
/* every month as its own statement plus one consolidated, zipped */
router.post(`${base}/bundle`, authenticateToken, c.generateBundle);
/* the long-running paths: a job runs in the background and the page polls it */
router.post(`${base}/ingest-drive`, authenticateToken, c.ingestDrive);
router.post(`${base}/bundle-job`, authenticateToken, c.bundleJob);
router.get(`${base}/job/:jobId`, authenticateToken, c.getJob);
router.get(`${base}/download/:filename`, authenticateToken, c.download);

module.exports = router;
