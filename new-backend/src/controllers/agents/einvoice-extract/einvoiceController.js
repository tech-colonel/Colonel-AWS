// E-Invoice Extractor controller.
// Deterministic (no LLM / no n8n): gathers e-invoice PDFs (multi-upload +/or a
// Drive folder link), parses each ONE AT A TIME through the reco engine
// (/api/einvoice/parse), pushes a live "X of N" counter, classifies every file
// red/yellow/green, builds the styled 3-sheet register (/api/einvoice/build),
// PERSISTS each invoice + its PDF (history, like Invoice Process), and returns
// ONE group per invoice (header + its line items) for the card UI.

const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
const axios = require('axios');
const enginePool = require('../../../lib/enginePool');
const drive = require('../../../services/driveService');
const events = require('../../../utils/einvoiceEvents');
const { getBrandConnection } = require('../../../config/database');
const { Brand } = require('../../../models/master');

const EINVOICE_DIR = path.resolve(__dirname, '../../../../output/einvoice');
const cancelFlags = new Map();

const isPdf = (name = '', mime = '') =>
  /\.pdf$/i.test(name || '') || String(mime || '').toLowerCase().includes('pdf');
const safeName = (s) => String(s || 'file').replace(/[^\w.\-]+/g, '_').slice(-80);

// Resolve a brand-scoped (RLS: app.brand_id preset) connection for a brandId.
async function brandConn(brandId) {
  try {
    const [rows] = await Brand.sequelize.query('SELECT db_name FROM brands WHERE id = :bid', { replacements: { bid: brandId } });
    const dbName = rows && rows[0] && rows[0].db_name;
    return dbName ? getBrandConnection(dbName) : null;
  } catch (_) { return null; }
}

async function gatherPdfs(req) {
  const pdfs = [];
  for (const f of (req.files || [])) {
    if (isPdf(f.originalname, f.mimetype)) pdfs.push({ filename: f.originalname, buffer: f.buffer });
  }
  const driveUrl = req.body.drive_url || req.body.folder_url;
  if (driveUrl && String(driveUrl).trim()) {
    const folderId = drive.parseFolderId(String(driveUrl).trim());
    if (!folderId) throw new Error('That does not look like a Google Drive folder link.');
    const children = await drive.listChildren(folderId);
    for (const c of children) {
      if (isPdf(c.name, c.mimeType)) {
        const buf = await drive.downloadFile(c.id);
        pdfs.push({ filename: c.name, buffer: buf });
      }
    }
  }
  return pdfs;
}

async function processEInvoices(req, res) {
  const { brandId, agentId } = req.params;
  const key = `${brandId}-${agentId}`;
  cancelFlags.delete(key);

  let pdfs;
  try {
    pdfs = await gatherPdfs(req);
  } catch (e) {
    return res.status(400).json({ error: `Could not read the Drive folder: ${e.message}` });
  }
  if (!pdfs.length) {
    return res.status(400).json({ error: 'Upload e-invoice PDF(s) or paste a Google Drive folder link.' });
  }

  events.startRun(brandId, agentId, pdfs.length);
  const invoices = [];        // per-invoice groups (the cards) — carry buffer for persistence
  const parsedForBuild = [];  // {header, line_items} for the register
  let approved = 0, review = 0, invalid = 0, done = 0;

  const engine = enginePool.acquireEngine();
  try {
    for (const pdf of pdfs) {
      if (cancelFlags.get(key)) break;
      let group;
      try {
        const form = new FormData();
        form.append('file', pdf.buffer, { filename: pdf.filename, contentType: 'application/pdf' });
        const r = await axios.post(`${engine}/api/einvoice/parse`, form, {
          headers: form.getHeaders(), timeout: 120000,
          maxContentLength: Infinity, maxBodyLength: Infinity,
        });
        const d = r.data || {};
        if (d.ok) {
          const h = d.header || {};
          const items = d.line_items || [];
          const status = items.length ? 'Extracted' : 'Needs Review';
          if (items.length) approved++; else review++;
          parsedForBuild.push({ header: h, line_items: items });
          group = {
            filename: pdf.filename, status,
            invoice_no: h.invoice_no || '', ack_no: h.ack_no || '', irn: h.irn || '',
            invoice_date: h.invoice_date || '', pos: h.pos || '',
            supplier_name: h.supplier_name || '', supplier_gstin: h.supplier_gstin || '',
            recipient_name: h.recipient_name || '', recipient_gstin: h.recipient_gstin || '',
            line_items: items, error: null, __buffer: pdf.buffer,
          };
        } else if (d.reason === 'not_einvoice') {
          invalid++;
          group = { filename: pdf.filename, status: 'Not an E-Invoice', line_items: [], error: 'This is not an E-Invoice PDF', __buffer: pdf.buffer };
        } else {
          invalid++;
          group = { filename: pdf.filename, status: 'Invalid', line_items: [], error: d.detail || 'Could not read this PDF', __buffer: pdf.buffer };
        }
      } catch (e) {
        invalid++;
        group = { filename: pdf.filename, status: 'Invalid', line_items: [], error: (e.response?.data?.detail || e.message), __buffer: pdf.buffer };
      }
      invoices.push(group);
      done++;
      events.tick(brandId, agentId, done, pdfs.length, { approved, review, invalid });
    }

    let job_id = null;
    if (parsedForBuild.length) {
      try {
        const b = await axios.post(`${engine}/api/einvoice/build`, { invoices: parsedForBuild }, { timeout: 200000 });
        job_id = b.data && b.data.job_id;
        if (job_id) enginePool.rememberJob(job_id, engine);
      } catch (e) { /* register build failed — cards still returned */ }
    }

    // ── Persist history (best-effort): save each PDF to disk + a row per invoice ──
    try {
      const conn = await brandConn(brandId);
      if (conn) {
        const dir = path.join(EINVOICE_DIR, brandId);
        fs.mkdirSync(dir, { recursive: true });
        for (const g of invoices) {
          let pdfPath = null;
          try {
            if (g.__buffer) {
              pdfPath = path.join(dir, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}__${safeName(g.filename)}`);
              fs.writeFileSync(pdfPath, g.__buffer);
            }
          } catch (_) { pdfPath = null; }
          try {
            await conn.query(
              `INSERT INTO einvoice_process
                 (agent_id, job_id, filename, invoice_no, ack_no, irn, invoice_date, pos,
                  supplier_name, supplier_gstin, recipient_name, recipient_gstin, status, line_items, pdf_path)
               VALUES (:agent_id, :job_id, :filename, :invoice_no, :ack_no, :irn, :invoice_date, :pos,
                  :supplier_name, :supplier_gstin, :recipient_name, :recipient_gstin, :status, CAST(:line_items AS jsonb), :pdf_path)`,
              { replacements: {
                agent_id: agentId, job_id: job_id || null, filename: g.filename || null,
                invoice_no: g.invoice_no || null, ack_no: g.ack_no || null, irn: g.irn || null,
                invoice_date: g.invoice_date || null, pos: g.pos || null,
                supplier_name: g.supplier_name || null, supplier_gstin: g.supplier_gstin || null,
                recipient_name: g.recipient_name || null, recipient_gstin: g.recipient_gstin || null,
                status: g.status || null, line_items: JSON.stringify(g.line_items || []), pdf_path: pdfPath,
              } });
          } catch (_) { /* one row failed — keep going */ }
        }
      }
    } catch (_) { /* persistence is best-effort; the run still returns */ }

    invoices.forEach((g) => { delete g.__buffer; }); // never send buffers to the client

    const cancelled = !!cancelFlags.get(key);
    cancelFlags.delete(key);
    events.complete(brandId, agentId, { approved, review, invalid, job_id, cancelled });
    return res.json({ job_id, invoices, cancelled, counts: { total: pdfs.length, approved, review, invalid } });
  } finally {
    enginePool.releaseEngine(engine);
  }
}

async function cancelEInvoice(req, res) {
  const { brandId, agentId } = req.params;
  cancelFlags.set(`${brandId}-${agentId}`, true);
  events.resetRun(brandId, agentId);
  return res.json({ cancelled: true });
}

// ── History: list past extractions (RLS auto-scopes to this brand) ──────────
async function listEInvoices(req, res) {
  const { brandId } = req.params;
  const conn = await brandConn(brandId);
  if (!conn) return res.json([]);
  try {
    const [rows] = await conn.query(
      `SELECT id, job_id, filename, invoice_no, ack_no, irn, invoice_date, pos,
              supplier_name, supplier_gstin, recipient_name, recipient_gstin,
              status, line_items, created_at, (pdf_path IS NOT NULL) AS has_pdf
       FROM einvoice_process ORDER BY created_at DESC LIMIT 500`);
    return res.json(rows);
  } catch (e) {
    return res.json([]);
  }
}

// ── Serve a stored source PDF (iframe uses ?token=… — see the route) ────────
async function getEInvoicePdf(req, res) {
  const { brandId, id } = req.params;
  const conn = await brandConn(brandId);
  if (!conn) return res.status(404).end();
  try {
    const [rows] = await conn.query('SELECT pdf_path FROM einvoice_process WHERE id = :id', { replacements: { id } });
    const p = rows && rows[0] && rows[0].pdf_path;
    if (!p || !fs.existsSync(p)) return res.status(404).end();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    return fs.createReadStream(p).pipe(res);
  } catch (e) {
    return res.status(404).end();
  }
}

module.exports = { processEInvoices, cancelEInvoice, listEInvoices, getEInvoicePdf };
