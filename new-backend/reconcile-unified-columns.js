// One-off: ensure every unified dynamic agent table has all columns the agent
// produces (agent.columns). Runs as the masterSequelize user (postgres in unified
// mode) so it can ALTER. Idempotent (ADD COLUMN IF NOT EXISTS). Never drops.
const { masterSequelize } = require('./src/config/database');
const { Agent } = require('./src/models/master');
const T = { STRING:'TEXT', TEXT:'TEXT', INTEGER:'INTEGER', BIGINT:'BIGINT', DECIMAL:'NUMERIC',
  FLOAT:'DOUBLE PRECISION', DOUBLE:'DOUBLE PRECISION', BOOLEAN:'BOOLEAN', DATE:'TIMESTAMPTZ',
  DATEONLY:'DATE', UUID:'UUID', JSONB:'JSONB' };
(async () => {
  const agents = await Agent.findAll();
  let added = 0, tables = 0;
  for (const a of agents) {
    const cols = Array.isArray(a.columns) ? a.columns : [];
    if (!cols.length) continue;
    const table = a.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const [ex] = await masterSequelize.query(`SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=$1`, { bind: [table] });
    if (!ex.length) continue;
    tables++;
    const [existing] = await masterSequelize.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, { bind: [table] });
    const have = new Set(existing.map(c => c.column_name));
    for (const c of cols) {
      if (['id','brand_id','created_at'].includes(c.name) || have.has(c.name)) continue;
      const sqlType = T[(c.type || 'STRING').toUpperCase()] || 'TEXT';
      await masterSequelize.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${c.name}" ${sqlType}`);
      console.log(`  + ${table}.${c.name} ${sqlType}`);
      added++;
    }
  }
  console.log(`reconcile done: ${tables} agent tables checked, ${added} columns added`);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
