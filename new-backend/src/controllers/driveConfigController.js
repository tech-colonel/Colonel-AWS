/* ──────────────────────────────────────────────────────────────────────────────
   driveConfigController.js — per-brand "central Drive folder" config.

   Lets an admin save each brand's Google Drive folder link. The folder lives in
   the firm's team@colonel.co.in Drive and is read via the existing service
   account (services/driveService.js). Stored one row per brand in the
   brand_drive_config table (see db-restructure/022_add_brand_drive_config.sql).

   DB access mirrors the sibling per-brand controllers (e.g.
   bankCorrectionsController): resolve brands.db_name → getBrandConnection(), which
   presets the RLS GUC `app.brand_id` per pooled connection via its afterConnect
   hook, then run raw SQL through Sequelize. Writes are wrapped in the same
   transaction/withBypass helper the siblings use. No Sequelize model is added —
   per-brand tables are accessed with raw queries throughout this codebase.
   ────────────────────────────────────────────────────────────────────────────── */

const { getBrandConnection } = require('../config/database');
const { Brand } = require('../models/master');
const driveService = require('../services/driveService');

// Resolve the brand's (unified-DB) connection — the afterConnect hook on this
// pool sets app.brand_id so RLS scopes every query to this brand.
const getBrandSeq = async (brandId) => {
  const brand = await Brand.findByPk(brandId);
  if (!brand) throw new Error('Brand not found');
  return getBrandConnection(brand.db_name);
};

// Same wrapper the sibling per-brand controllers use for writes.
const withBypass = async (seq, queryFn) => {
  return seq.transaction(async (t) => {
    await seq.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
    return queryFn(t);
  });
};

/* ── GET /api/brands/:brandId/drive-config ──────────────────────────────────────
   Returns { config } for the brand, or { config: null } when none is saved. */
const getDriveConfig = async (req, res) => {
  const { brandId } = req.params;
  try {
    const seq = await getBrandSeq(brandId);
    const [rows] = await seq.query(
      `SELECT brand_id, root_folder_url, root_folder_id, label, updated_by, updated_at
         FROM brand_drive_config
        WHERE brand_id = $1
        LIMIT 1`,
      { bind: [brandId] }
    );
    res.json({ config: rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/* ── PUT /api/brands/:brandId/drive-config ──────────────────────────────────────
   Body: { root_folder_url, label? }
   Parses the folder id, validates the service account can reach it, then upserts
   the row (updated_by = req.user.id, updated_at = now). */
const putDriveConfig = async (req, res) => {
  const { brandId } = req.params;
  const { root_folder_url, label } = req.body || {};

  if (!root_folder_url || !String(root_folder_url).trim()) {
    return res.status(400).json({ error: 'root_folder_url is required' });
  }

  if (!driveService.isConfigured()) {
    return res.status(422).json({
      error: 'Google Drive service account is not configured on this server.',
    });
  }

  const folderId = driveService.parseFolderId(root_folder_url);
  if (!folderId) {
    return res.status(400).json({
      error: 'Could not extract a Drive folder id from that link. Paste the folder URL from Google Drive.',
    });
  }

  // Validate the folder is reachable by the service account.
  try {
    await driveService.getMeta(folderId);
  } catch (_) {
    const svcEmail = driveService.serviceAccountEmail();
    return res.status(422).json({
      error: svcEmail
        ? `That folder isn't reachable. Share it (Viewer) with the service account ${svcEmail}, then try again.`
        : `That folder isn't reachable. Share it (Viewer) with the platform's Drive service account, then try again.`,
      serviceAccountEmail: svcEmail,
    });
  }

  try {
    const seq = await getBrandSeq(brandId);
    const [rows] = await withBypass(seq, async (t) => {
      return seq.query(
        `INSERT INTO brand_drive_config
           (brand_id, root_folder_url, root_folder_id, label, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (brand_id)
         DO UPDATE SET
           root_folder_url = EXCLUDED.root_folder_url,
           root_folder_id  = EXCLUDED.root_folder_id,
           label           = EXCLUDED.label,
           updated_by      = EXCLUDED.updated_by,
           updated_at      = now()
         RETURNING brand_id, root_folder_url, root_folder_id, label, updated_by, updated_at`,
        {
          bind: [
            brandId,
            String(root_folder_url).trim(),
            folderId,
            label != null ? String(label).trim() : null,
            req.user.id,
          ],
          transaction: t,
        }
      );
    });
    res.json({ config: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { getDriveConfig, putDriveConfig };
