const express = require('express');
const multer  = require('multer');
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const {
  getCorrections,
  saveCorrections,
  uploadCorrectionsExcel,
  uploadOutputExcel,
  seedPayeeDirectory,
  getBankAssets,
  deleteBankAsset,
} = require('../controllers/bankCorrectionsController');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// GET  /api/bank-reco/corrections/:brandId
router.get('/corrections/:brandId', authenticateToken, authorize(), getCorrections);

// POST /api/bank-reco/corrections/:brandId  (inline UI edits)
router.post('/corrections/:brandId', authenticateToken, authorize(), saveCorrections);

// POST /api/bank-reco/corrections/:brandId/upload-excel  (reviewed Excel with CHANGES column)
router.post(
  '/corrections/:brandId/upload-excel',
  authenticateToken,
  authorize(),
  upload.single('file'),
  uploadCorrectionsExcel
);

// POST /api/bank-reco/corrections/:brandId/upload-output  (previous output Excel — High rows auto-imported)
router.post(
  '/corrections/:brandId/upload-output',
  authenticateToken,
  authorize(),
  upload.single('file'),
  uploadOutputExcel
);

// GET /api/bank-reco/assets/:brandId — real bank-agent assets (CoA, learned directory,
// stored corrections, side rules) with counts + a sample for the admin Manage view.
// NOTE: roles must be listed explicitly. `authorize()` with no arguments rejects EVERY
// role — it checks `[].includes(req.user.role)`, which is always false.
router.get('/assets/:brandId', authenticateToken, authorize('admin', 'accountant'), getBankAssets);

// DELETE /api/bank-reco/assets/:brandId/:type[?source=…] — clear one asset.
// Admin-only: wiping a brand's CoA invalidates every side rule and learned key that is
// validated against it, so this is not something a brand user should be able to do.
router.delete('/assets/:brandId/:type', authenticateToken, authorize('admin'), deleteBankAsset);

// POST /api/bank-reco/payee-directory/:brandId/seed
// Body: { directory: { phone:{…}, vpa:{…}, neft_name:{…}, name:{…}, exact:{…} } }
// Seeds / updates the brand's payee directory from a pre-built JSON (output of seed_payee_directory.py).
router.post(
  '/payee-directory/:brandId/seed',
  authenticateToken,
  authorize('admin'),
  async (req, res) => {
    const { brandId } = req.params;
    const { directory } = req.body;
    if (!directory || typeof directory !== 'object') {
      return res.status(400).json({ error: 'Body must be { directory: { phone:{}, vpa:{}, … } }' });
    }
    try {
      const { getBrandConnection } = require('../config/database');
      const { Brand } = require('../models/master');
      const brand = await Brand.findByPk(brandId);
      if (!brand) return res.status(404).json({ error: 'Brand not found' });
      const seq = getBrandConnection(brand.db_name);
      const { inserted, updated } = await seedPayeeDirectory(brandId, seq, directory);
      res.json({ inserted, updated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
