// 007_fix_missing_agent_tables.js
// Part (2) of fix 007 — see 007_sales_master_and_missing_tables.sql for context.
//
// Some sales agents were added AFTER the unified DB was built, so their dynamic
// tables never existed; getDynamicModel.sync() is a no-op in unified mode, so the
// workspace no longer auto-creates them → GET /working-files 500s.
//
// This script scans agents.columns, finds any agent whose dynamic table is missing,
// and CREATEs it with the EXACT schema getDynamicModel would produce (same column
// types), then applies the unified treatment identical to the other tables:
//   - brand_id DEFAULT NULLIF(current_setting('app.brand_id',true),'')::uuid
//   - id DEFAULT gen_random_uuid()
//   - ENABLE + FORCE ROW LEVEL SECURITY + "<t>_tenant_isolation" policy (USING+WITH CHECK)
//   - brand_id btree index
//   - GRANT SELECT,INSERT,UPDATE,DELETE TO colonel_app
//
// Idempotent: existing tables are skipped. Re-run any time the friend adds a new
// sales/marketplace agent. Runs on the superuser (masterSequelize) connection,
// which is the only role that may run DDL in the unified DB.
// Resolve all app modules against new-backend (this file lives in db-restructure/).
const path = require('path');
const NB = path.join(__dirname, '..', 'new-backend');
require(path.join(NB, 'node_modules', 'dotenv')).config({ path: path.join(NB, '.env') });
const { DataTypes } = require(path.join(NB, 'node_modules', 'sequelize'));
const { masterSequelize, UNIFIED } = require(path.join(NB, 'src', 'config', 'database'));
const { Agent } = require(path.join(NB, 'src', 'models', 'master'));

async function ensureTable(agent) {
  const cols = Array.isArray(agent.columns) ? agent.columns : [];
  const table = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  if (!cols.length) return { table, status: 'skip (no columns — reco/portal agent)' };

  const [ex] = await masterSequelize.query(
    `SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=$1`, { bind: [table] });
  if (ex.length) return { table, status: 'exists' };

  // Build the schema EXACTLY as getDynamicModel does in UNIFIED mode.
  const schema = {
    id:             { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    month:          DataTypes.INTEGER,
    year:           DataTypes.INTEGER,
    file_type:      DataTypes.STRING,
    inventory_type: DataTypes.STRING,
    filename:       DataTypes.STRING,
    created_at:     { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    brand_id:       { type: DataTypes.UUID, allowNull: false },
  };
  cols.forEach((c) => {
    if (c.name === 'id' || c.name === 'brand_id') return;
    schema[c.name] = { type: DataTypes[c.type?.toUpperCase()] || DataTypes.STRING };
  });

  const model = masterSequelize.define(table, schema, {
    tableName: table,
    timestamps: false,
    indexes: [{ fields: ['filename'] }, { name: `${table}_brand_idx`, fields: ['brand_id'] }],
  });
  await model.sync(); // CREATE TABLE (superuser can DDL)

  // Unified treatment — mirror sales_amazon exactly.
  const q = (sql) => masterSequelize.query(sql);
  await q(`ALTER TABLE "${table}" ALTER COLUMN id SET DEFAULT gen_random_uuid()`);
  await q(`ALTER TABLE "${table}" ALTER COLUMN brand_id SET DEFAULT NULLIF(current_setting('app.brand_id', true), '')::uuid`);
  await q(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
  await q(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
  await q(`DROP POLICY IF EXISTS "${table}_tenant_isolation" ON "${table}"`);
  await q(`CREATE POLICY "${table}_tenant_isolation" ON "${table}"
             USING ((brand_id)::text = current_setting('app.brand_id', true))
             WITH CHECK ((brand_id)::text = current_setting('app.brand_id', true))`);
  await q(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO colonel_app`);
  return { table, status: `CREATED (${Object.keys(schema).length} cols) + RLS + grants` };
}

(async () => {
  if (!UNIFIED) { console.error('Refusing to run: USE_UNIFIED_DB is not true.'); process.exit(1); }
  const agents = await Agent.findAll();
  console.log(`Scanning ${agents.length} agents for missing dynamic tables...\n`);
  let created = 0;
  for (const a of agents) {
    const r = await ensureTable(a);
    if (r.status.startsWith('CREATED')) { created++; console.log(`  ✅ ${r.table.padEnd(24)} ${r.status}`); }
    else if (r.status === 'exists')     { /* quiet */ }
  }
  console.log(`\nDone. ${created} table(s) created.`);
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
