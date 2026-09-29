const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticateToken } = require('../middleware/authMiddleware');

const c = require('../controllers/agents/receivables-summary/receivablesSummaryController');

/* These workbooks run to 18 MB, well past multer's default. */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

const base = '/brands/:brandId/agents/:agentId/receivables-summary';

router.post(`${base}/upload`, authenticateToken, upload.array('files', 20), c.uploadFiles);
router.get(`${base}/files`, authenticateToken, c.listFiles);
router.delete(`${base}/files/:filename`, authenticateToken, c.deleteFile);
/* clear everything held, so the next run starts from nothing */
router.post(`${base}/reset`, authenticateToken, c.resetAll);
router.get(`${base}/summary`, authenticateToken, c.getSummary);
/* the year on one screen — a row per month and every finding, cached */
router.get(`${base}/overview`, authenticateToken, c.getOverview);
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
