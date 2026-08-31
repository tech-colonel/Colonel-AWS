/* ── Colonel AI — live dashboard context for the chat ──────────────────────
   Given a brandId (+ optional agentType) the chat is scoped to, build a
   compact PLAIN-TEXT snapshot of that brand's reconciliation dashboard —
   the same `reco_jobs` numbers the Brand Dashboard renders — so Colonel AI
   can answer "how many runs…", "what's my match rate…", "when did I last
   run GSTR-2B…" from real data instead of guessing.

   READ-ONLY. Brand-access gated (admin, or a `brand_users` link). Mirrors
   dashboardController's RLS handling: in UNIFIED mode the brand connection
   presets `app.brand_id`, so RLS already scopes every query to this brand
   and we must NOT bypass it (bypassing would leak other brands).           */

const { getBrandConnection, UNIFIED } = require('../config/database');
const { Brand, BrandUser } = require('../models/master');

// Best-effort agent_type → human label (matches frontend RECO_AGENT_SPECS).
const AGENT_LABELS = {
  credit_card_booking: 'Credit Card Booking',
  gstr_2b_books: 'GSTR-2B vs Books',
  gstr_2b_books_multistate: 'GSTR-2B vs Books (Multi-State)',
  gstr_2b_vs_purchase: 'GSTR-2B vs Purchase Register',
  gstr_2a_vs_2b_vs_books: 'GSTR-2A vs 2B vs Books (3-way)',
  gstr_2a_2b_books: 'GSTR-2A vs 2B vs Books (3-way)',
  gstr_3b_vs_2b: 'GSTR-3B vs GSTR-2B',
  gstr_1_vs_books: 'GSTR-1 vs Books',
  universal_bank_statement: 'Universal Bank Statement',
  bank_reco: 'Universal Bank Statement',
  gstr_3b_tally_entry: 'GSTR-3B Tally Entry',
  zepto_receivables: 'Zepto Receivables',
  receivable_cycle: 'Receivable Cycle',
};
const labelFor = (t) => AGENT_LABELS[t] || t || '';

const userCanAccessBrand = async (user, brandId) => {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const link = await BrandUser.findOne({ where: { brand_id: brandId, user_id: user.id } });
  return !!link;
};

const withBypass = (seq, fn) =>
  seq.transaction(async (t) => {
    if (!UNIFIED) await seq.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
    return fn(t);
  });

const ymd = (d) => {
  try { return new Date(d).toISOString().slice(0, 10); } catch (_) { return String(d || ''); }
};

/**
 * @param {object} opts
 * @param {object} opts.user       req.user (id, role)
 * @param {string} opts.brandId
 * @param {string} [opts.agentType]  reco agent_type the chat is focused on
 * @param {string} [opts.brandName]  client-supplied label (display only)
 * @param {string} [opts.agentLabel] client-supplied label (display only)
 * @returns {Promise<string|null>}   plain-text context block, or null if
 *                                   unavailable / no access / no data.
 */
async function buildDashboardContext({ user, brandId, agentType, brandName, agentLabel } = {}) {
  if (!brandId || brandId === 'demo' || brandId === 'other') return null;
  try {
    if (!(await userCanAccessBrand(user, brandId))) return null;
    const brand = await Brand.findByPk(brandId);
    if (!brand) return null;

    const seq = getBrandConnection(brand.db_name);
    // Non-admins only ever see their own jobs (mirrors effectiveUserId()).
    const uid = user && user.role === 'admin' ? null : (user && user.id) || null;

    const data = await withBypass(seq, async (t) => {
      const q = (sql, bind) => seq.query(sql, { bind, transaction: t }).then(([r]) => r);
      const own = `AND (created_by = $2 OR $2 IS NULL)`;

      const totRows = await q(
        `SELECT COUNT(*)::int              AS total_jobs,
                COALESCE(SUM(total_rows),0)::int     AS total_rows,
                COALESCE(SUM(matched_rows),0)::int   AS matched_rows,
                COALESCE(SUM(unmatched_rows),0)::int AS unmatched_rows,
                MAX(created_at)            AS last_run
           FROM reco_jobs WHERE brand_id = $1 ${own}`,
        [brandId, uid]);
      const tot = totRows[0] || {};

      const byAgent = await q(
        `SELECT agent_type,
                COUNT(*)::int                        AS runs,
                COALESCE(SUM(total_rows),0)::int     AS rows,
                COALESCE(SUM(matched_rows),0)::int   AS matched,
                COALESCE(SUM(unmatched_rows),0)::int AS unmatched,
                MAX(created_at)           AS last_run
           FROM reco_jobs WHERE brand_id = $1 ${own}
          GROUP BY agent_type ORDER BY runs DESC`,
        [brandId, uid]);

      const recent = await q(
        `SELECT agent_type, status, month, year,
                total_rows, matched_rows, unmatched_rows, created_at
           FROM reco_jobs WHERE brand_id = $1 ${own}
          ORDER BY created_at DESC LIMIT 8`,
        [brandId, uid]);

      let agentDetail = null;
      if (agentType) {
        const adRows = await q(
          `SELECT COUNT(*)::int                        AS runs,
                  COALESCE(SUM(total_rows),0)::int     AS rows,
                  COALESCE(SUM(matched_rows),0)::int   AS matched,
                  COALESCE(SUM(unmatched_rows),0)::int AS unmatched,
                  MAX(created_at)           AS last_run
             FROM reco_jobs WHERE brand_id = $1 AND agent_type = $3 ${own}`,
          [brandId, uid, agentType]);
        const statusMix = await q(
          `SELECT status, COUNT(*)::int AS count FROM reco_jobs
            WHERE brand_id = $1 AND agent_type = $3 ${own}
            GROUP BY status ORDER BY count DESC`,
          [brandId, uid, agentType]);
        agentDetail = { ...(adRows[0] || {}), statusMix };
      }

      return { tot, byAgent, recent, agentDetail };
    });

    const { tot, byAgent, recent, agentDetail } = data;
    if (!tot.total_jobs && !(byAgent || []).length) {
      return `Brand: ${brandName || brand.name}. No reconciliation runs recorded for this ${user && user.role === 'admin' ? 'brand' : 'user on this brand'} yet.`;
    }

    const matchRate = tot.total_rows > 0 ? Math.round((tot.matched_rows / tot.total_rows) * 100) : 0;
    const scopeNote = uid ? "the current user's own runs" : 'all users on this brand';
    const L = [];
    L.push(`DASHBOARD DATA for brand "${brandName || brand.name}" (${scopeNote}), pulled live from the reco_jobs dashboard just now:`);
    if (agentType) L.push(`Chat is focused on agent: ${agentLabel || labelFor(agentType)}.`);
    L.push('');
    L.push(`Totals across all agents: ${tot.total_jobs} runs · ${tot.total_rows} rows processed · ${tot.matched_rows} matched · ${tot.unmatched_rows} unmatched · overall match rate ${matchRate}%.`);
    if (tot.last_run) L.push(`Most recent run on this brand: ${ymd(tot.last_run)}.`);

    if ((byAgent || []).length) {
      L.push('');
      L.push('Per agent (runs · rows · matched · unmatched · last run):');
      byAgent.forEach((a) => {
        L.push(`- ${labelFor(a.agent_type)}: ${a.runs} · ${a.rows} · ${a.matched} · ${a.unmatched} · ${a.last_run ? ymd(a.last_run) : '—'}`);
      });
    }

    if (agentDetail && agentDetail.runs) {
      L.push('');
      L.push(`Focused agent "${agentLabel || labelFor(agentType)}" detail: ${agentDetail.runs} runs · ${agentDetail.rows} rows · ${agentDetail.matched} matched · ${agentDetail.unmatched} unmatched${agentDetail.last_run ? ` · last run ${ymd(agentDetail.last_run)}` : ''}.`);
      if ((agentDetail.statusMix || []).length) {
        L.push('Run status mix: ' + agentDetail.statusMix.map((s) => `${s.status || 'unknown'}=${s.count}`).join(', ') + '.');
      }
    }

    if ((recent || []).length) {
      L.push('');
      L.push('Last 8 runs (date · agent · period · status · rows/matched/unmatched):');
      recent.forEach((r) => {
        const period = r.month || r.year ? `${r.month || '?'}/${r.year || '?'}` : '—';
        L.push(`- ${ymd(r.created_at)} · ${labelFor(r.agent_type)} · ${period} · ${r.status || '—'} · ${r.total_rows || 0}/${r.matched_rows || 0}/${r.unmatched_rows || 0}`);
      });
    }

    L.push('');
    L.push('When the user asks about their numbers/history, answer from the data above and cite the figures. If they ask about something not shown here (a specific invoice row, a different brand, or an agent with no runs), say the dashboard does not show it.');

    return L.join('\n').slice(0, 6000);
  } catch (err) {
    console.warn('[chat] dashboard context failed:', err && err.message);
    return null;
  }
}

module.exports = { buildDashboardContext, labelFor };
