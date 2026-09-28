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
const { buildReceivables, buildMonthlyStatements } = require('../../../services/processors/offdutyReceivablesLedger');
const { buildWorkbook, yearSummarySheet, WRITE_OPTS } = require('../../../services/processors/offdutyReceivablesWorkbook');
const AdmZip = require('adm-zip');

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

/* The rows a statement is cast from. A month is scoped by `period`, which is
   already the month each row belongs to IN THE RETURN. Scoping matters as much
   as the cut-off: an April statement built from a year's rows would call every
   later order "goods in transit at 30 April". */
function scope(rows, month) {
  if (!month) return { rows, asAt: undefined };
  const sel = rows.filter((r) => r.period === month);
  const [y, m] = month.split('-').map(Number);
  const pad2 = (n) => String(n).padStart(2, '0');
  const asAt = `${y}-${pad2(m)}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
  return { rows: sel, asAt, hasPayment: sel.some((r) => r.source_kind === 'PAYMENT') };
}

/** Header numbers for the workspace — cheap, no workbook written. */
const getSummary = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    await ensureTable(ctx.Model);
    const rows = await ctx.Model.findAll({ raw: true });
    if (!rows.length) return res.json({ empty: true });

    /* One statement per month is what the user files. `month` picks one; with
       no `month` the behaviour is unchanged, which is what a single-month
       upload wants. */
    const sc = scope(rows, req.query.month);
    if (req.query.month && !sc.rows.length) {
      return res.json({ empty: true, month: req.query.month, reason: 'no records for that month' });
    }
    const b = buildReceivables(sc.rows, req.query.asAt || sc.asAt);
    res.json({
      empty: false,
      month: req.query.month || null,
      /* every month held, so the page can offer one statement per month */
      months: buildMonthlyStatements(rows).map((s) => ({
        month: s.month, asAt: s.asAt, hasPayment: s.hasPayment, note: s.receivableNote,
        orders: s.result.totals.orders,
      })),
      spansMultipleMonths: b.spansMultipleMonths,
      /* Stated, never implied: a month with no payment reconciliation has no
         receivable, and a blank or a zero would read as "nothing is owed". */
      receivableNote: req.query.month && sc.hasPayment === false
        ? 'No payment reconciliation was produced for this month, so no receivable is reported. '
          + 'The sales, RTO and return figures are complete.'
        : null,
      /* The GST sales summary, in the shape the accountant's own working
         already uses. Shown first, because it is the figure they check. */
      gst: { blocks: b.gst.blocks.map(({ _raw, ...rest }) => rest), consolidated: b.gst.consolidated },
      /* The order-by-order bridge from the sales registers to the payment
         reconciliation. Every figure measured; none is a balancing item. */
      bridge: b.bridge,
      orders: b.totals.orders,
      billed: b.totals.billed,
      collected: b.totals.collected,
      /* The position at the cut-off — what an accountant books. Kept apart from
         stillShortToday, which is the collection list. */
      asAt: b.asAt,
      position: b.positionTotals,
      byPosition: b.POSITION_ORDER.map((k) => b.byPosition[k]).filter((p) => p.orders),
      limits: b.limits,
      stillShortToday: b.totals.stillShortToday,
      periods: b.periods,
      entities: b.byEntity.map((e) => e.entity),
      splitShipments: b.totals.splitShipments,
      checks: b.checks,
      groups: b.GROUP_ORDER.filter((g) => b.byGroup[g].orders)
        .map((g) => ({ key: g, label: b.GROUP_LABEL[g], ...b.byGroup[g] })),
      receivableSplit: b.receivableSplit,
      worklists: [
        /* Same captions as the schedules in the workbook, so a figure on screen
           and a figure in the file are never called two different things. */
        { key: 'receivable', label: 'Trade receivables',
          rows: b.ledger.filter((l) => l.owed > 0 || l.position === 'RECEIVABLE_UNPAID').length },
        { key: 'uncertain', label: 'Realisation unascertained',
          rows: b.ledger.filter((l) => l.uncertain > 0).length },
        { key: 'inTransit', label: 'Goods in transit',
          rows: b.ledger.filter((l) => l.position === 'IN_TRANSIT').length },
        { key: 'unsettled', label: 'Unsettled orders', rows: b.exceptions.unsettled.length },
        { key: 'noCollector', label: 'Channel not identified', rows: b.exceptions.noCollector.length },
        { key: 'redFlag', label: 'Flagged in payment reco', rows: b.exceptions.redFlag.length },
        { key: 'shortPaid', label: 'Part realisation', rows: b.exceptions.shortPaid.length },
        { key: 'statusConflict', label: 'Workbooks differ', rows: b.exceptions.statusConflict.length },
        { key: 'taxedNowhere', label: 'Not in GSTR-1', rows: b.exceptions.taxedNowhere.length },
        { key: 'noDeposit', label: 'Bank date not recorded', rows: b.exceptions.noDeposit.length },
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

    const month = req.body && req.body.month;
    const sc = scope(rows, month);
    if (month && !sc.rows.length) return res.status(400).json({ error: `Nothing held for ${month}` });
    const b = buildReceivables(sc.rows, (req.body && req.body.asAt) || sc.asAt);

    /* Rebuild the "what was read" table from what is actually stored, so the
       Basis sheet describes the data in hand rather than the last upload. */
    const perFile = new Map();
    for (const r of sc.rows) {
      if (!r.filename) continue;
      let f = perFile.get(r.filename);
      if (!f) { f = { filename: r.filename, tabs: new Map(), skipped: [] }; perFile.set(r.filename, f); }
      const key = `${r.source_tab}|${r.source_kind}`;
      f.tabs.set(key, { tab: r.source_tab, kind: r.source_kind, headerRow: '', rows: (f.tabs.get(key)?.rows || 0) + 1 });
    }
    const files = [...perFile.values()].map((f) => ({ filename: f.filename, tabs: [...f.tabs.values()], skipped: [] }));

    const wb = buildWorkbook(b, {
      sourceLine: `${files.length} file(s) held by this agent`,
      /* carried onto the face of the statement, not just the API response */
      receivableNote: month && sc.hasPayment === false
        ? 'No payment reconciliation was produced for this month, so no receivable is reported. '
          + 'The sales, RTO and return figures are complete.'
        : null,
      entities: b.byEntity.map((e) => e.entity).filter((e) => !e.includes('+')),
      files,
    });

    await ensureDir();
    const filename = `Statement of Trade Receivables - ${brand.name} - as on ${b.asAt}.xlsx`;
    /* the month's own name is in the file name via asAt, so a year of statements
       sorts correctly in a folder */
    XLSXStyle.writeFile(wb, path.join(OUTPUT_DIR, filename), WRITE_OPTS);

    res.json({
      success: true, filename,
      asAt: b.asAt,
      position: b.positionTotals,
      totals: b.totals, checks: b.checks,
      receivableSplit: b.receivableSplit,
      limits: b.limits,
      sheets: wb.SheetNames,
    });
  } catch (error) { console.error('Receivables workbook error:', error); next(error); }
};

/* Shared so a single statement and a bundled one are produced by exactly the
   same code — a bundle that differed from the file you get on its own would be
   the worst kind of bug to find later. */
function statementFor(rows, month, brandName, heldFiles) {
  const sc = scope(rows, month);
  const b = buildReceivables(sc.rows, sc.asAt);
  const perFile = new Map();
  for (const r of sc.rows) {
    if (!r.filename) continue;
    let f = perFile.get(r.filename);
    if (!f) { f = { filename: r.filename, tabs: new Map() }; perFile.set(r.filename, f); }
    const key = `${r.source_tab}|${r.source_kind}`;
    f.tabs.set(key, { tab: r.source_tab, kind: r.source_kind, headerRow: '',
                      rows: (f.tabs.get(key)?.rows || 0) + 1 });
  }
  const files = [...perFile.values()].map((f) => ({ filename: f.filename, tabs: [...f.tabs.values()], skipped: [] }));
  const wb = buildWorkbook(b, {
    sourceLine: `${files.length} record(s) for this period`,
    receivableNote: month && sc.hasPayment === false
      ? 'No payment reconciliation was produced for this month, so no receivable is reported. '
        + 'The sales, RTO and return figures are complete.'
      : null,
    entities: b.byEntity.map((e) => e.entity).filter((e) => !e.includes('+')),
    files,
  });
  return { b, wb, hasPayment: sc.hasPayment, asAt: b.asAt };
}

/**
 * Every month as its own statement, plus one consolidated, in a single zip.
 * This is how the year is filed: a statement per month to go with that month's
 * return, and the consolidation to see the year at once.
 */
const generateBundle = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    const { brand, Model } = ctx;
    await ensureTable(Model);
    const rows = await Model.findAll({ raw: true });
    if (!rows.length) return res.status(400).json({ error: 'Nothing uploaded yet' });

    const wanted = (req.body && Array.isArray(req.body.months) && req.body.months.length)
      ? req.body.months
      : [...new Set(rows.map((r) => r.period).filter(Boolean))].sort();

    await ensureDir();
    const zip = new AdmZip();
    const monthly = [];
    const made = [];

    for (const month of wanted) {
      const st = statementFor(rows, month, brand.name);
      const name = `${month}  Statement of Trade Receivables - ${brand.name}.xlsx`;
      zip.addFile(name, XLSXStyle.write(st.wb, { ...WRITE_OPTS, type: 'buffer' }));
      monthly.push({ month, asAt: st.asAt, hasPayment: st.hasPayment, result: st.b });
      made.push({ month, hasPayment: st.hasPayment,
                  receivable: st.hasPayment ? st.b.positionTotals.receivable : null });
    }

    /* The consolidation, only when there is more than one month — for a single
       month it would restate the same figures under a second name. */
    if (monthly.length > 1) {
      const all = statementFor(rows, null, brand.name);
      const yws = yearSummarySheet(monthly, {
        periodLabel: `${wanted[0]} to ${wanted[wanted.length - 1]}`,
        entities: all.b.byEntity.map((e) => e.entity).filter((e) => !e.includes('+')),
      });
      /* the year sheet goes FIRST in the consolidated workbook */
      all.wb.SheetNames.unshift('Year Summary');
      all.wb.Sheets['Year Summary'] = yws;
      zip.addFile(`0  Consolidated - ${brand.name}.xlsx`,
                  XLSXStyle.write(all.wb, { ...WRITE_OPTS, type: 'buffer' }));
    }

    const filename = `${brand.name} - Receivables ${wanted[0]} to ${wanted[wanted.length - 1]}.zip`;
    await fs.writeFile(path.join(OUTPUT_DIR, filename), zip.toBuffer());
    res.json({ success: true, filename, months: made,
               consolidated: monthly.length > 1,
               statements: monthly.length + (monthly.length > 1 ? 1 : 0) });
  } catch (error) { console.error('Receivables bundle error:', error); next(error); }
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

    const sc2 = scope(rows, req.query.month);
    const b = buildReceivables(sc2.rows, req.query.asAt || sc2.asAt);
    const { worklist, limit = 200, offset = 0 } = req.query;
    /* The position lists are not in `exceptions` — they are the ledger sliced by
       where each order fell at the cut-off. */
    const POSITION_LISTS = {
      receivable: (l) => l.position === 'RECEIVABLE_LATE' || l.position === 'RECEIVABLE_UNPAID',
      uncertain:  (l) => l.uncertain > 0,
      inTransit:  (l) => l.position === 'IN_TRANSIT',
    };
    const source = POSITION_LISTS[worklist] ? b.ledger.filter(POSITION_LISTS[worklist])
                 : (worklist && b.exceptions[worklist]) ? b.exceptions[worklist]
                 : b.ledger;
    res.json({
      total: source.length,
      rows: source.slice(Number(offset), Number(offset) + Number(limit)),
    });
  } catch (error) { next(error); }
};

module.exports = { uploadFiles, listFiles, deleteFile, getSummary, generateWorkbook,
                   generateBundle, download, getLedger, COLUMNS };
