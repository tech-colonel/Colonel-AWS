/**
 * seed-leisure-reco-agent.js — register the "Leisure Reco" agent and assign it to brands.
 *
 * Leisure Reco = the generic two-party ledger reconciliation agent: any Internal
 * Ledger vs any Counterparty Statement (vendor, customer, or intercompany), even
 * when the two exports use different column layouts. Runs entirely through the
 * standard reco pipeline (POST /api/reco/upload -> Python reco-engine
 * reco_type=leisure_reco -> recon/leisure_reco.py) — no dedicated DB table, uses
 * the generic reco_jobs fire-and-forget save like every other download-only agent.
 *
 * Usage:  node seed-leisure-reco-agent.js            # assigns to ALL brands
 *         node seed-leisure-reco-agent.js Koparo      # assigns to just the named brand(s)
 *
 * Idempotent: re-running only tops up the agent row + missing assignments.
 */
const { masterSequelize } = require('./src/config/database');
const { Agent } = require('./src/models/master/index.js');

// Stable id — also added to frontend RECO_ID_TO_TYPE (AgentDispatch.jsx).
const LEISURE_RECO_AGENT_ID = 'bec276d9-5757-4385-b21b-0edfda6ccd37';
const LEISURE_RECO_AGENT_NAME = 'Leisure Reco';

(async () => {
  const onlyBrands = process.argv.slice(2).filter(Boolean);
  try {
    await masterSequelize.authenticate();

    // ── 1. Upsert the agent row ────────────────────────────────────────────
    const existing = await Agent.findByPk(LEISURE_RECO_AGENT_ID);
    const description =
      'Generic two-party ledger reconciliation — upload your Internal Ledger and any '
      + 'Counterparty Statement (vendor, customer, or intercompany). Locates the real column '
      + 'header amid each export’s own preamble/chart-of-accounts layout, matches entries by '
      + 'voucher/reference number, UTR/cheque number, or date + amount, groups lump-sum and '
      + 'partial settlements, and buckets whatever is left into Timing, Tax Deduction, Disputed, '
      + 'Omission, and Missing-at-Counterparty — works even when the two files’ headers differ.';
    if (!existing) {
      await Agent.create({ id: LEISURE_RECO_AGENT_ID, name: LEISURE_RECO_AGENT_NAME, description, columns: [] });
      console.log(`✓ created agent ${LEISURE_RECO_AGENT_NAME} (${LEISURE_RECO_AGENT_ID})`);
    } else {
      existing.name = LEISURE_RECO_AGENT_NAME;
      existing.description = description;
      await existing.save();
      console.log(`✓ updated agent ${LEISURE_RECO_AGENT_NAME} (${LEISURE_RECO_AGENT_ID})`);
    }

    // ── 2. Assign to brands (brand_agents) ─────────────────────────────────
    let where = '';
    const repl = { aid: LEISURE_RECO_AGENT_ID };
    if (onlyBrands.length) {
      where = 'WHERE b.name IN (:names)';
      repl.names = onlyBrands;
    }
    const [rows] = await masterSequelize.query(
      `INSERT INTO brand_agents (id, brand_id, agent_id, "createdAt", "updatedAt")
       SELECT gen_random_uuid(), b.id, :aid, NOW(), NOW()
       FROM brands b
       ${where}
       ON CONFLICT DO NOTHING
       RETURNING brand_id`,
      { replacements: repl },
    );
    console.log(`✓ assigned to ${Array.isArray(rows) ? rows.length : 0} new brand(s)`
      + (onlyBrands.length ? ` (filter: ${onlyBrands.join(', ')})` : ' (all brands)'));

    console.log('\nDone. Leisure Reco is live in the Agents grid for the assigned brand(s).');
    process.exit(0);
  } catch (err) {
    console.error('seed-leisure-reco-agent failed:', err.message);
    process.exit(1);
  }
})();
