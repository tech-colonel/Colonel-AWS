// PO Extractor master data — Vendor master (Buyer GSTIN -> Vendor Name as per
// Tally) and SKU master (Material/SKU Code -> FG, the Tally item name).
//
// The brand-scoped DB tables (po_vendor_master / po_sku_master, RLS) are the
// source of truth and are edited ONLY from the PO Extractor UI. After every
// change the whole table is mirrored to the brand's PO Sheet as the
// Vendor_Master / SKU_Master tabs, which the PO_Data XLOOKUP formulas read —
// so edits made directly in those tabs are overwritten by the next app save.
// Sheet mirroring is best-effort: a failure never blocks the DB write, and the
// response says whether it worked.

const XLSX = require('xlsx');
const { Brand } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const drive = require('../../../services/driveService');
const { VENDOR_TAB, SKU_TAB, VENDOR_HEADERS, SKU_HEADERS } = require('./poSheetLayout');

const GSTIN_RE = /^[0-9]{2}[A-Z0-9]{13}$/;

// kind -> table/columns/normalisers. `key` is the lookup key, `value` the result.
const KINDS = {
  vendor: {
    table: 'po_vendor_master', key: 'buyer_gstin', value: 'vendor_name_tally',
    tab: VENDOR_TAB, headers: VENDOR_HEADERS,
    normKey: (v) => String(v ?? '').replace(/\s+/g, '').toUpperCase(),
    validKey: (k) => GSTIN_RE.test(k),
    keyError: 'Buyer GSTIN must be a 15-character GSTIN',
    // Upload header detection (first matching column wins).
    keyHeader: /gstin|gstn|gst\s*no|gst\s*number/i,
    valueHeader: /vendor|party|ledger|customer|name/i,
  },
  sku: {
    table: 'po_sku_master', key: 'material_code', value: 'fg_name',
    tab: SKU_TAB, headers: SKU_HEADERS,
    normKey: (v) => String(v ?? '').trim().replace(/\.0+$/, ''),
    validKey: (k) => k.length > 0 && k.length <= 120,
    keyError: 'Material / SKU code is required',
    keyHeader: /material|sku|item\s*code|article|code/i,
    valueHeader: /fg|tally|item\s*name|stock\s*item|product|name|desc/i,
  },
};

const normValue = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

async function brandConn(brandId) {
  const [rows] = await Brand.sequelize.query('SELECT db_name FROM brands WHERE id = :bid', { replacements: { bid: brandId } });
  const dbName = rows && rows[0] && rows[0].db_name;
  return dbName ? getBrandConnection(dbName) : null;
}

const SHEET_ID_RE = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/;
function sheetIdFor(brand) {
  const envFor = (suffix) =>
    process.env[`${brand.name.toLowerCase()}${suffix}`] || process.env[`${brand.name}${suffix}`] ||
    process.env[`${brand.name.replace(/[^A-Za-z0-9]/g, '')}${suffix}`] || null;
  const raw = brand.po_sheet_url || envFor('_po_sheet');
  if (!raw) return null;
  const m = String(raw).match(SHEET_ID_RE);
  return m ? m[1] : (/^[a-zA-Z0-9_-]{20,}$/.test(String(raw).trim()) ? String(raw).trim() : null);
}

function kindOr400(req, res) {
  const k = KINDS[req.params.kind];
  if (!k) { res.status(400).json({ error: 'Unknown master — use "vendor" or "sku".' }); return null; }
  return k;
}

async function listRows(conn, k) {
  const [rows] = await conn.query(
    `SELECT id, ${k.key}, ${k.value}, updated_at FROM ${k.table} ORDER BY ${k.key}`);
  return rows;
}

// Mirror the whole table to its Sheet tab. Returns { sheetSynced, sheetError }.
async function mirrorToSheet(brandId, conn, k) {
  try {
    const brand = await Brand.findByPk(brandId);
    const sheetId = brand && sheetIdFor(brand);
    if (!sheetId) return { sheetSynced: false, sheetError: 'No PO Sheet configured for this brand.' };
    const rows = await listRows(conn, k);
    await drive.replaceTabValues(sheetId, k.tab, [k.headers, ...rows.map((r) => [r[k.key], r[k.value]])]);
    return { sheetSynced: true, sheetError: null };
  } catch (e) {
    console.warn(`[PO master] ${k.tab} sheet mirror failed (non-fatal):`, e.message);
    return { sheetSynced: false, sheetError: e.message };
  }
}

/** Normalise + validate incoming {key,value} pairs; dedupe by key (last wins). */
function cleanPairs(k, pairs) {
  const good = new Map();
  const skipped = [];
  pairs.forEach((p, i) => {
    const key = k.normKey(p.key);
    const value = normValue(p.value);
    if (!key && !value) return; // blank line
    if (!k.validKey(key)) { skipped.push({ row: p.row ?? i + 1, key: p.key, reason: k.keyError }); return; }
    if (!value) { skipped.push({ row: p.row ?? i + 1, key, reason: 'Name is empty' }); return; }
    good.set(k.normKey(key).toUpperCase(), { key, value });
  });
  return { rows: [...good.values()], skipped };
}

async function upsertPairs(conn, k, rows, replace) {
  await conn.transaction(async (t) => {
    if (replace) await conn.query(`DELETE FROM ${k.table}`, { transaction: t });
    for (const r of rows) {
      await conn.query(
        `INSERT INTO ${k.table} (${k.key}, ${k.value}) VALUES (:key, :value)
         ON CONFLICT (brand_id, ${k.key}) DO UPDATE SET ${k.value} = EXCLUDED.${k.value}, updated_at = now()`,
        { replacements: r, transaction: t });
    }
  });
}

// ─── GET /api/brands/:brandId/po/master/:kind ────────────────────────────────
async function getMaster(req, res) {
  const k = kindOr400(req, res); if (!k) return;
  const conn = await brandConn(req.params.brandId);
  if (!conn) return res.json([]);
  try { return res.json(await listRows(conn, k)); } catch (e) { return res.status(500).json({ error: e.message }); }
}

// ─── POST /api/brands/:brandId/po/master/:kind  { key, value } ───────────────
// Add one row, or update the name if the key already exists.
async function saveMasterRow(req, res) {
  const k = kindOr400(req, res); if (!k) return;
  const conn = await brandConn(req.params.brandId);
  if (!conn) return res.status(404).json({ error: 'Brand not found' });
  const { rows, skipped } = cleanPairs(k, [{ key: req.body.key, value: req.body.value }]);
  if (!rows.length) return res.status(400).json({ error: skipped[0]?.reason || 'Nothing to save' });
  try {
    await upsertPairs(conn, k, rows, false);
    const sync = await mirrorToSheet(req.params.brandId, conn, k);
    return res.json({ success: true, ...sync, rows: await listRows(conn, k) });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

// ─── PATCH /api/brands/:brandId/po/master/:kind/:id  { key, value } ──────────
async function updateMasterRow(req, res) {
  const k = kindOr400(req, res); if (!k) return;
  const conn = await brandConn(req.params.brandId);
  if (!conn) return res.status(404).json({ error: 'Brand not found' });
  const { rows, skipped } = cleanPairs(k, [{ key: req.body.key, value: req.body.value }]);
  if (!rows.length) return res.status(400).json({ error: skipped[0]?.reason || 'Nothing to save' });
  try {
    const [, meta] = await conn.query(
      `UPDATE ${k.table} SET ${k.key} = :key, ${k.value} = :value, updated_at = now() WHERE id = :id`,
      { replacements: { ...rows[0], id: req.params.id } });
    if (meta && meta.rowCount === 0) return res.status(404).json({ error: 'Row not found' });
    const sync = await mirrorToSheet(req.params.brandId, conn, k);
    return res.json({ success: true, ...sync, rows: await listRows(conn, k) });
  } catch (e) {
    if (/unique|duplicate/i.test(e.message)) return res.status(409).json({ error: `"${rows[0].key}" already exists in this master.` });
    return res.status(500).json({ error: e.message });
  }
}

// ─── DELETE /api/brands/:brandId/po/master/:kind/:id ─────────────────────────
async function deleteMasterRow(req, res) {
  const k = kindOr400(req, res); if (!k) return;
  const conn = await brandConn(req.params.brandId);
  if (!conn) return res.status(404).json({ error: 'Brand not found' });
  try {
    await conn.query(`DELETE FROM ${k.table} WHERE id = :id`, { replacements: { id: req.params.id } });
    const sync = await mirrorToSheet(req.params.brandId, conn, k);
    return res.json({ success: true, ...sync, rows: await listRows(conn, k) });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

// ─── POST /api/brands/:brandId/po/master/:kind/upload  (file, mode) ──────────
// Excel/CSV upload. mode=merge (default): add new keys, update existing names.
// mode=replace: the file becomes the whole master. Header row is detected in
// the first 10 rows by column name; failing that, columns A/B are used.
async function uploadMaster(req, res) {
  const k = kindOr400(req, res); if (!k) return;
  const conn = await brandConn(req.params.brandId);
  if (!conn) return res.status(404).json({ error: 'Brand not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const replace = String(req.body.mode || 'merge') === 'replace';

  let grid;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
  } catch (e) {
    return res.status(400).json({ error: 'Could not read that file — upload an .xlsx, .xls or .csv.' });
  }

  let headerIdx = -1, keyCol = 0, valueCol = 1;
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    const cells = (grid[i] || []).map((c) => String(c || ''));
    const kc = cells.findIndex((c) => k.keyHeader.test(c));
    const vc = cells.findIndex((c, j) => j !== kc && k.valueHeader.test(c));
    if (kc !== -1 && vc !== -1) { headerIdx = i; keyCol = kc; valueCol = vc; break; }
  }
  const pairs = grid.slice(headerIdx + 1).map((row, i) => ({
    row: headerIdx + 2 + i, key: (row || [])[keyCol], value: (row || [])[valueCol],
  }));
  const { rows, skipped } = cleanPairs(k, pairs);
  if (!rows.length) return res.status(400).json({ error: 'No valid rows found in the file.', skipped: skipped.slice(0, 50) });

  try {
    await upsertPairs(conn, k, rows, replace);
    const sync = await mirrorToSheet(req.params.brandId, conn, k);
    return res.json({
      success: true, saved: rows.length, skippedCount: skipped.length, skipped: skipped.slice(0, 50),
      mode: replace ? 'replace' : 'merge', ...sync, rows: await listRows(conn, k),
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

// ─── POST /api/brands/:brandId/po/master/sync ────────────────────────────────
// Re-push both masters to the Sheet (e.g. after sharing it with the service
// account, or after someone edited the master tabs by hand).
async function syncMasters(req, res) {
  const conn = await brandConn(req.params.brandId);
  if (!conn) return res.status(404).json({ error: 'Brand not found' });
  const vendor = await mirrorToSheet(req.params.brandId, conn, KINDS.vendor);
  const sku = await mirrorToSheet(req.params.brandId, conn, KINDS.sku);
  return res.json({ vendor, sku, sheetSynced: vendor.sheetSynced && sku.sheetSynced });
}

module.exports = { getMaster, saveMasterRow, updateMasterRow, deleteMasterRow, uploadMaster, syncMasters };
