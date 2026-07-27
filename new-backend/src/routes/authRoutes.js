const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticateToken, authorize } = require('../middleware/authMiddleware');

router.post('/register', authenticateToken, authorize('admin'), authController.register);
router.post('/login', authController.login);
router.get('/profile', authenticateToken, authController.getProfile);

module.exports = router;
