/**
 * seed-agent-workflows.js — Agent-workflow delta seeder runner
 *
 * Adds the 4 workflows built locally in the admin Workflow Manager
 * (Shopify urban, Firstcry M Brands, shopify-koparo, koparo-cread) to
 * colonel-master's agent_workflows table. Independent of seed.js / other
 * seed-*.js scripts so it can be run on its own — e.g. on AWS — without
 * touching anything else.
 *
 * Idempotent: safe to re-run (ON CONFLICT DO NOTHING in the seeder).
 * Touches ONLY the agent_workflows table in colonel-master.
 * Requires the parent agents (Sales-Shopify, Sales-FirstCry, Sales-cread)
 * to already exist — they do on both local and AWS. Resolves each parent
 * agent BY NAME, not by hardcoded id, since agent ids are random UUIDv4
 * and may not match between environments.
 *
 * IMPORTANT — run this FIRST if seeding a DB that predates the multi-file-
 * input workflow feature (agent_workflows may be missing the file_inputs
 * column):
 *   node migrations/add-workflow-file-inputs.js
 *
 * Usage:
 *   cd new-backend && node seed-agent-workflows.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { masterSequelize } = require('./src/config/database');

(async () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   Colonel — Agent-Workflows Seeder           ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  try {
    await masterSequelize.authenticate();
    console.log('[DB] ✅ Connected to colonel-master\n');
  } catch (err) {
    console.error('[DB] ❌ Cannot connect to colonel-master:', err.message);
    process.exit(1);
  }

  try {
    const seeder = require('./seeders/04-agent-workflows');
    await seeder.up(masterSequelize.getQueryInterface());
    console.log('\n[SEED] ✅ Agent workflows seeder finished');
  } catch (err) {
    console.error('[SEED] ❌ Seeder failed:', err.message);
    process.exit(1);
  }

  try {
    const [rows] = await masterSequelize.query(`
      SELECT w.name AS workflow, a.name AS agent
      FROM agent_workflows w
      JOIN agents a ON a.id = w.agent_id
      WHERE w.id IN (
        '231e59e7-f217-4805-b728-5511ee513512',
        '8a220322-c633-4abd-8d83-5951affa9ac7',
        '61608940-dad5-4be0-a697-5f77c35eff66',
        'dd36cbf8-9995-4b1a-b8ba-4a54d9915181'
      )
    `);
    console.log(`[SEED] ${rows.length}/4 target workflow(s) present:`);
    rows.forEach(r => console.log(`  - ${r.workflow}  (agent: ${r.agent})`));
  } catch (_) { /* non-fatal */ }

  console.log('\nNext: pm2 restart colonel-backend  (so the workflows appear in the API)\n');
  process.exit(0);
})().catch(err => {
  console.error('\n❌ Unexpected error:', err.message);
  process.exit(1);
});
