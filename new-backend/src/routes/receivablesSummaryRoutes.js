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
router.get(`${base}/summary`, authenticateToken, c.getSummary);
router.get(`${base}/ledger`, authenticateToken, c.getLedger);
router.post(`${base}/workbook`, authenticateToken, c.generateWorkbook);
router.get(`${base}/download/:filename`, authenticateToken, c.download);

module.exports = router;
