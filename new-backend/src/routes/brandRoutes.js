const express = require('express');
const router = express.Router();
const brandController = require('../controllers/brandController');
const { authenticateToken, authorize } = require('../middleware/authMiddleware');

router.get('/brands', authenticateToken, brandController.getAllBrands);
router.get('/brands/my-brands', authenticateToken, brandController.getAllBrands);
router.get('/brands/:id', authenticateToken, brandController.getBrandById);

// Admin only routes
router.post('/brands', authenticateToken, authorize('admin'), brandController.createBrand);
router.post('/brands/assign-user', authenticateToken, authorize('admin'), brandController.assignUserToBrand);
router.get('/brands/:brandId/users', authenticateToken, authorize('admin'), brandController.getBrandUsers);
router.get('/brands/:id/status', authenticateToken, authorize('admin'), brandController.getBrandStatus);

module.exports = router;
