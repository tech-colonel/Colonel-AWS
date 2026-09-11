// PO Extractor controller — the n8n-driven Purchase-Order scanner.
//
// Same shape as Invoice Process (invoice-process/invoiceController.js): this
// controller only TRIGGERS the per-brand n8n workflow and serves history; the
// actual scan + Google-Sheet write happens in n8n, which pushes rows back to
// POST /api/n8n/po/feed  (see n8n-po-feed-db.js) and live progress to the shared
// POST /api/n8n/progress. History lives in the RLS-scoped `po_extractor` table.

const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { markProcessing, resetRun, getState } = require('../../../utils/invoiceEvents');
const drive = require('../../../services/driveService');

let setExecution, getExecution, clearExecution;
try { ({ setExecution, getExecution, clearExecution } = require('../../../utils/executionStore')); } catch (_) { /* optional */ }
let n8nApi; try { n8nApi = require('../../../utils/n8nApi'); } catch (_) { /* optional */ }

// Per-brand n8n webhook + Sheet URL — same env convention as Invoice Process
// (<Brand>_invoice_url / <Brand>_invoice_sheet), space/apostrophe/dot variants.
const envFor = (brandName, suffix) =>
  process.env[`${brandName.toLowerCase()}${suffix}`] ||
  process.env[`${brandName.toUpperCase()}${suffix}`] ||
  process.env[`${brandName}${suffix}`] ||
  process.env[`${brandName.replace(/\s+/g, '_')}${suffix}`] ||
  process.env[`${brandName.replace(/[^A-Za-z0-9]/g, '')}${suffix}`] ||
  null;

// Resolve a brand-scoped (RLS: app.brand_id preset) connection for a brandId.
async function brandConn(brandId) {
  try {
    const [rows] = await Brand.sequelize.query('SELECT db_name FROM brands WHERE id = :bid', { replacements: { bid: brandId } });
    const dbName = rows && rows[0] && rows[0].db_name;
    return dbName ? getBrandConnection(dbName) : null;
  } catch (_) { return null; }
}

// DB column (settable from the UI) wins; falls back to the env var set up at
// deploy time, so nothing already configured stops working.
const folderIdFor = (brand) => brand.po_input_folder_id || envFor(brand.name, '_po_folder_id');
const sheetUrlFor = (brand) => brand.po_sheet_url || envFor(brand.name, '_po_sheet');

const SHEET_ID_RE = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/;
const parseSpreadsheetId = (urlOrId) => {
  if (!urlOrId) return null;
  const m = String(urlOrId).match(SHEET_ID_RE);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(String(urlOrId).trim()) ? urlOrId.trim() : null;
};

// PO_Data sheet's 8 columns, in order — same order everywhere they're touched
// (the n8n workflow's Append node, and here for edits).
const PO_SHEET_COLUMNS = [
  'po_number', 'po_date', 'supplier_gstin', 'buyer_gstin',
  'billing_address', 'product_description', 'unit_cost', 'gst_rate',
];

// ─── POST /api/brands/:brandId/agents/:agentId/po/process ────────────────────
async function processPO(req, res, next) {
  try {
    const { brandId, agentId } = req.params;
    const brand = await Brand.findByPk(brandId);
    const agent = await Agent.findByPk(agentId);
    if (!brand || !agent) return res.status(404).json({ error: 'Brand or Agent not found' });

    const webhookUrl = envFor(brand.name, '_po_url');
    if (!webhookUrl) {
      return res.status(400).json({
        error: `n8n webhook not configured for "${brand.name}". Add ${brand.name.toLowerCase()}_po_url to new-backend/.env`,
      });
    }

    // Concurrency guard — don't re-fire while a run is in flight (stale after 3 min).
    const state = getState(brandId, agentId);
    if (state && state.status === 'processing') {
      const age = Date.now() - new Date(state.timestamp || 0).getTime();
      if (age < 3 * 60 * 1000) {
        return res.status(409).json({ error: 'A run is already in progress. Please wait for it to finish.', busy: true });
      }
    }

    markProcessing(brandId, agentId);

    try {
      const r = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brandId: brand.id, brandName: brand.name,
          agentId: agent.id, agentName: agent.name,
          timestamp: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      // Best-effort: capture the n8n execution id for run-history / self-heal.
      let executionId = null;
      try {
        const base = process.env.N8N_API_BASE || 'https://colonel1234.app.n8n.cloud/api/v1';
        const ex = await fetch(`${base}/executions?status=running&limit=1`, { headers: { 'X-N8N-API-KEY': process.env.n8n_api_key } });
        const j = await ex.json();
        executionId = j?.data?.[0]?.id || null;
        if (executionId && setExecution) setExecution(brandId, agentId, executionId);
        if (executionId) { try { require('../../../utils/n8nWatcher').watch(brandId, agentId, executionId); } catch (_) {} }
        if (n8nApi && j?.data?.[0]?.workflowId) { try { n8nApi.remember(brandId, agentId, j.data[0].workflowId); } catch (_) {} }
      } catch (_) { /* n8n API optional */ }

      return res.json({ success: true, pending: true, executionId, message: 'Scan started. Rows will appear once n8n finishes.' });
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        return res.json({ success: true, pending: true, message: 'Scan started. Rows will appear once n8n finishes.' });
      }
      console.error('[PO] n8n webhook error:', e.message);
      return res.status(502).json({ error: 'Could not start the scan right now. Please try again.' });
    }
  } catch (error) {
    next(error);
  }
}

// ─── POST /api/brands/:brandId/agents/:agentId/po/cancel ─────────────────────
async function cancelPO(req, res) {
  const { brandId, agentId } = req.params;
  resetRun(brandId, agentId);
  if (clearExecution) { try { clearExecution(brandId, agentId); } catch (_) {} }
  return res.json({ cancelled: true });
}

// ─── GET /api/brands/:brandId/agents/:agentId/po/sheet-url ───────────────────
// Same shape as Invoice Process's getSheetUrl: hands back the Sheet + the Drive
// input folder id, so the UI can embed both (Open Sheet, Google Drive Folder).
async function getPOSheetUrl(req, res) {
  const { brandId } = req.params;
  const brand = await Brand.findByPk(brandId);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });
  return res.json({
    sheetUrl: sheetUrlFor(brand),
    folderId: folderIdFor(brand),
  });
}

// ─── PATCH /api/brands/:brandId/po/settings ───────────────────────────────────
// Lets the UI itself set/change the Drive input folder + output Sheet for this
// brand's PO Extractor (stored on brands.po_input_folder_id / po_sheet_url —
// same pattern as Invoice Process's brand.invoice_input_folder_id).
// NOTE: this only changes what the APP reads/writes to (upload target, sheet
// embed). The n8n workflow itself still scans/writes whatever folder+sheet its
// own nodes are configured with — repoint those too if you change these.
async function updatePOSettings(req, res, next) {
  try {
    const { brandId } = req.params;
    const brand = await Brand.findByPk(brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const updates = {};
    if (req.body.driveFolderUrl !== undefined) {
      const raw = String(req.body.driveFolderUrl || '').trim();
      if (!raw) updates.po_input_folder_id = null;
      else {
        const id = drive.parseFolderId(raw);
        if (!id) return res.status(400).json({ error: 'That does not look like a Google Drive folder link or id.' });
        updates.po_input_folder_id = id;
      }
    }
    if (req.body.sheetUrl !== undefined) {
      const raw = String(req.body.sheetUrl || '').trim();
      if (!raw) updates.po_sheet_url = null;
      else if (!parseSpreadsheetId(raw)) return res.status(400).json({ error: 'That does not look like a Google Sheets link or id.' });
      else updates.po_sheet_url = raw;
    }

    await brand.update(updates);
    return res.json({ success: true, sheetUrl: sheetUrlFor(brand), folderId: folderIdFor(brand) });
  } catch (error) {
    next(error);
  }
}

// ─── POST /api/brands/:brandId/agents/:agentId/po/upload ─────────────────────
// Manual-upload box: push chosen PDFs straight into the brand's PO Drive input
// folder (service account — same path as Invoice Process's uploadInvoiceFiles),
// so n8n's next Process run picks them up. No n8n call here; the UI triggers
// /po/process itself a moment later, matching the Invoice Process UX.
async function uploadPOFiles(req, res, next) {
  try {
    const { brandId } = req.params;
    const brand = await Brand.findByPk(brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const folderId = folderIdFor(brand);
    if (!folderId) {
      return res.status(400).json({ error: `No Drive input folder configured for "${brand.name}" yet. Set it from the PO Extractor's Settings panel, or add ${brand.name.toLowerCase()}_po_folder_id to new-backend/.env` });
    }

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files were uploaded.' });

    const uploaded = [];
    for (const f of files) {
      try {
        const r = await drive.uploadFile(f.buffer, f.originalname, f.mimetype, folderId);
        uploaded.push({ id: r.id, name: r.name, link: r.webViewLink });
      } catch (e) {
        console.error('[PO upload] failed for', f.originalname, '-', e.message);
        const sa = drive.serviceAccountEmail ? drive.serviceAccountEmail() : 'the service account';
        return res.status(502).json({ error: `Could not upload "${f.originalname}". Ensure the PO Drive folder is shared with ${sa}.`, uploaded });
      }
    }
    return res.json({ success: true, count: uploaded.length, uploaded });
  } catch (error) {
    next(error);
  }
}

// ─── GET /api/brands/:brandId/agents/:agentId/po-rows ────────────────────────
// RLS auto-scopes to this brand. One row per PO line item.
async function listPORows(req, res) {
  const { brandId, agentId } = req.params;
  const conn = await brandConn(brandId);
  if (!conn) return res.json([]);
  try {
    const [rows] = await conn.query(
      `SELECT id, run_id, source_file, po_pdf_link, po_number, po_date,
              supplier_gstin, buyer_gstin, billing_address, product_description,
              unit_cost, gst_rate, status, created_at
       FROM po_extractor
       WHERE agent_id = :aid OR agent_id IS NULL
       ORDER BY created_at DESC, po_number, id
       LIMIT 5000`,
      { replacements: { aid: agentId } });
    return res.json(rows);
  } catch (e) {
    return res.json([]);
  }
}

// ─── PATCH /api/brands/:brandId/agents/:agentId/po-rows/:rowId ───────────────
// Fix a wrongly/un-extracted field from the UI. Updates the DB row (source of
// truth for the app) and then best-effort mirrors the same row in the Google
// Sheet, matched by its ORIGINAL po_number+product_description+unit_cost (the
// same composite key the n8n feed dedupes on) — so the Sheet a human reads
// stays in sync with a correction made in the app. Sheet sync failing (e.g.
// not shared with the service account) never blocks the DB save.
const PO_ROW_ALLOWED = [
  'po_number', 'po_date', 'supplier_gstin', 'buyer_gstin',
  'billing_address', 'product_description', 'unit_cost', 'gst_rate', 'status',
];
async function updatePORow(req, res, next) {
  const { brandId, rowId } = req.params;
  const conn = await brandConn(brandId);
  if (!conn) return res.status(404).json({ error: 'not found' });
  try {
    const [existingRows] = await conn.query('SELECT * FROM po_extractor WHERE id = :id', { replacements: { id: rowId } });
    const existing = existingRows && existingRows[0];
    if (!existing) return res.status(404).json({ error: 'Row not found' });

    const updates = {};
    for (const key of PO_ROW_ALLOWED) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No editable fields in the request body.' });

    const setSql = Object.keys(updates).map((k) => `${k} = :${k}`).join(', ');
    await conn.query(
      `UPDATE po_extractor SET ${setSql}, updated_at = now() WHERE id = :id`,
      { replacements: { ...updates, id: rowId } });
    const merged = { ...existing, ...updates };

    // Best-effort Sheet sync — matched on the row's values BEFORE this edit.
    let sheetSynced = false, sheetError = null;
    try {
      const brand = await Brand.findByPk(brandId);
      const sheetId = parseSpreadsheetId(sheetUrlFor(brand));
      if (sheetId) {
        const matchValues = [existing.po_number, existing.product_description, existing.unit_cost];
        const newRow = PO_SHEET_COLUMNS.map((c) => merged[c] ?? '');
        sheetSynced = await drive.findAndUpdateRow(sheetId, 'PO_Data', [0, 5, 6], matchValues, newRow);
      }
    } catch (e) {
      sheetError = e.message;
      console.warn('[PO edit] sheet sync failed (non-fatal):', e.message);
    }

    return res.json({ success: true, data: merged, sheetSynced, sheetError });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ─── DELETE /api/brands/:brandId/agents/:agentId/po-rows/:rowId ──────────────
async function deletePORow(req, res) {
  const { brandId, rowId } = req.params;
  const conn = await brandConn(brandId);
  if (!conn) return res.status(404).json({ error: 'not found' });
  try {
    await conn.query('DELETE FROM po_extractor WHERE id = :id', { replacements: { id: rowId } });
    return res.json({ deleted: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ─── DELETE /api/brands/:brandId/agents/:agentId/po-rows  ("Delete All") ─────
async function deleteAllPO(req, res) {
  const { brandId, agentId } = req.params;
  const conn = await brandConn(brandId);
  if (!conn) return res.json({ deleted: 0 });
  try {
    const [rows] = await conn.query(
      'DELETE FROM po_extractor WHERE agent_id = :aid OR agent_id IS NULL RETURNING id',
      { replacements: { aid: agentId } });
    return res.json({ deleted: Array.isArray(rows) ? rows.length : 0 });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

module.exports = {
  processPO, cancelPO, getPOSheetUrl, updatePOSettings, uploadPOFiles,
  listPORows, updatePORow, deletePORow, deleteAllPO,
};
