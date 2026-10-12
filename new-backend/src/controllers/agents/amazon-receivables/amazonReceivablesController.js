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
const { reconcile, monthKey, num } = require('../../../services/processors/amazonThreeWay');
const orderVsMtr = require('../../../services/processors/amazonOrderVsMtr');
const mtrVsSettlement = require('../../../services/processors/amazonMtrVsSettlement');
const feeInvoices = require('../../../services/processors/amazonFeeInvoices');
const feeInvoiceCache = require('../../../services/amazonFeeInvoiceCache');
const amazonBank = require('../../../services/processors/amazonBank');
const { buildLedger, BASIS } = require('../../../services/processors/amazonReceivablesLedger');
const { auditLedger, drillFor } = require('../../../services/processors/amazonReceivablesAudit');
const { buildWorkbook, buildDrillWorkbook } = require('../../../services/processors/amazonReceivablesWorkbook');

const OUTPUT_DIR = path.join(__dirname, '../../../../outputs');
const UPLOAD_ROOT = path.join(OUTPUT_DIR, 'amazon-receivables');
const RUNS_TABLE = 'amazon_threeway_runs';
const ROWS_TABLE = 'amazon_receivables_rows';

/* ── keeping the per-order detail OUT of the payload ──────────────────────
   Each leg carries one row per order, and for eighteen months that is 45.5 MB
   of a 46 MB payload: moneyMatch 14 MB, ledger 13 MB, invoicing 12 MB, the
   order chain 6.5 MB. Everything the screen actually draws - perMonth, totals,
   buckets, legs, cash - comes to about 90 kB. Asking for the whole history
   therefore built an object Node could not hold and the process died part way
   through, which is why 66 months returned nothing at all.

   The rows go to their own table and are fetched one drill at a time, the way
   receivables_summary already works. `counts` is left behind in the payload so
   the view still knows how many there are without holding any of them. */
const ROW_LEGS = [
  { leg: 'ledger',    at: ['ledger', 'rows'],     bucket: (r) => r.status || null },
  { leg: 'money',     at: ['moneyMatch', 'rows'], bucket: (r) => r.bucket || null },
  { leg: 'invoicing', at: ['invoicing', 'rows'],  bucket: (r) => r.bucket || null },
  { leg: 'chain',     at: ['three', 'orderRows'], bucket: () => null },
];

function detachRows(result, opts = {}) {
  const detached = [];
  const counts = {};
  for (const { leg, at, bucket } of ROW_LEGS) {
    const [k1, k2] = at;
    const host = result[k1];
    const rows = host && Array.isArray(host[k2]) ? host[k2] : null;
    if (!rows) { counts[leg] = 0; continue; }
    counts[leg] = rows.length;
    for (const r of rows) {
      detached.push({ leg, month: r.month || null, order_id: r.orderId || null,
                      bucket: bucket(r), data: r });
    }
    if (!opts.keepInPayload) host[k2] = [];   // the shape stays, the weight goes
    host.rowCount = rows.length;
  }
  return { detached, counts };
}

/* Written in chunks, like receivables_summary does - a single multi-row INSERT
   of a quarter of a million rows is its own memory problem. */
async function storeRows(db, runId, brandId, detached) {
  await q(db, `DELETE FROM ${ROWS_TABLE} WHERE run_id = :r`, { r: runId });
  const CHUNK = 1000;
  for (let i = 0; i < detached.length; i += CHUNK) {
    const slice = detached.slice(i, i + CHUNK);
    const vals = slice.map((_, j) =>
      `(:r, :b, :l${j}, :m${j}, :o${j}, :k${j}, CAST(:d${j} AS JSONB))`).join(',');
    const bind = { r: runId, b: brandId };
    slice.forEach((x, j) => {
      bind[`l${j}`] = x.leg; bind[`m${j}`] = x.month;
      bind[`o${j}`] = x.order_id; bind[`k${j}`] = x.bucket;
      bind[`d${j}`] = JSON.stringify(x.data);
    });
    await q(db, `INSERT INTO ${ROWS_TABLE} (run_id, brand_id, leg, month, order_id, bucket, data)
                 VALUES ${vals}`, bind);
  }
}

const r2 = (n) => Number((n || 0).toFixed(2));
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
  const rows = [];
  /* `rows = rows.concat(parsed)` rebuilt the whole accumulated array once per
     file - 107 copies for the MTR folder alone, each a full duplicate of
     everything read so far. Pushing in place is the identical result with none
     of that churn.

     COLUMNS ARE NOT DROPPED. Trimming each source to the fields a leg
     "obviously" used silently zeroed gstMemo and mis-stated returns, because
     the ledger also reads Total Tax Amount and the Cgst/Sgst/Igst columns.
     Every row is kept exactly as parsed, so no figure can move. */
  for (const f of files) {
    /* Which FILE a row came from is carried on the row itself. A refund for an
       order invoiced before this window can then be reported as "found in the
       July file", which is the only way to explain how a March-dated refund is
       sitting in a July report. */
    const parsed = parseTable(await fs.readFile(path.join(dir, f)), opts);
    for (const r of parsed) { r.__file = f; rows.push(r); }
  }
  return { rows, files };
}

/* ── cheap source stats ───────────────────────────────────────────────────
   The page's FIRST call used to run the full gather - parsing 435 MB of csv
   into a million objects - purely to print "N rows, N files". That is why the
   screen sat on "Loading Amazon receivables..." for minutes before drawing
   anything, and why serving an already-stored run was as slow as building one.

   Rows are counted by scanning the bytes for newlines. No objects are built, so
   it costs a read rather than a heap. The answer is cached against a
   fingerprint of every file's size and mtime, so the second call is free and a
   changed or added file still invalidates it. */
const statCache = new Map();

async function sourceStats(dir) {
  if (!await fs.pathExists(dir)) return { files: [], rows: 0 };
  const names = (await fs.readdir(dir)).filter((f) => /\.(tsv|csv|txt)$/i.test(f)).sort();
  const stats = [];
  for (const f of names) {
    const st = await fs.stat(path.join(dir, f));
    stats.push(`${f}:${st.size}:${+st.mtimeMs}`);
  }
  const fp = `${dir}|${stats.join('|')}`;
  const hit = statCache.get(dir);
  if (hit && hit.fp === fp) return hit.val;

  let rows = 0;
  for (const f of names) {
    const buf = await fs.readFile(path.join(dir, f));
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    /* a trailing newline means the last line is not a row; a header is not one either */
    rows += Math.max(0, n - (buf.length && buf[buf.length - 1] === 10 ? 1 : 0));
  }
  const val = { files: names, rows };
  statCache.set(dir, { fp, val });
  return val;
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

/* Sequelize expands an ARRAY replacement into a comma-separated list, so one
   placeholder becomes N expressions and Postgres rejects the statement with
   "INSERT has more expressions than target columns". A text[] has to be handed
   over as a literal and cast on the other side. */
const pgArray = (a) => `{${(a || []).map((x) => `"${String(x).replace(/"/g, '\\"')}"`).join(',')}}`;

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
        /* Carry the DEDUCTION columns too, not just the sale. Dropping them
           made Amazon's fees read as zero for every month sourced from the
           ledgers, which silently overstated what Amazon still owed. */
        ledgerRows.push({
          __src: 'ledger', __file: f,
          /* kept so a rescued row can be matched to the unified report one
             SETTLEMENT at a time, not one order at a time */
          settlement_id: r.settlement_id,
          order_id: r.order_id, type: r.type, date_time: r.date_time,
          product_sales: r.product_sales, total: r.total,
          selling_fees: r.selling_fees, fba_fees: r.fba_fees,
          other_transaction_fees: r.other_transaction_fees, other: r.other,
          tds_194o: r.tds_194o,
          'TCS-CGST': r.tcs_cgst, 'TCS-SGST': r.tcs_sgst, 'TCS-IGST': r.tcs_igst,
        });
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
  /* Each uploaded FILE is its own source, not one lumped 'upload'.
     Date Range Reports are requested by hand and overlap all the time: a
     Jun-1..Jul-1 report and an Apr-1..Sep-22 report both carry every June row.
     With a single blanket tag the de-duplication's "same row, other source"
     test can never fire between two uploads, so those months were counted
     twice. Keying on the filename makes a cross-file repeat a duplicate while
     a genuine repeated payment INSIDE one file — two identical rows for a
     2-unit order, which is real and was once wrongly discarded — still has a
     matching source and is kept. */
  for (const r of settlement.rows) r.__src = `upload:${r.__file || 'unknown'}`;
  const upCount = perMonth(settlement.rows, (r) => r['date/time'] || r.date_time);
  const ledCount = perMonth(ledgerRows, (r) => r.date_time);
  const uploadedMonths = Object.keys(upCount)
    .filter((m) => upCount[m] >= (ledCount[m] || 0)).sort();
  const owned = new Set(uploadedMonths);
  const upMonth = (r) => monthKey(r['date/time'] || r.date_time);
  const keptLedger = ledgerRows.filter((r) => !owned.has(monthKey(r.date_time)));
  /* and drop upload rows for months the ledgers own, for the same reason */
  const keptUpload = settlement.rows.filter((r) => owned.has(upMonth(r)));

  /* ── the orders the winning source never had ────────────────────────────
     Awarding a whole month to one source is right for the bulk of it, but it
     is ALL OR NOTHING, and that silently loses orders the winner does not
     carry at all. Measured on Koparo: 430 orders worth Rs 2,22,620.89 read as
     never paid, because the unified transaction report that owned their month
     simply has no row for them while the week-wise ledger that does was
     discarded along with the rest of its month. 351 of those were a single
     cohort - everything sold 19-31 Mar 2025, paid 5-13 Apr 2025.

     So after the month is awarded, the loser's rows are offered back ONE
     ORDER AT A TIME, and only for an order the winner has no row for ANYWHERE
     in the period. An order the winner already knows about is never topped up
     from the other source, so this can only ever find money that was missing
     - it cannot count a rupee twice. */
  const oidOf = (r) => String(r.order_id || r['order id'] || r['order-id'] || '').trim();
  const sidOf = (r) => String(r.settlement_id || r['settlement id'] || r['settlement-id'] || '').trim();
  /* Keyed on the ORDER AND THE SETTLEMENT, not the order alone.
     Order-alone was too coarse and left a whole class of order wrong. Take
     407-8446439-0439526: the unified report carries its REFUND (settlement
     24593865142, -3,820.67) but not the SALE that preceded it (settlement
     24580979332, +3,820.67) - the sale posted 3 Apr 2025 and the unified
     report for that year simply does not have those rows. Because the order
     DID appear in the unified report, the order-level gate treated it as
     covered and never offered the missing half back. The ledger was then left
     holding a refund with no sale, which reads as Amazon owing us 3,799.50 on
     an order that nets to nothing. All ten of FY24-25's remaining "unpaid"
     orders were this, worth 8,177.60.

     A settlement is the unit Amazon actually pays in, and both sources name
     it, so the pair is exact: a settlement the unified report already has is
     never taken twice, and one it is missing is always recovered. */
  const pair = (r) => `${oidOf(r)}|${sidOf(r)}`;
  const covered = new Set();
  for (const r of keptUpload) { if (oidOf(r)) covered.add(pair(r)); }
  for (const r of keptLedger) { if (oidOf(r)) covered.add(pair(r)); }

  /* An order can be sitting in BOTH discarded piles - a dropped ledger month
     and a dropped upload month. Taking it from each would be the very double
     count this is meant to avoid, so the candidates are grouped by order and
     exactly ONE source is taken for each, the ledgers first because they are
     the per-settlement record Amazon paid against. */
  const byOrder = new Map();                 // "order|settlement" -> { ledger: [], upload: [] }
  const slot = (k) => { if (!byOrder.has(k)) byOrder.set(k, { ledger: [], upload: [] }); return byOrder.get(k); };
  for (const r of ledgerRows) {
    if (!owned.has(monthKey(r.date_time))) continue;        // already kept
    const k = pair(r); if (!oidOf(r) || covered.has(k)) continue;
    slot(k).ledger.push({ ...r, __src: 'ledger-rescued' });
  }
  for (const r of settlement.rows) {
    if (owned.has(upMonth(r))) continue;                     // already kept
    const k = pair(r); if (!oidOf(r) || covered.has(k)) continue;
    slot(k).upload.push({ ...r, __src: 'upload-rescued' });
  }
  const rescued = [];
  for (const { ledger, upload } of byOrder.values()) {
    for (const r of (ledger.length ? ledger : upload)) rescued.push(r);
  }
  settlement.rows = keptUpload;
  ledgerRows = keptLedger;

  return {
    orders: orders.rows, mtr: mtr.rows,
    settlement: settlement.rows.concat(ledgerRows).concat(rescued),
    rescuedOrders: new Set(rescued.map(oidOf)).size,
    rescuedRows: rescued.length,
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
    const [o, m, st] = await Promise.all([
      sourceStats(brandDir(ctx.brand, 'orders')),
      sourceStats(brandDir(ctx.brand, 'mtr')),
      sourceStats(brandDir(ctx.brand, 'settlement')),
    ]);
    const [runs] = await q(ctx.db,
      `SELECT window_months, order_rows, mtr_rows, settlement_rows, built_at, built_ms,
              payload->'totals' AS totals, payload->>'basis' AS basis
         FROM ${RUNS_TABLE} WHERE brand_id = :b ORDER BY built_at DESC`,
      { b: ctx.brand.id }).catch(() => [[]]);
    res.json({
      brand: ctx.brand.name,
      sources: {
        orders: { files: o.files.length, rows: o.rows },
        mtr: { files: m.files.length, rows: m.rows },
        settlement: { files: st.files.length, rows: st.rows },
      },
      runs: (runs || []).map((r) => ({
        months: r.window_months, builtAt: r.built_at, builtMs: r.built_ms,
        orderRows: r.order_rows, mtrRows: r.mtr_rows, settlementRows: r.settlement_rows,
        totals: r.totals, basis: r.basis || null,
      })),
    });
  } catch (e) { next(e); }
};

/** Upload MTR or settlement files. Order reports come from the API. */
const uploadSources = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    const kind = String(req.params.kind || '').toLowerCase();
    if (!['mtr', 'settlement', 'orders', 'invoices'].includes(kind)) {
      return res.status(400).json({ error: 'kind must be mtr, settlement, orders or invoices' });
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

    /* WHICH DATE BOOKS THE SALE. Companies differ and all three answers are
       defensible, so this is asked before processing rather than assumed.
       DELIVERY is refused outright: none of Amazon's three files carries a
       delivery date, and quietly falling back to another date would give a
       wrong answer under a right-sounding label. */
    const basis = String((req.body && req.body.basis) || BASIS.DISPATCH).toLowerCase();
    if (basis === BASIS.DELIVERY) {
      return res.status(400).json({
        error: 'Delivery date is not available in any of the three Amazon files. '
             + 'Load the Fulfilled Shipments report to use this basis.' });
    }
    if (![BASIS.ORDER, BASIS.DISPATCH].includes(basis)) {
      return res.status(400).json({ error: `basis must be "${BASIS.ORDER}" or "${BASIS.DISPATCH}"` });
    }

    const t0 = Date.now();
    const src = await gather(ctx, months);
    if (!src.orders.length) {
      return res.status(400).json({ error: 'No order reports held. Fetch them from Amazon first.' });
    }
    /* All three views from one read of the sources: the CHAIN (how the three
       files relate), the LEDGER (the money, by cohort), and the AUDIT (what is
       wrong and what would fix it). The page shows all three because showing
       only the money would hide which file each figure came from. */
    const three = reconcile(src, months, { basis });
    const ledger = buildLedger(src, months, { basis });

    /* ── what the OTHER basis would have said ──────────────────────────────
       Choosing order date over dispatch date is a policy decision the brand
       makes once, and until now the screen only said which one was used — never
       what it cost. On this data a single month moves by up to Rs 29,000 while
       the 17-month total moves by Rs 4,283, because the basis shifts orders
       across month boundaries rather than creating or destroying sales. That is
       exactly the thing an accountant needs to see to defend the choice, and to
       explain why one month looks different from last year's workpaper.
       The ledger builds in well under a second, so the other basis is computed
       alongside rather than making the user generate a second report. */
    const otherBasis = basis === BASIS.ORDER ? BASIS.DISPATCH : BASIS.ORDER;
    let basisCompare = null;
    try {
      const alt = buildLedger(src, months, { basis: otherBasis });
      const byMonth = new Map(alt.perMonth.map((x) => [x.month, x]));
      const amt = (v) => (v && typeof v === 'object' ? (v.amount || 0) : (v || 0));
      basisCompare = {
        basis, otherBasis,
        months: ledger.perMonth.map((x) => {
          const o = byMonth.get(x.month);
          const mine = amt(x.expected), theirs = o ? amt(o.expected) : 0;
          return {
            month: x.month,
            thisBasis: r2(mine), otherBasisAmt: r2(theirs), diff: r2(mine - theirs),
            invoicedThis: r2(amt(x.invoiced)),
            invoicedOther: o ? r2(amt(o.invoiced)) : 0,
          };
        }),
      };
      basisCompare.totalThis = r2(basisCompare.months.reduce((a, x) => a + x.thisBasis, 0));
      basisCompare.totalOther = r2(basisCompare.months.reduce((a, x) => a + x.otherBasisAmt, 0));
      basisCompare.totalDiff = r2(basisCompare.totalThis - basisCompare.totalOther);
      basisCompare.biggestMove = basisCompare.months
        .slice().sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))[0] || null;
    } catch (e) {
      /* a comparison is a convenience; never fail the report for it */
      basisCompare = null;
    }

    /* Order report vs MTR — why the two files differ, and by how much. Needs
       no settlement leg, so it survives a brand with no settlement data. */
    let invoicing = null;
    try { invoicing = orderVsMtr.build(src, months, { basis }); }
    catch (e) { invoicing = null; }

    /* MTR vs settlement — the tax invoice against the money, and the coverage
       the margin depends on: net sales is built on every invoiced order while
       Amazon's charges are known only for the ones the settlement has reached.
       Wrapped like the one above so a brand with no settlement files still
       gets the rest of the report rather than a 500. */
    let moneyMatch = null;
    try { moneyMatch = mtrVsSettlement.build(src, months, { basis }); }
    catch (e) { moneyMatch = null; }

    const sourceKind = {};
    for (const m of months) sourceKind[m] = src.uploadedMonths.includes(m) ? 'unified' : 'ledger';

    /* Fee invoices vs the settlement. The PDFs are an OPTIONAL leg - a brand
       that has not uploaded any still gets the settlement side and a page that
       says so, which is why the parse failing is swallowed the same way the
       two legs above are. */
    let fees = null;
    try {
      const parsed = await feeInvoiceCache.load(brandDir(ctx.brand, 'invoices'));
      fees = feeInvoices.build(src, months, { invoices: feeInvoiceCache.slim(parsed.months), sourceKind });
      fees.source = { documents: parsed.documents, parsedAt: parsed.parsedAt,
                      fromCache: parsed.fromCache, error: parsed.error };
    } catch (e) { fees = null; }

    /* Bank — when the money actually arrived. Built per month: the question is
       asked of a statement period, and only the settlement ledgers carry a
       deposit date, so a month whose ledgers are missing says so rather than
       guessing.

       TWO sources, most-trusted first. `amazon-ledgers` holds files Amazon
       itself produced, via the Settlement-Amazon agent; `amazon-ledgers-api`
       holds ones rebuilt from the SP-API Finances endpoints, which is the only
       way to reach a settlement older than 90 days - the Reports API refuses
       them outright. Kept in separate directories ON PURPOSE: the rebuilt set
       feeds the bank view only and must not change the numbers every other tab
       already reports from `gather()`. */
    let bank = null;
    try {
      bank = amazonBank.buildAll(src, months, {
        ledgerDir: [
          path.join(OUTPUT_DIR, 'amazon-ledgers', safe(ctx.brand.name)),
          path.join(OUTPUT_DIR, 'amazon-ledgers-api', safe(ctx.brand.name)),
        ],
        perMonth: ledger.perMonth,
      });
    } catch (e) { bank = null; }

    const audit = auditLedger(ledger, { sources: sourceKind,
                                        priorPeriodRefunds: ledger.priorPeriodRefunds });
    const drills = {};
    for (const i of audit.issues) if (i.drill) drills[i.id] = drillFor(ledger, i).slice(0, 400);

    /* what each file contributed per month, so all three are visible */
    const perSource = months.map((m) => {
      const o = src.orders.filter((r) => monthKey(r['purchase-date']) === m);
      const t = src.mtr.filter((r) => String(r['Transaction Type'] || '').trim() === 'Shipment'
        && monthKey(r['Invoice Date'] || r['Shipment Date']) === m);
      const st = src.settlement.filter((r) => monthKey(r.date_time ?? r['date/time']) === m);
      /* The three files spell the same field differently — the settlement is
         `order id` when uploaded and `order_id` once pivoted — so a lookup by
         one name silently returns nothing. Take the first key that is present. */
      const uniq = (rows, ...keys) => new Set(
        rows.map((r) => keys.map((k) => r[k]).find((v) => v !== undefined && v !== '')).filter(Boolean)
      ).size;
      return { month: m,
        order: { rows: o.length, orders: uniq(o, 'amazon-order-id'),
                 value: r2(o.filter((r) => r['order-status'] !== 'Cancelled')
                   .reduce((a, r) => a + num(r['item-price']) + num(r['item-tax']), 0)) },
        mtr: { rows: t.length, orders: uniq(t, 'Order Id', 'order_id'),
               value: r2(t.reduce((a, r) => a + num(r['Invoice Amount']), 0)) },
        settlement: { rows: st.length, orders: uniq(st, 'order_id', 'order id', 'order-id'),
                      value: r2(st.reduce((a, r) => a + num(r.product_sales ?? r['product sales']), 0)) } };
    });

    /* WHICH SOURCES A MONTH ACTUALLY HAS. Koparo's history does not start level:
       Amazon's GST Monthly Reports only offer 2022 onward, so FY21-22 has no MTR
       at all however hard anyone looks. Saying that plainly beats a tab that
       silently reads zero and leaves the accountant wondering whether the sales
       collapsed or the file is missing. */
    const coverage = {
      perMonth: perSource.map((p) => ({
        month: p.month,
        orders: p.order.rows > 0,
        mtr: p.mtr.rows > 0,
        settlement: p.settlement.rows > 0,
      })),
    };
    coverage.noMtr = coverage.perMonth.filter((m) => !m.mtr).map((m) => m.month);
    coverage.noOrders = coverage.perMonth.filter((m) => !m.orders).map((m) => m.month);
    coverage.noSettlement = coverage.perMonth.filter((m) => !m.settlement).map((m) => m.month);
    coverage.notices = [];
    if (coverage.noMtr.length) {
      /* every month missing MTR sits before Apr-2022 => it is the known gap, not a
         file somebody forgot to upload */
      const allEarly = coverage.noMtr.every((m) => m < '2022-04');
      coverage.notices.push({
        kind: 'mtr-missing',
        months: coverage.noMtr,
        title: coverage.noMtr.length === 1
          ? `No MTR for ${coverage.noMtr[0]}`
          : `No MTR for ${coverage.noMtr.length} of the months selected`,
        detail: allEarly
          ? 'Amazon\'s GST Monthly Reports only go back to 2022, so the merchant tax report cannot be '
            + 'obtained for these months at all. Everything else is here: the order reports and the '
            + 'settlement record both cover this period, so sales, payouts and the bank position are '
            + 'unaffected. Only the invoice-level GST detail is unavailable.'
          : 'The merchant tax report has not been loaded for these months. Orders and settlement are '
            + 'unaffected; only the invoice-level GST comparison is blank until the MTR is added.',
      });
    }

    /* ── a month whose ORDER report is short ────────────────────────────────
       Not missing - present, well formed, and simply holding fewer orders than
       Amazon invoiced. May 2023 is the case: the file covers 1-31 May and
       carries 331 orders against 2,145 in the MTR, and re-requesting it from
       both the API and Seller Central returns the same short file. Without
       saying so, the Order Cycle reads as though trading collapsed that month,
       and "invoiced with no order row" reads as a fault in the reconciliation
       rather than a gap in Amazon's own export. */
    /* The newest months always look short: the MTR has invoiced them but the
       order report and settlement are still catching up. Hold off TWO months
       so a month that is merely recent is never reported as a gap - Sep 2026
       tripped this on the first run. */
    const settledBy = new Date(Date.now() - 62 * 864e5).toISOString().slice(0, 7);
    const shortOrders = (invoicing && invoicing.rows ? invoicing.rows : [])
      .reduce((a, r) => {
        if (!r.month) return a;
        a[r.month] = a[r.month] || { only: 0, matched: 0 };
        if (r.bucket === 'mtrOnly') a[r.month].only += 1;
        else if (r.bucket === 'matched') a[r.month].matched += 1;
        return a;
      }, {});
    coverage.shortOrderReport = Object.entries(shortOrders)
      /* a quarter of the month's invoices with no order behind them is far
         past anything a period edge explains */
      .filter(([m, v]) => v.only > 50 && v.only > (v.matched + v.only) * 0.25 && m <= settledBy)
      .map(([m]) => m).sort();

    if (coverage.shortOrderReport.length) {
      coverage.notices.push({
        kind: 'orders-short',
        months: coverage.shortOrderReport,
        title: coverage.shortOrderReport.length === 1
          ? `Amazon's order report is short for ${coverage.shortOrderReport[0]}`
          : `Amazon's order report is short for ${coverage.shortOrderReport.length} months`,
        detail: 'The file is present and covers the whole month, but Amazon returns far fewer orders '
          + 'in it than it invoiced in the MTR, and requesting it again - through the API or Seller '
          + 'Central - returns the same short file. So "orders placed" understates the month and the '
          + 'invoices with no order behind them are Amazon\'s gap, not ours. The money is unaffected: '
          + 'the receivable is built from the MTR and the settlement, neither of which needs the '
          + 'order report.',
      });
    }

    /* ── fee invoices only start in April 2023 ──────────────────────────────
       Before that Amazon charged fees but we hold no tax invoice for them, so
       the Fee invoices tab shows the settlement side against a nil invoice
       side. That is an absence of documents, not a discrepancy to chase. */
    const feeMonths = (fees && fees.rows ? fees.rows : []).filter((m) => (m.documents || 0) > 0);
    const earliestFeeInvoice = feeMonths.length
      ? feeMonths.map((m) => m.month).sort()[0] : null;
    coverage.noFeeInvoices = earliestFeeInvoice
      ? months.filter((m) => m < earliestFeeInvoice) : [];

    if (coverage.noFeeInvoices.length) {
      coverage.notices.push({
        kind: 'no-fee-invoices',
        months: coverage.noFeeInvoices,
        title: `No fee invoices before ${earliestFeeInvoice}`,
        detail: 'Amazon\'s tax invoices for its own fees are only held from '
          + `${earliestFeeInvoice} onwards. For earlier months the settlement still shows every `
          + 'rupee Amazon charged, but there is no invoice to set against it, so the Fee invoices '
          + 'tab compares a real settlement side with a nil invoice side.',
      });
    }
    /* kept so anything still reading a single notice keeps working */
    [coverage.notice] = coverage.notices;


    const result = { three, ledger, audit, drills, sources: perSource, sourceKind, basis,
                     basisCompare, invoicing, moneyMatch, fees, bank, coverage };
    const ms = Date.now() - t0;
    /* Must match how getRun recomputes it - from sourceStats, not from the
       parsed arrays, or every stored run reads as stale the moment it opens. */
    const [fo, fm, fs_] = await Promise.all([
      sourceStats(brandDir(ctx.brand, 'orders')),
      sourceStats(brandDir(ctx.brand, 'mtr')),
      sourceStats(brandDir(ctx.brand, 'settlement')),
    ]);
    const fp = `${fo.rows}|${fm.rows}|${fs_.rows}`;

    /* Lift the per-order rows out before anything is stored or sent. `result`
       is mutated in place, so what goes to the table and what goes down the
       wire are the same slim object - they cannot drift apart. */
    /* Rows go to Postgres and LEAVE the payload.

       The earlier attempt at this split the fetch by TAB and failed, because
       the Cash Cycle walk sits on the Receivables tab but sums the invoicing
       leg - that one tab wanted ledger + chain + invoicing, about 366 MB over
       54 months. The split that works is not by tab, it is by WINDOW: the
       report is built over every month there is, but the screen only ever
       shows MAX_VIEW_MONTHS of it at a time, and only those months' rows are
       sent. Eighteen months of all four legs is about 37 MB - the size the
       18-month report has always been, and has always handled.

       So the payload is summaries only, roughly 3 MB whatever the window, and
       the 256 MB jsonb ceiling stops being reachable. */
    const { detached, counts } = detachRows(result, { keepInPayload: false });
    result.rowCounts = counts;

    const [ins] = await q(ctx.db,
      `INSERT INTO ${RUNS_TABLE}
         (brand_id, window_months, payload, order_rows, mtr_rows, settlement_rows,
          source_fingerprint, built_ms, built_by)
       VALUES (:b, CAST(:m AS text[]), CAST(:p AS JSONB), :o, :mt, :s, :fp, :ms, :who)
       ON CONFLICT (brand_id, window_months)
       DO UPDATE SET payload = EXCLUDED.payload, order_rows = EXCLUDED.order_rows,
                     mtr_rows = EXCLUDED.mtr_rows, settlement_rows = EXCLUDED.settlement_rows,
                     source_fingerprint = EXCLUDED.source_fingerprint,
                     built_ms = EXCLUDED.built_ms, built_by = EXCLUDED.built_by,
                     built_at = NOW()
       RETURNING id`,
      { b: ctx.brand.id, m: pgArray(months), p: JSON.stringify({ ...result, files: src.files }),
        o: src.orders.length, mt: src.mtr.length, s: src.settlement.length,
        fp, ms, who: (req.user && req.user.id) || null });

    const runId = ins && ins[0] && ins[0].id;
    if (runId) {
      try { await storeRows(ctx.db, runId, ctx.brand.id, detached); }
      catch (e) {
        /* The summaries are already safe. Losing the detail costs drill-downs,
           not numbers, so the run is still served rather than failed. */
        console.error('Amazon receivables: could not store per-order rows:', e.message);
        result.rowsStoreError = e.message;
      }
    }

    res.json({ success: true, builtInMs: ms, runId, ...result, files: src.files });
  } catch (e) { console.error('Amazon receivables run error:', e); next(e); }
};

/**
 * The per-order detail for ONE drill, fetched when it is clicked.
 *
 * This is the other half of keeping rows out of the payload: the view holds the
 * summaries and asks for detail only for the leg, months and bucket in front of
 * the user. `months` is required in practice - without it a 66-month run would
 * hand back a quarter of a million rows and we would be back where we started.
 */
const getRunRows = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    const leg = String(req.query.leg || '').trim();
    if (!['ledger', 'money', 'invoicing', 'chain'].includes(leg)) {
      return res.status(400).json({ error: 'leg must be ledger, money, invoicing or chain' });
    }
    const months = String(req.query.months || '').split(',').map((x) => x.trim()).filter(Boolean);
    const bucket = String(req.query.bucket || '').trim();
    /* A drill wants a page; a TAB wants the whole leg for the months on screen.
       all=1 lifts the cap, which is safe because it is one leg of one window -
       the thing that could not be sent was all four legs of every month. */
    const all    = String(req.query.all || '') === '1';
    const limit  = all ? 1000000 : Math.min(Number(req.query.limit) || 500, 5000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    /* Which run: the exact window if given, else the newest for this brand. */
    const win = String(req.query.window || '').split(',').map((x) => x.trim()).filter(Boolean);
    const [runs] = await q(ctx.db,
      win.length
        ? `SELECT id FROM ${RUNS_TABLE} WHERE brand_id = :b AND window_months = CAST(:w AS text[]) LIMIT 1`
        : `SELECT id FROM ${RUNS_TABLE} WHERE brand_id = :b ORDER BY built_at DESC LIMIT 1`,
      win.length ? { b: ctx.brand.id, w: pgArray(win) } : { b: ctx.brand.id });
    if (!runs || !runs.length) return res.json({ rows: [], total: 0, empty: true });
    const runId = runs[0].id;

    const where = ['run_id = :r', 'leg = :l'];
    const bind = { r: runId, l: leg, lim: limit, off: offset };
    if (months.length) { where.push('month = ANY(CAST(:m AS text[]))'); bind.m = pgArray(months); }
    if (bucket)        { where.push('bucket = :k'); bind.k = bucket; }
    const w = where.join(' AND ');

    const [cnt] = await q(ctx.db, `SELECT count(*)::int AS n FROM ${ROWS_TABLE} WHERE ${w}`, bind);
    const [rows] = await q(ctx.db,
      `SELECT data FROM ${ROWS_TABLE} WHERE ${w} ORDER BY id LIMIT :lim OFFSET :off`, bind);

    res.json({ rows: (rows || []).map((x) => x.data), total: (cnt && cnt[0] && cnt[0].n) || 0,
               leg, months, bucket: bucket || null, limit, offset });
  } catch (e) { next(e); }
};

/* ── the rows for the months on screen ───────────────────────────────────
   The report is built over every month there is; the screen shows a window of
   it. This hands back all four legs for that window and nothing else, so the
   browser holds the same ~37 MB it always held for eighteen months, whether
   the run behind it covers eighteen months or sixty-six.

   The panels are not touched. They still sum the arrays themselves, with the
   same code and the same rounding they have always used - which is the point.
   Aggregating in SQL would have been faster and would have risked the last
   paisa; this cannot, because nothing about the arithmetic moved. */
const MAX_VIEW_MONTHS = 18;

/* The money leg cannot be sliced by month alone. `mmAgg` keeps a row when the
   INVOICE is in the window or when any SETTLEMENT against it landed in the
   window - that second case is the whole `settlementOnly` bucket, an invoice
   from before the window paid inside it. Filtering on `month` (the MTR month)
   drops exactly those. Measured on the 54-month run, Apr 2025 - Sep 2026:
   20,582 by month, 20,648 once grossBy is included - and 20,648 is precisely
   what the standalone 18-month build produced. */
/* Written as a UNION of two index-able halves rather than one OR. As a single
   `month = ANY(...) OR data->'grossBy' ?| ...` the planner can use neither
   index and falls back to a parallel seq scan of the whole table: 7,031 ms for
   this window. Split, with a GIN index on grossBy, it is 244 ms. */
const legSql = (leg) => (leg !== 'money'
  ? `SELECT data FROM ${ROWS_TABLE}
      WHERE run_id = :r AND leg = :l AND month = ANY(CAST(:m AS text[])) ORDER BY id`
  : `SELECT data FROM ${ROWS_TABLE} WHERE id IN (
       SELECT id FROM ${ROWS_TABLE}
        WHERE run_id = :r AND leg = :l AND month = ANY(CAST(:m AS text[]))
       UNION
       SELECT id FROM ${ROWS_TABLE}
        WHERE run_id = :r AND leg = :l AND data->'grossBy' ?| CAST(:m AS text[])
     ) ORDER BY id`);

const getWindowRows = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    const months = String(req.query.months || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!months.length) return res.status(400).json({ error: 'months is required' });
    if (months.length > MAX_VIEW_MONTHS) {
      return res.status(400).json({
        error: `A report can cover any number of months, but only ${MAX_VIEW_MONTHS} can be shown at once.`,
        maxViewMonths: MAX_VIEW_MONTHS, asked: months.length });
    }

    /* Which run: the exact window if given, else the newest for this brand. */
    const win = String(req.query.window || '').split(',').map((x) => x.trim()).filter(Boolean);
    const [runs] = await q(ctx.db,
      win.length
        ? `SELECT id, payload FROM ${RUNS_TABLE} WHERE brand_id = :b AND window_months = CAST(:w AS text[]) LIMIT 1`
        : `SELECT id, payload FROM ${RUNS_TABLE} WHERE brand_id = :b ORDER BY built_at DESC LIMIT 1`,
      win.length ? { b: ctx.brand.id, w: pgArray(win) } : { b: ctx.brand.id });
    if (!runs || !runs.length) return res.json({ empty: true });
    const runId = runs[0].id;

    const out = { runId, months, legs: {}, counts: {}, source: 'rows' };

    /* A report generated before this table existed still carries its rows in
       its own payload. Slice those rather than tell the reader it is empty. */
    const [any] = await q(ctx.db, `SELECT 1 FROM ${ROWS_TABLE} WHERE run_id = :r LIMIT 1`, { r: runId });
    if (!any || !any.length) {
      const p = runs[0].payload || {};
      const sel = new Set(months);
      const keep = (rows) => (rows || []).filter((r) => !r.month || sel.has(r.month));
      out.source = 'payload';
      out.legs = {
        ledger: keep(p.ledger && p.ledger.rows),
        invoicing: keep(p.invoicing && p.invoicing.rows),
        chain: keep(p.three && p.three.orderRows),
        money: (p.moneyMatch && p.moneyMatch.rows || []).filter((r) =>
          (r.month && sel.has(r.month)) || Object.keys(r.grossBy || {}).some((cm) => sel.has(cm))),
      };
      for (const k of Object.keys(out.legs)) out.counts[k] = out.legs[k].length;
      return res.json(out);
    }

    for (const leg of ['ledger', 'invoicing', 'money', 'chain']) {
      const [rows] = await q(ctx.db, legSql(leg),
        { r: runId, l: leg, m: pgArray(months) });
      out.legs[leg] = (rows || []).map((x) => x.data);
      out.counts[leg] = out.legs[leg].length;
    }
    res.json(out);
  } catch (e) { console.error('Amazon receivables window rows error:', e); next(e); }
};

/** Serve a stored run. Never builds. */
const getRun = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    const months = String(req.query.months || '').split(',').map((s) => s.trim()).filter(Boolean);
    const [rows] = await q(ctx.db,
      months.length
        ? `SELECT * FROM ${RUNS_TABLE} WHERE brand_id = :b AND window_months = CAST(:m AS text[]) LIMIT 1`
        : `SELECT * FROM ${RUNS_TABLE} WHERE brand_id = :b ORDER BY built_at DESC LIMIT 1`,
      months.length ? { b: ctx.brand.id, m: pgArray(months) } : { b: ctx.brand.id });
    if (!rows || !rows.length) return res.json({ empty: true });
    const r = rows[0];
    /* Staleness used to be decided by re-running the whole gather - parsing
       435 MB to compare three numbers. The same three numbers come from the
       cheap stats, so opening a saved report no longer costs as much as
       rebuilding it. */
    const [o, m, st] = await Promise.all([
      sourceStats(brandDir(ctx.brand, 'orders')),
      sourceStats(brandDir(ctx.brand, 'mtr')),
      sourceStats(brandDir(ctx.brand, 'settlement')),
    ]);
    const fp = `${o.rows}|${m.rows}|${st.rows}`;
    res.json({ ...r.payload, served: true, months: r.window_months,
               builtAt: r.built_at, builtInMs: r.built_ms,
               stale: fp !== r.source_fingerprint });
  } catch (e) { next(e); }
};

/** The stored run as a formatted workbook.
 *
 * Built HERE rather than in the browser for one reason: the frontend's only
 * spreadsheet library is SheetJS's community build, which silently discards
 * every style it is given. The first version of this export went out as a grid
 * of unformatted numbers with no currency, no subtotals and not one live
 * formula — a data dump, and the one artefact that leaves this system and goes
 * to a client. ExcelJS is a backend dependency, so the workbook is built where
 * the library that can format it actually lives.
 */
const exportWorkbook = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    const asked = String(req.query.months || '').split(',').map((s) => s.trim()).filter(Boolean);
    const [stored] = await q(ctx.db,
      `SELECT payload, window_months FROM ${RUNS_TABLE}
        WHERE brand_id = :b ORDER BY built_at DESC LIMIT 1`, { b: ctx.brand.id });
    if (!stored || !stored.length) {
      return res.status(404).json({ error: 'No reconciliation has been run yet.' });
    }
    const all = stored[0].window_months || [];
    /* The caller may be looking at one month of a three-month run. Honour that,
       but never invent a month the run does not hold. */
    const months = asked.length ? all.filter((m) => asked.includes(m)) : all;
    if (!months.length) return res.status(400).json({ error: 'None of those months are in the stored run.' });

    const wb = buildWorkbook(stored[0].payload, { brand: ctx.brand.name, months });
    const name = `Amazon_Receivables_${ctx.brand.name.replace(/[^A-Za-z0-9]/g, '')}_`
               + `${months[0]}_to_${months[months.length - 1]}.xlsx`;
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { console.error('Amazon receivables export error:', e); next(e); }
};

/** One drilled group, formatted by the same hand as the full workbook.
 *  The page knows which rows sit behind a figure; only the backend can format
 *  them, so it sends the rows and gets the styled sheet back. */
const exportDrill = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    const b = req.body || {};
    const rows = Array.isArray(b.rows) ? b.rows.slice(0, 20000) : [];
    if (!Array.isArray(b.columns) || !b.columns.length) {
      return res.status(400).json({ error: 'columns required' });
    }
    const wb = buildDrillWorkbook({
      title: b.title, period: b.period, brand: ctx.brand.name,
      provenance: b.provenance || {}, columns: b.columns, rows,
    });
    const name = `${String(b.filename || 'amazon-receivables').replace(/[^A-Za-z0-9_-]/g, '_')}.xlsx`;
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { console.error('Amazon receivables drill export error:', e); next(e); }
};

/** Remove a stored run. The source files stay. */
const deleteRun = async (req, res, next) => {
  try {
    const ctx = await resolve(req, res); if (!ctx) return;
    const months = String(req.query.months || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!months.length) return res.status(400).json({ error: 'months required' });
    const [, meta] = await q(ctx.db,
      `DELETE FROM ${RUNS_TABLE} WHERE brand_id = :b AND window_months = CAST(:m AS text[])`,
      { b: ctx.brand.id, m: pgArray(months) });
    res.json({ success: true, removed: (meta && meta.rowCount) || 0 });
  } catch (e) { next(e); }
};

module.exports = { getStatus, uploadSources, fetchOrders, runReco, getRun, getRunRows,
                   getWindowRows, MAX_VIEW_MONTHS, deleteRun,
                   exportWorkbook, exportDrill, parseTable };
