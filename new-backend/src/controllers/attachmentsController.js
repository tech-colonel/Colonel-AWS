/**
 * attachmentsController.js — polymorphic file attachments.
 * Serves BOTH the Compliance Tracker (entity_type 'compliance_task') and the
 * existing Tasks (entity_type 'task'). Two sources:
 *   • 'upload' — local PDF/Excel/CSV, written under output/attachments, served
 *                by the existing /api/files static mount.
 *   • 'drive'  — a Google Drive file linked from the brand's Drive folder
 *                (via the existing GET /api/brands/:brandId/drive picker).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { masterSequelize } = require('../config/database');

// NOTE: app.js serves the static mount from new-backend/output (its own ../output).
// This controller lives in src/controllers, so reaching that same dir is ../../output.
const OUTPUT_DIR = path.join(__dirname, '../../output');
const ATTACH_DIR = path.join(OUTPUT_DIR, 'attachments');
const ENTITY_TYPES = ['compliance_task', 'task'];

const rowToClient = (a) => ({
  id: a.id,
  entityType: a.entity_type,
  entityId: a.entity_id,
  source: a.source,
  fileName: a.file_name,
  mimeType: a.mime_type,
  fileSize: a.file_size ? Number(a.file_size) : null,
  url: a.source === 'drive' ? a.drive_url : `/api/files/attachments/${path.basename(a.storage_path || '')}`,
  driveFileId: a.drive_file_id || null,
  createdAt: a.created_at,
});

/* ── GET /api/attachments/:entityType/:entityId ── */
const listAttachments = async (req, res, next) => {
  try {
    const { entityType, entityId } = req.params;
    if (!ENTITY_TYPES.includes(entityType)) return res.status(400).json({ error: 'Bad entity type' });
    const [rows] = await masterSequelize.query(
      `SELECT * FROM compliance_attachments
       WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at ASC`,
      { bind: [entityType, entityId] }
    );
    res.json(rows.map(rowToClient));
  } catch (err) { next(err); }
};

/* ── POST /api/attachments/:entityType/:entityId/upload  (multipart, field: file) ── */
const uploadAttachment = async (req, res, next) => {
  try {
    const { entityType, entityId } = req.params;
    if (!ENTITY_TYPES.includes(entityType)) return res.status(400).json({ error: 'Bad entity type' });
    const file = req.file || (req.files && req.files[0]);
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    fs.mkdirSync(ATTACH_DIR, { recursive: true });
    const safe = (file.originalname || 'file').replace(/[^\w.\-]+/g, '_');
    const stored = `${crypto.randomUUID()}__${safe}`;
    fs.writeFileSync(path.join(ATTACH_DIR, stored), file.buffer);

    const [rows] = await masterSequelize.query(
      `INSERT INTO compliance_attachments
        (entity_type, entity_id, source, file_name, mime_type, file_size, storage_path, uploaded_by)
       VALUES ($1,$2,'upload',$3,$4,$5,$6,$7) RETURNING *`,
      { bind: [entityType, entityId, file.originalname || safe, file.mimetype || null,
               file.size || file.buffer.length, `attachments/${stored}`, req.user.id] }
    );
    res.status(201).json(rowToClient(rows[0]));
  } catch (err) { next(err); }
};

/* ── POST /api/attachments/:entityType/:entityId/drive
      body: { driveFileId, fileName, mimeType, driveUrl } ── */
const linkDriveAttachment = async (req, res, next) => {
  try {
    const { entityType, entityId } = req.params;
    if (!ENTITY_TYPES.includes(entityType)) return res.status(400).json({ error: 'Bad entity type' });
    const { driveFileId, fileName, mimeType, driveUrl } = req.body;
    if (!driveFileId || !fileName) return res.status(400).json({ error: 'driveFileId and fileName are required' });

    const url = driveUrl || `https://drive.google.com/file/d/${driveFileId}/view`;
    const [rows] = await masterSequelize.query(
      `INSERT INTO compliance_attachments
        (entity_type, entity_id, source, file_name, mime_type, drive_file_id, drive_url, uploaded_by)
       VALUES ($1,$2,'drive',$3,$4,$5,$6,$7) RETURNING *`,
      { bind: [entityType, entityId, fileName, mimeType || null, driveFileId, url, req.user.id] }
    );
    res.status(201).json(rowToClient(rows[0]));
  } catch (err) { next(err); }
};

/* ── DELETE /api/attachments/:id ── */
const deleteAttachment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const [rows] = await masterSequelize.query(
      `SELECT * FROM compliance_attachments WHERE id = $1 LIMIT 1`, { bind: [id] }
    );
    const a = rows[0];
    if (!a) return res.status(404).json({ error: 'Attachment not found' });
    if (a.source === 'upload' && a.storage_path) {
      try { fs.unlinkSync(path.join(OUTPUT_DIR, a.storage_path)); } catch (_) {}
    }
    await masterSequelize.query(`DELETE FROM compliance_attachments WHERE id = $1`, { bind: [id] });
    res.json({ message: 'Attachment removed' });
  } catch (err) { next(err); }
};

module.exports = { listAttachments, uploadAttachment, linkDriveAttachment, deleteAttachment };
