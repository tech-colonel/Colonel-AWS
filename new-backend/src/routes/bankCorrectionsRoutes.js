const express = require('express');
const multer  = require('multer');
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const {
  getCorrections,
  saveCorrections,
  uploadCorrectionsExcel,
} = require('../controllers/bankCorrectionsController');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// GET  /api/bank-reco/corrections/:brandId
router.get('/corrections/:brandId', authenticateToken, authorize(), getCorrections);

// POST /api/bank-reco/corrections/:brandId  (inline UI edits)
router.post('/corrections/:brandId', authenticateToken, authorize(), saveCorrections);

// POST /api/bank-reco/corrections/:brandId/upload-excel  (reviewed Excel file)
router.post(
  '/corrections/:brandId/upload-excel',
  authenticateToken,
  authorize(),
  upload.single('file'),
  uploadCorrectionsExcel
);

module.exports = router;
