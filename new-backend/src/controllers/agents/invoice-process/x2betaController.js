/**
 * x2betaController.js — export a brand's Invoice Process rows as the CA's X2Beta
 * (Tally purchase-import) workbook.
 *
 * Reads `invoice_process` through getBrandConnection so RLS scopes the rows to the
 * brand, hands them to the reco engine (`/api/x2beta/build`), and streams back the
 * xlsx with a brand-named, dated filename.
 *
 * Classification is NOT done here: `voucher_type` already arrives from n8n inverted
 * to our side (supplier Credit Note -> "Debit Note <State>"), and the engine reads
 * that prefix. One template serves every brand; only the GST ledger block varies,
 * and the engine resolves that per run.
 *
 * Read-only with respect to invoice data — nothing is written back.
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { Brand } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const enginePool = require('../../../lib/enginePool');
const axios = require('axios');

const COLUMNS = [
  'invoice_number', 'invoice_date', 'company', 'vendor_name_tally', 'voucher_type',
  'category', 'seller_gstin', 'buyer_gstin', 'taxable_value',
  'cgst_rate', 'sgst_rate', 'igst_rate',
  'cgst_amount', 'sgst_amount', 'igst_amount',
];

/** Brand + an RLS-scoped connection, mirroring purchaseInvoiceController. */
const brandCtx = async (brandId) => {
  const brand = await Brand.findByPk(brandId);
  if (!brand) {
    const e = new Error('Brand not found');
    e.status = 404;
    throw e;
  }
  return { brand, seq: getBrandConnection(brand.db_name) };
};

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

/**
 * GET/POST …/invoice/x2beta   ?run_id= | ?month=&year= | ?from=&to=
 * Streams the X2Beta workbook for the selected rows.
 */
exports.build = async (req, res) => {
  try {
    const { brandId } = req.params;
    const q = { ...req.query, ...(req.body || {}) };
    const { brand, seq } = await brandCtx(brandId);

    const where = ['brand_id = :brandId'];
    const repl = { brandId };

    // scope=latest -> only the most recent n8n execution's rows. Rows written
    // before run_id existed are NULL and deliberately excluded here; they are
    // still reachable with the default (all) scope.
    let runId = q.run_id;
    let inferredRun = false;
    if (!runId && String(q.scope || '').toLowerCase() === 'latest') {
      const [latest] = await seq.query(
        `SELECT run_id FROM invoice_process
          WHERE brand_id = :brandId AND run_id IS NOT NULL
          ORDER BY processed_on DESC NULLS LAST LIMIT 1`,
        { replacements: { brandId }, type: QueryTypes.SELECT }
      );
      if (latest) {
        runId = latest.run_id;
      } else {
        // No row for this brand carries a run_id. Until 2026-09-03 only ONE
        // brand's n8n workflow sent {{ $execution.id }}, so for every other
        // brand "Latest run" was permanently empty — and told the user to
        // process invoices they had already processed.
        //
        // Infer the run instead: walk back from the newest row and keep taking
        // rows while consecutive arrivals are close together, breaking at the
        // first long gap. One n8n run posts continuously (once per line item),
        // so a gap of this size reliably separates two runs.
        const gap = Number(process.env.X2BETA_RUN_GAP_MINUTES || 20);
        const burst = await seq.query(
          `WITH ordered AS (
             SELECT id, processed_on,
                    lag(processed_on) OVER (ORDER BY processed_on) AS prev
               FROM invoice_process
              WHERE brand_id = :brandId AND processed_on IS NOT NULL
                AND COALESCE(status,'') NOT IN ('Invalid','failed')
           ), marked AS (
             SELECT id, processed_on,
                    CASE WHEN prev IS NULL
                          OR processed_on - prev > (:gap || ' minutes')::interval
                         THEN 1 ELSE 0 END AS is_start
               FROM ordered
           ), grouped AS (
             SELECT id, sum(is_start) OVER (ORDER BY processed_on) AS grp FROM marked
           )
           SELECT id FROM grouped WHERE grp = (SELECT max(grp) FROM grouped)`,
          { replacements: { brandId, gap }, type: QueryTypes.SELECT },
        );
        if (!burst.length) {
          return res.status(404).json({
            error: 'No invoices found for this brand yet. Process invoices once, then Latest run will work.',
          });
        }
        where.push('id IN (:burstIds)');
        repl.burstIds = burst.map((r) => r.id);
        inferredRun = true;
      }
    }
    if (runId) {
      where.push('run_id = :runId');
      repl.runId = runId;
    }
    // scope=today -> everything processed today, however many runs that took.
    // Sits between "latest run" and "all data": the usual end-of-day handover to
    // Tally, where a day may have needed several runs.
    const isToday = String(q.scope || '').toLowerCase() === 'today';
    if (isToday) where.push('processed_on::date = CURRENT_DATE');
    if (q.month && q.year) {
      where.push('month = :month AND year = :year');
      repl.month = Number(q.month);
      repl.year = Number(q.year);
    }
    if (q.from && q.to) {
      where.push('processed_on::date BETWEEN :from AND :to');
      repl.from = q.from;
      repl.to = q.to;
    }
    // Rows that never parsed carry no ledger/amount — they would emit empty
    // vouchers, so they are excluded rather than silently exported.
    where.push("COALESCE(status,'') NOT IN ('Invalid','failed')");

    const rows = await seq.query(
      `SELECT ${COLUMNS.join(', ')} FROM invoice_process
        WHERE ${where.join(' AND ')}
        ORDER BY invoice_number, category`,
      { replacements: repl, type: QueryTypes.SELECT }
    );

    if (!rows.length) {
      return res.status(404).json({
        error: isToday
          ? 'No invoices have been processed today yet. Use "All data" for earlier invoices.'
          : 'No invoice rows matched the selection',
      });
    }

    const engine = enginePool.acquireEngine();
    let jobId;
    try {
      const r = await axios.post(`${engine}/api/x2beta/build`,
        { rows, brand_name: brand.name },
        { timeout: 300000, maxContentLength: Infinity, maxBodyLength: Infinity });
      if (r.data?.error) {
        const e = new Error(r.data.error);
        e.status = 500;
        throw e;
      }
      jobId = r.data.job_id;
      enginePool.rememberJob(jobId, engine);
    } finally {
      enginePool.releaseEngine(engine);
    }

    const xr = await enginePool.exportFromEngines(jobId,
      { responseType: 'arraybuffer', timeout: 200000 });

    // Filename says WHICH slice this is, so a "latest run" file is never confused
    // with a full export sitting in the same Downloads folder.
    const slug = (brand.name || 'Brand').replace(/[^A-Za-z0-9]+/g, '');
    const scopeTag = runId
      ? `Run${String(runId).replace(/[^A-Za-z0-9]+/g, '')}`
      : (inferredRun ? 'LatestRun' : (isToday ? 'Today' : 'All'));
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="${slug}_X2Beta_${scopeTag}_${stamp()}.xlsx"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    return res.send(Buffer.from(xr.data));
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
};

/**
 * GET …/invoice/x2beta/preview — what WOULD be exported, without building the file.
 * Lets the UI show a count (and warn on nothing-to-export) before downloading.
 */
exports.preview = async (req, res) => {
  try {
    const { brandId } = req.params;
    const { seq } = await brandCtx(brandId);
    const rows = await seq.query(
      `SELECT COALESCE(NULLIF(split_part(voucher_type, ' ', 1) || ' ' ||
                              split_part(voucher_type, ' ', 2), ' '), 'Unclassified') AS kind,
              count(*)::int AS rows,
              count(DISTINCT invoice_number)::int AS vouchers
         FROM invoice_process
        WHERE brand_id = :brandId
          AND COALESCE(status,'') NOT IN ('Invalid','failed')
        GROUP BY 1 ORDER BY 2 DESC`,
      { replacements: { brandId }, type: QueryTypes.SELECT }
    );
    return res.json({ breakdown: rows });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
};
