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
const drive = require('../../../services/driveService');

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

/* Read one workbook and store its rows. Shared so a file uploaded from the
   desktop and one pulled from Drive go through exactly the same path. */
async function storeOneFile(Model, brand, originalname, buffer) {
  let parsed;
  try { parsed = parseReceivablesFile(buffer, originalname); }
  catch (e) { return { file: originalname, rows: 0, error: `could not read: ${e.message}` }; }
  if (!parsed.rows.length) {
    return { file: originalname, rows: 0, error: 'no order rows found', skipped: parsed.skipped };
  }
  const stamp = `${Date.now()}_${uuidv4().slice(0, 8)}`;
  const filename = `receivables_${brand.name.replace(/[^\w]+/g, '_')}_${stamp}.xlsx`;
  await ensureDir();
  await fs.writeFile(path.join(OUTPUT_DIR, filename), buffer);
  const rows = parsed.rows.map((r) => toRow(r, filename));
  for (let i = 0; i < rows.length; i += 2000) await Model.bulkCreate(rows.slice(i, i + 2000));
  return { file: originalname, filename, kind: parsed.kind, entity: parsed.entity,
           rows: parsed.rows.length, tabs: parsed.tabs, skipped: parsed.skipped };
}

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
/* Every month as its own statement, plus one consolidated, in a single zip.
 *
 * ONE MONTH AT A TIME. Loading the year and holding thirteen workbooks killed
 * the process — 1.55 million rows and every sheet alive at once. Each month is
 * now queried on its own, written straight to disk, added to the zip from that
 * file and dropped. Only a few numbers per month are carried forward, for the
 * consolidation.
 *
 * The consolidated statement carries the month-by-month table and the basis,
 * NOT a ledger of every order in the year — that would be a million-row sheet
 * nobody can open, and it is what the monthly statements are for.
 */
async function buildBundle(Model, brandName, wantedIn, onProgress) {
  const say = (stage, detail, done, total) =>
    onProgress && onProgress({ stage, detail, done, total });

  say('reading', 'finding the months held');
  const periods = await Model.findAll({
    attributes: [[Model.sequelize.fn('DISTINCT', Model.sequelize.col('period')), 'period']],
    raw: true,
  });
  const all = periods.map((p) => p.period).filter(Boolean).sort();
  const wanted = (wantedIn && wantedIn.length) ? wantedIn.filter((m) => all.includes(m)) : all;
  if (!wanted.length) throw new Error('Nothing held for those months');

  await ensureDir();
  const zip = new AdmZip();
  const monthly = [];
  const made = [];

  for (let i = 0; i < wanted.length; i++) {
    const month = wanted[i];
    say('month', `${month} — reading`, i, wanted.length);
    const rows = await Model.findAll({ where: { period: month }, raw: true });

    say('month', `${month} — building the statement`, i, wanted.length);
    const st = statementFor(rows, month, brandName);
    const name = `${month}  Statement of Trade Receivables - ${brandName}.xlsx`;
    const tmp = path.join(OUTPUT_DIR, `.bundle_${Date.now()}_${month}.xlsx`);
    XLSXStyle.writeFile(st.wb, tmp, WRITE_OPTS);
    zip.addLocalFile(tmp, '', name);
    await fs.remove(tmp);

    /* keep only what the consolidation needs — holding each month's full result
       is what ran the process out of memory */
    const gc = st.b.gst.consolidated || st.b.gst.blocks[0] || null;
    monthly.push({
      month, asAt: st.asAt, hasPayment: st.hasPayment,
      result: {
        gst: { consolidated: gc && { sales: gc.sales, rto: gc.rto, refund: gc.refund, net: gc.net },
               blocks: [] },
        positionTotals: st.b.positionTotals,
      },
    });
    made.push({ month, hasPayment: st.hasPayment,
                receivable: st.hasPayment ? st.b.positionTotals.receivable : null,
                inTransit: st.hasPayment ? st.b.positionTotals.inTransit : null });
    say('month', `${month} — done`, i + 1, wanted.length);
  }

  if (monthly.length > 1) {
    say('consolidating', 'building the consolidated statement', wanted.length, wanted.length);
    const ents = await Model.findAll({
      attributes: [[Model.sequelize.fn('DISTINCT', Model.sequelize.col('entity')), 'entity']], raw: true });
    const yws = yearSummarySheet(monthly, {
      periodLabel: `${wanted[0]} to ${wanted[wanted.length - 1]}`,
      entities: ents.map((e) => e.entity).filter((e) => e && !e.includes('+')).sort(),
    });
    const wb = XLSXStyle.utils.book_new();
    XLSXStyle.utils.book_append_sheet(wb, yws, 'Year Summary');
    const tmp = path.join(OUTPUT_DIR, `.bundle_${Date.now()}_consolidated.xlsx`);
    XLSXStyle.writeFile(wb, tmp, WRITE_OPTS);
    zip.addLocalFile(tmp, '', `0  Consolidated - ${brandName}.xlsx`);
    await fs.remove(tmp);
  }

  say('zipping', 'writing the zip');
  const filename = `${brandName} - Receivables ${wanted[0]} to ${wanted[wanted.length - 1]}.zip`;
  await fs.writeFile(path.join(OUTPUT_DIR, filename), zip.toBuffer());
  return { filename, months: made, consolidated: monthly.length > 1,
           statements: monthly.length + (monthly.length > 1 ? 1 : 0) };
}

const generateBundle = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    await ensureTable(ctx.Model);
    const out = await buildBundle(ctx.Model, ctx.brand.name, req.body && req.body.months, null);
    res.json({ success: true, ...out });
  } catch (error) { console.error('Receivables bundle error:', error); next(error); }
};

/* ── jobs ──────────────────────────────────────────────────────────────────
   A year is 46 files and a million and a half rows; the work outlives any
   request. A job runs in the background and the page polls it, so the person
   sees which month is being read rather than a spinner that might be dead.

   Held in memory on purpose: a job is only interesting while it runs, and the
   statements it produces are on disk and listed by the files endpoint. A
   restart loses the progress, not the work. */
const JOBS = new Map();
const JOB_TTL = 60 * 60 * 1000;

function newJob(label) {
  const id = uuidv4();
  const job = { id, label, state: 'running', startedAt: Date.now(),
                stage: 'starting', detail: '', done: 0, total: 0,
                log: [], result: null, error: null };
  JOBS.set(id, job);
  for (const [k, j] of JOBS) if (Date.now() - j.startedAt > JOB_TTL) JOBS.delete(k);
  return job;
}
const step = (job, stage, detail, done, total) => {
  if (!job) return;
  job.stage = stage; job.detail = detail || '';
  if (done !== undefined) job.done = done;
  if (total !== undefined) job.total = total;
  job.log.push({ at: Date.now(), stage, detail: job.detail });
  if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
};

const getJob = async (req, res) => {
  const j = JOBS.get(req.params.jobId);
  if (!j) return res.status(404).json({ error: 'No such job — it may have expired' });
  res.json({ id: j.id, label: j.label, state: j.state, stage: j.stage, detail: j.detail,
             done: j.done, total: j.total, result: j.result, error: j.error,
             seconds: Math.round((Date.now() - j.startedAt) / 1000),
             log: j.log.slice(-40) });
};

/**
 * Take a Google Drive folder, read every workbook in it, store them, then build
 * a statement for each month and one consolidated — reporting each stage.
 * Files are read and stored ONE AT A TIME so a year does not have to fit in
 * memory at once.
 */
const ingestDrive = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    const { brand, Model } = ctx;
    await ensureTable(Model);
    const folders = String((req.body && req.body.url) || '').split(/[\s,]+/).filter(Boolean);
    if (!folders.length) return res.status(400).json({ error: 'Give me a Drive folder link' });
    const replace = !!(req.body && req.body.replace);
    const buildAfter = (req.body && req.body.build) !== false;

    const job = newJob(`${brand.name} — ${folders.length} Drive folder(s)`);
    res.json({ jobId: job.id });          // the page starts polling from here

    (async () => {
      try {
        if (replace) {
          step(job, 'clearing', 'removing what was held before');
          await Model.destroy({ where: {} });
        }

        step(job, 'extracting', 'listing the Drive folder');
        const found = [];
        for (const f of folders) {
          const root = drive.parseFolderId(f);
          const walk = async (id, trail, depth) => {
            if (depth > 5) return;
            for (const ch of await drive.listChildren(id)) {
              if (ch.mimeType === drive.FOLDER_MIME) { await walk(ch.id, `${trail}${ch.name}/`, depth + 1); continue; }
              const sheet = ch.mimeType === 'application/vnd.google-apps.spreadsheet';
              if (!sheet && !/\.(xlsx|xls)$/i.test(ch.name)) continue;
              found.push({ id: ch.id, name: ch.name, sheet });
              step(job, 'extracting', `found ${found.length} workbooks`);
            }
          };
          await walk(root, '', 0);
        }
        if (!found.length) throw new Error('No workbooks in that folder');

        const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        let stored = 0;
        const readReport = [];
        for (let i = 0; i < found.length; i++) {
          const f = found[i];
          step(job, 'processing', `${f.name}`, i, found.length);
          let buf;
          try {
            buf = f.sheet ? await drive.exportFile(f.id, XLSX_MIME) : await drive.downloadFile(f.id);
          } catch (e) {
            readReport.push({ file: f.name, error: `could not download: ${e.message}` });
            continue;
          }
          const one = await storeOneFile(Model, brand, f.name, buf);
          stored += one.rows;
          readReport.push(one);
          step(job, 'processing', `${f.name} — ${one.rows.toLocaleString('en-IN')} lines`, i + 1, found.length);
          buf = null;                       // let it go before the next file
        }
        job.readReport = readReport;

        if (!buildAfter) {
          job.result = { stored, files: readReport };
          job.state = 'done'; step(job, 'done', `${stored.toLocaleString('en-IN')} lines stored`);
          return;
        }

        const out = await buildBundle(Model, brand.name, null,
          (p) => step(job, p.stage, p.detail, p.done, p.total));
        job.result = { stored, files: readReport, ...out };
        job.state = 'done';
        step(job, 'done', `${out.statements} statements`, out.months.length, out.months.length);
      } catch (e) {
        job.state = 'failed'; job.error = e.message;
        step(job, 'failed', e.message);
        console.error('Receivables ingest failed:', e);
      }
    })();
  } catch (error) { next(error); }
};

/** Build the bundle in the background, reporting progress. */
const bundleJob = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    await ensureTable(ctx.Model);
    const job = newJob(`${ctx.brand.name} — statements`);
    res.json({ jobId: job.id });
    (async () => {
      try {
        const out = await buildBundle(ctx.Model, ctx.brand.name, req.body && req.body.months,
          (p) => step(job, p.stage, p.detail, p.done, p.total));
        job.result = out; job.state = 'done';
        step(job, 'done', `${out.statements} statements`, out.months.length, out.months.length);
      } catch (e) { job.state = 'failed'; job.error = e.message; step(job, 'failed', e.message); }
    })();
  } catch (error) { next(error); }
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
                   generateBundle, buildBundle, ingestDrive, bundleJob, getJob,
                   download, getLedger, COLUMNS };
