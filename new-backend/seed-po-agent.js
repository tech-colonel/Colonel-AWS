/**
 * seed-po-agent.js — register the "PO Extractor" agent and assign it to brands.
 *
 * PO Extractor = the n8n-driven Purchase-Order scanner:
 *   Drive folder of PO PDFs → Gemini extraction → per-brand Google Sheet
 *   (8 columns, one row per line item) → POST /api/n8n/po/feed → po_extractor table.
 *
 * PREREQUISITE (run once, as the postgres superuser — the app role can't do DDL):
 *   psql "$UNIFIED_DB" -f ../db-restructure/031_po_extractor.sql
 *
 * Then:  node seed-po-agent.js            # assigns to ALL brands
 *        node seed-po-agent.js Koparo     # assigns to just the named brand(s)
 *
 * Idempotent: re-running only tops up the agent row + missing assignments.
 */
const { masterSequelize } = require('./src/config/database');
const { Agent } = require('./src/models/master/index.js');

// Stable id — also added to frontend RECO_ID_TO_TYPE (AgentDispatch.jsx).
const PO_AGENT_ID = '0a9f6d2e-5c31-4b88-9e77-1f4a2c6b8d05';
const PO_AGENT_NAME = 'PO Extractor';

(async () => {
  const onlyBrands = process.argv.slice(2).filter(Boolean);
  try {
    await masterSequelize.authenticate();

    // ── 1. Upsert the agent row ────────────────────────────────────────────
    const existing = await Agent.findByPk(PO_AGENT_ID);
    const description =
      'Scan Purchase Order PDFs from a Google Drive folder — Gemini extracts PO no, date, '
      + 'supplier & buyer GSTIN, billing address, and every line item (description, unit cost, GST %) '
      + 'into the brand’s Google Sheet.';
    if (!existing) {
      await Agent.create({ id: PO_AGENT_ID, name: PO_AGENT_NAME, description, columns: [] });
      console.log(`✓ created agent ${PO_AGENT_NAME} (${PO_AGENT_ID})`);
    } else {
      existing.name = PO_AGENT_NAME;
      existing.description = description;
      await existing.save();
      console.log(`✓ updated agent ${PO_AGENT_NAME} (${PO_AGENT_ID})`);
    }

    // ── 2. Assign to brands (brand_agents) ─────────────────────────────────
    let where = '';
    const repl = { aid: PO_AGENT_ID };
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

    // ── 3. Sanity: is the history table present? ───────────────────────────
    const [[chk]] = await masterSequelize.query(
      `SELECT to_regclass('public.po_extractor') IS NOT NULL AS ok`,
    );
    if (!chk || !chk.ok) {
      console.warn('⚠  table public.po_extractor is MISSING — run '
        + 'db-restructure/031_po_extractor.sql as the postgres superuser before using the agent.');
    } else {
      console.log('✓ po_extractor table present');
    }

    console.log('\nDone. Next: set  <BrandName>_po_url  and  <BrandName>_po_sheet  in new-backend/.env');
    process.exit(0);
  } catch (err) {
    console.error('seed-po-agent failed:', err.message);
    process.exit(1);
  }
})();
