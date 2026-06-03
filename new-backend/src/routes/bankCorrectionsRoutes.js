const express = require('express');
const multer  = require('multer');
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const {
  getCorrections,
  saveCorrections,
  uploadCorrectionsExcel,
  uploadOutputExcel,
} = require('../controllers/bankCorrectionsController');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// GET  /api/bank-reco/corrections/:brandId
router.get('/corrections/:brandId', authenticateToken, authorize('admin', 'accountant'), getCorrections);

// POST /api/bank-reco/corrections/:brandId  (inline UI edits)
router.post('/corrections/:brandId', authenticateToken, authorize('admin', 'accountant'), saveCorrections);

// POST /api/bank-reco/corrections/:brandId/upload-excel  (reviewed Excel with CHANGES column)
router.post(
  '/corrections/:brandId/upload-excel',
  authenticateToken,
  authorize('admin', 'accountant'),
  upload.single('file'),
  uploadCorrectionsExcel
);

// POST /api/bank-reco/corrections/:brandId/upload-output  (previous output Excel — High rows auto-imported)
router.post(
  '/corrections/:brandId/upload-output',
  authenticateToken,
  authorize('admin', 'accountant'),
  upload.single('file'),
  uploadOutputExcel
);

module.exports = router;
