const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticateToken } = require('../middleware/authMiddleware');
const gstr3b = require('../controllers/gstr3bController');

const upload = multer({ storage: multer.memoryStorage() });

const fields = upload.fields([
  { name: 'gstr3b', maxCount: 15 },
  { name: 'coa', maxCount: 1 },
  { name: 'vouchertype', maxCount: 1 },
]);

router.post('/brands/:brandId/gstr3b/upload', authenticateToken, fields, gstr3b.upload);
router.get('/brands/:brandId/gstr3b/download/:jobId', authenticateToken, gstr3b.download);
router.get('/brands/:brandId/gstr3b/coa-status', authenticateToken, gstr3b.getCoaStatus);
router.get('/brands/:brandId/gstr3b/history', authenticateToken, gstr3b.getHistory);

module.exports = router;
