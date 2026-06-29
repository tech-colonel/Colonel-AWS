/**
 * seed-order-cycle.js — Shopify-Order-Cycle delta seeder runner
 *
 * Adds the Shopify-Order-Cycle agent to colonel-master and assigns it to every
 * brand. Independent of seed.js (which is RECO-only) so it can be run on its own
 * — e.g. on AWS — without re-running the RECO seeder.
 *
 * Idempotent: safe to re-run (ON CONFLICT DO NOTHING in the seeder).
 * Touches ONLY the agents + brand_agents tables in colonel-master.
 * The per-brand `shopify_order_cycle` table auto-creates on the agent's first run.
 *
 * Usage:
 *   cd new-backend && node seed-order-cycle.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { masterSequelize } = require('./src/config/database');

(async () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   Colonel — Shopify-Order-Cycle Seeder       ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  try {
    await masterSequelize.authenticate();
    console.log('[DB] ✅ Connected to colonel-master\n');
  } catch (err) {
    console.error('[DB] ❌ Cannot connect to colonel-master:', err.message);
    process.exit(1);
  }

  try {
    const seeder = require('./seeders/02-order-cycle-agent');
    await seeder.up(masterSequelize.getQueryInterface());
    console.log('\n[SEED] ✅ Shopify-Order-Cycle agent + brand assignments done');
  } catch (err) {
    console.error('[SEED] ❌ Seeder failed:', err.message);
    process.exit(1);
  }

  // Report the resulting assignment count so the operator can confirm.
  try {
    const [[{ count }]] = await masterSequelize.query(`
      SELECT count(*)::int AS count
      FROM brand_agents ba
      JOIN agents a ON a.id = ba.agent_id
      WHERE a.name = 'Shopify-Order-Cycle'
    `);
    console.log(`[SEED] Shopify-Order-Cycle is now assigned to ${count} brand(s).\n`);
  } catch (_) { /* non-fatal */ }

  console.log('Next: pm2 restart colonel-backend  (so the agent appears in the API)\n');
  process.exit(0);
})().catch(err => {
  console.error('\n❌ Unexpected error:', err.message);
  process.exit(1);
});
