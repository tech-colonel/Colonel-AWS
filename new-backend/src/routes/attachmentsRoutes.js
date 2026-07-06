const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticateToken } = require('../middleware/authMiddleware');
const a = require('../controllers/attachmentsController');

const auth = authenticateToken;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.get('/attachments/:entityType/:entityId', auth, a.listAttachments);
router.post('/attachments/:entityType/:entityId/upload', auth, upload.single('file'), a.uploadAttachment);
router.post('/attachments/:entityType/:entityId/drive', auth, a.linkDriveAttachment);
router.delete('/attachments/:id', auth, a.deleteAttachment);

module.exports = router;
