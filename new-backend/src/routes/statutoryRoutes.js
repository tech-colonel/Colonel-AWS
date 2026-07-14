const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const c = require('../controllers/statutoryController');

const auth = authenticateToken;

// Admin cross-brand summary (static path before params).
router.get('/statutory/admin/summary', auth, c.adminSummary);

// Brand-scoped working surface.
router.get('/brands/:brandId/statutory/config', auth, c.getConfig);
router.get('/brands/:brandId/statutory/categories', auth, c.listCategories);
router.post('/brands/:brandId/statutory/seed', auth, c.seedBrand);
router.get('/brands/:brandId/statutory', auth, c.listFilings);
router.post('/brands/:brandId/statutory', auth, c.createFiling);

router.patch('/statutory/:id', auth, c.updateFiling);
router.delete('/statutory/:id', auth, c.deleteFiling);

module.exports = router;
