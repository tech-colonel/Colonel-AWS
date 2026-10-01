/* ──────────────────────────────────────────────────────────────────────────────
   Amazon Receivables — order report → MTR → settlement, in one place.

   This is deliberately NOT part of the Settlement-Amazon agent. That agent's job
   is one settlement: its fee split, its reconciliation to Amazon's stated payout.
   Useful, and far too deep to also answer "of everything we sold, what have we
   actually been paid for". That question needs the order report, which the
   settlement agent has no business holding.

   THE THREE SOURCES, AND HOW EACH ARRIVES

     order report   SP-API, on demand.  GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_
                    DATE_GENERAL sits under "Inventory and Order Tracking", which
                    IS granted, and is created with an explicit date range — so
                    unlike settlements it does not rot after 90 days. 30-day cap
                    per call, hence the half-month windows.

     MTR            UPLOAD ONLY. GET_GST_MTR_B2B_CUSTOM / B2C_CUSTOM need the
                    Tax Invoicing role, which is still under review. Until it is
                    granted the file has to come from Seller Central by hand.

     settlement     Either the ledgers the Settlement-Amazon agent already
                    retains, or Amazon's unified transaction report uploaded
                    here. The second matters: it is the ONLY way to recover a
                    month whose raw ledgers have aged past the 90-day window,
                    which is how June 2026 was rescued.

   A run is stored (see 038_amazon_threeway.sql) so opening the page is a read.
   ────────────────────────────────────────────────────────────────────────────── */

const path = require('path');
const fs = require('fs-extra');
const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const amazonReports = require('../../../services/amazonReports');
const { reconcile, monthKey } = require('../../../services/processors/amazonThreeWay');

const OUTPUT_DIR = path.join(__dirname, '../../../../outputs');
const UPLOAD_ROOT = path.join(OUTPUT_DIR, 'amazon-receivables');
const RUNS_TABLE = 'amazon_threeway_runs';

const safe = (s) => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_');
const brandDir = (brand, kind) => path.join(UPLOAD_ROOT, safe(brand.name), kind);

/* ── parsing ──────────────────────────────────────────────────────────────
   Amazon ships three different shapes and all three need the same treatment:
   find the header, split, trim. The unified transaction report buries its
   header under a dozen lines of prose, so it cannot be assumed to be line 1. */
function splitDelimited(text, delim) {
  const out = []; let field = ''; let row = []; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); out.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); out.push(row); }
  return out;
}

function parseTable(buffer, { delim = null, headerHint = null } = {}) {
  let text = buffer.toString('utf8').replace(/^﻿/, '');
  const d = delim || (text.slice(0, 4000).split('\t').length > text.slice(0, 4000).split(',').length ? '\t' : ',');
  const grid = splitDelimited(text, d).filter((r) => r.some((c) => String(c).trim()));
  if (!grid.length) return [];
  /* The header is the first row with enough columns AND the expected marker.
     Picking row 0 blindly reads Amazon's prose preamble as column names. */
  let hi = 0;
  for (let i = 0; i < Math.min(grid.length, 40); i++) {
    const joined = grid[i].join(' ').toLowerCase();
    if (grid[i].length >= 8 && (!headerHint || joined.includes(headerHint))) { hi = i; break; }
  }
  const hdr = grid[hi].map((h) => String(h).trim());
  return grid.slice(hi + 1).map((r) => {
    const o = {};
    hdr.forEach((h, i) => { o[h] = (r[i] === undefined ? '' : String(r[i]).trim()); });
    return o;
  });
}

async function readDir(dir, opts) {
  if (!await fs.pathExists(dir)) return { rows: [], files: [] };
  const files = (await fs.readdir(dir)).filter((f) => /\.(tsv|csv|txt)$/i.test(f)).sort();
  let rows = [];
  for (const f of files) {
    rows = rows.concat(parseTable(await fs.readFile(path.join(dir, f)), opts));
  }
  return { rows, files };
}

/* ── context ──────────────────────────────────────────────────────────── */
async function resolve(req, res) {
  const { brandId, agentId } = req.params;
  const brand = await Brand.findByPk(brandId);
  const agent = agentId ? await Agent.findByPk(agentId) : null;
  if (!brand) { res.status(404).json({ error: 'Brand not found' }); return null; }
  const db = getBrandConnection(brand.db_name);
  await db.query(`SET LOCAL app.brand_id = '${brand.id}'`).catch(() => {});
  return { brand, agent, db };
}

const q = (db, sql, replacements) => db.query(sql, { replacements });

/* ── the sources a run will read ──────────────────────────────────────── */
async function gather(ctx, months) {
  const orders = await readDir(brandDir(ctx.brand, 'orders'), { delim: '\t' });
  const mtr = await readDir(brandDir(ctx.brand, 'mtr'), { headerHint: 'order id' });
  const settlement = await readDir(brandDir(ctx.brand, 'settlement'), { headerHint: 'date/time' });

  /* Settlement months the brand already has as retained ledgers, via the
     Settlement-Amazon agent. Reusing them means a month only needs uploading
     when its ledgers are gone. */
  const ledgerDir = path.join(OUTPUT_DIR, 'amazon-ledgers', safe(ctx.brand.name));
  let ledgerRows = [];
  if (await fs.pathExists(ledgerDir)) {
    const { pivotSettlementRows } = require('../../../services/processors/amazonSettlementPivot');
    const seen = new Set();
    for (const f of (await fs.readdir(ledgerDir)).filter((x) => x.endsWith('.tsv')).sort()) {
      const rows = parseTable(await fs.readFile(path.join(ledgerDir, f)), { delim: '\t' });
      let piv;
      try { piv = pivotSettlementRows(rows); } catch { continue; }
      if (!piv.settlement || seen.has(piv.settlement.settlement_id)) continue;
      seen.add(piv.settlement.settlement_id);
      for (const r of piv.rows) {
        ledgerRows.push({ order_id: r.order_id, type: r.type,
                          date_time: r.date_time, product_sales: r.product_sales });
      }
    }
  }
  /* ── which source owns each month ───────────────────────────────────────
     An upload is made because a month's ledgers are gone or short, so the
     instinct is "uploaded wins". That is wrong at the edges, and wrongly in a
     way that destroys data: Amazon's unified report for June also carries 25
     spillover rows dated 1 July, and letting those 25 displace the 620 real
     July ledger rows would make July read as almost entirely unsettled.

     So the month goes to whichever source actually has more of it. The upload
     wins where it is genuinely more complete, and nowhere else. */
  const perMonth = (rows, get) => rows.reduce((a, r) => {
    const m = monthKey(get(r)); if (m) a[m] = (a[m] || 0) + 1; return a;
  }, {});
  const upCount = perMonth(settlement.rows, (r) => r['date/time'] || r.date_time);
  const ledCount = perMonth(ledgerRows, (r) => r.date_time);
  const uploadedMonths = Object.keys(upCount)
    .filter((m) => upCount[m] >= (ledCount[m] || 0)).sort();
  const owned = new Set(uploadedMonths);
  ledgerRows = ledgerRows.filter((r) => !owned.has(monthKey(r.date_time)));
  /* and drop upload rows for months the ledgers own, for the same reason */
  settlement.rows = settlement.rows
    .filter((r) => owned.has(monthKey(r['date/time'] || r.date_time)));

  return {
    orders: orders.rows, mtr: mtr.rows,
    settlement: settlement.rows.concat(ledgerRows),
    files: { orders: orders.files, mtr: mtr.files, settlement: settlement.files,
             ledgerMonths: [...new Set(ledgerRows.map((r) => monthKey(r.date_time)))].filter(Boolean).sort() },
    uploadedMonths: [...uploadedMonths].sort(),
  };
}

/* ── endpoints ────────────────────────────────────────────────────────── */

/** What sources are in hand, and what has been run. */
const getStatus = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    const src = await gather(ctx, null);
    const [runs] = await q(ctx.db,
      `SELECT window_months, order_rows, mtr_rows, settlement_rows, built_at, built_ms,
              payload->'totals' AS totals
         FROM ${RUNS_TABLE} WHERE brand_id = :b ORDER BY built_at DESC`,
      { b: ctx.brand.id }).catch(() => [[]]);
    res.json({
      brand: ctx.brand.name,
      sources: {
        orders: { files: src.files.orders.length, rows: src.orders.length },
        mtr: { files: src.files.mtr.length, rows: src.mtr.length },
        settlement: { files: src.files.settlement.length, rows: src.settlement.length,
                      uploadedMonths: src.uploadedMonths, fromLedgers: src.files.ledgerMonths },
      },
      runs: (runs || []).map((r) => ({
        months: r.window_months, builtAt: r.built_at, builtMs: r.built_ms,
        orderRows: r.order_rows, mtrRows: r.mtr_rows, settlementRows: r.settlement_rows,
        totals: r.totals,
      })),
    });
  } catch (e) { next(e); }
};

/** Upload MTR or settlement files. Order reports come from the API. */
const uploadSources = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    const kind = String(req.params.kind || '').toLowerCase();
    if (!['mtr', 'settlement', 'orders'].includes(kind)) {
      return res.status(400).json({ error: 'kind must be mtr, settlement or orders' });
    }
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files' });
    const dir = brandDir(ctx.brand, kind);
    await fs.ensureDir(dir);
    const saved = [];
    for (const f of req.files) {
      const name = f.originalname.replace(/[/\\]/g, '_');
      await fs.writeFile(path.join(dir, name), f.buffer);
      saved.push({ name, bytes: f.size, rows: parseTable(f.buffer).length });
    }
    res.json({ success: true, kind, saved });
  } catch (e) { next(e); }
};

/** Pull order reports from Amazon for a month range. */
const fetchOrders = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    const months = (req.body && req.body.months) || [];
    if (!months.length) return res.status(400).json({ error: 'months required, e.g. ["2026-06","2026-07"]' });

    const dir = brandDir(ctx.brand, 'orders');
    await fs.ensureDir(dir);
    const type = amazonReports.REPORT_TYPES.ORDERS_BY_ORDER_DATE.type;
    const done = [], failed = [];

    for (const m of months) {
      const [y, mo] = m.split('-').map(Number);
      const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      /* 30-day cap per report, so each month is two calls. */
      for (const [a, b] of [[1, 15], [16, last]]) {
        const from = `${m}-${String(a).padStart(2, '0')}`;
        const to = `${m}-${String(b).padStart(2, '0')}`;
        const out = path.join(dir, `orders_${from}_to_${to}.tsv`);
        if (await fs.pathExists(out) && (await fs.stat(out)).size > 1000) { done.push({ from, to, cached: true }); continue; }
        try {
          const c = await amazonReports.createReport(ctx.brand.id, type, {
            dataStartTime: `${from}T00:00:00Z`, dataEndTime: `${to}T23:59:59Z` });
          let ok = false;
          for (let i = 0; i < 30 && !ok; i++) {
            await new Promise((s) => setTimeout(s, 10000));
            const g = await amazonReports.getReport(ctx.brand.id, c.reportId);
            if (g.processingStatus === 'DONE') {
              const doc = await amazonReports.getReportDocument(ctx.brand.id, g.reportDocumentId);
              await amazonReports.downloadDocument(doc, out);
              done.push({ from, to, rows: parseTable(await fs.readFile(out), { delim: '\t' }).length });
              ok = true;
            } else if (['FATAL', 'CANCELLED'].includes(g.processingStatus)) {
              failed.push({ from, to, reason: g.processingStatus }); ok = true;
            }
          }
          if (!ok) failed.push({ from, to, reason: 'timed out waiting for Amazon' });
        } catch (e) { failed.push({ from, to, reason: e.message.slice(0, 120) }); }
      }
    }
    res.json({ success: true, fetched: done, failed });
  } catch (e) { next(e); }
};

/** Run the reconciliation and store it. */
const runReco = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    const months = (req.body && req.body.months) || [];
    if (!months.length) return res.status(400).json({ error: 'months required' });

    const t0 = Date.now();
    const src = await gather(ctx, months);
    if (!src.orders.length) {
      return res.status(400).json({ error: 'No order reports held. Fetch them from Amazon first.' });
    }
    const result = reconcile(src, months);
    const ms = Date.now() - t0;
    const fp = `${src.orders.length}|${src.mtr.length}|${src.settlement.length}`;

    await q(ctx.db,
      `INSERT INTO ${RUNS_TABLE}
         (brand_id, window_months, payload, order_rows, mtr_rows, settlement_rows,
          source_fingerprint, built_ms, built_by)
       VALUES (:b, :m, CAST(:p AS JSONB), :o, :mt, :s, :fp, :ms, :who)
       ON CONFLICT (brand_id, window_months)
       DO UPDATE SET payload = EXCLUDED.payload, order_rows = EXCLUDED.order_rows,
                     mtr_rows = EXCLUDED.mtr_rows, settlement_rows = EXCLUDED.settlement_rows,
                     source_fingerprint = EXCLUDED.source_fingerprint,
                     built_ms = EXCLUDED.built_ms, built_by = EXCLUDED.built_by,
                     built_at = NOW()`,
      { b: ctx.brand.id, m: months, p: JSON.stringify({ ...result, files: src.files }),
        o: src.orders.length, mt: src.mtr.length, s: src.settlement.length,
        fp, ms, who: (req.user && req.user.id) || null });

    res.json({ success: true, builtInMs: ms, ...result, files: src.files });
  } catch (e) { console.error('Amazon receivables run error:', e); next(e); }
};

/** Serve a stored run. Never builds. */
const getRun = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    const months = String(req.query.months || '').split(',').map((s) => s.trim()).filter(Boolean);
    const [rows] = await q(ctx.db,
      months.length
        ? `SELECT * FROM ${RUNS_TABLE} WHERE brand_id = :b AND window_months = :m LIMIT 1`
        : `SELECT * FROM ${RUNS_TABLE} WHERE brand_id = :b ORDER BY built_at DESC LIMIT 1`,
      months.length ? { b: ctx.brand.id, m: months } : { b: ctx.brand.id });
    if (!rows || !rows.length) return res.json({ empty: true });
    const r = rows[0];
    const src = await gather(ctx, r.window_months);
    const fp = `${src.orders.length}|${src.mtr.length}|${src.settlement.length}`;
    res.json({ ...r.payload, served: true, months: r.window_months,
               builtAt: r.built_at, builtInMs: r.built_ms,
               stale: fp !== r.source_fingerprint });
  } catch (e) { next(e); }
};

/** Remove a stored run. The source files stay. */
const deleteRun = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    const months = String(req.query.months || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!months.length) return res.status(400).json({ error: 'months required' });
    const [, meta] = await q(ctx.db,
      `DELETE FROM ${RUNS_TABLE} WHERE brand_id = :b AND window_months = :m`,
      { b: ctx.brand.id, m: months });
    res.json({ success: true, removed: (meta && meta.rowCount) || 0 });
  } catch (e) { next(e); }
};

module.exports = { getStatus, uploadSources, fetchOrders, runReco, getRun, deleteRun, parseTable };
