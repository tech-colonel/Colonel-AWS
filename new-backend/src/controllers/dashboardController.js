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
                COALESCE(SUM(matched_rows),0)    AS matched_rows,
                MAX(created_at)                  AS last_run
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
  einvoice_reco:             { table: 'gstr_2b_results', columns: GST_2B_COLUMNS },
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
    columns: 'invoice_number, invoice_date, customer_name, gstin, taxable_value, igst, cgst, sgst, remark_1, remark_2',
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
  // Guard non-persistent / demo contexts ('other', 'demo', anything not a UUID)
  // so we never hit Postgres with `WHERE brand_id = 'other'` → uuid syntax error.
  if (!brandId || brandId === 'demo' || !/^[0-9a-f-]{36}$/i.test(brandId)) {
    return res.json({ job: null, rows: [] });
  }
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
            // High bound, not 1000 — reconcile appends unmatched rows (In 2B-not-Books /
            // In Books-not-2B) at the END, so a 1000 cap silently dropped them from the
            // analytics and undercounted Total Rows. 100k covers any real reco job.
            `SELECT ${mapping.columns} FROM ${mapping.table} WHERE job_id = $1 ORDER BY created_at ASC LIMIT 100000`,
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

// Friendly labels for the per-tool analytics table.
const TOOL_LABELS = {
  gstr_2b_books: 'GSTR-2B vs Books',
  gstr_2b_vs_purchase: 'GSTR-2B vs Purchase',
  gstr_2a_vs_2b_vs_books: 'GSTR2 vs Books',
  gstr_2b_books_multistate: 'GSTR-2B vs Books (Multi-State)',
  gstr_3b_vs_2b: 'GSTR-3B vs 2B',
  gstr_3b_tally_entry: 'GSTR-3B Tally Entry',
  gstr_1_vs_books: 'GSTR-1 vs Books',
  bank_reco: 'Bank Statement',
  universal_bank_statement: 'Universal Bank Statement',
  pdf_bank_extract: 'PDF → Bank Statement',
  amazon_mtr_consolidator: 'Amazon MTR Consolidator',
  einvoice_reco: 'E-Invoice Reco',
};

// The full universe of finance tools we ship — analytics zero-fills against this
// so the dashboard shows ALL tools (with 0 runs) not just the ones that have run.
const TOOL_UNIVERSE = Object.keys(TOOL_LABELS);

// Last N calendar days as 'YYYY-MM-DD' (oldest → newest), inclusive of today.
const lastNDates = (n) => {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

// Zero-fill a {date→runs} map across the last N days.
const zeroFillTimeline = (map, n = 30) =>
  lastNDates(n).map((date) => ({ date, runs: map[date] || 0 }));

/**
 * GET /api/dashboard/admin/tool-analytics  (admin only)
 * Platform-wide per-tool overview: aggregates reco_jobs across ALL brand DBs by
 * agent_type. Light — reco_jobs is one row per run. Reflects current data (the
 * nightly purge resets it), matching the transient-data model.
 *
 * Returns the FULL tool universe (zero-filled) + a zero-filled 30-day timeline +
 * a runsShare array for the donut.
 */
const getAdminToolAnalytics = async (req, res) => {
  try {
    const brands = await Brand.findAll();
    const toolMap = {};
    const timelineMap = {};
    let brandsWithData = 0;

    for (const b of brands) {
      let seq;
      try { seq = getBrandConnection(b.db_name); } catch { continue; }
      try {
        const [agg, tl] = await withBypass(seq, async (t) => {
          const [a] = await seq.query(
            `SELECT agent_type,
                    COUNT(*)::int                      AS runs,
                    COALESCE(SUM(total_rows),0)::int   AS rows,
                    COALESCE(SUM(matched_rows),0)::int AS matched,
                    COALESCE(SUM(unmatched_rows),0)::int AS unmatched,
                    MAX(created_at)                    AS last_run
             FROM reco_jobs GROUP BY agent_type`,
            { transaction: t });
          const [tline] = await seq.query(
            `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS d, COUNT(*)::int AS runs
             FROM reco_jobs WHERE created_at >= NOW() - INTERVAL '30 days' GROUP BY d`,
            { transaction: t });
          return [a, tline];
        });

        if (agg.length) brandsWithData++;
        for (const r of agg) {
          const k = r.agent_type || 'unknown';
          if (!toolMap[k]) toolMap[k] = { agent_type: k, runs: 0, rows: 0, matched: 0, unmatched: 0, lastRun: null };
          toolMap[k].runs += r.runs; toolMap[k].rows += r.rows;
          toolMap[k].matched += r.matched; toolMap[k].unmatched += r.unmatched;
          if (r.last_run && (!toolMap[k].lastRun || new Date(r.last_run) > new Date(toolMap[k].lastRun))) toolMap[k].lastRun = r.last_run;
        }
        for (const r of tl) timelineMap[r.d] = (timelineMap[r.d] || 0) + r.runs;
      } catch { /* brand DB without reco_jobs / unreachable — skip */ }
    }

    // Universe = curated tool list ∪ any agent_type that actually appeared in data.
    const universe = Array.from(new Set([...TOOL_UNIVERSE, ...Object.keys(toolMap)]));
    const tools = universe.map((k) => {
      const t = toolMap[k] || { agent_type: k, runs: 0, rows: 0, matched: 0, unmatched: 0, lastRun: null };
      return {
        ...t,
        agent_type: k,
        label: TOOL_LABELS[k] || k,
        matchRate: t.rows > 0 ? Math.round((t.matched / t.rows) * 1000) / 10 : null,
      };
    }).sort((a, b) => b.runs - a.runs || a.label.localeCompare(b.label));

    const activeTools = tools.filter((t) => t.runs > 0).length;
    const totals = {
      runs: tools.reduce((s, t) => s + t.runs, 0),
      rows: tools.reduce((s, t) => s + t.rows, 0),
      matched: tools.reduce((s, t) => s + t.matched, 0),
      totalTools: tools.length,
      activeTools,
      brands: brands.length,
      brandsWithData,
    };
    totals.matchRate = totals.rows > 0 ? Math.round((totals.matched / totals.rows) * 1000) / 10 : null;

    // Donut share — only tools that actually ran.
    const runsShare = tools
      .filter((t) => t.runs > 0)
      .map((t) => ({ name: t.label, agent_type: t.agent_type, runs: t.runs }));

    const timeline = zeroFillTimeline(timelineMap, 30);

    res.json({ tools, totals, timeline, runsShare });
  } catch (err) {
    console.error('[DASH] getAdminToolAnalytics error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/dashboard/admin/tool-details/:agentType  (admin only)
 * Drill-down for one tool: who uses it most, which brands, 30-day trend, status mix.
 */
const getToolDetails = async (req, res) => {
  try {
    const { agentType } = req.params;
    const brands = await Brand.findAll();
    const userMap = {};     // created_by → { runs, rows, matched }
    const perBrand = [];    // { brandId, brandName, runs, rows, matched, matchRate }
    const timelineMap = {}; // date → runs
    const statusMap = {};   // status → count
    let totals = { runs: 0, rows: 0, matched: 0, unmatched: 0, lastRun: null };

    for (const b of brands) {
      let seq;
      try { seq = getBrandConnection(b.db_name); } catch { continue; }
      try {
        const { byUser, byDay, byStatus, brandAgg } = await withBypass(seq, async (t) => {
          const [u] = await seq.query(
            `SELECT created_by,
                    COUNT(*)::int                      AS runs,
                    COALESCE(SUM(total_rows),0)::int   AS rows,
                    COALESCE(SUM(matched_rows),0)::int AS matched
             FROM reco_jobs WHERE agent_type = $1 GROUP BY created_by`,
            { bind: [agentType], transaction: t });
          const [d] = await seq.query(
            `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS d, COUNT(*)::int AS runs
             FROM reco_jobs WHERE agent_type = $1 AND created_at >= NOW() - INTERVAL '30 days' GROUP BY d`,
            { bind: [agentType], transaction: t });
          const [s] = await seq.query(
            `SELECT COALESCE(status,'unknown') AS status, COUNT(*)::int AS count
             FROM reco_jobs WHERE agent_type = $1 GROUP BY status`,
            { bind: [agentType], transaction: t });
          const [[ba]] = await seq.query(
            `SELECT COUNT(*)::int                      AS runs,
                    COALESCE(SUM(total_rows),0)::int   AS rows,
                    COALESCE(SUM(matched_rows),0)::int AS matched,
                    COALESCE(SUM(unmatched_rows),0)::int AS unmatched,
                    MAX(created_at)                    AS last_run
             FROM reco_jobs WHERE agent_type = $1`,
            { bind: [agentType], transaction: t });
          return { byUser: u, byDay: d, byStatus: s, brandAgg: ba };
        });

        if (brandAgg.runs > 0) {
          perBrand.push({
            brandId: b.id, brandName: b.name,
            runs: brandAgg.runs, rows: brandAgg.rows, matched: brandAgg.matched,
            matchRate: brandAgg.rows > 0 ? Math.round((brandAgg.matched / brandAgg.rows) * 1000) / 10 : null,
          });
          totals.runs += brandAgg.runs; totals.rows += brandAgg.rows;
          totals.matched += brandAgg.matched; totals.unmatched += brandAgg.unmatched;
          if (brandAgg.last_run && (!totals.lastRun || new Date(brandAgg.last_run) > new Date(totals.lastRun))) totals.lastRun = brandAgg.last_run;
        }
        for (const r of byUser) {
          const k = r.created_by || 'unknown';
          if (!userMap[k]) userMap[k] = { runs: 0, rows: 0, matched: 0 };
          userMap[k].runs += r.runs; userMap[k].rows += r.rows; userMap[k].matched += r.matched;
        }
        for (const r of byDay) timelineMap[r.d] = (timelineMap[r.d] || 0) + r.runs;
        for (const r of byStatus) statusMap[r.status] = (statusMap[r.status] || 0) + r.count;
      } catch { /* skip brand without reco_jobs */ }
    }

    // Resolve user names.
    const { User } = require('../models/master');
    const ids = Object.keys(userMap).filter((k) => k !== 'unknown' && /^[0-9a-f-]{36}$/i.test(k));
    const users = ids.length ? await User.findAll({ where: { id: ids }, attributes: ['id', 'name', 'email'] }) : [];
    const nameById = Object.fromEntries(users.map((u) => [u.id, u.name || u.email]));
    const topUsers = Object.entries(userMap)
      .map(([id, v]) => ({
        userId: id, name: nameById[id] || (id === 'unknown' ? 'Unknown' : 'Deleted user'),
        runs: v.runs, rows: v.rows, matched: v.matched,
        matchRate: v.rows > 0 ? Math.round((v.matched / v.rows) * 1000) / 10 : null,
      }))
      .sort((a, b) => b.runs - a.runs);

    totals.matchRate = totals.rows > 0 ? Math.round((totals.matched / totals.rows) * 1000) / 10 : null;

    res.json({
      agentType,
      label: TOOL_LABELS[agentType] || agentType,
      totals,
      topUsers,
      perBrand: perBrand.sort((a, b) => b.runs - a.runs),
      runsTrend: zeroFillTimeline(timelineMap, 30),
      statusDistribution: Object.entries(statusMap).map(([status, count]) => ({ status, count })),
    });
  } catch (err) {
    console.error('[DASH] getToolDetails error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/dashboard/admin/users-overview  (admin only)
 * Ranking of users by reco activity across all brands + each user's top agent.
 */
const getUsersOverview = async (req, res) => {
  try {
    const brands = await Brand.findAll();
    // created_by → { runs, rows, matched, brands:Set, byAgent:{agent_type→runs} }
    const userMap = {};

    for (const b of brands) {
      let seq;
      try { seq = getBrandConnection(b.db_name); } catch { continue; }
      try {
        const rows = await withBypass(seq, async (t) => {
          const [r] = await seq.query(
            `SELECT created_by, agent_type,
                    COUNT(*)::int                      AS runs,
                    COALESCE(SUM(total_rows),0)::int   AS rows,
                    COALESCE(SUM(matched_rows),0)::int AS matched
             FROM reco_jobs GROUP BY created_by, agent_type`,
            { transaction: t });
          return r;
        });
        for (const r of rows) {
          const k = r.created_by || 'unknown';
          if (!userMap[k]) userMap[k] = { runs: 0, rows: 0, matched: 0, brands: new Set(), byAgent: {} };
          userMap[k].runs += r.runs; userMap[k].rows += r.rows; userMap[k].matched += r.matched;
          userMap[k].brands.add(b.id);
          userMap[k].byAgent[r.agent_type] = (userMap[k].byAgent[r.agent_type] || 0) + r.runs;
        }
      } catch { /* skip */ }
    }

    const { User } = require('../models/master');
    const ids = Object.keys(userMap).filter((k) => k !== 'unknown' && /^[0-9a-f-]{36}$/i.test(k));
    const users = ids.length ? await User.findAll({ where: { id: ids }, attributes: ['id', 'name', 'email', 'role'] }) : [];
    const byId = Object.fromEntries(users.map((u) => [u.id, u]));

    const topUsers = Object.entries(userMap).map(([id, v]) => {
      const topAgent = Object.entries(v.byAgent).sort((a, b) => b[1] - a[1])[0];
      const u = byId[id];
      return {
        userId: id,
        name: u ? (u.name || u.email) : (id === 'unknown' ? 'Unknown' : 'Deleted user'),
        role: u ? u.role : null,
        totalRuns: v.runs,
        totalRows: v.rows,
        matched: v.matched,
        matchRate: v.rows > 0 ? Math.round((v.matched / v.rows) * 1000) / 10 : null,
        brands: v.brands.size,
        topAgent: topAgent ? topAgent[0] : null,
        topAgentLabel: topAgent ? (TOOL_LABELS[topAgent[0]] || topAgent[0]) : null,
      };
    }).sort((a, b) => b.totalRuns - a.totalRuns);

    // How many accountants exist in total (for "active X / Y" context).
    const allAccountants = await User.count({ where: { role: 'accountant' } });

    res.json({
      topUsers,
      usersSummary: {
        totalUsers: allAccountants,
        activeUsers: topUsers.filter((u) => u.totalRuns > 0 && u.role === 'accountant').length,
        totalRuns: topUsers.reduce((s, u) => s + u.totalRuns, 0),
        totalRows: topUsers.reduce((s, u) => s + u.totalRows, 0),
      },
    });
  } catch (err) {
    console.error('[DASH] getUsersOverview error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/dashboard/admin/user-activity/:userId  (admin only)
 * What a specific user has been doing: their assigned brands, and per-brand
 * tool-wise usage/accuracy (reco_jobs filtered by created_by = that user).
 */
const getUserActivity = async (req, res) => {
  try {
    const { userId } = req.params;
    const { User, Brand, BrandUser } = require('../models/master');
    const user = await User.findByPk(userId, { attributes: ['id', 'name', 'email', 'role'] });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const links = await BrandUser.findAll({ where: { user_id: userId } });
    const brandIds = links.map((l) => l.brand_id);
    const brands = brandIds.length ? await Brand.findAll({ where: { id: brandIds } }) : [];

    const out = [];
    for (const b of brands) {
      let seq;
      try { seq = getBrandConnection(b.db_name); } catch { continue; }
      let tools = [];
      try {
        const rows = await withBypass(seq, async (t) => {
          const [r] = await seq.query(
            `SELECT agent_type,
                    COUNT(*)::int                      AS runs,
                    COALESCE(SUM(total_rows),0)::int   AS rows,
                    COALESCE(SUM(matched_rows),0)::int AS matched,
                    MAX(created_at)                    AS last_run
             FROM reco_jobs WHERE created_by = $1 GROUP BY agent_type`,
            { bind: [userId], transaction: t });
          return r;
        });
        tools = rows.map((r) => ({
          agent_type: r.agent_type,
          label: TOOL_LABELS[r.agent_type] || r.agent_type,
          runs: r.runs, rows: r.rows, matched: r.matched,
          matchRate: r.rows > 0 ? Math.round((r.matched / r.rows) * 1000) / 10 : null,
          lastRun: r.last_run,
        })).sort((a, b) => b.runs - a.runs);
      } catch { /* brand DB without reco_jobs — skip */ }
      out.push({
        brandId: b.id, brandName: b.name,
        tools,
        totals: { runs: tools.reduce((s, x) => s + x.runs, 0), rows: tools.reduce((s, x) => s + x.rows, 0) },
      });
    }

    const grandTotals = {
      runs: out.reduce((s, br) => s + br.totals.runs, 0),
      rows: out.reduce((s, br) => s + br.totals.rows, 0),
      brands: out.length,
    };
    res.json({ user, brands: out, totals: grandTotals });
  } catch (err) {
    console.error('[DASH] getUserActivity error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

module.exports = { getRecoHistory, getJobResults, getDashboardSummary, getJobById, getAdminToolAnalytics, getUserActivity, getToolDetails, getUsersOverview };
