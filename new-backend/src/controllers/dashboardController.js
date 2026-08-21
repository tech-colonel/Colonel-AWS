const { getBrandConnection, UNIFIED } = require('../config/database');
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
    // OFF: bypass RLS (isolation is the physical brand DB). UNIFIED: do NOT bypass —
    // the brand connection presets app.brand_id, so RLS scopes each query to that
    // brand. Bypassing in unified would let per-brand aggregation see ALL brands.
    if (!UNIFIED) {
      await seq.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
    }
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
        `SELECT id, agent_type, month, year, period_end_month, period_end_year, status,
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

const emptyReceivableDashboard = () => ({
  period: null,
  kpis: null,
  receivedBySource: [],
  receivedByChannel: [],
  receivedPrepaidByChannel: [],
  settledOfThisMonthsSalesBySource: [],
  settledPrepaidByChannel: [],
  carriedForwardCollections: [],
  salesByChannel: [],
  courierAging: [],
  thisMonthPendingByCourier: [],
  receivableByCourierAsOfDate: [],
  returnsBySource: [],
  returnsPrepaidByChannel: [],
  returnsByMonth: [],
  monthlyTrend: [],
  receivableByMonth: [],
  dataQuality: { unmatched_count: 0, unmatched_amount: 0, bySource: [] },
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
        `SELECT id, agent_type, month, year, period_end_month, period_end_year, status,
                total_rows, matched_rows, unmatched_rows,
                output_file_id, created_at
         FROM reco_jobs
         WHERE (output_file_id = $1 OR id::text = $1)
           AND brand_id = $2
         LIMIT 1`,
        { bind: [jobId, brandId], transaction: t }
      );
      if (!job) return { job: null, rows: [] };

      // Receivable Cycle stores rows as JSONB (sheet_name, row_data) rather than a flat
      // schema — see receivable_cycle_results migration comment. Reconstruct the Main
      // Sheet array + a { [sheetName]: rows } map of the COD sub-sheets.
      if (job.agent_type === 'receivable_cycle') {
        try {
          const [data] = await seq.query(
            `SELECT sheet_name, row_data FROM receivable_cycle_results
             WHERE job_id = $1 ORDER BY sheet_name, row_index ASC LIMIT 200000`,
            { bind: [job.id], transaction: t }
          );
          const codSheets = {};
          let mainRows = [];
          let mainColumns = null;
          let codColumns = {};
          let receivableSummary = null;
          for (const { sheet_name, row_data } of data) {
            if (sheet_name === '__columns__') {
              const { 'Main Sheet': mainCols, ...rest } = row_data || {};
              mainColumns = mainCols || null;
              codColumns = rest;
            } else if (sheet_name === '__receivable_summary__') {
              receivableSummary = row_data || null;
            } else if (sheet_name === 'Main Sheet') {
              mainRows.push(row_data);
            } else {
              (codSheets[sheet_name] ||= []).push(row_data);
            }
          }
          return {
            job, rows: mainRows, cod_sheets: codSheets,
            main_sheet_columns: mainColumns, cod_sheet_columns: codColumns,
            receivable_summary: receivableSummary,
          };
        } catch (_) {
          return { job, rows: [], cod_sheets: {} };
        }
      }

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

/**
 * GET /api/dashboard/activity/:brandId?days=30
 * Per-day runs + rows for this brand (user-scoped like the rest) — drives the
 * daily-process diagram on the accountant Analysis page. Zero-filled.
 */
const getBrandActivity = async (req, res) => {
  const { brandId } = req.params;
  const days = Math.min(parseInt(req.query.days, 10) || 30, 90);
  const userId = effectiveUserId(req);
  if (!brandId || brandId === 'demo') return res.json({ days: [] });
  try {
    const seq = await getBrandSeq(brandId);
    const rows = await withBypass(seq, async (t) => {
      const [r] = await seq.query(
        `SELECT to_char(created_at, 'YYYY-MM-DD') AS day,
                COUNT(*)::int AS runs, COALESCE(SUM(total_rows),0)::int AS rows
         FROM reco_jobs
         WHERE brand_id = $1 AND (created_by = $2 OR $2 IS NULL)
           AND created_at >= NOW() - ($3 || ' days')::interval
         GROUP BY day ORDER BY day ASC`,
        { bind: [brandId, userId || null, String(days)], transaction: t }
      );
      return r;
    });
    const map = new Map((rows || []).map((x) => [x.day, x]));
    const out = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const hit = map.get(key);
      out.push({ date: key, runs: hit ? Number(hit.runs) : 0, rows: hit ? Number(hit.rows) : 0 });
    }
    res.json({ days: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/dashboard/agent-detail/:brandId/:agentType
 * Per-agent drill-down for the Analysis page: totals, monthly trend, status mix,
 * and a USER-WISE breakdown (who ran this tool on this brand, how often).
 * Brand-level (not self-scoped) — this is team analysis, gated by brand access.
 */
const getBrandAgentDetail = async (req, res) => {
  const { brandId, agentType } = req.params;
  if (!brandId || brandId === 'demo') return res.json({ totals: {}, byUser: [], monthly: [], statusDist: [] });
  try {
    const seq = await getBrandSeq(brandId);
    const data = await withBypass(seq, async (t) => {
      const [[totals]] = await seq.query(
        `SELECT COUNT(*)::int AS runs, COALESCE(SUM(total_rows),0)::int AS rows,
                COALESCE(SUM(matched_rows),0)::int AS matched, COALESCE(SUM(unmatched_rows),0)::int AS unmatched,
                MAX(created_at) AS last_run
         FROM reco_jobs WHERE brand_id = $1 AND agent_type = $2`,
        { bind: [brandId, agentType], transaction: t }
      );
      const [byUserRaw] = await seq.query(
        `SELECT created_by, COUNT(*)::int AS runs, COALESCE(SUM(total_rows),0)::int AS rows,
                COALESCE(SUM(matched_rows),0)::int AS matched, MAX(created_at) AS last_run
         FROM reco_jobs WHERE brand_id = $1 AND agent_type = $2
         GROUP BY created_by ORDER BY runs DESC`,
        { bind: [brandId, agentType], transaction: t }
      );
      const [monthly] = await seq.query(
        `SELECT to_char(date_trunc('month', created_at), 'Mon YYYY') AS label,
                date_trunc('month', created_at) AS m,
                COUNT(*)::int AS runs, COALESCE(SUM(total_rows),0)::int AS rows
         FROM reco_jobs WHERE brand_id = $1 AND agent_type = $2
         GROUP BY m ORDER BY m ASC`,
        { bind: [brandId, agentType], transaction: t }
      );
      const [statusDist] = await seq.query(
        `SELECT status, COUNT(*)::int AS count FROM reco_jobs
         WHERE brand_id = $1 AND agent_type = $2 GROUP BY status`,
        { bind: [brandId, agentType], transaction: t }
      );
      return { totals, byUserRaw, monthly, statusDist };
    });
    const { User } = require('../models/master');
    const ids = [...new Set((data.byUserRaw || []).map((u) => u.created_by).filter(Boolean))];
    const users = ids.length ? await User.findAll({ where: { id: ids }, attributes: ['id', 'name', 'email'] }) : [];
    const nameMap = Object.fromEntries(users.map((u) => [u.id, u.name || u.email]));
    const byUser = (data.byUserRaw || []).map((u) => ({
      userId: u.created_by,
      name: u.created_by ? (nameMap[u.created_by] || 'Unknown user') : 'Unattributed',
      runs: Number(u.runs), rows: Number(u.rows), matched: Number(u.matched), last_run: u.last_run,
    }));
    res.json({ totals: data.totals || {}, byUser, monthly: data.monthly || [], statusDist: data.statusDist || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// A ledger row only counts as "settled"/"returned" for a selected reporting period
// if the settlement/return itself happened on or before that period's end — a March
// courier remittance for a Feb-sold order must never leak into a dashboard scoped to
// Feb. settled_flag/returned_flag alone are live, as-of-today facts; gating them by
// settled_month/settled_year (resp. returned_month/returned_year) not exceeding the
// selected month/year turns them into "as of the selected period" facts instead, so
// picking an earlier month reconstructs what the ledger looked like at that month's
// end rather than leaking in cash/returns that only happened later. Both fragments
// assume the query's bind array is [brandId, month, year, ...] ($2 = month, $3 = year).
const SETTLED_ASOF = `(settled_flag AND (settled_year * 12 + settled_month) <= ($3 * 12 + $2))`;
const RETURNED_ASOF = `(returned_flag AND (returned_year * 12 + returned_month) <= ($3 * 12 + $2))`;

// Best-effort join from a prepaid receivable_ledger row to the actual payment
// gateway that financed it (Snapmint / BharatX / Razorpay) — that attribution
// only ever lives in shopify_order_cycle (the Shopify Order Cycle agent's saved
// rows), matched by normalized AWB, falling back to normalized invoice number
// when there's no AWB — mirroring the same normCode() rules
// buildReceivableLedger.js used to build receivable_ledger's own awb/invoice_key
// in the first place, so the join keys are apples-to-apples.
//
// shopify_order_cycle only ever contains Shopify-store rows, so any prepaid
// order whose sales channel isn't Shopify (or its "Custom / Manual" bucket)
// will always come back "No gateway match" — that's a true fact about the data
// (Amazon/Flipkart/Zepto prepaid orders settle through the marketplace itself,
// with no gateway settlement file to match against), not a join bug. It also
// means "Snapmint"/"Zepto" etc. can legitimately appear as a CHANNEL (a raw
// Tally "Channel Ledger" tag) with gateway = "No gateway match" — that channel
// tag is not the same fact as the gateway column, which is exactly the mix-up
// this join exists to make visually unambiguous.
//
// Split into two separate equi-joins (by awb, by invoice) instead of one
// OR'd condition so Postgres can hash-join both gw_awb/gw_inv against
// receivable_ledger instead of a nested-loop regex re-scan per row — verified
// on real data (one brand, ~190k prepaid rows / ~66k shopify_order_cycle rows):
// the OR'd single-join version took ~30s, this version ~80ms.
const PREPAID_GATEWAY_CTE = `
  WITH gw_raw AS (
    SELECT
      regexp_replace(upper(regexp_replace(COALESCE(awb_number,''), '\\.0+$', '')), '\\s+', '', 'g') AS awb_norm,
      regexp_replace(upper(regexp_replace(COALESCE(invoice_number,''), '\\.0+$', '')), '\\s+', '', 'g') AS invoice_norm,
      CASE
        WHEN COALESCE(snapmint_settlement_value,0) > 0 THEN 'Snapmint'
        WHEN COALESCE(bharatx_ledger_amount,0) > 0 THEN 'BharatX'
        WHEN COALESCE(razorpay_settlement_amount,0) > 0 THEN 'Razorpay'
      END AS gateway
    FROM shopify_order_cycle
    WHERE brand_id = $1
      AND (COALESCE(snapmint_settlement_value,0) > 0 OR COALESCE(bharatx_ledger_amount,0) > 0 OR COALESCE(razorpay_settlement_amount,0) > 0)
  ),
  gw_awb AS (SELECT DISTINCT ON (awb_norm) awb_norm, gateway FROM gw_raw WHERE awb_norm <> ''),
  gw_inv AS (SELECT DISTINCT ON (invoice_norm) invoice_norm, gateway FROM gw_raw WHERE invoice_norm <> '')
`;
const PREPAID_GATEWAY_JOIN = `
  LEFT JOIN gw_awb ga ON rl.awb <> '' AND ga.awb_norm = rl.awb
  LEFT JOIN gw_inv gi ON rl.awb = '' AND rl.invoice_key <> '' AND gi.invoice_norm = rl.invoice_key
`;
const PREPAID_GATEWAY_COL = `COALESCE(ga.gateway, gi.gateway, 'No gateway match')`;

/**
 * GET /api/dashboard/receivables/:brandId?month=&year=
 * Global Receivable Cycle dashboard — reads the cross-year receivable_ledger
 * (built by new-backend/scripts/buildReceivableLedger.js from every Tally/
 * courier-settlement/SRN file loaded for the brand) and answers, for a
 * selected month: total sales, total receivable, how much of that receivable
 * was carried forward from earlier months, how much was actually collected
 * this month (and from whom), and how many returns landed this month.
 *
 * "Still pending"/"settled"/"returned" figures are all reconstructed AS OF THE
 * SELECTED PERIOD'S END (via SETTLED_ASOF/RETURNED_ASOF above), not as of today —
 * so viewing Feb always shows Feb's own state at Feb's close, even if some of that
 * receivable was later collected (or returned) in March or beyond. monthlyTrend
 * therefore reads as "of orders sold in month X, how much was still stuck as of the
 * selected period", which is the aging view CFOs actually want, not a live-today
 * figure that silently drifts every time the same past month is reopened.
 */
const getReceivableDashboard = async (req, res) => {
  const { brandId } = req.params;
  let month = parseInt(req.query.month, 10);
  let year = parseInt(req.query.year, 10);
  // Optional "cycle start" — everything sold before this month is treated as if it
  // never existed for every figure on this dashboard (sales, receivable, settlements,
  // returns, all of it), not just excluded from carried-forward. Lets a CFO say "our
  // data before April is unreliable/irrelevant, start the whole cycle from there."
  const startMonth = parseInt(req.query.startMonth, 10) || null;
  const startYear = parseInt(req.query.startYear, 10) || null;
  const startIndex = (startMonth && startYear) ? (startYear * 12 + startMonth) : 0; // 0 = no lower bound, any real order index is far greater
  if (!brandId || brandId === 'demo') return res.status(400).json({ error: 'brandId required' });

  try {
    const seq = await getBrandSeq(brandId);

    // No month/year given → default to the latest month with any ledger data,
    // so the dashboard has something sensible to show on first load for any brand.
    if (!month || !year) {
      const [[latest]] = await seq.query(
        `SELECT order_month, order_year FROM receivable_ledger WHERE brand_id = $1
         ORDER BY order_year DESC, order_month DESC LIMIT 1`,
        { bind: [brandId] }
      );
      if (!latest) return res.json(emptyReceivableDashboard());
      month = latest.order_month;
      year = latest.order_year;
    }

    // Selected period is before the cycle's own start — nothing to show; the start
    // month itself is the earliest month this dashboard will ever report on.
    if (startIndex > 0 && (year * 12 + month) < startIndex) {
      return res.json({
        ...emptyReceivableDashboard(),
        period: { month, year },
        cycleStart: { month: startMonth, year: startYear },
        beforeCycleStart: true,
      });
    }

    const data = await withBypass(seq, async (t) => {
      const bind = [brandId, month, year, startIndex];
      // Cash-collected queries deliberately drop the $4 cycle-start placeholder (see the
      // comment above received_this_month) — Postgres' prepared-statement bind requires
      // the parameter count to match exactly how many placeholders the query text uses.
      const bindNoCycleStart = [brandId, month, year];

      const [[kpis]] = await seq.query(
        `SELECT
           COALESCE(SUM(total_amount) FILTER (WHERE order_month = $2 AND order_year = $3), 0) AS sales_this_month,
           -- "Still receivable" = not yet settled AND not returned, both AS OF THE
           -- SELECTED PERIOD'S END (SETTLED_ASOF/RETURNED_ASOF above). A returned COD
           -- order (RTO, or a post-delivery return) never generates real cash, so once
           -- the return has landed by the selected month's own close it must stop
           -- counting as outstanding — but a return that only lands afterward does not
           -- retroactively empty out an earlier month's receivable. Same population as sales_this_month
           -- (COD+Prepaid, no payment_method filter) — a Prepaid row genuinely counts
           -- here now too (see receivableLedgerBuilder.js's loadTallyRows comment):
           -- it stays "still receivable" until a delivery_status upload confirms
           -- delivery, exactly like COD stays receivable until courier remittance.
           -- The population matches every other KPI on this card exactly, so
           -- Sales − Returned − Settled always reconciles to this to the rupee.
           COALESCE(SUM(total_amount) FILTER (
             WHERE NOT ${SETTLED_ASOF} AND NOT ${RETURNED_ASOF}
               AND (order_year * 12 + order_month) <= ($3 * 12 + $2) AND (order_year * 12 + order_month) >= $4
           ), 0) AS total_receivable_as_of_date,
           COALESCE(SUM(total_amount) FILTER (
             WHERE NOT ${SETTLED_ASOF} AND NOT ${RETURNED_ASOF}
               AND order_month = $2 AND order_year = $3
           ), 0) AS this_month_own_receivable,
           COALESCE(SUM(total_amount) FILTER (
             WHERE NOT ${SETTLED_ASOF} AND NOT ${RETURNED_ASOF}
               AND (order_year * 12 + order_month) < ($3 * 12 + $2) AND (order_year * 12 + order_month) >= $4
           ), 0) AS carried_forward_receivable,
           -- Settled AS OF THIS PERIOD'S END of THIS MONTH'S OWN sales — same total_amount
           -- partition as the receivable figures above, so it is the exact complement:
           -- sales_this_month − returned_of_this_months_sales − settled_of_this_months_sales
           -- = this_month_own_receivable, always, to the rupee. A settlement that happened
           -- after the selected period (e.g. a Feb sale settled in March) does NOT count here
           -- when Feb is selected — do not confuse with received_this_month below, which is a
           -- CASH figure (money that physically arrived in this exact calendar month, from
           -- orders sold in any month).
           COALESCE(SUM(total_amount) FILTER (
             WHERE ${SETTLED_ASOF} AND NOT ${RETURNED_ASOF} AND order_month = $2 AND order_year = $3
           ), 0) AS settled_of_this_months_sales,
           -- Cash collected — deliberately NOT gated by the cycle-start sentinel ($4):
           -- cycle start means "treat orders sold before this month as untrustworthy/
           -- nonexistent," which is right for accrual figures anchored to the ORDER's own
           -- month, but wrong here — this is a pure treasury fact (cash that physically
           -- landed this calendar month), true regardless of whether we trust the sales
           -- data from whichever earlier month that cash's underlying order was sold in.
           -- IS however net of returns (NOT RETURNED_ASOF): an order the courier remitted
           -- and then RTO'd/refunded by the selected period's close never became real
           -- revenue, so it's excluded here too — same rule as the Received/Receivable
           -- cards, applied to the cash figure so the two don't diverge by exactly the
           -- settled-then-returned population.
           COALESCE(SUM(settled_amount) FILTER (WHERE settled_month = $2 AND settled_year = $3 AND NOT ${RETURNED_ASOF}), 0) AS received_this_month,
           COALESCE(SUM(settled_amount) FILTER (
             WHERE settled_month = $2 AND settled_year = $3 AND order_month = $2 AND order_year = $3 AND NOT ${RETURNED_ASOF}
           ), 0) AS received_from_this_months_sales,
           COALESCE(SUM(settled_amount) FILTER (
             WHERE settled_month = $2 AND settled_year = $3
               AND (order_year * 12 + order_month) < ($3 * 12 + $2) AND NOT ${RETURNED_ASOF}
           ), 0) AS received_from_carried_forward,
           COALESCE(SUM(returned_amount) FILTER (WHERE returned_month = $2 AND returned_year = $3 AND (order_year * 12 + order_month) >= $4), 0) AS returns_this_month_amount,
           COUNT(*) FILTER (WHERE returned_month = $2 AND returned_year = $3 AND (order_year * 12 + order_month) >= $4) AS returns_this_month_count,
           -- Behind "Total sales" card's net-of-returns view — returns of an order SOLD
           -- this month, processed on or before this period's end (same month or an
           -- earlier-closing later one; a return processed AFTER the selected period does
           -- not count here). Different from returns_this_month_amount above, which is
           -- returns PROCESSED this month regardless of the sale's own month.
           COALESCE(SUM(total_amount) FILTER (WHERE order_month = $2 AND order_year = $3 AND ${RETURNED_ASOF}), 0) AS returned_of_this_months_sales,
           -- Movement bridge behind the "Total receivable" / "Carried forward" drill-downs —
           -- same population as carried_forward_receivable/total_receivable_as_of_date above,
           -- but evaluated as of the PREVIOUS calendar month's close (($3*12+$2)-1 instead of
           -- $3*12+$2; a plain integer step, so Jan correctly rolls back into December of the
           -- prior year with no special-casing). Lets the dashboard show, in real rupees, why a
           -- month's own receivable shrinks every time a later month re-reads it: opening balance
           -- minus what got collected and returned since, landing exactly on the new figure —
           -- total_receivable_as_of_previous_month − received_from_carried_forward −
           -- returned_of_carried_forward_this_month = carried_forward_receivable, to the rupee.
           COALESCE(SUM(total_amount) FILTER (
             WHERE NOT (settled_flag AND (settled_year * 12 + settled_month) <= (($3 * 12 + $2) - 1))
               AND NOT (returned_flag AND (returned_year * 12 + returned_month) <= (($3 * 12 + $2) - 1))
               AND (order_year * 12 + order_month) <= (($3 * 12 + $2) - 1) AND (order_year * 12 + order_month) >= $4
           ), 0) AS total_receivable_as_of_previous_month,
           -- Must be measured in total_amount (like every other bucket in this bridge, not
           -- returned_amount) AND restricted to orders that were still in the OPENING pending
           -- pool (not already settled by the previous month's close) — otherwise this also
           -- picks up orders that had already settled by then and were only returned/refunded
           -- afterward, which were never part of the opening balance and would double-subtract.
           COALESCE(SUM(total_amount) FILTER (
             WHERE returned_month = $2 AND returned_year = $3
               AND (order_year * 12 + order_month) < ($3 * 12 + $2) AND (order_year * 12 + order_month) >= $4
               AND NOT (settled_flag AND (settled_year * 12 + settled_month) <= (($3 * 12 + $2) - 1))
           ), 0) AS returned_of_carried_forward_this_month
         FROM receivable_ledger WHERE brand_id = $1`,
        { bind, transaction: t }
      );

      // Behind the "Received" KPI card's by-source table — for each courier/prepaid
      // source, how much of what it paid out THIS calendar month was for an order
      // sold this same month vs an order sold in an earlier month (i.e. it was
      // finally collecting old carried-forward debt). Net of returns (NOT RETURNED_ASOF),
      // same as received_this_month above.
      const [receivedBySource] = await seq.query(
        `SELECT COALESCE(settled_source, 'unknown') AS source, COUNT(*) AS count, SUM(settled_amount) AS amount,
                COALESCE(SUM(settled_amount) FILTER (WHERE order_month = $2 AND order_year = $3), 0) AS from_this_month,
                COALESCE(SUM(settled_amount) FILTER (WHERE NOT (order_month = $2 AND order_year = $3)), 0) AS from_earlier_months
         FROM receivable_ledger
         WHERE brand_id = $1 AND settled_month = $2 AND settled_year = $3 AND NOT ${RETURNED_ASOF}
         GROUP BY 1 ORDER BY amount DESC`,
        { bind: bindNoCycleStart, transaction: t }
      );

      // Same split as receivedBySource above, but by sales portal/channel instead of
      // by courier — "from what portal" was this month's cash actually collected.
      const [receivedByChannel] = await seq.query(
        `SELECT COALESCE(NULLIF(channel, ''), 'Unknown') AS channel, COUNT(*) AS count, SUM(settled_amount) AS amount,
                COALESCE(SUM(settled_amount) FILTER (WHERE order_month = $2 AND order_year = $3), 0) AS from_this_month,
                COALESCE(SUM(settled_amount) FILTER (WHERE NOT (order_month = $2 AND order_year = $3)), 0) AS from_earlier_months
         FROM receivable_ledger
         WHERE brand_id = $1 AND settled_month = $2 AND settled_year = $3 AND NOT ${RETURNED_ASOF}
         GROUP BY 1 ORDER BY amount DESC`,
        { bind: bindNoCycleStart, transaction: t }
      );

      // Prepaid's row in receivedBySource above is one lump sum (settled_source is
      // the literal 'delivered' once a delivery_status upload confirms it) — this
      // splits that same population by sales channel/portal AND (best-effort)
      // actual payment gateway, so "Received → Prepaid" is a real two-dimensional
      // breakdown, not a dead end.
      const [receivedPrepaidByChannel] = await seq.query(
        `${PREPAID_GATEWAY_CTE}
         SELECT COALESCE(NULLIF(rl.channel, ''), 'Unknown') AS channel, ${PREPAID_GATEWAY_COL} AS gateway,
                COUNT(*) AS count, SUM(rl.settled_amount) AS amount
         FROM receivable_ledger rl
         ${PREPAID_GATEWAY_JOIN}
         WHERE rl.brand_id = $1 AND rl.payment_method = 'PREPAID' AND rl.settled_month = $2 AND rl.settled_year = $3 AND NOT ${RETURNED_ASOF}
         GROUP BY 1, 2 ORDER BY 1, amount DESC`,
        { bind: bindNoCycleStart, transaction: t }
      );

      // Behind the reconciliation strip's "Settled to date" figure
      // (kpis.settled_of_this_months_sales) — same mutually-exclusive total_amount
      // partition, grouped by settled_source, so "how much of THIS MONTH'S OWN sales
      // is settled, and from where" is a literal breakdown instead of one lump sum.
      // Unlike receivedBySource above, this is NOT filtered by settled_month/year being
      // exactly this month — an order sold this month but settled later via Ekart still
      // counts here, under 'ekart', AS LONG AS that settlement landed on or before the
      // selected period's end (SETTLED_ASOF); a settlement after the selected period does
      // not. Rows are ranked by amount so the biggest channel leads.
      const [settledOfThisMonthsSalesBySource] = await seq.query(
        `SELECT COALESCE(settled_source, 'unknown') AS source, COUNT(*) AS count,
                SUM(total_amount) AS amount
         FROM receivable_ledger
         WHERE brand_id = $1 AND order_month = $2 AND order_year = $3
           AND ${SETTLED_ASOF} AND NOT ${RETURNED_ASOF} AND (order_year * 12 + order_month) >= $4
         GROUP BY 1 ORDER BY amount DESC`,
        { bind, transaction: t }
      );

      // Prepaid's row in settledOfThisMonthsSalesBySource above is one lump sum —
      // this splits that same "settled as of this period, this month's own sale"
      // population by sales channel/portal AND (best-effort) actual payment
      // gateway, behind the "Settled to date" modal's Prepaid breakdown.
      const [settledPrepaidByChannel] = await seq.query(
        `${PREPAID_GATEWAY_CTE}
         SELECT COALESCE(NULLIF(rl.channel, ''), 'Unknown') AS channel, ${PREPAID_GATEWAY_COL} AS gateway,
                COUNT(*) AS count, SUM(rl.total_amount) AS amount
         FROM receivable_ledger rl
         ${PREPAID_GATEWAY_JOIN}
         WHERE rl.brand_id = $1 AND rl.payment_method = 'PREPAID' AND rl.order_month = $2 AND rl.order_year = $3
           AND ${SETTLED_ASOF} AND NOT ${RETURNED_ASOF} AND (rl.order_year * 12 + rl.order_month) >= $4
         GROUP BY 1, 2 ORDER BY 1, amount DESC`,
        { bind, transaction: t }
      );

      // Drills into the "Previous months' sale" slice of the Received card — exactly
      // which origin month's backlog got cleared this calendar month, and via which
      // courier/prepaid source, so "we collected a Jan sale via Ekart in March" is a
      // literal row instead of one lump carried-forward number. Net of returns, same as
      // received_from_carried_forward above.
      const [carriedForwardCollections] = await seq.query(
        `SELECT order_month, order_year, COALESCE(settled_source, 'unknown') AS source,
                COUNT(*) AS count, SUM(settled_amount) AS amount
         FROM receivable_ledger
         WHERE brand_id = $1 AND settled_month = $2 AND settled_year = $3
           AND NOT (order_month = $2 AND order_year = $3) AND NOT ${RETURNED_ASOF}
         GROUP BY order_month, order_year, settled_source
         ORDER BY order_year DESC, order_month DESC, amount DESC`,
        { bind: bindNoCycleStart, transaction: t }
      );

      // Behind the "Total sales" KPI card — which portal/channel this month's sales
      // actually came from (Shopify, Amazon, Flipkart, etc.), COD + Prepaid combined.
      const [salesByChannel] = await seq.query(
        `SELECT COALESCE(NULLIF(channel, ''), 'Unknown') AS channel, COUNT(*) AS count, SUM(total_amount) AS amount
         FROM receivable_ledger
         WHERE brand_id = $1 AND order_month = $2 AND order_year = $3 AND (order_year * 12 + order_month) >= $4
         GROUP BY 1 ORDER BY amount DESC`,
        { bind, transaction: t }
      );

      // All-time (not month-filtered) per-courier picture — this is what surfaces data
      // gaps like "Delhivery FY24-25 settlement file not loaded yet" as a near-100%
      // pending rate, instead of that silently masquerading as a real business problem.
      //
      // settled_amount/returned_amount/pending_amount here are a MUTUALLY EXCLUSIVE
      // partition of total_amount (settled-and-not-returned / returned-regardless-of-
      // settled / neither) — NOT a straight sum of the settled_amount/returned_amount
      // ledger columns, which can double-count an order that was briefly settled and
      // then later refunded. This partition is what makes
      // total_amount = settled_amount + returned_amount + pending_amount hold exactly.
      const [courierAging] = await seq.query(
        `SELECT courier, COUNT(*) AS total_orders, SUM(total_amount) AS total_amount,
                COUNT(*) FILTER (WHERE settled_flag AND NOT returned_flag) AS settled_orders,
                COALESCE(SUM(total_amount) FILTER (WHERE settled_flag AND NOT returned_flag), 0) AS settled_amount,
                COUNT(*) FILTER (WHERE returned_flag) AS returned_orders,
                COALESCE(SUM(total_amount) FILTER (WHERE returned_flag), 0) AS returned_amount,
                COALESCE(SUM(total_amount) FILTER (WHERE NOT settled_flag AND NOT returned_flag), 0) AS pending_amount
         FROM receivable_ledger
         WHERE brand_id = $1 AND payment_method = 'COD' AND (order_year * 12 + order_month) >= $2
         GROUP BY courier ORDER BY total_amount DESC`,
        { bind: [brandId, startIndex], transaction: t }
      );

      // Behind the "This month's own receivable" KPI card — where THIS month's still-
      // pending COD amount actually sits, broken down by courier/partner. Unlike
      // courierAging above (all-time), this is scoped to this month's own sales only.
      // Same mutually-exclusive partition as courierAging above.
      const [thisMonthPendingByCourier] = await seq.query(
        `SELECT courier, COUNT(*) AS total_orders, SUM(total_amount) AS total_amount,
                COUNT(*) FILTER (WHERE ${SETTLED_ASOF} AND NOT ${RETURNED_ASOF}) AS settled_orders,
                COALESCE(SUM(total_amount) FILTER (WHERE ${SETTLED_ASOF} AND NOT ${RETURNED_ASOF}), 0) AS settled_amount,
                COUNT(*) FILTER (WHERE ${RETURNED_ASOF}) AS returned_orders,
                COALESCE(SUM(total_amount) FILTER (WHERE ${RETURNED_ASOF}), 0) AS returned_amount,
                COUNT(*) FILTER (WHERE NOT ${SETTLED_ASOF} AND NOT ${RETURNED_ASOF}) AS pending_orders,
                COALESCE(SUM(total_amount) FILTER (WHERE NOT ${SETTLED_ASOF} AND NOT ${RETURNED_ASOF}), 0) AS pending_amount
         FROM receivable_ledger
         WHERE brand_id = $1 AND payment_method = 'COD' AND order_month = $2 AND order_year = $3
           AND (order_year * 12 + order_month) >= $4
         GROUP BY courier ORDER BY pending_amount DESC`,
        { bind, transaction: t }
      );

      // Also behind "Total receivable" — same pending-as-of-date universe as
      // total_receivable_as_of_date, but grouped by courier/partner instead of by
      // month, so the card can answer "from where is it receivable" as well as
      // "from which month".
      const [receivableByCourierAsOfDate] = await seq.query(
        `SELECT courier, COUNT(*) AS pending_orders, SUM(total_amount) AS pending_amount
         FROM receivable_ledger
         WHERE brand_id = $1 AND payment_method = 'COD' AND NOT ${SETTLED_ASOF} AND NOT ${RETURNED_ASOF}
           AND (order_year * 12 + order_month) <= ($3 * 12 + $2) AND (order_year * 12 + order_month) >= $4
         GROUP BY courier ORDER BY pending_amount DESC`,
        { bind, transaction: t }
      );

      // Behind the "Returns (SRN)" KPI card — this month's returns broken down by
      // where the order shipped from (courier, or "Prepaid" for non-Shopify
      // prepaid orders, which get returned too — not just COD; Shopify Prepaid
      // lives in shopify_order_cycle, not here — see receivableLedgerBuilder.js).
      //
      // Also splits every row into collected_amount/rto_amount — whether cash had
      // actually landed before this return (same predicate as
      // PAYABLE_LEDGER_COLLECTED_THEN_RETURNED below: courier remittance for COD;
      // for Prepaid, cash is always considered collected, unconditionally — see
      // that macro's comment), i.e. whether this return creates a refund liability
      // on the Payables Dashboard (as 'COD' or 'Marketplace Prepaid' there) or not.
      const [returnsBySource] = await seq.query(
        `SELECT CASE WHEN payment_method = 'PREPAID' THEN 'Prepaid'
                     ELSE COALESCE(NULLIF(courier, ''), 'Other COD') END AS source,
                COUNT(*) AS count, SUM(returned_amount) AS amount,
                COUNT(*) FILTER (WHERE ${PAYABLE_LEDGER_COLLECTED_THEN_RETURNED}) AS collected_count,
                COALESCE(SUM(returned_amount) FILTER (WHERE ${PAYABLE_LEDGER_COLLECTED_THEN_RETURNED}), 0) AS collected_amount,
                COUNT(*) FILTER (WHERE NOT (${PAYABLE_LEDGER_COLLECTED_THEN_RETURNED})) AS rto_count,
                COALESCE(SUM(returned_amount) FILTER (WHERE NOT (${PAYABLE_LEDGER_COLLECTED_THEN_RETURNED})), 0) AS rto_amount
         FROM receivable_ledger
         WHERE brand_id = $1 AND returned_month = $2 AND returned_year = $3 AND (order_year * 12 + order_month) >= $4
         GROUP BY 1 ORDER BY amount DESC`,
        { bind, transaction: t }
      );

      // Prepaid's row in returnsBySource above is one lump sum — this splits that
      // same "returns processed this period" population by sales channel/portal
      // AND (best-effort) actual payment gateway, behind the "Returns (SRN)"
      // modal's Prepaid breakdown.
      const [returnsPrepaidByChannel] = await seq.query(
        `${PREPAID_GATEWAY_CTE}
         SELECT COALESCE(NULLIF(rl.channel, ''), 'Unknown') AS channel, ${PREPAID_GATEWAY_COL} AS gateway,
                COUNT(*) AS count, SUM(rl.returned_amount) AS amount
         FROM receivable_ledger rl
         ${PREPAID_GATEWAY_JOIN}
         WHERE rl.brand_id = $1 AND rl.payment_method = 'PREPAID' AND rl.returned_month = $2 AND rl.returned_year = $3
           AND (rl.order_year * 12 + rl.order_month) >= $4
         GROUP BY 1, 2 ORDER BY 1, amount DESC`,
        { bind, transaction: t }
      );

      // Also behind "Returns (SRN)" — this month's returns broken down by which
      // ORIGIN month the underlying sale happened in. A return processed this month
      // is very often for a sale from a previous month, not this month's own — this
      // is what makes that visible instead of one lump total.
      // Bifurcates each origin month's returns (processed this period) into orders that
      // were STILL OPEN going into this period (not yet settled as of the PREVIOUS
      // month's close — the same population the Carried Forward bridge's "Returned"
      // line moves) vs orders that had ALREADY SETTLED by then and only got
      // reversed/refunded this period. Both total_amount-based, so still_open_amount
      // reconciles exactly to returned_of_carried_forward_this_month in the kpis above
      // for that origin month's own contribution.
      const [returnsByMonth] = await seq.query(
        `SELECT order_month AS month, order_year AS year, COUNT(*) AS count, SUM(returned_amount) AS amount,
                COUNT(*) FILTER (WHERE NOT (settled_flag AND (settled_year * 12 + settled_month) <= (($3 * 12 + $2) - 1))) AS still_open_count,
                COALESCE(SUM(total_amount) FILTER (WHERE NOT (settled_flag AND (settled_year * 12 + settled_month) <= (($3 * 12 + $2) - 1))), 0) AS still_open_amount,
                COUNT(*) FILTER (WHERE settled_flag AND (settled_year * 12 + settled_month) <= (($3 * 12 + $2) - 1)) AS already_settled_count,
                COALESCE(SUM(total_amount) FILTER (WHERE settled_flag AND (settled_year * 12 + settled_month) <= (($3 * 12 + $2) - 1)), 0) AS already_settled_amount
         FROM receivable_ledger
         WHERE brand_id = $1 AND returned_month = $2 AND returned_year = $3 AND (order_year * 12 + order_month) >= $4
         GROUP BY order_month, order_year ORDER BY order_year DESC, order_month DESC`,
        { bind, transaction: t }
      );

      // Full aging breakdown behind the "Total receivable" KPI card — every origin
      // month with COD sales up to the selected month (not windowed to 12, unlike
      // monthlyTrend below, since the total-receivable figure can include older
      // pending than that window covers), newest first.
      // Same mutually-exclusive total_amount partition as courierAging/thisMonthPendingByCourier —
      // cod_sales = settled_amount + returned_amount + pending, exactly, every row.
      const [receivableByMonth] = await seq.query(
        `SELECT order_month AS month, order_year AS year,
                SUM(total_amount) AS cod_sales,
                COALESCE(SUM(total_amount) FILTER (WHERE ${SETTLED_ASOF} AND NOT ${RETURNED_ASOF}), 0) AS settled_amount,
                COALESCE(SUM(total_amount) FILTER (WHERE ${RETURNED_ASOF}), 0) AS returned_amount,
                SUM(total_amount) FILTER (WHERE NOT ${SETTLED_ASOF} AND NOT ${RETURNED_ASOF}) AS pending
         FROM receivable_ledger
         WHERE brand_id = $1 AND payment_method = 'COD' AND (order_year * 12 + order_month) <= ($3 * 12 + $2)
           AND (order_year * 12 + order_month) >= $4
         GROUP BY order_month, order_year
         ORDER BY order_year DESC, order_month DESC`,
        { bind, transaction: t }
      );

      const [monthlyTrend] = await seq.query(
        `SELECT order_month AS month, order_year AS year,
                SUM(total_amount) AS sales,
                SUM(settled_amount) FILTER (WHERE settled_month = order_month AND settled_year = order_year) AS received_same_month,
                COALESCE(SUM(returned_amount) FILTER (WHERE ${RETURNED_ASOF}), 0) AS returned_amount,
                SUM(total_amount) FILTER (WHERE payment_method = 'COD' AND NOT ${SETTLED_ASOF} AND NOT ${RETURNED_ASOF}) AS still_pending
         FROM receivable_ledger
         WHERE brand_id = $1 AND (order_year * 12 + order_month) <= ($3 * 12 + $2)
           AND (order_year * 12 + order_month) > ($3 * 12 + $2) - 12
           AND (order_year * 12 + order_month) >= $4
         GROUP BY order_month, order_year
         ORDER BY order_year, order_month`,
        { bind, transaction: t }
      );

      const [[dataQualityTotals]] = await seq.query(
        `SELECT COUNT(*) AS unmatched_count, COALESCE(SUM(amount), 0) AS unmatched_amount
         FROM receivable_ledger_unmatched WHERE brand_id = $1`,
        { bind: [brandId], transaction: t }
      );
      const [dataQualityBySource] = await seq.query(
        `SELECT source, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
         FROM receivable_ledger_unmatched WHERE brand_id = $1
         GROUP BY source ORDER BY amount DESC`,
        { bind: [brandId], transaction: t }
      );

      return { kpis, receivedBySource, receivedByChannel, receivedPrepaidByChannel, settledOfThisMonthsSalesBySource, settledPrepaidByChannel, carriedForwardCollections, salesByChannel, courierAging, thisMonthPendingByCourier, receivableByCourierAsOfDate, returnsBySource, returnsPrepaidByChannel, returnsByMonth, monthlyTrend, receivableByMonth, dataQualityTotals, dataQualityBySource };
    });

    const prevIndex = year * 12 + month - 1;
    const previousPeriod = { month: ((prevIndex - 1) % 12) + 1, year: Math.floor((prevIndex - 1) / 12) };

    res.json({
      period: { month, year },
      previousPeriod,
      cycleStart: startIndex > 0 ? { month: startMonth, year: startYear } : null,
      kpis: data.kpis,
      receivedBySource: data.receivedBySource,
      receivedByChannel: data.receivedByChannel,
      receivedPrepaidByChannel: data.receivedPrepaidByChannel,
      settledOfThisMonthsSalesBySource: data.settledOfThisMonthsSalesBySource,
      settledPrepaidByChannel: data.settledPrepaidByChannel,
      carriedForwardCollections: data.carriedForwardCollections,
      salesByChannel: data.salesByChannel,
      courierAging: data.courierAging,
      thisMonthPendingByCourier: data.thisMonthPendingByCourier,
      receivableByCourierAsOfDate: data.receivableByCourierAsOfDate,
      returnsBySource: data.returnsBySource,
      returnsPrepaidByChannel: data.returnsPrepaidByChannel,
      returnsByMonth: data.returnsByMonth,
      monthlyTrend: data.monthlyTrend,
      receivableByMonth: data.receivableByMonth,
      dataQuality: { ...data.dataQualityTotals, bySource: data.dataQualityBySource },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/dashboard/receivables/:brandId/journey?month=&year=&startMonth=&startYear=&originMonth=&originYear=&channel=&courier=&source=
 * "Click any number, see its complete journey" drill-down — the month-by-month
 * trajectory behind a single figure on the Receivable Dashboard, instead of the
 * one-step (this month vs previous month) view the KPI cards show.
 *
 * Two modes:
 *  - Ledger mode (default): one row per calendar month that has ledger activity,
 *    from the cycle start (or the ledger's own first month) through the selected
 *    month, each row re-evaluating the SAME whole-ledger metrics AS OF that row's
 *    own month-end — e.g. total_receivable_as_of's last row always equals the
 *    "Total receivable" KPI card's own value for the selected month, to the rupee.
 *    Optionally scoped to one channel/courier (order-level attributes, valid for
 *    every metric) and/or one settlement source (valid only for the settled_of_own/
 *    received_* columns — a pending order has no settled_source yet).
 *  - Origin mode (originMonth/originYear given): fixes the ORDER population to one
 *    specific month's own sales and traces only how much of THAT month's own sale
 *    has settled/returned/still-pending, evaluated as of each later month's close —
 *    e.g. this is what shows Feb's own receivable shrinking from Feb's close to
 *    March's close as March's collections/returns land. Ignores the whole-ledger
 *    cumulative columns (total_receivable_as_of/carried_forward_as_of), which don't
 *    apply to a single fixed origin month.
 */
const getReceivableJourney = async (req, res) => {
  const { brandId } = req.params;
  const month = parseInt(req.query.month, 10);
  const year = parseInt(req.query.year, 10);
  const startMonth = parseInt(req.query.startMonth, 10) || null;
  const startYear = parseInt(req.query.startYear, 10) || null;
  const startIndex = (startMonth && startYear) ? (startYear * 12 + startMonth) : 0;
  const originMonth = parseInt(req.query.originMonth, 10) || null;
  const originYear = parseInt(req.query.originYear, 10) || null;
  const channel = (req.query.channel || '').trim() || null;
  const courier = (req.query.courier || '').trim() || null;
  const source = (req.query.source || '').trim() || null;

  if (!brandId || brandId === 'demo') return res.status(400).json({ error: 'brandId required' });
  if (!month || !year) return res.status(400).json({ error: 'month and year query params required' });

  try {
    const seq = await getBrandSeq(brandId);
    const months = await withBypass(seq, async (t) => {
      if (originMonth && originYear) {
        const [rows] = await seq.query(
          `WITH months AS (
             SELECT DISTINCT order_month AS month, order_year AS year
             FROM receivable_ledger
             WHERE brand_id = $1 AND (order_year * 12 + order_month) <= ($3 * 12 + $2)
               AND (order_year * 12 + order_month) >= ($5 * 12 + $4)
           )
           SELECT m.month, m.year, agg.*
           FROM months m
           CROSS JOIN LATERAL (
             SELECT
               COALESCE(SUM(total_amount) FILTER (WHERE order_month = $4 AND order_year = $5), 0) AS origin_sales,
               COALESCE(SUM(total_amount) FILTER (
                 WHERE order_month = $4 AND order_year = $5
                   AND (settled_flag AND (settled_year * 12 + settled_month) <= (m.year * 12 + m.month))
                   AND NOT (returned_flag AND (returned_year * 12 + returned_month) <= (m.year * 12 + m.month))
               ), 0) AS origin_settled_as_of,
               COALESCE(SUM(total_amount) FILTER (
                 WHERE order_month = $4 AND order_year = $5
                   AND (returned_flag AND (returned_year * 12 + returned_month) <= (m.year * 12 + m.month))
               ), 0) AS origin_returned_as_of,
               COALESCE(SUM(total_amount) FILTER (
                 WHERE order_month = $4 AND order_year = $5
                   AND NOT (settled_flag AND (settled_year * 12 + settled_month) <= (m.year * 12 + m.month))
                   AND NOT (returned_flag AND (returned_year * 12 + returned_month) <= (m.year * 12 + m.month))
               ), 0) AS origin_pending_as_of
             FROM receivable_ledger
             WHERE brand_id = $1
           ) agg
           ORDER BY m.year, m.month`,
          { bind: [brandId, month, year, originMonth, originYear], transaction: t }
        );
        return rows;
      }

      const bind = [brandId, month, year, startIndex];
      let dimClause = '';
      if (channel) {
        bind.push(channel);
        dimClause += ` AND channel = $${bind.length}`;
      }
      if (courier) {
        bind.push(courier);
        dimClause += ` AND courier = $${bind.length}`;
      }
      let sourceClause = '';
      if (source) {
        bind.push(source);
        sourceClause = ` AND settled_source = $${bind.length}`;
      }

      const [rows] = await seq.query(
        `WITH months AS (
           SELECT DISTINCT order_month AS month, order_year AS year
           FROM receivable_ledger
           WHERE brand_id = $1 AND (order_year * 12 + order_month) <= ($3 * 12 + $2)
             AND (order_year * 12 + order_month) >= $4 ${dimClause}
         )
         SELECT m.month, m.year, agg.*
         FROM months m
         CROSS JOIN LATERAL (
           SELECT
             COALESCE(SUM(total_amount) FILTER (WHERE order_month = m.month AND order_year = m.year), 0) AS sales,
             COALESCE(SUM(total_amount) FILTER (
               WHERE order_month = m.month AND order_year = m.year
                 AND (settled_flag AND (settled_year * 12 + settled_month) <= (m.year * 12 + m.month))
                 AND NOT (returned_flag AND (returned_year * 12 + returned_month) <= (m.year * 12 + m.month))
                 ${sourceClause}
             ), 0) AS settled_of_own,
             COALESCE(SUM(total_amount) FILTER (
               WHERE order_month = m.month AND order_year = m.year
                 AND (returned_flag AND (returned_year * 12 + returned_month) <= (m.year * 12 + m.month))
             ), 0) AS returned_of_own,
             COALESCE(SUM(total_amount) FILTER (
               WHERE order_month = m.month AND order_year = m.year
                 AND NOT (settled_flag AND (settled_year * 12 + settled_month) <= (m.year * 12 + m.month))
                 AND NOT (returned_flag AND (returned_year * 12 + returned_month) <= (m.year * 12 + m.month))
             ), 0) AS this_month_own_receivable,
             COALESCE(SUM(total_amount) FILTER (
               WHERE (order_year * 12 + order_month) <= (m.year * 12 + m.month) AND (order_year * 12 + order_month) >= $4
                 AND NOT (settled_flag AND (settled_year * 12 + settled_month) <= (m.year * 12 + m.month))
                 AND NOT (returned_flag AND (returned_year * 12 + returned_month) <= (m.year * 12 + m.month))
             ), 0) AS total_receivable_as_of,
             COALESCE(SUM(total_amount) FILTER (
               WHERE (order_year * 12 + order_month) < (m.year * 12 + m.month) AND (order_year * 12 + order_month) >= $4
                 AND NOT (settled_flag AND (settled_year * 12 + settled_month) <= (m.year * 12 + m.month))
                 AND NOT (returned_flag AND (returned_year * 12 + returned_month) <= (m.year * 12 + m.month))
             ), 0) AS carried_forward_as_of,
             COALESCE(SUM(settled_amount) FILTER (
               WHERE settled_month = m.month AND settled_year = m.year AND order_month = m.month AND order_year = m.year
                 AND NOT (returned_flag AND (returned_year * 12 + returned_month) <= (m.year * 12 + m.month))
                 ${sourceClause}
             ), 0) AS received_from_own,
             COALESCE(SUM(settled_amount) FILTER (
               WHERE settled_month = m.month AND settled_year = m.year AND (order_year * 12 + order_month) < (m.year * 12 + m.month)
                 AND NOT (returned_flag AND (returned_year * 12 + returned_month) <= (m.year * 12 + m.month))
                 ${sourceClause}
             ), 0) AS received_from_carried_forward,
             COALESCE(SUM(settled_amount) FILTER (
               WHERE settled_month = m.month AND settled_year = m.year
                 AND NOT (returned_flag AND (returned_year * 12 + returned_month) <= (m.year * 12 + m.month))
                 ${sourceClause}
             ), 0) AS received_this_month,
             COALESCE(SUM(returned_amount) FILTER (
               WHERE returned_month = m.month AND returned_year = m.year AND (order_year * 12 + order_month) >= $4
             ), 0) AS returns_this_month,
             -- total_amount (not returned_amount) of orders from BEFORE m that were still
             -- open going into m (not yet settled as of the month before m) and got
             -- returned in m — the "returned" leg of the carried-forward bridge. Mirrors
             -- returned_of_carried_forward_this_month in getReceivableDashboard's kpis.
             COALESCE(SUM(total_amount) FILTER (
               WHERE returned_month = m.month AND returned_year = m.year
                 AND (order_year * 12 + order_month) < (m.year * 12 + m.month) AND (order_year * 12 + order_month) >= $4
                 AND NOT (settled_flag AND (settled_year * 12 + settled_month) <= ((m.year * 12 + m.month) - 1))
             ), 0) AS returned_of_carried_forward
           FROM receivable_ledger
           WHERE brand_id = $1 ${dimClause}
         ) agg
         ORDER BY m.year, m.month`,
        { bind, transaction: t }
      );
      return rows;
    });

    res.json({
      mode: (originMonth && originYear) ? 'origin' : 'ledger',
      period: { month, year },
      origin: (originMonth && originYear) ? { month: originMonth, year: originYear } : null,
      dimension: channel ? { type: 'channel', value: channel } : courier ? { type: 'courier', value: courier } : source ? { type: 'source', value: source } : null,
      months,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Fixed whitelist — mirrors COD_SHEET_ORDER in reco-engine/recon/receivable_cycle.py
// (plus "Main Sheet" and the real "Other COD" bucket the engine's own courierBucket()
// falls back to). Never interpolate the requested sheet key directly into SQL —
// this map is the only thing that ever reaches the query.
const RECEIVABLE_SHEET_FILTERS = {
  'Main Sheet': '',
  'COD main sheet': `AND payment_method = 'COD'`,
  'Delivery': `AND payment_method = 'COD' AND courier = 'Delivery'`,
  'Ekart': `AND payment_method = 'COD' AND courier = 'Ekart'`,
  'Xpressbees': `AND payment_method = 'COD' AND courier = 'Xpressbees'`,
  'DTDC': `AND payment_method = 'COD' AND courier = 'DTDC'`,
  'Self shipping': `AND payment_method = 'COD' AND courier = 'Self shipping'`,
  'Other COD': `AND payment_method = 'COD' AND courier = 'Other COD'`,
};
const RECEIVABLE_SHEET_ORDER = Object.keys(RECEIVABLE_SHEET_FILTERS);

// Whitelist of headers the "view sheet data" table exposes as Excel-style column
// filters. `expr` is the only thing that ever reaches raw SQL for a given key —
// never interpolate a client-supplied column name directly. SETTLED_ASOF/RETURNED_ASOF
// reference the fixed $2 (month) / $3 (year) bind positions, so callers of
// buildColumnFilterClause() must always start their bind array as [brandId, month, year, ...].
const RECEIVABLE_SHEET_COLUMNS = {
  date: `to_char(order_date, 'YYYY-MM-DD')`,
  invoice: `COALESCE(invoice_number, '')`,
  order: `COALESCE(sale_order_number, '')`,
  awb: `COALESCE(awb, '')`,
  channel: `COALESCE(channel, '')`,
  payment: `COALESCE(payment_method, '')`,
  total: `total_amount::text`,
  collection: `(CASE WHEN ${SETTLED_ASOF} THEN 'Settled' ELSE 'Pending' END)`,
  return: `(CASE WHEN ${RETURNED_ASOF} THEN 'Returned' ELSE 'Not Returned' END)`,
};

// Parses the `filters` query param (JSON object of column key -> selected values)
// and appends a parameterized `AND <expr> = ANY($n::text[])` clause per column,
// skipping unknown keys, empty arrays, and (if given) `excludeKey` itself — used by
// the column-values endpoint so a column's own selection never narrows its own list.
const buildColumnFilterClause = (rawFilters, bind, excludeKey) => {
  let filters = {};
  if (rawFilters) {
    try {
      filters = JSON.parse(rawFilters);
    } catch {
      return '';
    }
  }
  let clause = '';
  for (const [key, values] of Object.entries(filters)) {
    if (key === excludeKey) continue;
    if (!(key in RECEIVABLE_SHEET_COLUMNS)) continue;
    if (!Array.isArray(values) || !values.length) continue;
    const cleanValues = values.filter((v) => typeof v === 'string').slice(0, 500);
    if (!cleanValues.length) continue;
    bind.push(cleanValues);
    clause += ` AND ${RECEIVABLE_SHEET_COLUMNS[key]} = ANY($${bind.length}::text[])`;
  }
  return clause;
};

/**
 * GET /api/dashboard/receivables/:brandId/sheet?month=&year=&sheet=&status=&search=&filters=&page=&pageSize=
 * Row-level "sheet" browser behind the Receivable Dashboard's "View" button —
 * same tab set as the per-run Receivable Cycle workbook (Main Sheet, COD main
 * sheet, one tab per courier), but reading the cross-year receivable_ledger for
 * whichever month is selected on the dashboard, instead of a single upload's rows.
 * `filters` is a JSON-encoded { columnKey: [selectedValue, ...] } map driving the
 * per-header Excel-style checkbox filters (see RECEIVABLE_SHEET_COLUMNS).
 */
const getReceivableSheetRows = async (req, res) => {
  const { brandId } = req.params;
  const month = parseInt(req.query.month, 10);
  const year = parseInt(req.query.year, 10);
  const sheet = req.query.sheet || 'Main Sheet';
  const status = req.query.status || 'all'; // all | pending | settled | returned
  const search = (req.query.search || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(10, parseInt(req.query.pageSize, 10) || 50));

  if (!brandId || brandId === 'demo') return res.status(400).json({ error: 'brandId required' });
  if (!month || !year) return res.status(400).json({ error: 'month and year query params required' });
  if (!(sheet in RECEIVABLE_SHEET_FILTERS)) return res.status(400).json({ error: `Unknown sheet "${sheet}"` });

  // Gated by SETTLED_ASOF/RETURNED_ASOF (not the live settled_flag/returned_flag) so a
  // row settled or returned AFTER the selected month doesn't show as settled/returned
  // (or drop out of "pending") when browsing that earlier month's sheet.
  const statusClause = status === 'pending' ? `AND NOT ${SETTLED_ASOF}`
    : status === 'settled' ? `AND ${SETTLED_ASOF}`
    : status === 'returned' ? `AND ${RETURNED_ASOF}`
    : '';

  try {
    const seq = await getBrandSeq(brandId);
    const data = await withBypass(seq, async (t) => {
      const bind = [brandId, month, year];
      let searchClause = '';
      if (search) {
        bind.push(`%${search}%`);
        searchClause = `AND (invoice_number ILIKE $${bind.length} OR awb ILIKE $${bind.length} OR sale_order_number ILIKE $${bind.length})`;
      }
      const columnFilterClause = buildColumnFilterClause(req.query.filters, bind);
      const whereSql = `WHERE brand_id = $1 AND order_month = $2 AND order_year = $3
        ${RECEIVABLE_SHEET_FILTERS[sheet]} ${statusClause} ${searchClause} ${columnFilterClause}`;

      const [[{ count }]] = await seq.query(
        `SELECT COUNT(*) AS count FROM receivable_ledger ${whereSql}`,
        { bind, transaction: t }
      );

      bind.push(pageSize, (page - 1) * pageSize);
      const [rows] = await seq.query(
        `SELECT order_date, invoice_number, sale_order_number, awb, channel, payment_method, courier,
                total_amount, settled_flag, settled_amount, settled_month, settled_year, settled_source,
                returned_flag, returned_amount, returned_month, returned_year
         FROM receivable_ledger ${whereSql}
         ORDER BY order_date DESC, invoice_number
         LIMIT $${bind.length - 1} OFFSET $${bind.length}`,
        { bind, transaction: t }
      );
      return { rows, total: Number(count) };
    });

    res.json({
      sheet, page, pageSize, total: data.total, rows: data.rows,
      sheets: RECEIVABLE_SHEET_ORDER,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const COLUMN_VALUES_LIMIT = 500;

/**
 * GET /api/dashboard/receivables/:brandId/sheet/column-values?column=&month=&year=&sheet=&status=&search=&filters=&q=
 * Distinct values for one column of the sheet browser, scoped by the currently
 * active sheet tab / status pill / global search / other column filters (but NOT
 * this column's own filter, so its popup always lists every option — same
 * cascading behaviour as Excel's AutoFilter). `q` narrows the list for the
 * popup's own search box. Powers the per-header filter popovers.
 */
const getReceivableSheetColumnValues = async (req, res) => {
  const { brandId } = req.params;
  const month = parseInt(req.query.month, 10);
  const year = parseInt(req.query.year, 10);
  const sheet = req.query.sheet || 'Main Sheet';
  const status = req.query.status || 'all';
  const search = (req.query.search || '').trim();
  const column = req.query.column;
  const q = (req.query.q || '').trim();

  if (!brandId || brandId === 'demo') return res.status(400).json({ error: 'brandId required' });
  if (!month || !year) return res.status(400).json({ error: 'month and year query params required' });
  if (!(sheet in RECEIVABLE_SHEET_FILTERS)) return res.status(400).json({ error: `Unknown sheet "${sheet}"` });
  if (!(column in RECEIVABLE_SHEET_COLUMNS)) return res.status(400).json({ error: `Unknown column "${column}"` });

  const statusClause = status === 'pending' ? `AND NOT ${SETTLED_ASOF}`
    : status === 'settled' ? `AND ${SETTLED_ASOF}`
    : status === 'returned' ? `AND ${RETURNED_ASOF}`
    : '';

  try {
    const seq = await getBrandSeq(brandId);
    const data = await withBypass(seq, async (t) => {
      const bind = [brandId, month, year];
      let searchClause = '';
      if (search) {
        bind.push(`%${search}%`);
        searchClause = `AND (invoice_number ILIKE $${bind.length} OR awb ILIKE $${bind.length} OR sale_order_number ILIKE $${bind.length})`;
      }
      const columnFilterClause = buildColumnFilterClause(req.query.filters, bind, column);
      const expr = RECEIVABLE_SHEET_COLUMNS[column];
      let qClause = '';
      if (q) {
        bind.push(`%${q}%`);
        qClause = `AND ${expr} ILIKE $${bind.length}`;
      }
      const whereSql = `WHERE brand_id = $1 AND order_month = $2 AND order_year = $3
        ${RECEIVABLE_SHEET_FILTERS[sheet]} ${statusClause} ${searchClause} ${columnFilterClause} ${qClause}`;

      bind.push(COLUMN_VALUES_LIMIT + 1);
      const [rows] = await seq.query(
        `SELECT DISTINCT ${expr} AS value
         FROM receivable_ledger ${whereSql}
         AND ${expr} IS NOT NULL AND ${expr} <> ''
         ORDER BY 1
         LIMIT $${bind.length}`,
        { bind, transaction: t }
      );
      return rows.map((r) => r.value);
    });

    const truncated = data.length > COLUMN_VALUES_LIMIT;
    res.json({ column, values: truncated ? data.slice(0, COLUMN_VALUES_LIMIT) : data, truncated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Advance Amount Dashboard ─────────────────────────────────────────────────
// User-specified rule (2026-08-20, superseding the previous "found in the Sales
// Order Combined file → excluded for good, regardless of range" design): for a
// selected month range, get every Shopify Prepaid order whose gateway amount
// (Snapmint/BharatX/Razorpay) was RECEIVED in that range, then check each one
// against the Sales Order Combined file's resolution (delivery_status +
// dispatch_or_cancellation_date, set by matchDeliveryStatus) AS OF THE SELECTED
// RANGE'S END — not as a permanent, date-independent fact.
//   - No fulfillment record at all (delivery_status IS NULL), OR one exists but
//     its own date falls AFTER the selected range's end → still counts as
//     Advance for this range.
//   - A fulfillment record exists and its date falls ON OR BEFORE the selected
//     range's end → resolved as of this range → excluded.
// Worked example: order's prepaid cash arrives 25 May 2024, delivered 3 June
// 2024. Viewing May 2024 → May 2024: still Advance (delivery is after the
// range's end). Viewing May 2024 → June 2024: no longer Advance (delivery now
// falls within the range). Same order, same data, different as-of date — same
// convention the Receivable Dashboard already uses for settled_flag via
// SETTLED_ASOF, now applied to delivery here too (see advanceStillOpenAsOf).
//
// This dashboard's population is scoped to ADVANCE_HAS_GATEWAY — no stage
// breakdown, no status breakdown, no returns, since every row here took a
// prepaid-gateway advance and none of those axes apply.
//
// Sourced from receivable_ledger (the Receivable Cycle agent's own table) via the
// advance_amount_ledger view (db-restructure/024_receivable_ledger_advance_columns.sql)
// — NOT shopify_order_cycle, which held fabricated test data (Flo Mattress and Koparo
// had byte-identical rows).
const ADVANCE_TABLE = 'advance_amount_ledger';
const ADVANCE_GATEWAY_AMOUNT = `(COALESCE(snapmint_settlement_value,0) + COALESCE(bharatx_ledger_amount,0) + COALESCE(razorpay_settlement_amount,0))`;
// "This order actually received a Snapmint/BharatX/Razorpay advance" — on its own
// (no delivery_status condition) this is the scope for the "Track an order" lookup,
// so an order with zero advance money never shows up there just because it happens
// to match the search text.
const ADVANCE_HAS_GATEWAY = `(COALESCE(snapmint_settlement_value,0) > 0 OR COALESCE(bharatx_ledger_amount,0) > 0 OR COALESCE(razorpay_settlement_amount,0) > 0)`;
// Whichever gateway actually paid this order carries its own settlement-date column;
// only one of the three is ever populated per row, so COALESCE picks the one that's
// real. This is the dashboard's own period anchor (ADVANCE_MONTH_INDEX below) — "the
// month" always means the month the cash actually arrived.
const ADVANCE_RECEIVED_DATE = `COALESCE(snapmint_settlement_date, bharatx_settlement_timestamp, razorpay_settlement_date)`;
const ADVANCE_MONTH_INDEX = `(EXTRACT(YEAR FROM ${ADVANCE_RECEIVED_DATE} AT TIME ZONE 'Asia/Kolkata')::int * 12 + EXTRACT(MONTH FROM ${ADVANCE_RECEIVED_DATE} AT TIME ZONE 'Asia/Kolkata')::int)`;
const ADVANCE_IST_DATE = `(${ADVANCE_RECEIVED_DATE} AT TIME ZONE 'Asia/Kolkata')::date`;
// "Still Advance, as of the selected range's end" = took a gateway advance AND
// (no fulfillment record exists yet, OR its own resolution date is still in the
// future relative to the range being viewed). `toIdx` (year*12+month) is a plain
// JS-computed integer — safe to inline, same pattern as advanceAsOfDateLiteral.
const advanceStillOpenAsOf = (toMonth, toYear) => {
  const toIdx = toYear * 12 + toMonth;
  const resolvedIdx = `(EXTRACT(YEAR FROM dispatch_or_cancellation_date AT TIME ZONE 'Asia/Kolkata')::int * 12
    + EXTRACT(MONTH FROM dispatch_or_cancellation_date AT TIME ZONE 'Asia/Kolkata')::int)`;
  return `${ADVANCE_HAS_GATEWAY} AND (delivery_status IS NULL OR ${resolvedIdx} > ${toIdx})`;
};
// "days pending" = as-of date minus the received date — how long this cash has been
// sitting with no fulfillment record found for it at all. As-of is the END of the
// selected range's to-month, capped at today (see advanceAsOfDateLiteral below) — so
// picking "Mar 2024 → Mar 2024" ages every row against 31 Mar 2024, not the real
// calendar date, and a same-month order can be at most ~30 days pending. The one
// exception is the "Track an order" lookup (getAdvanceOrderStatus), which has no
// range at all and always ages against the real, live today (ADVANCE_ASOF_TODAY).
const ADVANCE_ASOF_TODAY = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;

// Advance Amount Dashboard's as-of date for a given selected range — the END of the
// selected range's to-month, capped at today. Same convention as the Payables
// Dashboard below (its own "days pending" = as-of date − return date), now shared
// instead of duplicated, since both dashboards anchor "how old is this" to the range
// being viewed rather than the real calendar date.
// Returns a `'YYYY-MM-DD'::date` SQL literal — inlined rather than bound because the
// query text conditionally references it (aging-bucket filters, days_pending column)
// across several queries that share one growing bind array, and Postgres requires a
// bind array's length to exactly match the placeholders actually referenced in each
// query. Safe to inline: built purely from validated integers via Date arithmetic,
// asserted to the exact YYYY-MM-DD shape before ever reaching SQL text.
const advanceAsOfDateLiteral = (toMonth, toYear) => {
  const todayIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const endOfToMonth = new Date(Date.UTC(toYear, toMonth, 0)).toISOString().slice(0, 10);
  const asOf = endOfToMonth < todayIst ? endOfToMonth : todayIst;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('invalid as-of date');
  return `'${asOf}'::date`;
};

const emptyAdvanceAmountDashboard = () => ({
  range: null,
  availableRange: null,
  kpis: null,
  byGateway: [],
  aging: [],
  monthlyTrend: [],
});

// Inverse of (year*12 + month) — month always lands in [1,12].
const monthIndexToPeriod = (idx) => {
  const i = Number(idx);
  const year = Math.floor((i - 1) / 12);
  return { month: i - year * 12, year };
};

/**
 * GET /api/dashboard/advance-amount/:brandId?fromMonth&fromYear&toMonth&toYear
 * No range given → defaults to the full span of available advance data.
 */
const getAdvanceAmountDashboard = async (req, res) => {
  const { brandId } = req.params;
  if (!brandId || brandId === 'demo') return res.status(400).json({ error: 'brandId required' });

  let fromMonth = parseInt(req.query.fromMonth, 10) || null;
  let fromYear = parseInt(req.query.fromYear, 10) || null;
  let toMonth = parseInt(req.query.toMonth, 10) || null;
  let toYear = parseInt(req.query.toYear, 10) || null;

  try {
    const seq = await getBrandSeq(brandId);

    // Scoped to ADVANCE_HAS_GATEWAY (any advance order) rather than the stricter
    // advanceStillOpenAsOf (also requires "not yet resolved as of the range's end")
    // — otherwise a brand whose advance orders have ALL since resolved would have
    // no still-open rows, min_idx would come back null, and the whole page would
    // render as "no advance data" even though Track an order (which uses the
    // broader scope) still has real data to show.
    const availableSpan = await withBypass(seq, async (t) => {
      const [[row]] = await seq.query(
        `SELECT MIN(${ADVANCE_MONTH_INDEX}) AS min_idx, MAX(${ADVANCE_MONTH_INDEX}) AS max_idx
         FROM ${ADVANCE_TABLE} WHERE brand_id = $1 AND ${ADVANCE_HAS_GATEWAY}`,
        { bind: [brandId], transaction: t }
      );
      return row;
    });

    if (availableSpan.min_idx == null) return res.json(emptyAdvanceAmountDashboard());

    const availableRange = {
      from: monthIndexToPeriod(availableSpan.min_idx),
      to: monthIndexToPeriod(availableSpan.max_idx),
    };

    if (!fromMonth || !fromYear) { fromMonth = availableRange.from.month; fromYear = availableRange.from.year; }
    if (!toMonth || !toYear) { toMonth = availableRange.to.month; toYear = availableRange.to.year; }

    const fromIdx = fromYear * 12 + fromMonth;
    const toIdx = toYear * 12 + toMonth;
    // Ages every row against the END of the selected range's to-month (capped at
    // today) — not the real calendar date — so "days pending" reflects how old the
    // cash was as of the period being viewed, matching the Payables Dashboard.
    const asOf = advanceAsOfDateLiteral(toMonth, toYear);
    const stillOpen = advanceStillOpenAsOf(toMonth, toYear);

    const data = await withBypass(seq, async (t) => {
      const bind = [brandId, fromIdx, toIdx];
      const whereSql = `WHERE brand_id = $1 AND ${stillOpen} AND ${ADVANCE_MONTH_INDEX} BETWEEN $2 AND $3`;

      const [[kpis]] = await seq.query(
        `SELECT
           COUNT(*) AS total_orders,
           COALESCE(SUM(${ADVANCE_GATEWAY_AMOUNT}), 0) AS total_advance_amount,
           COALESCE(AVG(${asOf} - ${ADVANCE_IST_DATE}), 0) AS avg_days_pending,
           COALESCE(MAX(${asOf} - ${ADVANCE_IST_DATE}), 0) AS oldest_days_pending
         FROM ${ADVANCE_TABLE} ${whereSql}`,
        { bind, transaction: t }
      );

      // One row per (order, gateway-that-actually-paid) — an order only appears more
      // than once here if more than one gateway shows money against it.
      const [byGateway] = await seq.query(
        `SELECT gateway, COUNT(*) AS orders, SUM(amount) AS amount FROM (
           SELECT 'Snapmint' AS gateway, snapmint_settlement_value AS amount FROM ${ADVANCE_TABLE} ${whereSql} AND COALESCE(snapmint_settlement_value,0) > 0
           UNION ALL
           SELECT 'BharatX' AS gateway, bharatx_ledger_amount AS amount FROM ${ADVANCE_TABLE} ${whereSql} AND COALESCE(bharatx_ledger_amount,0) > 0
           UNION ALL
           SELECT 'Razorpay' AS gateway, razorpay_settlement_amount AS amount FROM ${ADVANCE_TABLE} ${whereSql} AND COALESCE(razorpay_settlement_amount,0) > 0
         ) g GROUP BY gateway ORDER BY amount DESC`,
        { bind, transaction: t }
      );

      const [aging] = await seq.query(
        `SELECT
           CASE
             WHEN (${asOf} - ${ADVANCE_IST_DATE}) <= 7 THEN '0-7 days'
             WHEN (${asOf} - ${ADVANCE_IST_DATE}) <= 15 THEN '8-15 days'
             WHEN (${asOf} - ${ADVANCE_IST_DATE}) <= 30 THEN '16-30 days'
             WHEN (${asOf} - ${ADVANCE_IST_DATE}) <= 60 THEN '31-60 days'
             ELSE '60+ days'
           END AS bucket,
           MIN(CASE
             WHEN (${asOf} - ${ADVANCE_IST_DATE}) <= 7 THEN 1
             WHEN (${asOf} - ${ADVANCE_IST_DATE}) <= 15 THEN 2
             WHEN (${asOf} - ${ADVANCE_IST_DATE}) <= 30 THEN 3
             WHEN (${asOf} - ${ADVANCE_IST_DATE}) <= 60 THEN 4
             ELSE 5
           END) AS sort_order,
           COUNT(*) AS orders, SUM(${ADVANCE_GATEWAY_AMOUNT}) AS amount
         FROM ${ADVANCE_TABLE} ${whereSql}
         GROUP BY 1 ORDER BY sort_order`,
        { bind, transaction: t }
      );

      const [monthlyTrend] = await seq.query(
        `SELECT EXTRACT(YEAR FROM ${ADVANCE_RECEIVED_DATE} AT TIME ZONE 'Asia/Kolkata')::int AS year,
                EXTRACT(MONTH FROM ${ADVANCE_RECEIVED_DATE} AT TIME ZONE 'Asia/Kolkata')::int AS month,
                COUNT(*) AS orders, SUM(${ADVANCE_GATEWAY_AMOUNT}) AS amount
         FROM ${ADVANCE_TABLE} ${whereSql}
         GROUP BY 1, 2 ORDER BY 1, 2`,
        { bind, transaction: t }
      );

      return { kpis, byGateway, aging, monthlyTrend };
    });

    res.json({ range: { fromMonth, fromYear, toMonth, toYear }, availableRange, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Same bucket boundaries as the `aging` breakdown in getAdvanceAmountDashboard —
// keyed so a breakdown row's bucket label can be passed straight back as a filter.
// Takes the same range-anchored `asOf` literal (advanceAsOfDateLiteral) so this
// stays consistent with the dashboard's own aging buckets.
const advanceAgingClause = (agingBucket, asOf) => {
  const expr = `(${asOf} - ${ADVANCE_IST_DATE})`;
  const buckets = {
    '0-7 days':   `${expr} BETWEEN 0 AND 7`,
    '8-15 days':  `${expr} BETWEEN 8 AND 15`,
    '16-30 days': `${expr} BETWEEN 16 AND 30`,
    '31-60 days': `${expr} BETWEEN 31 AND 60`,
    '60+ days':   `${expr} > 60`,
  };
  return buckets[agingBucket] || '';
};

// Whitelist of headers the order browser exposes as Excel-style column filters —
// covers everything the gateway tabs / status pills don't already filter on. `expr`
// is the only thing that ever reaches raw SQL for a given key — never interpolate a
// client-supplied column name directly.
const ADVANCE_SHEET_COLUMNS = {
  date: `to_char(${ADVANCE_IST_DATE}, 'YYYY-MM-DD')`,
  order: `COALESCE(sale_order_number, '')`,
  invoice: `COALESCE(invoice_number, '')`,
  awb: `COALESCE(awb_number, '')`,
  platform: `COALESCE(platform, '')`,
};

// Parses the `filters` query param (JSON object of column key -> selected values)
// and appends a parameterized `AND <expr> = ANY($n::text[])` clause per column,
// skipping unknown keys, empty arrays, and (if given) `excludeKey` itself — used by
// the column-values endpoint so a column's own selection never narrows its own list.
const buildAdvanceColumnFilterClause = (rawFilters, bind, excludeKey) => {
  let filters = {};
  if (rawFilters) {
    try {
      filters = JSON.parse(rawFilters);
    } catch {
      return '';
    }
  }
  let clause = '';
  for (const [key, values] of Object.entries(filters)) {
    if (key === excludeKey) continue;
    if (!(key in ADVANCE_SHEET_COLUMNS)) continue;
    if (!Array.isArray(values) || !values.length) continue;
    const cleanValues = values.filter((v) => typeof v === 'string').slice(0, 500);
    if (!cleanValues.length) continue;
    bind.push(cleanValues);
    clause += ` AND ${ADVANCE_SHEET_COLUMNS[key]} = ANY($${bind.length}::text[])`;
  }
  return clause;
};

// Shared by getAdvanceAmountSheet and getAdvanceAmountSheetColumnValues — every
// filter EXCEPT the column-filter clause itself, which callers append separately
// (the column-values endpoint needs to exclude its own column's selection). No
// status filter here — advanceStillOpenAsOf already scopes this population to
// "not yet resolved as of the selected range's end" (whether that's no
// fulfillment record at all, or one dated after the range), so a status axis
// would carry zero information.
const buildAdvanceSheetBaseWhere = (req, bind) => {
  const gateway = req.query.gateway || 'all';
  const agingBucket = req.query.agingBucket || '';
  const search = (req.query.search || '').trim();
  const asOf = advanceAsOfDateLiteral(parseInt(req.query.toMonth, 10), parseInt(req.query.toYear, 10));

  const gatewayClause = gateway === 'snapmint' ? `AND COALESCE(snapmint_settlement_value,0) > 0`
    : gateway === 'bharatx' ? `AND COALESCE(bharatx_ledger_amount,0) > 0`
    : gateway === 'razorpay' ? `AND COALESCE(razorpay_settlement_amount,0) > 0`
    : '';
  const agingExpr = advanceAgingClause(agingBucket, asOf);
  const agingClause = agingExpr ? `AND ${agingExpr}` : '';

  let searchClause = '';
  if (search) {
    bind.push(`%${search}%`);
    searchClause = `AND (sale_order_number ILIKE $${bind.length} OR invoice_number ILIKE $${bind.length} OR awb_number ILIKE $${bind.length})`;
  }
  return `${gatewayClause} ${agingClause} ${searchClause}`;
};

/**
 * GET /api/dashboard/advance-amount/:brandId/sheet
 *   ?fromMonth&fromYear&toMonth&toYear&gateway=all|snapmint|bharatx|razorpay
 *   &agingBucket=<one of ADVANCE_AGING_BUCKETS>&sort=recent|oldest&search=&filters=&page=&pageSize=
 * Order-level rows behind the Advance Amount Dashboard's KPIs and every one of its
 * breakdown tables — same advanceStillOpenAsOf population, paginated, filterable by the
 * exact dimension a breakdown row or trend-chart point represents so every number on
 * the dashboard can be clicked through to the orders behind it. `filters` is a
 * JSON-encoded { columnKey: [selectedValue, ...] } map driving the per-header
 * Excel-style checkbox filters (see ADVANCE_SHEET_COLUMNS).
 */
const getAdvanceAmountSheet = async (req, res) => {
  const { brandId } = req.params;
  if (!brandId || brandId === 'demo') return res.status(400).json({ error: 'brandId required' });

  const fromMonth = parseInt(req.query.fromMonth, 10);
  const fromYear = parseInt(req.query.fromYear, 10);
  const toMonth = parseInt(req.query.toMonth, 10);
  const toYear = parseInt(req.query.toYear, 10);
  if (!fromMonth || !fromYear || !toMonth || !toYear) {
    return res.status(400).json({ error: 'fromMonth, fromYear, toMonth, toYear query params required' });
  }
  const sort = req.query.sort === 'oldest' ? 'oldest' : 'recent';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(10, parseInt(req.query.pageSize, 10) || 50));

  try {
    const seq = await getBrandSeq(brandId);
    const fromIdx = fromYear * 12 + fromMonth;
    const toIdx = toYear * 12 + toMonth;
    const asOf = advanceAsOfDateLiteral(toMonth, toYear);
    const stillOpen = advanceStillOpenAsOf(toMonth, toYear);

    const data = await withBypass(seq, async (t) => {
      const bind = [brandId, fromIdx, toIdx];
      const baseClauses = buildAdvanceSheetBaseWhere(req, bind);
      const columnFilterClause = buildAdvanceColumnFilterClause(req.query.filters, bind);
      const whereSql = `WHERE brand_id = $1 AND ${stillOpen} AND ${ADVANCE_MONTH_INDEX} BETWEEN $2 AND $3
        ${baseClauses} ${columnFilterClause}`;

      const [[{ count }]] = await seq.query(
        `SELECT COUNT(*) AS count FROM ${ADVANCE_TABLE} ${whereSql}`,
        { bind, transaction: t }
      );

      bind.push(pageSize, (page - 1) * pageSize);
      const [rows] = await seq.query(
        `SELECT date, sale_order_number, invoice_number, awb_number, platform,
                CASE
                  WHEN COALESCE(snapmint_settlement_value,0) > 0 THEN 'Snapmint'
                  WHEN COALESCE(bharatx_ledger_amount,0) > 0 THEN 'BharatX'
                  WHEN COALESCE(razorpay_settlement_amount,0) > 0 THEN 'Razorpay'
                  ELSE 'Unknown'
                END AS gateway,
                ${ADVANCE_GATEWAY_AMOUNT} AS gateway_amount, ${ADVANCE_RECEIVED_DATE} AS advance_received_date,
                total_amount,
                (${asOf} - ${ADVANCE_IST_DATE}) AS days_pending
         FROM ${ADVANCE_TABLE} ${whereSql}
         ORDER BY ${sort === 'oldest' ? 'days_pending DESC' : `${ADVANCE_RECEIVED_DATE} DESC`}
         LIMIT $${bind.length - 1} OFFSET $${bind.length}`,
        { bind, transaction: t }
      );
      return { rows, total: Number(count) };
    });

    res.json({ page, pageSize, total: data.total, rows: data.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const ADVANCE_COLUMN_VALUES_LIMIT = 500;

/**
 * GET /api/dashboard/advance-amount/:brandId/sheet/column-values
 *   ?fromMonth&fromYear&toMonth&toYear&gateway=&agingBucket=&search=&filters=&column=&q=
 * Distinct values for one column of the order browser, scoped by every other
 * currently-active filter (but NOT this column's own filter, so its popup always
 * lists every option) — same cascading behaviour as Excel's AutoFilter. `q` narrows
 * the list for the popup's own search box.
 */
const getAdvanceAmountSheetColumnValues = async (req, res) => {
  const { brandId } = req.params;
  if (!brandId || brandId === 'demo') return res.status(400).json({ error: 'brandId required' });

  const fromMonth = parseInt(req.query.fromMonth, 10);
  const fromYear = parseInt(req.query.fromYear, 10);
  const toMonth = parseInt(req.query.toMonth, 10);
  const toYear = parseInt(req.query.toYear, 10);
  if (!fromMonth || !fromYear || !toMonth || !toYear) {
    return res.status(400).json({ error: 'fromMonth, fromYear, toMonth, toYear query params required' });
  }
  const column = req.query.column;
  if (!(column in ADVANCE_SHEET_COLUMNS)) return res.status(400).json({ error: `Unknown column "${column}"` });
  const q = (req.query.q || '').trim();

  try {
    const seq = await getBrandSeq(brandId);
    const fromIdx = fromYear * 12 + fromMonth;
    const toIdx = toYear * 12 + toMonth;
    const stillOpen = advanceStillOpenAsOf(toMonth, toYear);

    const data = await withBypass(seq, async (t) => {
      const bind = [brandId, fromIdx, toIdx];
      const baseClauses = buildAdvanceSheetBaseWhere(req, bind);
      const columnFilterClause = buildAdvanceColumnFilterClause(req.query.filters, bind, column);
      const expr = ADVANCE_SHEET_COLUMNS[column];
      let qClause = '';
      if (q) {
        bind.push(`%${q}%`);
        qClause = `AND ${expr} ILIKE $${bind.length}`;
      }
      const whereSql = `WHERE brand_id = $1 AND ${stillOpen} AND ${ADVANCE_MONTH_INDEX} BETWEEN $2 AND $3
        ${baseClauses} ${columnFilterClause} ${qClause}`;

      bind.push(ADVANCE_COLUMN_VALUES_LIMIT + 1);
      const [rows] = await seq.query(
        `SELECT DISTINCT ${expr} AS value
         FROM ${ADVANCE_TABLE} ${whereSql}
         AND ${expr} IS NOT NULL AND ${expr} <> ''
         ORDER BY 1
         LIMIT $${bind.length}`,
        { bind, transaction: t }
      );
      return rows.map((r) => r.value);
    });

    const truncated = data.length > ADVANCE_COLUMN_VALUES_LIMIT;
    res.json({ column, values: truncated ? data.slice(0, ADVANCE_COLUMN_VALUES_LIMIT) : data, truncated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const ADVANCE_ORDER_STATUS_LIMIT = 20;

/**
 * GET /api/dashboard/advance-amount/:brandId/order-status?q=<order#, AWB, or invoice#>
 * Looks up an order's advance amount + received date, so an accountant can answer
 * "how much did we get for this order and when". Scoped to ADVANCE_HAS_GATEWAY only
 * (not advanceStillOpenAsOf, which also requires "not yet resolved as of a given
 * range's end" — and this lookup has no range at all) — this is a lookup tool on the
 * Advance Amount Dashboard, so it finds any order that actually took a Snapmint/BharatX/Razorpay advance, found in
 * the Sales Order Combined file or not. An order paid another way (COD, plain
 * checkout) has nothing to do with this page and won't turn up here even if its
 * order/invoice/AWB matches the search.
 */
const getAdvanceOrderStatus = async (req, res) => {
  const { brandId } = req.params;
  if (!brandId || brandId === 'demo') return res.status(400).json({ error: 'brandId required' });

  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q query param required' });

  try {
    const seq = await getBrandSeq(brandId);
    const rows = await withBypass(seq, async (t) => {
      const [rows] = await seq.query(
        `SELECT date, sale_order_number, invoice_number, awb_number, platform,
                CASE
                  WHEN COALESCE(snapmint_settlement_value,0) > 0 THEN 'Snapmint'
                  WHEN COALESCE(bharatx_ledger_amount,0) > 0 THEN 'BharatX'
                  WHEN COALESCE(razorpay_settlement_amount,0) > 0 THEN 'Razorpay'
                  ELSE 'Unknown'
                END AS gateway,
                total_amount, ${ADVANCE_GATEWAY_AMOUNT} AS gateway_amount, ${ADVANCE_RECEIVED_DATE} AS advance_received_date,
                (${ADVANCE_ASOF_TODAY} - ${ADVANCE_IST_DATE}) AS days_pending
         FROM ${ADVANCE_TABLE}
         WHERE brand_id = $1 AND ${ADVANCE_HAS_GATEWAY}
           AND (sale_order_number ILIKE $2 OR invoice_number ILIKE $2 OR awb_number ILIKE $2)
         ORDER BY ${ADVANCE_RECEIVED_DATE} DESC
         LIMIT $3`,
        { bind: [brandId, `%${q}%`, ADVANCE_ORDER_STATUS_LIMIT], transaction: t }
      );
      return rows;
    });

    res.json({ query: q, results: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Payables Dashboard ───────────────────────────────────────────────────────
// Money already collected from a customer for an order that was subsequently
// returned — a refund/credit-note liability we're sitting on, not revenue. This
// is the mirror image of the Receivable Dashboard (money owed TO us, not yet
// collected). Note this is now a DIFFERENT population than the Advance Amount
// Dashboard's own — that dashboard no longer looks at return_date at all (see its
// own comment above); a returned Shopify Prepaid order lives here regardless of
// whether it was ever found in the Sales Order Combined file.
//
// Combines three structurally different sources under one "payable" umbrella:
//   - Prepaid Gateway: shopify_order_cycle rows with return_date set AND a
//     Snapmint/BharatX/Razorpay settlement > 0. The gateway actually advanced
//     this cash before dispatch, so on a return it's what must be reconciled/paid
//     back — same ADVANCE_GATEWAY_AMOUNT used on the Advance dashboard, not
//     return_amount (verified against real data: return_amount is an unrelated
//     GST/credit-note figure from the Return-vs-Books agent, matches the gateway
//     amount in only ~4% of rows).
//   - COD and Marketplace Prepaid: receivable_ledger rows that had cash actually
//     land AND were later returned — i.e. cash came in, then the order came
//     back, regardless of payment_method. "Cash actually landed" means a
//     different thing per payment method (see PAYABLE_LEDGER_COLLECTED_THEN_RETURNED):
//     courier COD remittance for COD; for Prepaid it's unconditional — the
//     customer paid at checkout, full stop, regardless of settled_flag (which
//     now tracks something else entirely: whether the order was DELIVERED, i.e.
//     revenue-recognized, not whether cash was collected — see
//     receivableLedgerBuilder.js's loadTallyRows comment). The much larger
//     population of COD "returns" that were RTO'd before ever being collected
//     (no cash ever exchanged hands) has zero payable liability and is
//     deliberately excluded. Verified against real data: only ~3.5% of COD
//     "returns" fall in this collected-then-returned bucket; the other ~96% are
//     plain RTOs with nothing to pay back. Prepaid rows are kept as their own
//     'Marketplace Prepaid' source (not lumped into 'COD') since the
//     counterparty is a different kind of thing (the sales channel itself —
//     Amazon/Flipkart/Zepto/etc — not a courier), and channel groups on
//     receivable_ledger's own `channel` column instead of `courier` (blank for
//     Prepaid rows).
//
// Anchored on the RETURN event's month/year (not the order date) — that's when
// the liability actually came into existence, mirroring how the Advance
// dashboard anchors on the order date (when THAT liability began).
const PAYABLE_LEDGER_COLLECTED_THEN_RETURNED = `returned_flag AND (
  payment_method = 'PREPAID'
  OR (settled_flag AND (settled_year * 12 + settled_month) <= (returned_year * 12 + returned_month))
)`;
const PAYABLE_SHOPIFY_RETURNED_WITH_ADVANCE = `return_date IS NOT NULL AND ${ADVANCE_HAS_GATEWAY}`;
// receivable_ledger only carries returned_month/returned_year (no exact date), so
// COD rows are dated to the 1st of that month for date arithmetic (aging, sort,
// trend) — the conservative (oldest-possible) choice within the month, which is
// the safer direction to round for a liability figure.
const PAYABLE_COD_RETURN_DATE = `make_date(returned_year, returned_month, 1)`;

// One normalized row per payable order, regardless of source. `channel` is the
// counterparty that actually holds/moved the cash (gateway name for Prepaid
// Gateway rows, courier name for COD rows, sales channel/portal for Marketplace
// Prepaid rows) — the dimension the "by channel" breakdown groups on.
const payablesUnionSql = () => `
  SELECT 'Prepaid Gateway' AS source,
         CASE WHEN COALESCE(snapmint_settlement_value,0) > 0 THEN 'Snapmint'
              WHEN COALESCE(bharatx_ledger_amount,0) > 0 THEN 'BharatX'
              ELSE 'Razorpay' END AS channel,
         ${ADVANCE_GATEWAY_AMOUNT} AS amount,
         (return_date AT TIME ZONE 'Asia/Kolkata')::date AS return_date,
         EXTRACT(YEAR FROM return_date AT TIME ZONE 'Asia/Kolkata')::int AS return_year,
         EXTRACT(MONTH FROM return_date AT TIME ZONE 'Asia/Kolkata')::int AS return_month,
         (date AT TIME ZONE 'Asia/Kolkata')::date AS order_date, sale_order_number AS order_number, invoice_number,
         awb_number AS awb, platform
  FROM advance_amount_ledger
  WHERE brand_id = $1 AND ${PAYABLE_SHOPIFY_RETURNED_WITH_ADVANCE}
  UNION ALL
  SELECT 'COD' AS source,
         courier AS channel,
         settled_amount AS amount,
         ${PAYABLE_COD_RETURN_DATE} AS return_date,
         returned_year AS return_year,
         returned_month AS return_month,
         order_date, sale_order_number AS order_number, invoice_number,
         awb, channel AS platform
  FROM receivable_ledger
  WHERE brand_id = $1 AND payment_method = 'COD' AND ${PAYABLE_LEDGER_COLLECTED_THEN_RETURNED}
  UNION ALL
  SELECT 'Marketplace Prepaid' AS source,
         channel AS channel,
         total_amount AS amount,
         ${PAYABLE_COD_RETURN_DATE} AS return_date,
         returned_year AS return_year,
         returned_month AS return_month,
         order_date, sale_order_number AS order_number, invoice_number,
         awb, channel AS platform
  FROM receivable_ledger
  -- total_amount, not settled_amount: settled_amount is only populated once a
  -- delivery_status upload confirms delivery (may still be NULL here), but the
  -- Prepaid liability itself is the order's own sale amount, known from the Tally
  -- row regardless of delivery/settlement status. Excludes Shopify: those rows are
  -- already covered by the "Prepaid Gateway" branch above (advance_amount_ledger is
  -- scoped to payment_method='PREPAID' AND channel='Shopify' on this same
  -- receivable_ledger table) — without this exclusion a returned Shopify Prepaid
  -- order would double-count across both branches.
  WHERE brand_id = $1 AND payment_method = 'PREPAID' AND channel <> 'Shopify' AND ${PAYABLE_LEDGER_COLLECTED_THEN_RETURNED}
`;
const PAYABLE_MONTH_INDEX = `(return_year * 12 + return_month)`;

// AP-style aging buckets (wider than the Advance dashboard's day buckets, since a
// refund liability can realistically sit for months, not just days). Shared
// between the dashboard's aging breakdown and the sheet's aging-bucket filter so
// a breakdown row's bucket label can be passed straight back as a filter, same
// pattern as advanceAgingClause.
const PAYABLE_AGING_BUCKETS = new Set(['0-30 days', '31-60 days', '61-90 days', '91-180 days', '180+ days']);
const PAYABLE_AGING_BUCKET_SORT = { '0-30 days': 1, '31-60 days': 2, '61-90 days': 3, '91-180 days': 4, '180+ days': 5 };
const payableAgingBucketClause = (agingBucket, asOfLiteral) => {
  const expr = `(${asOfLiteral} - return_date)`;
  const buckets = {
    '0-30 days':   `${expr} BETWEEN 0 AND 30`,
    '31-60 days':  `${expr} BETWEEN 31 AND 60`,
    '61-90 days':  `${expr} BETWEEN 61 AND 90`,
    '91-180 days': `${expr} BETWEEN 91 AND 180`,
    '180+ days':   `${expr} > 180`,
  };
  return buckets[agingBucket] || '';
};
const payableAgingBucketCase = (asOfLiteral) => `CASE
  ${[...PAYABLE_AGING_BUCKETS].map((b) => `WHEN ${payableAgingBucketClause(b, asOfLiteral)} THEN '${b}'`).join('\n  ')}
END`;

const emptyPayablesDashboard = () => ({
  range: null,
  availableRange: null,
  kpis: null,
  bySource: [],
  byChannel: [],
  aging: [],
  monthlyTrend: [],
});

/**
 * GET /api/dashboard/payables/:brandId?fromMonth&fromYear&toMonth&toYear
 * No range given → defaults to the full span of available payables data.
 */
const getPayablesDashboard = async (req, res) => {
  const { brandId } = req.params;
  if (!brandId || brandId === 'demo') return res.status(400).json({ error: 'brandId required' });

  let fromMonth = parseInt(req.query.fromMonth, 10) || null;
  let fromYear = parseInt(req.query.fromYear, 10) || null;
  let toMonth = parseInt(req.query.toMonth, 10) || null;
  let toYear = parseInt(req.query.toYear, 10) || null;

  try {
    const seq = await getBrandSeq(brandId);

    const availableSpan = await withBypass(seq, async (t) => {
      const [[row]] = await seq.query(
        `SELECT MIN(${PAYABLE_MONTH_INDEX}) AS min_idx, MAX(${PAYABLE_MONTH_INDEX}) AS max_idx
         FROM (${payablesUnionSql()}) combined`,
        { bind: [brandId], transaction: t }
      );
      return row;
    });

    if (availableSpan.min_idx == null) return res.json(emptyPayablesDashboard());

    const availableRange = {
      from: monthIndexToPeriod(availableSpan.min_idx),
      to: monthIndexToPeriod(availableSpan.max_idx),
    };

    if (!fromMonth || !fromYear) { fromMonth = availableRange.from.month; fromYear = availableRange.from.year; }
    if (!toMonth || !toYear) { toMonth = availableRange.to.month; toYear = availableRange.to.year; }

    const fromIdx = fromYear * 12 + fromMonth;
    const toIdx = toYear * 12 + toMonth;

    const data = await withBypass(seq, async (t) => {
      const ASOF = advanceAsOfDateLiteral(toMonth, toYear);
      const bind = [brandId, fromIdx, toIdx];
      const combinedSql = `WITH combined AS (${payablesUnionSql()})
        SELECT * FROM combined WHERE ${PAYABLE_MONTH_INDEX} BETWEEN $2 AND $3`;

      const [[kpis]] = await seq.query(
        `WITH scoped AS (${combinedSql})
         SELECT
           COUNT(*) AS total_orders,
           COALESCE(SUM(amount), 0) AS total_payable_amount,
           COALESCE(AVG(${ASOF} - return_date), 0) AS avg_days_pending,
           COALESCE(MAX(${ASOF} - return_date), 0) AS oldest_days_pending
         FROM scoped`,
        { bind, transaction: t }
      );

      const [bySource] = await seq.query(
        `WITH scoped AS (${combinedSql})
         SELECT source, COUNT(*) AS orders, COALESCE(SUM(amount), 0) AS amount
         FROM scoped GROUP BY source ORDER BY amount DESC`,
        { bind, transaction: t }
      );

      const [byChannel] = await seq.query(
        `WITH scoped AS (${combinedSql})
         SELECT source, channel, COUNT(*) AS orders, COALESCE(SUM(amount), 0) AS amount
         FROM scoped GROUP BY source, channel ORDER BY source, amount DESC`,
        { bind, transaction: t }
      );

      const [agingRaw] = await seq.query(
        `WITH scoped AS (${combinedSql})
         SELECT ${payableAgingBucketCase(ASOF)} AS bucket, COUNT(*) AS orders, COALESCE(SUM(amount), 0) AS amount
         FROM scoped
         GROUP BY 1`,
        { bind, transaction: t }
      );
      const aging = agingRaw
        .map((r) => ({ ...r, sort_order: PAYABLE_AGING_BUCKET_SORT[r.bucket] }))
        .sort((a, b) => a.sort_order - b.sort_order);

      const [monthlyTrend] = await seq.query(
        `WITH scoped AS (${combinedSql})
         SELECT return_year AS year, return_month AS month, source,
                COUNT(*) AS orders, COALESCE(SUM(amount), 0) AS amount
         FROM scoped GROUP BY 1, 2, 3 ORDER BY 1, 2`,
        { bind, transaction: t }
      );

      return { kpis, bySource, byChannel, aging, monthlyTrend };
    });

    res.json({ range: { fromMonth, fromYear, toMonth, toYear }, availableRange, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const PAYABLES_SHEET_PAGE_SIZE_DEFAULT = 50;

/**
 * GET /api/dashboard/payables/:brandId/sheet?fromMonth&fromYear&toMonth&toYear
 *   &source=all|prepaid|cod|marketplace_prepaid&q=<order#, invoice#, or AWB>&sort=recent|oldest&page&pageSize
 * Order-level rows behind the Payables KPIs/breakdowns, paginated.
 */
const getPayablesSheet = async (req, res) => {
  const { brandId } = req.params;
  if (!brandId || brandId === 'demo') return res.status(400).json({ error: 'brandId required' });

  const fromMonth = parseInt(req.query.fromMonth, 10);
  const fromYear = parseInt(req.query.fromYear, 10);
  const toMonth = parseInt(req.query.toMonth, 10);
  const toYear = parseInt(req.query.toYear, 10);
  if (!fromMonth || !fromYear || !toMonth || !toYear) {
    return res.status(400).json({ error: 'fromMonth, fromYear, toMonth, toYear query params required' });
  }
  const source = ['prepaid', 'cod', 'marketplace_prepaid'].includes(req.query.source) ? req.query.source : 'all';
  const channel = (req.query.channel || '').trim();
  const agingBucket = PAYABLE_AGING_BUCKETS.has(req.query.agingBucket) ? req.query.agingBucket : null;
  const sort = req.query.sort === 'oldest' ? 'oldest' : 'recent';
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(10, parseInt(req.query.pageSize, 10) || PAYABLES_SHEET_PAGE_SIZE_DEFAULT));

  try {
    const seq = await getBrandSeq(brandId);
    const fromIdx = fromYear * 12 + fromMonth;
    const toIdx = toYear * 12 + toMonth;

    const data = await withBypass(seq, async (t) => {
      const ASOF = advanceAsOfDateLiteral(toMonth, toYear);
      const bind = [brandId, fromIdx, toIdx];
      let sourceClause = '';
      if (source === 'prepaid') sourceClause = `AND source = 'Prepaid Gateway'`;
      if (source === 'cod') sourceClause = `AND source = 'COD'`;
      if (source === 'marketplace_prepaid') sourceClause = `AND source = 'Marketplace Prepaid'`;
      let channelClause = '';
      if (channel) {
        bind.push(channel);
        channelClause = `AND channel = $${bind.length}`;
      }
      let agingClause = '';
      if (agingBucket) agingClause = `AND ${payableAgingBucketClause(agingBucket, ASOF)}`;
      let qClause = '';
      if (q) {
        bind.push(`%${q}%`);
        qClause = `AND (order_number ILIKE $${bind.length} OR invoice_number ILIKE $${bind.length} OR awb ILIKE $${bind.length})`;
      }
      const combinedSql = `WITH combined AS (${payablesUnionSql()})
        SELECT * FROM combined WHERE ${PAYABLE_MONTH_INDEX} BETWEEN $2 AND $3 ${sourceClause} ${channelClause} ${agingClause} ${qClause}`;

      const [[{ count }]] = await seq.query(
        `SELECT COUNT(*) AS count FROM (${combinedSql}) c`,
        { bind, transaction: t }
      );

      bind.push(pageSize, (page - 1) * pageSize);
      const [rows] = await seq.query(
        `${combinedSql}
         ORDER BY return_date ${sort === 'oldest' ? 'ASC' : 'DESC'}
         LIMIT $${bind.length - 1} OFFSET $${bind.length}`,
        { bind, transaction: t }
      );
      return { rows, total: Number(count) };
    });

    res.json({ page, pageSize, total: data.total, rows: data.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { getRecoHistory, getJobResults, getDashboardSummary, getJobById, getAdminToolAnalytics, getUserActivity, getToolDetails, getUsersOverview, getBrandActivity, getBrandAgentDetail, getReceivableDashboard, getReceivableJourney, getReceivableSheetRows, getReceivableSheetColumnValues, getAdvanceAmountDashboard, getAdvanceAmountSheet, getAdvanceAmountSheetColumnValues, getAdvanceOrderStatus, getPayablesDashboard, getPayablesSheet };
