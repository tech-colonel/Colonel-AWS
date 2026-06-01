const { getBrandConnection } = require('../config/database');
const { Brand } = require('../models/master');

/**
 * Resolve brand's db_name by brandId, with RLS bypass for read queries.
 */
const getBrandSeq = async (brandId) => {
  const brand = await Brand.findByPk(brandId);
  if (!brand) throw new Error('Brand not found');
  return getBrandConnection(brand.db_name);
};

const withBypass = async (seq, queryFn) => {
  return seq.transaction(async (t) => {
    await seq.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
    return queryFn(t);
  });
};

// Admins see all jobs across all users; non-admins see only their own.
const effectiveUserId = (req) => req.user?.role === 'admin' ? null : (req.user?.id || null);

/**
 * GET /api/dashboard/reco/history/:brandId
 * Last 50 reco jobs for the requesting user on this brand.
 */
const getRecoHistory = async (req, res) => {
  const { brandId } = req.params;
  const userId = effectiveUserId(req);
  if (!brandId || brandId === 'demo') return res.json({ jobs: [] });
  try {
    const seq = await getBrandSeq(brandId);
    const jobs = await withBypass(seq, async (t) => {
      const [rows] = await seq.query(
        `SELECT id, agent_type, month, year, status,
                total_rows, matched_rows, unmatched_rows,
                output_file_id, created_at
         FROM reco_jobs
         WHERE brand_id = $1
           AND (created_by = $2 OR $2 IS NULL)
         ORDER BY created_at DESC
         LIMIT 50`,
        { bind: [brandId, userId || null], transaction: t }
      );
      return rows;
    });
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/dashboard/reco/results/:jobId?brandId=xxx
 * Row-level results for a specific bank_reco job.
 * Verifies job belongs to the requesting user before returning rows.
 */
const getJobResults = async (req, res) => {
  const { jobId } = req.params;
  const { brandId } = req.query;
  const userId = effectiveUserId(req);
  if (!brandId || brandId === 'demo') return res.json({ rows: [] });
  try {
    const seq = await getBrandSeq(brandId);
    const rows = await withBypass(seq, async (t) => {
      // Verify job belongs to user
      const [[job]] = await seq.query(
        `SELECT id FROM reco_jobs WHERE id = $1 AND (created_by = $2 OR $2 IS NULL) LIMIT 1`,
        { bind: [jobId, userId || null], transaction: t }
      );
      if (!job) return [];
      const [data] = await seq.query(
        `SELECT txn_date, description, debit, credit, balance,
                txn_type, ledger_name, confidence
         FROM bank_reco_results
         WHERE job_id = $1
         ORDER BY txn_date ASC NULLS LAST`,
        { bind: [jobId], transaction: t }
      );
      return data;
    });
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/dashboard/summary/:brandId
 * Aggregated stats for the dashboard cards + charts.
 */
const getDashboardSummary = async (req, res) => {
  const { brandId } = req.params;
  if (!brandId || brandId === 'demo') return res.json(emptyDashboard());
  try {
    const seq = await getBrandSeq(brandId);
    const userId = effectiveUserId(req);
    const data = await withBypass(seq, async (t) => {
      const userFilter = `AND (created_by = $2 OR $2 IS NULL)`;
      const bind2 = [brandId, userId || null];

      // Total jobs and row stats
      const [[totals]] = await seq.query(
        `SELECT COUNT(*) AS total_jobs,
                COALESCE(SUM(total_rows),0)     AS total_rows,
                COALESCE(SUM(matched_rows),0)   AS matched_rows,
                COALESCE(SUM(unmatched_rows),0) AS unmatched_rows
         FROM reco_jobs WHERE brand_id = $1 ${userFilter}`,
        { bind: bind2, transaction: t }
      );

      // Jobs per agent type
      const [byAgent] = await seq.query(
        `SELECT agent_type,
                COUNT(*)                         AS runs,
                COALESCE(SUM(total_rows),0)      AS total_rows,
                COALESCE(SUM(matched_rows),0)    AS matched_rows
         FROM reco_jobs WHERE brand_id = $1 ${userFilter}
         GROUP BY agent_type ORDER BY runs DESC`,
        { bind: bind2, transaction: t }
      );

      // Monthly trend (last 12 months)
      const [monthlyTrend] = await seq.query(
        `SELECT TO_CHAR(created_at, 'Mon YYYY') AS label,
                COUNT(*)                         AS jobs,
                COALESCE(SUM(matched_rows),0)    AS matched,
                COALESCE(SUM(unmatched_rows),0)  AS unmatched
         FROM reco_jobs
         WHERE brand_id = $1 ${userFilter}
           AND created_at >= NOW() - INTERVAL '12 months'
         GROUP BY TO_CHAR(created_at, 'Mon YYYY'), DATE_TRUNC('month', created_at)
         ORDER BY DATE_TRUNC('month', created_at) ASC`,
        { bind: bind2, transaction: t }
      );

      // Ledger category breakdown — only from jobs owned by this user
      const [ledgerBreakdown] = await seq.query(
        `SELECT ledger_name,
                COUNT(*)              AS txn_count,
                COALESCE(SUM(debit),0)  AS total_debit,
                COALESCE(SUM(credit),0) AS total_credit
         FROM bank_reco_results
         WHERE brand_id = $1
           AND ledger_name IS NOT NULL AND ledger_name != ''
           AND job_id IN (
             SELECT id FROM reco_jobs WHERE brand_id = $1 ${userFilter}
           )
         GROUP BY ledger_name
         ORDER BY txn_count DESC
         LIMIT 10`,
        { bind: bind2, transaction: t }
      );

      // Confidence distribution — only from jobs owned by this user
      const [confidenceDist] = await seq.query(
        `SELECT confidence, COUNT(*) AS count
         FROM bank_reco_results
         WHERE brand_id = $1
           AND job_id IN (
             SELECT id FROM reco_jobs WHERE brand_id = $1 ${userFilter}
           )
         GROUP BY confidence`,
        { bind: bind2, transaction: t }
      );

      // Recent 5 jobs
      const [recentJobs] = await seq.query(
        `SELECT id, agent_type, month, year, status,
                total_rows, matched_rows, unmatched_rows,
                output_file_id, created_at
         FROM reco_jobs WHERE brand_id = $1 ${userFilter}
         ORDER BY created_at DESC LIMIT 5`,
        { bind: bind2, transaction: t }
      );

      return { totals, byAgent, monthlyTrend, ledgerBreakdown, confidenceDist, recentJobs };
    });

    res.json({
      summary: {
        total_jobs: parseInt(data.totals.total_jobs) || 0,
        total_rows: parseInt(data.totals.total_rows) || 0,
        matched_rows: parseInt(data.totals.matched_rows) || 0,
        unmatched_rows: parseInt(data.totals.unmatched_rows) || 0,
        match_rate: data.totals.total_rows > 0
          ? Math.round((data.totals.matched_rows / data.totals.total_rows) * 100)
          : 0,
      },
      by_agent: data.byAgent,
      monthly_trend: data.monthlyTrend,
      ledger_breakdown: data.ledgerBreakdown,
      confidence_dist: data.confidenceDist,
      recent_jobs: data.recentJobs,
    });
  } catch (err) {
    console.error('[DASHBOARD] summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

const emptyDashboard = () => ({
  summary: { total_jobs: 0, total_rows: 0, matched_rows: 0, unmatched_rows: 0, match_rate: 0 },
  by_agent: [], monthly_trend: [], ledger_breakdown: [],
  confidence_dist: [], recent_jobs: [],
});

const GST_2B_COLUMNS = 'supplier_name, supplier_gstin, invoice_number, invoice_date, taxable_value, igst, cgst, sgst, remark_1, remark_2';

const RESULTS_TABLE_MAP = {
  bank_reco: {
    table: 'bank_reco_results',
    columns: 'txn_date, description, debit, credit, balance, txn_type, ledger_name, confidence',
  },
  // Python gstr_2b_books engine — stored under multiple frontend type names
  gstr_2b_books:             { table: 'gstr_2b_results', columns: GST_2B_COLUMNS },
  gstr_2a_vs_2b_vs_books:   { table: 'gstr_2b_results', columns: GST_2B_COLUMNS },
  gstr_2b_vs_purchase:       { table: 'gstr_2b_results', columns: GST_2B_COLUMNS },
  gstr_2b_books_multistate:  { table: 'gstr_2b_results', columns: GST_2B_COLUMNS },
  gstr_2a_2b_books: {
    table: 'gstr_2a_2b_results',
    columns: GST_2B_COLUMNS,
  },
  gstr_3b_vs_2b: {
    table: 'gstr_3b_results',
    columns: 'itc_type, claimed_value, available_value, difference, remark',
  },
  gstr_1_vs_books: {
    table: 'gstr_1_results',
    columns: 'invoice_number, invoice_date, customer_name, taxable_value, igst, cgst, sgst, remark_1, remark_2',
  },
  gstr_3b_tally_entry: {
    table: 'gstr_3b_tally_results',
    columns: 'row_type, sno, particulars, debit, credit',
  },
};

const getJobById = async (req, res) => {
  const { jobId } = req.params;
  const { brandId } = req.query;
  const userId = effectiveUserId(req);
  if (!brandId || brandId === 'demo') return res.json({ job: null, rows: [] });
  try {
    const seq = await getBrandSeq(brandId);
    const result = await withBypass(seq, async (t) => {
      const [[job]] = await seq.query(
        `SELECT id, agent_type, month, year, status,
                total_rows, matched_rows, unmatched_rows,
                output_file_id, created_at
         FROM reco_jobs
         WHERE (output_file_id = $1 OR id::text = $1)
           AND brand_id = $2
         LIMIT 1`,
        { bind: [jobId, brandId], transaction: t }
      );
      if (!job) return { job: null, rows: [] };
      const mapping = RESULTS_TABLE_MAP[job.agent_type];
      let rows = [];
      if (mapping) {
        try {
          const [data] = await seq.query(
            `SELECT ${mapping.columns} FROM ${mapping.table} WHERE job_id = $1 ORDER BY created_at ASC LIMIT 1000`,
            { bind: [job.id], transaction: t }
          );
          rows = data;
        } catch (_) {
          rows = [];
        }
      }
      return { job, rows };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { getRecoHistory, getJobResults, getDashboardSummary, getJobById };
