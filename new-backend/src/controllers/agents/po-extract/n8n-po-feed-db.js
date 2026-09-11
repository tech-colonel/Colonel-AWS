// POST /api/n8n/po/feed — the n8n "PO Extract" workflow pushes extracted
// Purchase-Order line items here (one call per PO, body = array of line-item
// rows). We persist them to the RLS-scoped `po_extractor` table and tick the
// shared live progress store (feedTick) so the workspace's "X of N" counter
// moves. No auth — called by n8n directly, like /api/n8n/feed.

const { Op } = require('sequelize');
const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { feedTick } = require('../../../utils/invoiceEvents');

const s = (v) => (v === undefined || v === null || v === 'null' || v === 'undefined') ? null : String(v).trim() || null;
const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(String(v).replace(/[,\s₹]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const pick = (row, q, ...keys) => {
  for (const k of keys) {
    if (q && q[k] != null && q[k] !== '') return q[k];
    if (row && row[k] != null && row[k] !== '') return row[k];
  }
  return null;
};

async function feedPOFromN8n(req, res, next) {
  try {
    const q = req.query || {};
    let rows = [];
    if (Array.isArray(req.body)) rows = req.body;
    else if (req.body && Array.isArray(req.body.rows)) rows = req.body.rows;
    else if (req.body && Array.isArray(req.body.processed_rows)) rows = req.body.processed_rows;
    // n8n's HTTP Request node sends { agentId, brandId, batch_total, run_id, processed_invoices: [...] }
    // — same wrapper key Invoice Process uses (/api/n8n/feed) — so the PO workflow's payload matches it.
    else if (req.body && Array.isArray(req.body.processed_invoices)) rows = req.body.processed_invoices;
    else if (req.body && typeof req.body === 'object') rows = [req.body];

    // Meta fields (brandId/agentId/run_id/batch_total) live at the TOP of the body in the
    // { agentId, brandId, batch_total, run_id, processed_invoices:[...] } wrapper shape — NOT
    // inside each line item. Prefer those; fall back to the first row for the flat-array shape.
    const first = rows[0] || {};
    const bodyMeta = (!Array.isArray(req.body) && req.body && typeof req.body === 'object') ? req.body : {};
    const meta = { ...first, ...bodyMeta };
    const brandId   = pick(meta, q, 'brandId', 'brandid', 'brand_id');
    const agentId   = pick(meta, q, 'agentId', 'agentid', 'agent_id');
    const brandName = pick(meta, q, 'brandName', 'brand_name');
    const agentName = pick(meta, q, 'agentName', 'agent_name');

    if (!brandId && !brandName) return res.status(400).json({ error: 'brandId or brandName required' });
    if (!agentId && !agentName) return res.status(400).json({ error: 'agentId or agentName required' });

    let brand = brandId ? await Brand.findByPk(brandId) : null;
    if (!brand && brandName) brand = await Brand.findOne({ where: { name: { [Op.iLike]: brandName } } });
    let agent = agentId ? await Agent.findByPk(agentId) : null;
    if (!agent && agentName) agent = await Agent.findOne({ where: { name: { [Op.iLike]: agentName } } });
    if (!brand || !agent) {
      return res.status(404).json({ error: 'Brand or Agent not found', detail: { brandId, brandName, agentId, agentName } });
    }

    if (!rows.length) {
      return res.json({ success: true, message: 'No rows to store', count: 0 });
    }

    const conn = getBrandConnection(brand.db_name);
    const runId = s(pick(meta, q, 'run_id', 'runId'));
    const batchTotal = Number(pick(meta, q, 'batch_total', 'batchTotal')) || 0;

    // Map each incoming line item to the po_extractor column set.
    const mapped = rows.map((r) => ({
      run_id: runId || s(r.run_id),
      source_file: s(r.source_file || r.file || r.filename),
      po_pdf_link: s(r.po_pdf_link || r.pdf_link || r.webViewLink),
      po_number: s(r.po_number || r.po_no || r.poNumber),
      po_date: s(r.po_date || r.poDate),
      supplier_gstin: s(r.supplier_gstin || r.seller_gstin || r.vendor_gstin),
      buyer_gstin: s(r.buyer_gstin || r.recipient_gstin),
      billing_address: s(r.billing_address || r.billing_address_deliver_to || r.address || r.ship_to),
      product_description: s(r.product_description || r.description || r.item_description || r.product_name),
      unit_cost: num(r.unit_cost != null ? r.unit_cost : (r.basic_cost_price != null ? r.basic_cost_price : r.rate)),
      gst_rate: num(r.gst_rate != null ? r.gst_rate : r.gst),
      status: s(r.status) || 'Extracted',
    }));

    // Dedupe: skip line items already present for this PO (idempotent re-runs).
    const poNos = [...new Set(mapped.map((m) => m.po_number).filter(Boolean))];
    let existing = new Set();
    if (poNos.length) {
      try {
        const [ex] = await conn.query(
          `SELECT po_number, product_description, unit_cost FROM po_extractor WHERE po_number IN (:pos)`,
          { replacements: { pos: poNos } });
        existing = new Set((ex || []).map((e) => `${e.po_number}||${e.product_description}||${Number(e.unit_cost) || 0}`));
      } catch (_) { /* first run — table empty */ }
    }
    const fresh = mapped.filter((m) => !existing.has(`${m.po_number}||${m.product_description}||${Number(m.unit_cost) || 0}`));

    let inserted = 0;
    for (const m of fresh) {
      try {
        await conn.query(
          `INSERT INTO po_extractor
             (agent_id, run_id, source_file, po_pdf_link, po_number, po_date,
              supplier_gstin, buyer_gstin, billing_address, product_description,
              unit_cost, gst_rate, status)
           VALUES (:agent_id, :run_id, :source_file, :po_pdf_link, :po_number, :po_date,
              :supplier_gstin, :buyer_gstin, :billing_address, :product_description,
              :unit_cost, :gst_rate, :status)`,
          { replacements: { agent_id: agent.id, ...m } });
        inserted++;
      } catch (e) { console.warn('[n8n po feed] row insert failed (skipped):', e.message); }
    }

    // Live counter — one distinct PO per feed call (n8n calls this once per PO).
    const feedItems = [...new Map(mapped.map((m) => [
      m.po_number || m.source_file || `row_${Math.random()}`,
      { invoice_number: m.po_number, invoice_link: m.po_pdf_link, status: m.status === 'Not a PO' ? 'Invalid' : (m.status === 'Needs Review' ? 'Needs Review' : 'Approved') },
    ])).values()];
    feedTick(brand.id, agent.id, { items: feedItems, total: batchTotal });

    console.log(`[n8n po feed] ${brand.name}: +${inserted} line item(s) (${rows.length} received, ${rows.length - fresh.length} dup)`);
    return res.json({ success: true, count: inserted, received: rows.length, deduped: rows.length - fresh.length });
  } catch (error) {
    console.error('❌ PO Feed Error:', error);
    next(error);
  }
}

module.exports = { feedPOFromN8n };
