/**
 * dynamicTablesMigrate.js — makes sure every agent's dynamic working-file table
 * exists in the UNIFIED DB. Idempotent and additive → safe to run every boot.
 *
 * Why: an agent's table name is derived from its name ("Sales-Meesho" →
 * sales_meesho) and its shape from agents.columns. In unified mode the app role
 * (colonel_app) cannot run DDL and getDynamicModel.sync() is a no-op, so a newly
 * seeded agent used to have NO table until someone hand-ran a db-restructure
 * script — every request then failed with `relation "sales_<x>" does not exist`
 * (Sales-AJIO and Sales-Meesho shipped that way). This closes the gap for good:
 * seed an agent, restart the backend, the table is there.
 *
 * For each agent with a non-empty `columns` list:
 *   - table missing  → CREATE it with the same shape getDynamicModel defines,
 *                      plus the unified treatment every other sales_* table has:
 *                      brand_id default from app.brand_id + FK to brands,
 *                      created_by FK to users, brand/filename indexes,
 *                      ENABLE + FORCE RLS, tenant_isolation policy, colonel_app grants.
 *   - table present  → ADD COLUMN IF NOT EXISTS for anything the model expects
 *                      but the table lacks (never drops or alters a column).
 *
 * Runs on masterSequelize (the superuser connection) — the only role allowed DDL.
 * A failure on one agent is logged and skipped; it never blocks boot.
 */
const { DataTypes } = require('sequelize');
const { masterSequelize, UNIFIED } = require('../config/database');

const IDENT = /^[a-z_][a-z0-9_]*$/;
const BRAND_DEFAULT = `NULLIF(current_setting('app.brand_id', true), '')::uuid`;

// Columns getDynamicModel always defines, in table order. id + brand_id are only
// ever created with the table (never bolted on afterwards).
const BASE_COLUMNS = [
  ['id', `UUID PRIMARY KEY DEFAULT gen_random_uuid()`],
  ['brand_id', `UUID NOT NULL DEFAULT ${BRAND_DEFAULT} REFERENCES brands(id) ON DELETE CASCADE`],
  ['month', 'INTEGER'],
  ['year', 'INTEGER'],
  ['file_type', 'VARCHAR(255)'],
  ['inventory_type', 'VARCHAR(255)'],
  ['filename', 'VARCHAR(255)'],
  ['created_at', 'TIMESTAMP WITH TIME ZONE DEFAULT NOW()'],
  ['created_by', 'UUID REFERENCES users(id) ON DELETE SET NULL'],
];
const BASE_NAMES = new Set(BASE_COLUMNS.map(([n]) => n));

// Same resolution as getDynamicModel: DataTypes[TYPE], falling back to STRING.
const sqlType = (type) => {
  const dt = DataTypes[String(type || '').toUpperCase()] || DataTypes.STRING;
  try { return masterSequelize.normalizeDataType(dt).toSql(); }
  catch (_) { return 'VARCHAR(255)'; }
};

const tableNameFor = (agentName) => agentName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();

const ensureAgentTable = async (agent) => {
  const table = tableNameFor(agent.name);
  if (!IDENT.test(table)) return { table, status: 'skipped', reason: 'unsafe table name' };

  // Agent-specific columns, de-duplicated, minus the base ones handled above.
  const custom = [];
  const seen = new Set();
  for (const c of agent.columns) {
    const name = c && c.name;
    if (!name || BASE_NAMES.has(name) || seen.has(name)) continue;
    if (!IDENT.test(name)) { console.warn(`[DYNAMIC TABLES] ${table}: skipping unsafe column name "${name}"`); continue; }
    seen.add(name);
    custom.push([name, sqlType(c.type)]);
  }

  const [existing] = await masterSequelize.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    { bind: [table] }
  );

  if (existing.length === 0) {
    const defs = [...BASE_COLUMNS, ...custom].map(([n, t]) => `"${n}" ${t}`).join(',\n  ');
    await masterSequelize.transaction(async (transaction) => {
      const q = (sql) => masterSequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS "${table}" (\n  ${defs}\n)`);
      await q(`CREATE INDEX IF NOT EXISTS "${table}_brand_idx" ON "${table}" (brand_id)`);
      await q(`CREATE INDEX IF NOT EXISTS "${table}_filename" ON "${table}" (filename)`);
      await q(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await q(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      await q(`DROP POLICY IF EXISTS "${table}_tenant_isolation" ON "${table}"`);
      await q(`CREATE POLICY "${table}_tenant_isolation" ON "${table}"
                 USING ((brand_id)::text = current_setting('app.brand_id', true))
                 WITH CHECK ((brand_id)::text = current_setting('app.brand_id', true))`);
      await q(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO colonel_app`);
    });
    return { table, status: 'created', columns: BASE_COLUMNS.length + custom.length };
  }

  const have = new Set(existing.map((r) => r.column_name));
  // A table with no brand_id is not one of ours (name collision) — leave it alone.
  if (!have.has('brand_id')) return { table, status: 'skipped', reason: 'existing table has no brand_id' };

  const wanted = [...BASE_COLUMNS.filter(([n]) => n !== 'id' && n !== 'brand_id'), ...custom];
  const added = [];
  for (const [name, type] of wanted) {
    if (have.has(name)) continue;
    await masterSequelize.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${name}" ${type}`);
    added.push(name);
  }
  return added.length ? { table, status: 'altered', added } : { table, status: 'ok' };
};

const migrateDynamicTables = async () => {
  if (!UNIFIED) return; // legacy per-brand DBs still create tables via model.sync()
  try {
    // Per-(brand, agent) masters live as JSONB on brand_agents; the model reads all
    // of them on every findOrCreate, so a missing column breaks every sales agent.
    for (const col of ['sku_master', 'ledger_master', 'hsn_master', 'product_type_master']) {
      await masterSequelize.query(
        `ALTER TABLE brand_agents ADD COLUMN IF NOT EXISTS "${col}" JSONB DEFAULT '[]'::jsonb`
      );
    }

    const [agents] = await masterSequelize.query(`SELECT name, columns FROM agents ORDER BY name`);
    let created = 0, altered = 0, failed = 0;
    for (const agent of agents) {
      if (!Array.isArray(agent.columns) || agent.columns.length === 0) continue; // reco/portal agent — no table
      try {
        const r = await ensureAgentTable(agent);
        if (r.status === 'created') { created++; console.log(`[DYNAMIC TABLES] created ${r.table} (${r.columns} cols) + RLS + grants`); }
        else if (r.status === 'altered') { altered++; console.log(`[DYNAMIC TABLES] ${r.table}: added ${r.added.join(', ')}`); }
        else if (r.status === 'skipped') console.warn(`[DYNAMIC TABLES] ${r.table}: skipped (${r.reason})`);
      } catch (e) {
        failed++;
        console.error(`[DYNAMIC TABLES] ${agent.name}: ${e.message}`);
      }
    }
    console.log(`[DYNAMIC TABLES] Agent tables ensured (${created} created, ${altered} altered${failed ? `, ${failed} FAILED` : ''}).`);
  } catch (e) {
    console.error('[DYNAMIC TABLES] migration skipped:', e.message);
  }
};

module.exports = { migrateDynamicTables, ensureAgentTable, tableNameFor };
