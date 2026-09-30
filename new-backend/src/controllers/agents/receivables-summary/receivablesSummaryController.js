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
const { buildOverview, decorateLimits, slim, label } = require('../../../services/processors/offdutyReceivablesOverview');
const AdmZip = require('adm-zip');
const drive = require('../../../services/driveService');

const OUTPUT_DIR = path.join(__dirname, '../../../../outputs');
const ensureDir = () => fs.ensureDir(OUTPUT_DIR);

/* Every column the parser can emit. Kept in one place so the seed script and
   the controller cannot drift apart. */
const COLUMNS = [
  { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },
  { name: 'filename', type: 'STRING' },
  /* the name it arrived under, so a record can be recognised and removed —
     see db-restructure/034_receivables_source_file.sql */
  { name: 'source_file', type: 'STRING' },
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

  /* The agent row carries a copy of the column list, taken when it was seeded.
     A column added to COLUMNS afterwards is therefore unknown to the model, and
     Sequelize drops an unknown field on insert WITHOUT ERROR — `source_file`
     was written on every one of 1.55 million rows and landed as NULL on all of
     them. The code's list is the authority; the stored one is a cache, so
     anything the code knows and the cache does not is added back. */
  const stored = (agent.columns && agent.columns.length) ? agent.columns : [];
  const known = new Set(stored.map((c) => c.name));
  const cols = stored.length
    ? [...stored, ...COLUMNS.filter((c) => !known.has(c.name))]
    : COLUMNS;

  const Model = getDynamicModel(brandDb, tableName, cols);
  return { brand, agent, Model };
}

/* THE ORDER ROWS ARE READ IN IS PART OF THE ANSWER.
   Two folds in the ledger take "the first row that states it" — a payment
   order's delivered_date among them — and 38,391 orders carry more than one
   delivery date across their payment rows. Postgres returns rows in heap
   order, which is not stable, so the same table read twice put different
   delivery dates on those orders and moved goods-in-transit by a few thousand
   rupees between runs. An accountant who runs a statement twice and gets two
   answers cannot use either.

   Ordering on the SOURCE — the file, the tab, then the order — makes the
   statement a function of the records and nothing else. `id` breaks any
   remaining tie so the sort is total. COALESCE keeps rows read before
   source_file existed working, falling back to the stored name. */
const READ_ORDER = [
  [require('sequelize').literal('COALESCE(source_file, filename)'), 'ASC'],
  ['source_tab', 'ASC'],
  ['order_id', 'ASC'],
  ['id', 'ASC'],
];

/* Keep only the columns the table has, so a parser change cannot throw. */
const toRow = (r, filename, sourceFile) => {
  const out = { filename, source_file: sourceFile || null };
  for (const f of FIELDS) {
    if (f === 'filename' || f === 'source_file') continue;
    out[f] = r[f] === undefined ? null : r[f];
  }
  return out;
};

/* Read one workbook and store its rows. Shared so a file uploaded from the
   desktop and one pulled from Drive go through exactly the same path. */
async function storeOneFile(Model, brand, originalname, buffer, window) {
  let parsed;
  try { parsed = parseReceivablesFile(buffer, originalname); }
  catch (e) { return { file: originalname, rows: 0, error: `could not read: ${e.message}` }; }
  if (!parsed.rows.length) {
    return { file: originalname, rows: 0, error: 'no order rows found', skipped: parsed.skipped };
  }

  /* Keep only the months asked for. The client's Drive folder holds May 2024
     through June 2026 — seventy-four workbooks where the year wanted is
     thirty-six — so without this the agent reads two years it was never asked
     for and every total on the page covers the wrong period. Rows are dropped
     here rather than at the folder, because the month a row belongs to is
     decided by its CONTENTS, not by the folder it sat in. */
  let kept = parsed.rows;
  let dropped = 0;
  if (window && (window.from || window.to)) {
    kept = parsed.rows.filter((r) => {
      if (!r.period) return true;                 // undated rows are never silently lost
      if (window.from && r.period < window.from) return false;
      if (window.to && r.period > window.to) return false;
      return true;
    });
    dropped = parsed.rows.length - kept.length;
  }
  if (!kept.length) {
    return { file: originalname, rows: 0, droppedOutsideWindow: dropped,
             error: `every row falls outside ${window.from} to ${window.to}`,
             skipped: parsed.skipped };
  }

  const stamp = `${Date.now()}_${uuidv4().slice(0, 8)}`;
  const filename = `receivables_${brand.name.replace(/[^\w]+/g, '_')}_${stamp}.xlsx`;
  await ensureDir();
  await fs.writeFile(path.join(OUTPUT_DIR, filename), buffer);
  const rows = kept.map((r) => toRow(r, filename, originalname));
  for (let i = 0; i < rows.length; i += 2000) await Model.bulkCreate(rows.slice(i, i + 2000));
  return { file: originalname, filename, kind: parsed.kind, entity: parsed.entity,
           rows: kept.length, droppedOutsideWindow: dropped,
           tabs: parsed.tabs, skipped: parsed.skipped };
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

    invalidateOverview(ctx.brand.id);
    res.json({ success: true, stored, files: report });
  } catch (error) { console.error('Receivables upload error:', error); next(error); }
};

const listFiles = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    await ensureTable(ctx.Model);
    /* Grouped in the database. Pulling a million and a half rows into Node to
       count them held the whole page up before a single figure was drawn. */
    const [rows] = await ctx.Model.sequelize.query(
      `SELECT filename,
              count(*)::int                                   AS rows,
              array_agg(DISTINCT source_kind)                 AS kinds,
              array_remove(array_agg(DISTINCT entity), NULL)  AS entities,
              array_remove(array_agg(DISTINCT period), NULL)  AS periods,
              min(created_at)                                 AS "uploadedAt"
         FROM receivables_summary
        WHERE filename IS NOT NULL
        GROUP BY filename
        ORDER BY min(created_at) DESC`);
    res.json({
      files: rows.map((f) => ({ ...f,
        kinds: (f.kinds || []).filter(Boolean),
        entities: f.entities || [],
        periods: (f.periods || []).slice().sort() })),
    });
  } catch (error) { next(error); }
};

/**
 * Clear everything held, so the next run starts from nothing.
 *
 * Irreversible, and the reason it exists: without it a fresh run means
 * deleting forty-six records one at a time. It removes the RECORDS and the
 * cached year only. Statements already built and downloaded are left where
 * they are — they are the output of a run that did happen, and this brand is
 * not the only one whose files live in that folder.
 */
const resetAll = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    await ensureTable(ctx.Model);
    const [[before]] = await ctx.Model.sequelize.query(
      'SELECT count(*)::int AS n, count(DISTINCT filename)::int AS f FROM receivables_summary');
    const removed = await ctx.Model.destroy({ where: {} });
    /* A new run means the records AND the statements built from them go — that
       is what the button says. Adding or removing ONE file does not: there the
       statements stay and are marked stale, so nobody loses work they have
       already produced. */
    await clearStatements(ctx.Model, ctx.brand.id);
    res.json({ success: true, removedRows: removed, heldRows: before.n, heldFiles: before.f });
  } catch (error) { console.error('Receivables reset error:', error); next(error); }
};

const deleteFile = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    const { filename } = req.params;
    const removed = await ctx.Model.destroy({ where: { filename } });
    await fs.remove(path.join(OUTPUT_DIR, filename)).catch(() => {});
    invalidateOverview(ctx.brand.id);
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

/** The months held, and whether each was reconciled. One pass, no statements. */
function monthList(rows) {
  const pad2 = (n) => String(n).padStart(2, '0');
  const m = new Map();
  for (const r of rows) {
    if (!r.period) continue;
    let e = m.get(r.period);
    if (!e) { e = { month: r.period, orders: 0, hasPayment: false, hasShopify: false }; m.set(r.period, e); }
    /* The Shopify export is a coverage check held alongside, not a source of
       the statement — counting its rows here would inflate the month's size on
       the picker by a third. */
    if (r.source_kind === 'SHOPIFY') { e.hasShopify = true; continue; }
    e.orders += 1;
    if (r.source_kind === 'PAYMENT') e.hasPayment = true;
  }
  return [...m.values()].sort((a, b) => a.month.localeCompare(b.month)).map((e) => {
    const [y, mo] = e.month.split('-').map(Number);
    return { ...e,
      asAt: `${y}-${pad2(mo)}-${pad2(new Date(Date.UTC(y, mo, 0)).getUTCDate())}`,
      note: e.hasPayment ? null
        : 'No payment reconciliation was produced for this month, so no receivable is reported. '
        + 'The sales, RTO and return figures are complete.' };
  });
}

/* ── BUILT STATEMENTS ARE ARTIFACTS, NOT A CACHE ──────────────────────────
   Opening this agent used to REBUILD the year from the raw rows — 1.3 million
   of them, twelve statements, twenty to sixty seconds and about a gigabyte of
   heap on the shared backend, every time the cache missed. It missed often: it
   lived in a file under outputs/ and its key included the mtimes of the
   processor files, so every deploy threw it away and the next person to open
   the page paid for it, competing with every other agent for the same node
   process.

   The Order Cycle agent already solved this — compute once, write the result to
   the brand database, and afterwards opening a saved output is a read. Same
   shape here: the FINISHED statement is stored in receivables_statements, the
   page reads it, and a build only happens when somebody asks for one.

   Staleness is known without recomputing, by comparing the fingerprint of the
   records now against the fingerprint they had when the statement was built.
   Different means the records moved — the page says so and offers a rebuild,
   rather than either serving a stale figure silently or silently spending a
   minute making a new one. */

const STATEMENTS_TABLE = 'receivables_statements';

/* Count and newest row of the records — asked of the database, never by
   reading a million rows into memory. */
const fingerprint = async (Model) => {
  const [[k]] = await Model.sequelize.query(
    'SELECT count(*)::text AS n, coalesce(max(created_at)::text, \'-\') AS t FROM receivables_summary');
  return { rows: Number(k.n), fp: `${k.n}|${k.t}` };
};

/* The built statement as the page renders it. scope 'YEAR' has no period. */
async function readStatement(Model, brandId, scope, period = null) {
  const [rows] = await Model.sequelize.query(
    `SELECT payload, source_rows, source_fingerprint, built_ms, built_at
       FROM ${STATEMENTS_TABLE}
      WHERE brand_id = :b AND scope = :s AND COALESCE(period,'') = COALESCE(:p,'')
      LIMIT 1`,
    { replacements: { b: brandId, s: scope, p: period } });
  return rows[0] || null;
}

async function writeStatement(Model, brandId, scope, period, payload, fp, rowCount, ms, userId) {
  await Model.sequelize.query(
    `INSERT INTO ${STATEMENTS_TABLE}
       (brand_id, scope, period, payload, source_rows, source_fingerprint, built_ms, built_by)
     VALUES (:b, :s, :p, CAST(:payload AS JSONB), :rows, :fp, :ms, :who)
     ON CONFLICT (brand_id, scope, COALESCE(period, ''))
     DO UPDATE SET payload = EXCLUDED.payload,
                   source_rows = EXCLUDED.source_rows,
                   source_fingerprint = EXCLUDED.source_fingerprint,
                   built_ms = EXCLUDED.built_ms,
                   built_by = EXCLUDED.built_by,
                   built_at = NOW()`,
    { replacements: { b: brandId, s: scope, p: period, payload: JSON.stringify(payload),
                      rows: rowCount, fp, ms, who: userId || null } });
}

/* Build the year AND every month, and store all of them.
 *
 * ONE MONTH AT A TIME. Reading the whole table and holding twelve full results
 * alive is what cost a gigabyte and took the backend down mid-build — the same
 * fault the zip builder already avoids. Each month is queried on its own, built,
 * REDUCED to the totals the year needs (slim), stored, and dropped. Only the
 * slim months survive the loop, and they are small.
 */
async function buildAndStore(ctx, userId, onProgress) {
  const say = (stage, detail, done, total) => onProgress && onProgress(stage, detail, done, total);
  const { rows: rowCount, fp } = await fingerprint(ctx.Model);
  if (!rowCount) return { empty: true };

  const t0 = Date.now();

  /* the month list and the file count, without reading a single order row */
  const [meta] = await ctx.Model.sequelize.query(
    `SELECT period, count(*)::int AS n,
            bool_or(source_kind = 'PAYMENT') AS has_payment
       FROM receivables_summary WHERE period IS NOT NULL
      GROUP BY period ORDER BY period`);
  const [[fileRow]] = await ctx.Model.sequelize.query(
    'SELECT count(DISTINCT filename)::int AS f FROM receivables_summary');

  const months = monthList(
    await ctx.Model.findAll({ attributes: ['period', 'source_kind'], raw: true }));
  const pad2 = (n) => String(n).padStart(2, '0');
  const endOf = (p) => { const [y, m] = p.split('-').map(Number);
                         return `${y}-${pad2(m)}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };

  const slimStatements = [];
  for (let i = 0; i < meta.length; i++) {
    const period = meta[i].period;
    say('month', `${period} — building the statement`, i, meta.length);

    let rows = await ctx.Model.findAll({ where: { period }, raw: true, order: READ_ORDER });
    const asAt = endOf(period);
    const hasPayment = rows.some((r) => r.source_kind === 'PAYMENT');
    const result = buildReceivables(rows, asAt);

    /* store the month exactly as the page will render it */
    await writeStatement(ctx.Model, ctx.brand.id, 'MONTH', period,
      summaryPayload(result, period, asAt, hasPayment, months),
      fp, result.totals.orders, null, userId);

    /* keep only what the year reads, then let the month go */
    slimStatements.push({
      month: period, asAt, hasPayment,
      receivableNote: hasPayment ? null
        : 'No payment reconciliation was produced for this month, so no receivable is reported. '
        + 'The sales, RTO and return figures below are complete.',
      result: slim(result),
    });
    rows = null;
    say('month', `${period} — stored`, i + 1, meta.length);
  }

  say('consolidating', 'building the year from the months');
  const overview = buildOverview(slimStatements, {
    empty: false,
    brand: ctx.brand.name,
    rows: rowCount,
    files: fileRow.f,
    builtInMs: 0,
  });
  overview.builtInMs = Date.now() - t0;

  await writeStatement(ctx.Model, ctx.brand.id, 'YEAR', null, overview, fp, rowCount,
                       overview.builtInMs, userId);

  return { built: true, months: slimStatements.length, ms: overview.builtInMs, rows: rowCount };
}

const clearStatements = async (Model, brandId) => {
  await Model.sequelize.query(`DELETE FROM ${STATEMENTS_TABLE} WHERE brand_id = :b`,
                              { replacements: { b: brandId } });
};

/* Records changed, so the built statements no longer describe what is held.
   They are LEFT IN PLACE and marked stale by the fingerprint comparison — an
   accountant who has already produced a statement should not lose it because
   a file was added. */
const invalidateOverview = () => {};

/**
 * The reports that have been produced, newest first — the list the agent opens
 * on. Reads the statements table only: no payload, no order rows, so this is a
 * few rows of metadata however large the year is.
 */
const listStatements = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    await ensureTable(ctx.Model);
    const { rows: heldRows, fp } = await fingerprint(ctx.Model);

    const [rows] = await ctx.Model.sequelize.query(
      `SELECT scope, period, source_rows, source_fingerprint, built_ms, built_at,
              length(payload::text) AS bytes
         FROM ${STATEMENTS_TABLE}
        WHERE brand_id = :b
        ORDER BY CASE scope WHEN 'YEAR' THEN 0 ELSE 1 END, period`,
      { replacements: { b: ctx.brand.id } });

    res.json({
      heldRows,
      brand: ctx.brand.name,
      reports: rows.map((r) => ({
        scope: r.scope,
        period: r.period,
        label: r.scope === 'YEAR' ? 'The year' : label(r.period),
        orders: Number(r.source_rows) || 0,
        builtAt: r.built_at,
        builtMs: r.built_ms,
        bytes: Number(r.bytes) || 0,
        /* built from records that are no longer what is held */
        stale: r.source_fingerprint !== fp,
      })),
    });
  } catch (error) { next(error); }
};

/** Remove one produced report. The records it was built from are untouched. */
const deleteStatement = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    const { scope } = req.params;
    const period = req.params.period || null;
    const [, meta] = await ctx.Model.sequelize.query(
      `DELETE FROM ${STATEMENTS_TABLE}
        WHERE brand_id = :b AND scope = :s AND COALESCE(period,'') = COALESCE(:p,'')`,
      { replacements: { b: ctx.brand.id, s: scope, p: period } });
    res.json({ success: true, removed: (meta && meta.rowCount) || 0 });
  } catch (error) { next(error); }
};

/**
 * The whole year on one screen — SERVED, never built. If no statement has been
 * built yet, or the records have moved since it was, that is said plainly and
 * the page offers a build instead of starting one.
 */
const getOverview = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    await ensureTable(ctx.Model);

    const { rows: rowCount, fp } = await fingerprint(ctx.Model);
    if (!rowCount) return res.json({ empty: true });

    const saved = await readStatement(ctx.Model, ctx.brand.id, 'YEAR');
    if (!saved) {
      return res.json({ empty: false, needsBuild: true, stale: false,
                        heldRows: rowCount,
                        reason: 'No statement has been built for these records yet.' });
    }
    const stale = saved.source_fingerprint !== fp;
    res.json({
      ...saved.payload,
      served: true,
      stale,
      builtAt: saved.built_at,
      builtInMs: saved.built_ms,
      builtFromRows: saved.source_rows,
      heldRows: rowCount,
      ...(stale ? { reason: `Built from ${Number(saved.source_rows).toLocaleString('en-IN')} lines; `
                          + `${rowCount.toLocaleString('en-IN')} are held now.` } : {}),
    });
  } catch (error) { console.error('Receivables overview error:', error); next(error); }
};

/** Build the year and every month, and store them. The only path that computes. */
const buildStatements = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    await ensureTable(ctx.Model);
    const job = newJob(`${ctx.brand.name} — building the year`);
    res.json({ jobId: job.id });

    (async () => {
      try {
        step(job, 'month', 'reading the records held');
        const out = await buildAndStore(ctx, req.user && req.user.id,
          (stage, detail, done, total) => step(job, stage, detail, done, total));
        job.result = out;
        job.state = 'done';
        step(job, 'done', out.empty ? 'nothing held'
          : `${out.months} months built in ${Math.round(out.ms / 1000)}s`);
      } catch (e) {
        job.state = 'failed'; job.error = e.message;
        step(job, 'failed', e.message);
        console.error('Receivables build failed:', e);
      }
    })();
  } catch (error) { next(error); }
};

/* One month's statement, in the shape the page renders. Extracted so that a
   month STORED by buildAndStore and a month built live are the same object by
   construction — two code paths producing "the same" statement is how they
   drift. */
function summaryPayload(b, month, asAt, hasPayment, months) {
    return {
      empty: false,
      month: month || null,
      /* Every month held, so the page can offer one statement per month. One
         pass over the rows — this used to build a full statement per month just
         to draw a row of buttons, which is a year of work for a month picker. */
      months,
      spansMultipleMonths: b.spansMultipleMonths,
      /* Stated, never implied: a month with no payment reconciliation has no
         receivable, and a blank or a zero would read as "nothing is owed". */
      receivableNote: month && hasPayment === false
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
      limits: decorateLimits(b.limits),
      stillShortToday: b.totals.stillShortToday,
      periods: b.periods,
      entities: b.byEntity.map((e) => e.entity),
      /* registration by registration, so the month has the same side-by-side
         table the year has — one row per GST registration instead of per month */
      byEntity: b.byEntity,
      gstBlocks: b.gst.blocks.map(({ _raw, ...rest }) => rest),
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
    };
}

/**
 * One month — SERVED from the stored statement when there is one, and only
 * built live when there is not. Building a month live still costs seconds and
 * holds the rows in memory; the store exists so that opening a month the user
 * has already produced costs a read.
 */
const getSummary = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    await ensureTable(ctx.Model);
    const month = req.query.month || null;

    const { rows: rowCount, fp } = await fingerprint(ctx.Model);
    if (!rowCount) return res.json({ empty: true, month });

    /* stored first — this is the whole point */
    if (month && !req.query.refresh) {
      const saved = await readStatement(ctx.Model, ctx.brand.id, 'MONTH', month);
      if (saved) {
        return res.json({ ...saved.payload, served: true,
                          stale: saved.source_fingerprint !== fp,
                          builtAt: saved.built_at });
      }
    }

    /* No month means the whole year in one position, which is a million and a
       half lines in heap and the thing that used to take the backend down. The
       year is served by /overview from the store; there is no reason to build
       it here and every reason not to. */
    if (!month) {
      return res.status(400).json({
        error: 'Ask for a month. The year is served by the overview.',
        hint: 'GET …/receivables-summary/overview',
      });
    }

    /* nothing stored for this month: build just this one, which is bounded */
    const rows = await ctx.Model.findAll({ where: { period: month }, raw: true, order: READ_ORDER });
    if (!rows.length) return res.json({ empty: true, month });

    const sc = scope(rows, month);
    if (month && !sc.rows.length) {
      return res.json({ empty: true, month, reason: 'no records for that month' });
    }
    const b = buildReceivables(sc.rows, req.query.asAt || sc.asAt);
    const months = monthList(await ctx.Model.findAll({ attributes: ['period', 'source_kind'], raw: true }));
    res.json({ ...summaryPayload(b, month, sc.asAt, sc.hasPayment, months), served: false });
  } catch (error) { next(error); }
};

/** Build the workbook and hand back a filename to download. */
const generateWorkbook = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    const { brand, Model } = ctx;
    await ensureTable(Model);

    const month = req.body && req.body.month;
    /* One workbook for the whole year would mean holding the whole year. The
       bundle already produces every month plus a consolidated sheet, and it
       does it a month at a time. */
    if (!month) {
      return res.status(400).json({
        error: 'Name a month. A whole-year workbook is produced by the bundle, which builds it a month at a time.',
        hint: 'POST …/receivables-summary/bundle',
      });
    }

    const rows = await Model.findAll({ where: { period: month }, raw: true, order: READ_ORDER });
    if (!rows.length) return res.status(400).json({ error: `Nothing held for ${month}` });

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
    const rows = await Model.findAll({ where: { period: month }, raw: true, order: READ_ORDER });

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
    /* The months to keep, as YYYY-MM. Given, only those months are stored and
       the rest are counted and reported — never dropped in silence. */
    const window = (req.body && (req.body.from || req.body.to))
      ? { from: req.body.from || null, to: req.body.to || null } : null;

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
        let outside = 0;            // rows belonging to months not asked for
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
          const one = await storeOneFile(Model, brand, f.name, buf, window);
          stored += one.rows;
          outside += one.droppedOutsideWindow || 0;
          readReport.push(one);
          step(job, 'processing',
               `${f.name} — ${one.rows.toLocaleString('en-IN')} lines`
               + (one.droppedOutsideWindow
                   ? `, ${one.droppedOutsideWindow.toLocaleString('en-IN')} outside the period`
                   : ''),
               i + 1, found.length);
          buf = null;                       // let it go before the next file
        }
        job.readReport = readReport;
        job.outsideWindow = outside;
        invalidateOverview(brand.id);     // the year has changed

        if (!buildAfter) {
          job.result = { stored, outsideWindow: outside, files: readReport };
          job.state = 'done'; step(job, 'done', `${stored.toLocaleString('en-IN')} lines stored`);
          return;
        }

        const out = await buildBundle(Model, brand.name, null,
          (p) => step(job, p.stage, p.detail, p.done, p.total));
        job.result = { stored, outsideWindow: outside, files: readReport, ...out };
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

/* The position lists are not in `exceptions` — they are the ledger sliced by
   where each order fell at the cut-off. */
const POSITION_LISTS = {
  receivable: (l) => l.position === 'RECEIVABLE_LATE' || l.position === 'RECEIVABLE_UNPAID',
  uncertain:  (l) => l.uncertain > 0,
  inTransit:  (l) => l.position === 'IN_TRANSIT',
};

/** The rows behind one figure, for one month. */
function ledgerSlice(rows, month, asAt, worklist) {
  const sc = scope(rows, month);
  if (!sc.rows.length) return [];
  const b = buildReceivables(sc.rows, asAt || sc.asAt);
  if (POSITION_LISTS[worklist]) return b.ledger.filter(POSITION_LISTS[worklist]);
  if (worklist && b.exceptions[worklist]) return b.exceptions[worklist];
  return b.ledger;
}

/**
 * A slice of the ledger, for the on-screen table.
 *
 * Drilling into a figure used to read the entire table — every month, a million
 * and a half lines — to hand back two hundred rows. It is read a month at a
 * time now, so the cost of opening a schedule is one month regardless of how
 * many years are held.
 */
const getLedger = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    await ensureTable(ctx.Model);
    const { worklist, asAt, month } = req.query;
    const limit = Number(req.query.limit || 200);
    const offset = Number(req.query.offset || 0);

    if (month) {
      const rows = await ctx.Model.findAll({ where: { period: month }, raw: true, order: READ_ORDER });
      if (!rows.length) return res.json({ rows: [], total: 0 });
      const source = ledgerSlice(rows, month, asAt, worklist);
      return res.json({ total: source.length, rows: source.slice(offset, offset + limit) });
    }

    /* No month: walk the months in order and keep only the page being asked
       for. `total` still counts the year, but one month is ever in hand. */
    const periods = await ctx.Model.findAll({
      attributes: [[ctx.Model.sequelize.fn('DISTINCT', ctx.Model.sequelize.col('period')), 'period']],
      raw: true,
    });
    const months = periods.map((p) => p.period).filter(Boolean).sort();
    if (!months.length) return res.json({ rows: [], total: 0 });

    let total = 0;
    const page = [];
    for (const m of months) {
      const rows = await ctx.Model.findAll({ where: { period: m }, raw: true, order: READ_ORDER });
      const source = ledgerSlice(rows, m, asAt, worklist);
      /* where this month's rows sit in the year-long list */
      const from = Math.max(0, offset - total);
      if (page.length < limit && from < source.length) {
        page.push(...source.slice(from, from + (limit - page.length)));
      }
      total += source.length;
    }
    res.json({ total, rows: page });
  } catch (error) { next(error); }
};

module.exports = { uploadFiles, listFiles, deleteFile, resetAll, getSummary, getOverview, buildStatements, listStatements, deleteStatement, generateWorkbook,
                   generateBundle, buildBundle, ingestDrive, bundleJob, getJob,
                   download, getLedger, COLUMNS };
