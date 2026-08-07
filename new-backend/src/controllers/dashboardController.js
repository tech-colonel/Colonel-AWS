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
  settledOfThisMonthsSalesBySource: [],
  carriedForwardCollections: [],
  salesByChannel: [],
  courierAging: [],
  thisMonthPendingByCourier: [],
  receivableByCourierAsOfDate: [],
  returnsBySource: [],
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
  credit_card_booking: 'Credit Card Booking',
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
           -- (COD+Prepaid, no payment_method filter) — Prepaid rows are always settled
           -- the same month they're sold (see buildReceivableLedger.js), so they always
           -- fall out of this filter on their own and contribute exactly ₹0; the number
           -- is unaffected, but the population now matches every other KPI on this card
           -- exactly, so Sales − Returned − Settled always reconciles to this to the rupee.
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
           COALESCE(SUM(total_amount) FILTER (WHERE order_month = $2 AND order_year = $3 AND ${RETURNED_ASOF}), 0) AS returned_of_this_months_sales
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
      // where the order shipped from (courier, or "Prepaid" for prepaid orders,
      // which get returned too — not just COD).
      const [returnsBySource] = await seq.query(
        `SELECT CASE WHEN payment_method = 'PREPAID' THEN 'Prepaid'
                     ELSE COALESCE(NULLIF(courier, ''), 'Other COD') END AS source,
                COUNT(*) AS count, SUM(returned_amount) AS amount
         FROM receivable_ledger
         WHERE brand_id = $1 AND returned_month = $2 AND returned_year = $3 AND (order_year * 12 + order_month) >= $4
         GROUP BY 1 ORDER BY amount DESC`,
        { bind, transaction: t }
      );

      // Also behind "Returns (SRN)" — this month's returns broken down by which
      // ORIGIN month the underlying sale happened in. A return processed this month
      // is very often for a sale from a previous month, not this month's own — this
      // is what makes that visible instead of one lump total.
      const [returnsByMonth] = await seq.query(
        `SELECT order_month AS month, order_year AS year, COUNT(*) AS count, SUM(returned_amount) AS amount
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

      return { kpis, receivedBySource, receivedByChannel, settledOfThisMonthsSalesBySource, carriedForwardCollections, salesByChannel, courierAging, thisMonthPendingByCourier, receivableByCourierAsOfDate, returnsBySource, returnsByMonth, monthlyTrend, receivableByMonth, dataQualityTotals, dataQualityBySource };
    });

    res.json({
      period: { month, year },
      cycleStart: startIndex > 0 ? { month: startMonth, year: startYear } : null,
      kpis: data.kpis,
      receivedBySource: data.receivedBySource,
      receivedByChannel: data.receivedByChannel,
      settledOfThisMonthsSalesBySource: data.settledOfThisMonthsSalesBySource,
      carriedForwardCollections: data.carriedForwardCollections,
      salesByChannel: data.salesByChannel,
      courierAging: data.courierAging,
      thisMonthPendingByCourier: data.thisMonthPendingByCourier,
      receivableByCourierAsOfDate: data.receivableByCourierAsOfDate,
      returnsBySource: data.returnsBySource,
      returnsByMonth: data.returnsByMonth,
      monthlyTrend: data.monthlyTrend,
      receivableByMonth: data.receivableByMonth,
      dataQuality: { ...data.dataQualityTotals, bySource: data.dataQualityBySource },
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

/**
 * GET /api/dashboard/receivables/:brandId/sheet?month=&year=&sheet=&status=&search=&page=&pageSize=
 * Row-level "sheet" browser behind the Receivable Dashboard's "View" button —
 * same tab set as the per-run Receivable Cycle workbook (Main Sheet, COD main
 * sheet, one tab per courier), but reading the cross-year receivable_ledger for
 * whichever month is selected on the dashboard, instead of a single upload's rows.
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
      const whereSql = `WHERE brand_id = $1 AND order_month = $2 AND order_year = $3
        ${RECEIVABLE_SHEET_FILTERS[sheet]} ${statusClause} ${searchClause}`;

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

module.exports = { getRecoHistory, getJobResults, getDashboardSummary, getJobById, getAdminToolAnalytics, getUserActivity, getToolDetails, getUsersOverview, getBrandActivity, getBrandAgentDetail, getReceivableDashboard, getReceivableSheetRows };
