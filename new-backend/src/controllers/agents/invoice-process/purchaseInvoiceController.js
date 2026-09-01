// ── Purchase-Invoice → Tally controller ─────────────────────────────────────
// Urban-Plant "Purchase Invoice" mode. Uploads vendor purchase-invoice PDFs →
// Python engine extracts (deterministic per known vendor; Gemini only for a new
// layout) + maps each line to a Tally stock item via the SKU ladder → returns a
// preview. The accountant resolves duplicates (dropdown) / adds missing items
// (form); every resolution is written back to the DB so it auto-maps next time.
// Finally the 109-column Excel-to-Tally workbook is built for download.
//
// DB (unified, brand-scoped by RLS via getBrandConnection):
//   purchase_sku         — the master (description → tally_name)
//   purchase_sku_learned — write-back of manual picks (vendor+desc(+rate) → tally)
const { Sequelize } = require('sequelize');
const { Brand } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const enginePool = require('../../../lib/enginePool');
const FormData = require('form-data');
const axios = require('axios');

// mirror of recon.purchase_sku_match.norm — MUST stay in sync (learned match key)
function norm(s) {
  s = String(s || '').toLowerCase().replace(/₹/g, ' ');
  s = s.replace(/\s+\d{1,2}\s*%\s*$/, '');
  s = s.replace(/[^a-z0-9]+/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

async function brandConn(brandId) {
  const brand = await Brand.findByPk(brandId);
  if (!brand) throw Object.assign(new Error('Brand not found'), { status: 404 });
  return { brand, seq: getBrandConnection(brand.db_name) };
}

async function loadMaster(seq) {
  const rows = await seq.query(
    'SELECT description, sku, tally_name AS tally FROM purchase_sku',
    { type: Sequelize.QueryTypes.SELECT });
  return rows;
}
async function loadLearned(seq) {
  const rows = await seq.query(
    `SELECT vendor_gstin, description_raw AS description, rate, sku, tally_name AS tally
       FROM purchase_sku_learned`,
    { type: Sequelize.QueryTypes.SELECT });
  return rows;
}

// POST …/purchase-invoice/extract   (multipart: files[])
exports.extract = async (req, res) => {
  try {
    const { brandId } = req.params;
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok: false, error: 'No PDF files uploaded' });
    const { seq } = await brandConn(brandId);
    const [master, learned] = await Promise.all([loadMaster(seq), loadLearned(seq)]);

    const form = new FormData();
    form.append('master_rows', JSON.stringify(master));
    form.append('learned_rows', JSON.stringify(learned));
    form.append('use_gemini', String(req.body.use_gemini !== 'false'));
    form.append('narration', req.body.narration || 'Excel to tally');
    for (const f of files) {
      form.append('files', f.buffer, { filename: f.originalname, contentType: 'application/pdf' });
    }
    const engine = enginePool.acquireEngine();
    try {
      const r = await axios.post(`${engine}/api/purchase-invoice/extract`, form, {
        headers: { ...form.getHeaders() }, timeout: 600000,
        maxContentLength: Infinity, maxBodyLength: Infinity,
      });
      return res.json(r.data);
    } finally {
      enginePool.releaseEngine(engine);
    }
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.message });
  }
};

// POST …/purchase-invoice/pick   { vendor_gstin, description, rate, sku, tally_name }
// Records a manual duplicate-resolution so it becomes an EXACT hit next time.
exports.savePick = async (req, res) => {
  try {
    const { brandId } = req.params;
    const { vendor_gstin, description, rate, sku, tally_name } = req.body;
    if (!description || !tally_name) return res.status(400).json({ error: 'description and tally_name required' });
    const { seq } = await brandConn(brandId);
    await seq.query(
      `INSERT INTO purchase_sku_learned
         (brand_id, vendor_gstin, description_norm, description_raw, rate, sku, tally_name, created_by)
       VALUES (current_setting('app.brand_id')::uuid, :g, :dn, :dr, :rate, :sku, :tn, :uid)`,
      { replacements: {
          g: vendor_gstin || null, dn: norm(description), dr: description,
          rate: (rate === '' || rate == null) ? null : rate, sku: sku || null,
          tn: tally_name, uid: (req.user && req.user.id) || null },
        type: Sequelize.QueryTypes.INSERT });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
};

// POST …/purchase-invoice/master   { description, sku, tally_name }
// Adds a genuinely-missing product to the master (auto-adds to the DB).
exports.addMaster = async (req, res) => {
  try {
    const { brandId } = req.params;
    const { description, sku, tally_name } = req.body;
    if (!description || !tally_name) return res.status(400).json({ error: 'description and tally_name required' });
    const { seq } = await brandConn(brandId);
    await seq.query(
      `INSERT INTO purchase_sku (brand_id, description, sku, tally_name, created_by)
       VALUES (current_setting('app.brand_id')::uuid, :d, :sku, :tn, :uid)`,
      { replacements: { d: description, sku: sku || null, tn: tally_name, uid: (req.user && req.user.id) || null },
        type: Sequelize.QueryTypes.INSERT });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
};

// GET …/purchase-invoice/master?q=   — search the master (dropdown / add autocomplete)
exports.searchMaster = async (req, res) => {
  try {
    const { brandId } = req.params;
    const q = `%${(req.query.q || '').trim()}%`;
    const { seq } = await brandConn(brandId);
    const rows = await seq.query(
      `SELECT id, description, sku, tally_name FROM purchase_sku
        WHERE description ILIKE :q OR tally_name ILIKE :q OR sku ILIKE :q
        ORDER BY tally_name LIMIT 50`,
      { replacements: { q }, type: Sequelize.QueryTypes.SELECT });
    return res.json({ ok: true, rows });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
};

// POST …/purchase-invoice/build   { invoices, narration }  → streams the xlsx
exports.build = async (req, res) => {
  try {
    const { brandId } = req.params;
    const { invoices, narration } = req.body;
    if (!Array.isArray(invoices) || !invoices.length)
      return res.status(400).json({ error: 'invoices required' });
    // brand-named, dated filename so downloads don't collide (Excel_to_Tally (1)…)
    let fname = 'Purchase_Tally';
    try {
      const brand = await Brand.findByPk(brandId);
      const slug = (brand?.name || 'Purchase').replace(/[^A-Za-z0-9]+/g, '');
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
      fname = `${slug}_Tally_${stamp}`;
    } catch (_) { /* keep default */ }
    const engine = enginePool.acquireEngine();
    let jobId;
    try {
      const r = await axios.post(`${engine}/api/purchase-invoice/build`,
        { invoices, narration: narration || 'Excel to tally' },
        { timeout: 300000, maxContentLength: Infinity, maxBodyLength: Infinity });
      jobId = r.data.job_id;
      enginePool.rememberJob(jobId, engine);
    } finally {
      enginePool.releaseEngine(engine);
    }
    const xr = await enginePool.exportFromEngines(jobId, { responseType: 'arraybuffer', timeout: 200000 });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}.xlsx"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    return res.send(Buffer.from(xr.data));
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
};
