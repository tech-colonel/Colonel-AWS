const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const googleLogin = require('../controllers/googleLoginController');
const { authenticateToken, authorize } = require('../middleware/authMiddleware');

router.post('/register', authenticateToken, authorize('admin'), authController.register);
router.post('/login', authController.login);
router.get('/profile', authenticateToken, authController.getProfile);

// Public — "Sign in with Google" on the login page. The existing-users-only
// gate is enforced server-side in finish(); the client can never create a user.
router.post('/google/start', googleLogin.start);
router.post('/google/finish', googleLogin.finish);

module.exports = router;
