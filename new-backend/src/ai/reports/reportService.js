/* ── Colonel AI — canned usage reports (role-scoped, NO free-form SQL) ───────
   Safe, parameterized aggregations over reco_jobs (which records who ran which
   agent on which brand, and when). NEVER LLM-generated SQL. Role scoping is
   enforced HERE in code, not by the model:
     - admin      → all users, all brands
     - non-admin  → ONLY their own runs (created_by = self), their own brands
   Reuses the exact per-brand scan pattern from dashboardController's admin
   tool-analytics (Brand.findAll → per-brand connection → withBypass → aggregate
   in JS), so it works with unified-DB RLS.

   Additive + read-only: no agent logic, no writes.                            */

const { Brand, User } = require('../../models/master');
const { getBrandConnection, UNIFIED } = require('../../config/database');

// Friendly tool labels (kept in sync with dashboardController.TOOL_LABELS).
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
  receivable_cycle: 'Receivables / Order Cycle',
  bank_tally_reco: 'Bank vs Tally Reco',
};
const toolLabel = (k) => TOOL_LABELS[k] || k || 'Unknown';

const withBypass = async (seq, queryFn) =>
  seq.transaction(async (t) => {
    // UNIFIED: do NOT bypass — the brand connection presets app.brand_id and RLS
    // scopes each query to that brand (we aggregate across brands in JS). OFF:
    // bypass, since isolation is the physical brand DB.
    if (!UNIFIED) await seq.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
    return queryFn(t);
  });

/* Scan reco_jobs across every brand, grouped by (agent_type, created_by).
   scopeUserId != null restricts to that user's own runs (non-admin). Returns
   facts tagged with brand id + name so any report shape can be built from them. */
async function scanFacts(scopeUserId) {
  const brands = await Brand.findAll();
  const facts = [];
  for (const b of brands) {
    let seq;
    try { seq = getBrandConnection(b.db_name); } catch { continue; }
    try {
      const rows = await withBypass(seq, async (t) => {
        const [r] = await seq.query(
          `SELECT agent_type,
                  created_by,
                  COUNT(*)::int                       AS runs,
                  COALESCE(SUM(total_rows),0)::int    AS rows,
                  COALESCE(SUM(matched_rows),0)::int  AS matched,
                  MAX(created_at)                     AS last_run
           FROM reco_jobs
           WHERE ($1::uuid IS NULL OR created_by = $1)
           GROUP BY agent_type, created_by`,
          { bind: [scopeUserId], transaction: t });
        return r;
      });
      for (const r of rows) {
        facts.push({
          brandId: b.id,
          brandName: b.name,
          agentType: r.agent_type || 'unknown',
          userId: r.created_by || null,
          runs: r.runs, rows: r.rows, matched: r.matched, lastRun: r.last_run,
        });
      }
    } catch { /* brand without reco_jobs / unreachable — skip */ }
  }
  return facts;
}

// Resolve created_by UUIDs → display names.
async function userNameMap(ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return {};
  const users = await User.findAll({ where: { id: uniq }, attributes: ['id', 'name', 'email'] });
  const map = {};
  for (const u of users) map[u.id] = u.name || u.email || 'Unknown';
  return map;
}

const sumBy = (facts, keyFn) => {
  const m = {};
  for (const f of facts) {
    const k = keyFn(f);
    if (!m[k]) m[k] = { runs: 0, rows: 0, matched: 0 };
    m[k].runs += f.runs; m[k].rows += f.rows; m[k].matched += f.matched;
  }
  return m;
};

const totalRuns = (facts) => facts.reduce((s, f) => s + f.runs, 0);

/**
 * buildReport — returns a ready-to-render report.
 * @param {string} key one of usage_by_tool | usage_by_brand | usage_by_user | who_uses_what | my_usage
 * @param {{userId:string, isAdmin:boolean}} ctx
 * @returns {Promise<{key,title,summary,columns,rows,chart}>}
 */
async function buildReport(key, ctx) {
  const isAdmin = !!ctx.isAdmin;
  const scopeUserId = isAdmin ? null : ctx.userId; // non-admin → own runs only
  const facts = await scanFacts(scopeUserId);
  const grand = totalRuns(facts);

  const emptyNote = grand === 0
    ? (isAdmin ? 'No reconciliation runs have been recorded yet.' : 'You have no reconciliation runs recorded yet.')
    : '';

  if (key === 'usage_by_brand') {
    const m = sumBy(facts, (f) => f.brandName);
    const rows = Object.entries(m).map(([brand, v]) => ({ brand, runs: v.runs, rows: v.rows }))
      .sort((a, b) => b.runs - a.runs);
    return {
      key, title: isAdmin ? 'Usage by brand' : 'Your usage by brand',
      summary: emptyNote || `${grand} run(s) across ${rows.length} brand(s). Top: ${rows.slice(0, 3).map((r) => `${r.brand} (${r.runs})`).join(', ')}.`,
      columns: [{ key: 'brand', label: 'Brand' }, { key: 'runs', label: 'Runs' }, { key: 'rows', label: 'Rows' }],
      rows,
      chart: { type: 'bar', xKey: 'brand', yKey: 'runs', data: rows.slice(0, 12).map((r) => ({ label: r.brand, runs: r.runs })) },
    };
  }

  if (key === 'usage_by_user') {
    const m = sumBy(facts, (f) => f.userId || 'unknown');
    const names = await userNameMap(Object.keys(m));
    const rows = Object.entries(m).map(([uid, v]) => ({ user: names[uid] || 'Unknown', runs: v.runs, rows: v.rows }))
      .sort((a, b) => b.runs - a.runs);
    return {
      key, title: 'Usage by user',
      summary: emptyNote || `${grand} run(s) by ${rows.length} user(s). Most active: ${rows.slice(0, 3).map((r) => `${r.user} (${r.runs})`).join(', ')}.`,
      columns: [{ key: 'user', label: 'User' }, { key: 'runs', label: 'Runs' }, { key: 'rows', label: 'Rows' }],
      rows,
      chart: { type: 'bar', xKey: 'user', yKey: 'runs', data: rows.slice(0, 12).map((r) => ({ label: r.user, runs: r.runs })) },
    };
  }

  if (key === 'who_uses_what') {
    const names = await userNameMap(facts.map((f) => f.userId));
    const rows = facts
      .map((f) => ({ user: names[f.userId] || 'Unknown', tool: toolLabel(f.agentType), brand: f.brandName, runs: f.runs }))
      .sort((a, b) => b.runs - a.runs);
    return {
      key, title: 'Who uses which tools, on which brands',
      summary: emptyNote || `${rows.length} user-tool-brand combination(s), ${grand} run(s) total.`,
      columns: [
        { key: 'user', label: 'User' }, { key: 'tool', label: 'Tool' },
        { key: 'brand', label: 'Brand' }, { key: 'runs', label: 'Runs' },
      ],
      rows,
      chart: { type: 'bar', xKey: 'user', yKey: 'runs', data: (() => {
        const byUser = sumBy(facts.map((f) => ({ ...f, _u: names[f.userId] || 'Unknown' })), (f) => f._u);
        return Object.entries(byUser).map(([label, v]) => ({ label, runs: v.runs })).sort((a, b) => b.runs - a.runs).slice(0, 12);
      })() },
    };
  }

  // Default: usage_by_tool (and my_usage — same shape, already scoped to self).
  const m = sumBy(facts, (f) => f.agentType);
  const rows = Object.entries(m).map(([tool, v]) => ({
    tool: toolLabel(tool), runs: v.runs, rows: v.rows,
    matchRate: v.rows > 0 ? Math.round((v.matched / v.rows) * 1000) / 10 : null,
  })).sort((a, b) => b.runs - a.runs);
  const mine = key === 'my_usage';
  return {
    key: mine ? 'my_usage' : 'usage_by_tool',
    title: mine ? 'Your usage by tool' : (isAdmin ? 'Usage by tool (all brands)' : 'Your usage by tool'),
    summary: emptyNote || `${grand} run(s) across ${rows.length} tool(s). Most used: ${rows.slice(0, 3).map((r) => `${r.tool} (${r.runs})`).join(', ')}.`,
    columns: [{ key: 'tool', label: 'Tool' }, { key: 'runs', label: 'Runs' }, { key: 'rows', label: 'Rows' }, { key: 'matchRate', label: 'Match %' }],
    rows,
    chart: { type: 'bar', xKey: 'tool', yKey: 'runs', data: rows.slice(0, 12).map((r) => ({ label: r.tool, runs: r.runs })) },
  };
}

const ADMIN_ONLY = new Set(['usage_by_user', 'who_uses_what']);

module.exports = { buildReport, ADMIN_ONLY };
