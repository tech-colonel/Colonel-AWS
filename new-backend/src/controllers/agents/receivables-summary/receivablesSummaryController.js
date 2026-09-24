/* ──────────────────────────────────────────────────────────────────────────────
   receivablesSummaryController.js — the Receivables Summary agent.

   Shaped after the Amazon settlement agent (upload → parse → store flat →
   summarise with live formulas), but a SEPARATE agent with its own table,
   routes and processors. Nothing here imports or alters the Amazon agent, so
   that agent keeps behaving exactly as it does today.

   The difference that justifies the separation: Amazon hands over one settlement
   report with a fixed header and states its own payout. Here the inputs are a
   hand-kept workbook per GST registration plus a payment reconciliation, the
   header sits at a different row in every tab, and the payout has to be rebuilt
   from five collector columns before it can be trusted.
   ────────────────────────────────────────────────────────────────────────────── */

const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const XLSXStyle = require('xlsx-js-style');

const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');
const { parseReceivablesFile } = require('../../../services/processors/offdutyReceivablesParser');
const { buildReceivables } = require('../../../services/processors/offdutyReceivablesLedger');
const { buildWorkbook } = require('../../../services/processors/offdutyReceivablesWorkbook');

const OUTPUT_DIR = path.join(__dirname, '../../../../outputs');
const ensureDir = () => fs.ensureDir(OUTPUT_DIR);

/* Every column the parser can emit. Kept in one place so the seed script and
   the controller cannot drift apart. */
const COLUMNS = [
  { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },
  { name: 'filename', type: 'STRING' },
  { name: 'source_kind', type: 'STRING' },
  { name: 'source_tab', type: 'STRING' },
  { name: 'entity', type: 'STRING' },
  { name: 'order_id', type: 'STRING' },
  { name: 'order_date', type: 'STRING' },
  { name: 'period', type: 'STRING' },
  { name: 'sales_month', type: 'STRING' },
  { name: 'shipping_state', type: 'STRING' },
  { name: 'pickup_state', type: 'STRING' },
  { name: 'sku', type: 'STRING' },
  { name: 'product_name', type: 'STRING' },
  { name: 'qty', type: 'DECIMAL' },
  { name: 'order_total', type: 'DECIMAL' },
  { name: 'tax_rate', type: 'DECIMAL' },
  { name: 'taxable_value', type: 'DECIMAL' },
  { name: 'tax_amount', type: 'DECIMAL' },
  { name: 'cgst', type: 'DECIMAL' },
  { name: 'sgst', type: 'DECIMAL' },
  { name: 'igst', type: 'DECIMAL' },
  { name: 'order_status', type: 'STRING' },
  { name: 'gst_status', type: 'STRING' },
  { name: 'delivered_date', type: 'STRING' },
  { name: 'rto_date', type: 'STRING' },
  { name: 'rto_month', type: 'STRING' },
  { name: 'refunded_at', type: 'STRING' },
  { name: 'refunded_amount', type: 'DECIMAL' },
  { name: 'refund_status', type: 'STRING' },
  { name: 'refund_mode', type: 'STRING' },
  { name: 'financial_status', type: 'STRING' },
  { name: 'payment_method', type: 'STRING' },
  { name: 'shipping_aggregator', type: 'STRING' },
  { name: 'collector', type: 'STRING' },
  { name: 'cashfree', type: 'DECIMAL' },
  { name: 'billdesk', type: 'DECIMAL' },
  { name: 'billdesk_exchange', type: 'DECIMAL' },
  { name: 'razorpay_exchange', type: 'DECIMAL' },
  { name: 'shiprocket', type: 'DECIMAL' },
  { name: 'collectors_total', type: 'DECIMAL' },
  { name: 'remitted_amount', type: 'DECIMAL' },
  { name: 'difference', type: 'DECIMAL' },
  { name: 'remarks', type: 'STRING' },
  { name: 'utr_id', type: 'STRING' },
  { name: 'payment_date', type: 'STRING' },
  { name: 'deposit_date', type: 'STRING' },
  { name: 'cancelled_at', type: 'STRING' },
  { name: 'discount_amount', type: 'DECIMAL' },
  { name: 'created_at', type: 'DATE', defaultValue: 'NOW' },
];
const FIELDS = COLUMNS.map((c) => c.name).filter((n) => n !== 'id' && n !== 'created_at');

/* Brand connections run as colonel_app, which has no CREATE on schema public,
   so the table cannot appear by itself at runtime — it comes from
   db-restructure/033_receivables_summary.sql. Checking for it here turns a
   Sequelize stack trace into a sentence that says what to do. */
async function ensureTable(Model) {
  try {
    await Model.findOne({ attributes: ['id'], limit: 1 });
  } catch (e) {
    if (/does not exist/i.test(e.message || '')) {
      const err = new Error('The receivables_summary table is missing. Apply '
        + 'db-restructure/033_receivables_summary.sql to this database.');
      err.status = 500;
      throw err;
    }
    throw e;
  }
}

async function resolve(req, res) {
  const { brandId, agentId } = req.params;
  const brand = await Brand.findByPk(brandId);
  const agent = await Agent.findByPk(agentId);
  if (!brand || !agent) { res.status(404).json({ error: 'Brand or Agent not found' }); return null; }
  const brandDb = getBrandConnection(brand.db_name);
  const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const Model = getDynamicModel(brandDb, tableName, agent.columns && agent.columns.length ? agent.columns : COLUMNS);
  return { brand, agent, Model };
}

/* Keep only the columns the table has, so a parser change cannot throw. */
const toRow = (r, filename) => {
  const out = { filename };
  for (const f of FIELDS) if (f !== 'filename') out[f] = r[f] === undefined ? null : r[f];
  return out;
};

/**
 * Upload one or more workbooks. The kind of each file is detected from its
 * contents, so the user does not have to say which is which.
 */
const uploadFiles = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    const { brand, Model } = ctx;
    const files = req.files && req.files.length ? req.files : (req.file ? [req.file] : []);
    if (!files.length) return res.status(400).json({ error: 'At least one file is required' });

    await ensureDir();
    await ensureTable(Model);

    const report = [];
    let stored = 0;

    for (const f of files) {
      let parsed;
      try {
        parsed = parseReceivablesFile(f.buffer, f.originalname);
      } catch (e) {
        report.push({ file: f.originalname, error: `Could not read: ${e.message}` });
        continue;
      }
      if (!parsed.rows.length) {
        report.push({ file: f.originalname, error: 'No Shopify order rows found', skipped: parsed.skipped });
        continue;
      }

      const stamp = `${Date.now()}_${uuidv4().slice(0, 8)}`;
      const filename = `receivables_${brand.name.replace(/[^\w]+/g, '_')}_${stamp}.xlsx`;
      await fs.writeFile(path.join(OUTPUT_DIR, filename), f.buffer);

      const rows = parsed.rows.map((r) => toRow(r, filename));
      /* Chunked — a payment file is 35k rows and one bulkCreate of that size
         builds a single enormous statement. */
      for (let i = 0; i < rows.length; i += 2000) await Model.bulkCreate(rows.slice(i, i + 2000));
      stored += rows.length;

      report.push({
        file: f.originalname, filename, kind: parsed.kind, entity: parsed.entity,
        rows: parsed.rows.length, tabs: parsed.tabs, skipped: parsed.skipped,
      });
    }

    res.json({ success: true, stored, files: report });
  } catch (error) { console.error('Receivables upload error:', error); next(error); }
};

const listFiles = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    await ensureTable(ctx.Model);
    const rows = await ctx.Model.findAll({
      attributes: ['filename', 'source_kind', 'entity', 'period', 'created_at'], raw: true,
    });
    const byFile = new Map();
    for (const r of rows) {
      if (!r.filename) continue;
      let f = byFile.get(r.filename);
      if (!f) { f = { filename: r.filename, rows: 0, kinds: new Set(), entities: new Set(), periods: new Set(), uploadedAt: r.created_at }; byFile.set(r.filename, f); }
      f.rows += 1;
      if (r.source_kind) f.kinds.add(r.source_kind);
      if (r.entity) f.entities.add(r.entity);
      if (r.period) f.periods.add(r.period);
      if (r.created_at && (!f.uploadedAt || r.created_at < f.uploadedAt)) f.uploadedAt = r.created_at;
    }
    res.json({
      files: [...byFile.values()].map((f) => ({
        ...f, kinds: [...f.kinds], entities: [...f.entities], periods: [...f.periods].sort(),
      })).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)),
    });
  } catch (error) { next(error); }
};

const deleteFile = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    const { filename } = req.params;
    const removed = await ctx.Model.destroy({ where: { filename } });
    await fs.remove(path.join(OUTPUT_DIR, filename)).catch(() => {});
    res.json({ success: true, removed });
  } catch (error) { next(error); }
};

/** Header numbers for the workspace — cheap, no workbook written. */
const getSummary = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    await ensureTable(ctx.Model);
    const rows = await ctx.Model.findAll({ raw: true });
    if (!rows.length) return res.json({ empty: true });

    const b = buildReceivables(rows);
    res.json({
      empty: false,
      orders: b.totals.orders,
      billed: b.totals.billed,
      collected: b.totals.collected,
      receivable: b.totals.receivable,
      periods: b.periods,
      entities: b.byEntity.map((e) => e.entity),
      splitShipments: b.totals.splitShipments,
      checks: b.checks,
      groups: b.GROUP_ORDER.filter((g) => b.byGroup[g].orders)
        .map((g) => ({ key: g, label: b.GROUP_LABEL[g], ...b.byGroup[g] })),
      receivableSplit: b.receivableSplit,
      worklists: [
        { key: 'noCollector', label: 'No collector', rows: b.exceptions.noCollector.length },
        { key: 'redFlag', label: 'Red flag', rows: b.exceptions.redFlag.length },
        { key: 'shortPaid', label: 'Short paid', rows: b.exceptions.shortPaid.length },
        { key: 'statusConflict', label: 'Status conflict', rows: b.exceptions.statusConflict.length },
        { key: 'taxedNowhere', label: 'Delivered, taxed nowhere', rows: b.exceptions.taxedNowhere.length },
        { key: 'noDeposit', label: 'No deposit date', rows: b.exceptions.noDeposit.length },
      ],
    });
  } catch (error) { next(error); }
};

/** Build the workbook and hand back a filename to download. */
const generateWorkbook = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    const { brand, Model } = ctx;
    await ensureTable(Model);
    const rows = await Model.findAll({ raw: true });
    if (!rows.length) return res.status(400).json({ error: 'Nothing uploaded yet' });

    const b = buildReceivables(rows);

    /* Rebuild the "what was read" table from what is actually stored, so the
       Basis sheet describes the data in hand rather than the last upload. */
    const perFile = new Map();
    for (const r of rows) {
      if (!r.filename) continue;
      let f = perFile.get(r.filename);
      if (!f) { f = { filename: r.filename, tabs: new Map(), skipped: [] }; perFile.set(r.filename, f); }
      const key = `${r.source_tab}|${r.source_kind}`;
      f.tabs.set(key, { tab: r.source_tab, kind: r.source_kind, headerRow: '', rows: (f.tabs.get(key)?.rows || 0) + 1 });
    }
    const files = [...perFile.values()].map((f) => ({ filename: f.filename, tabs: [...f.tabs.values()], skipped: [] }));

    const wb = buildWorkbook(b, {
      sourceLine: `${files.length} file(s) held by this agent`,
      entities: b.byEntity.map((e) => e.entity).filter((e) => !e.includes('+')),
      files,
    });

    await ensureDir();
    const filename = `Receivables Summary - ${brand.name} - ${b.periods.join(' to ') || 'all'}.xlsx`;
    XLSXStyle.writeFile(wb, path.join(OUTPUT_DIR, filename));

    res.json({
      success: true, filename,
      totals: b.totals, checks: b.checks,
      receivableSplit: b.receivableSplit,
      sheets: wb.SheetNames,
    });
  } catch (error) { console.error('Receivables workbook error:', error); next(error); }
};

const download = async (req, res, next) => {
  try {
    const file = path.join(OUTPUT_DIR, path.basename(req.params.filename));
    if (!await fs.pathExists(file)) return res.status(404).json({ error: 'File not found' });
    res.download(file);
  } catch (error) { next(error); }
};

/** A slice of the ledger, for the on-screen table. */
const getLedger = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    await ensureTable(ctx.Model);
    const rows = await ctx.Model.findAll({ raw: true });
    if (!rows.length) return res.json({ rows: [], total: 0 });

    const b = buildReceivables(rows);
    const { worklist, limit = 200, offset = 0 } = req.query;
    const source = worklist && b.exceptions[worklist] ? b.exceptions[worklist] : b.ledger;
    res.json({
      total: source.length,
      rows: source.slice(Number(offset), Number(offset) + Number(limit)),
    });
  } catch (error) { next(error); }
};

module.exports = { uploadFiles, listFiles, deleteFile, getSummary, generateWorkbook, download, getLedger, COLUMNS };
