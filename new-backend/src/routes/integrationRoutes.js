const express = require('express');
const router = express.Router();
const { authenticateToken, authorize } = require('../middleware/authMiddleware');
const { listIntegrations, connectIntegration, disconnectIntegration, startGoogleOAuth, googleOAuthCallback } = require('../controllers/integrationController');

// Accountants + admins can manage integrations (connect Google/Fireflies/etc.).
const allowManage = [authenticateToken, authorize('admin', 'accountant')];

router.get('/integrations', ...allowManage, listIntegrations);
router.post('/integrations/:type/connect', ...allowManage, connectIntegration);
router.post('/integrations/:type/disconnect', ...allowManage, disconnectIntegration);

// Google OAuth — start returns a JSON consent URL (auth required); callback is
// public (Google redirects the browser here after the user grants permission).
router.get('/integrations/google/oauth/start', ...allowManage, startGoogleOAuth);
router.get('/auth/google/callback', googleOAuthCallback);

module.exports = router;
