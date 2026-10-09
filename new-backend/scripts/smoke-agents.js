#!/usr/bin/env node
/**
 * smoke-agents.js — checks that every agent with a dynamic working-file table is usable.
 *
 * For each agent whose `columns` list is non-empty:
 *   1. API read  — GET /api/brands/:brandId/agents/:agentId/working-files as a real
 *                  (admin) user against the running backend. Catches
 *                  `relation "sales_<x>" does not exist` and missing-column errors.
 *   2. DB write  — as the app role (colonel_app) with app.brand_id set, INSERT one row
 *                  using every column the model writes, then ROLLBACK. Catches missing
 *                  grants, RLS policy gaps and missing columns. Nothing is persisted.
 *
 * Read-only in effect. Exit code 1 if any agent fails.
 *
 * Run from new-backend/:  node scripts/smoke-agents.js [--port 8001] [--brand <name>]
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const { Sequelize } = require('sequelize');
const { masterSequelize, UNIFIED } = require('../src/config/database');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const PORT = arg('port', process.env.PORT || 8001);
const BRAND = arg('brand', null);
const BASE_COLUMNS = ['month', 'year', 'file_type', 'inventory_type', 'filename', 'created_by'];
const tableNameFor = (name) => name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();

(async () => {
  if (!UNIFIED) { console.error('smoke-agents only supports unified-DB mode.'); process.exit(2); }

  const [agents] = await masterSequelize.query(`SELECT id, name, columns FROM agents ORDER BY name`);
  const [brands] = await masterSequelize.query(
    BRAND ? `SELECT id, name FROM brands WHERE lower(name) = lower($1) LIMIT 1` : `SELECT id, name FROM brands ORDER BY name LIMIT 1`,
    BRAND ? { bind: [BRAND] } : {}
  );
  const [admins] = await masterSequelize.query(`SELECT id, email FROM users WHERE role = 'admin' ORDER BY "createdAt" LIMIT 1`);
  if (!brands.length || !admins.length) { console.error('Need at least one brand and one admin user.'); process.exit(2); }
  const brand = brands[0];
  const token = jwt.sign({ userId: admins[0].id }, process.env.JWT_SECRET, { expiresIn: '5m' });

  const appDb = new Sequelize(process.env.UNIFIED_DB_NAME || 'colonel_agent_accountant',
    process.env.DB_APP_USER || 'colonel_app', process.env.DB_APP_PASSWORD || 'colonel_app_local',
    { host: process.env.DB_HOST, port: process.env.DB_PORT, dialect: 'postgres', logging: false });

  console.log(`Brand: ${brand.name} · backend :${PORT} · ${agents.length} agents\n`);
  let failed = 0, checked = 0;

  for (const agent of agents) {
    if (!Array.isArray(agent.columns) || agent.columns.length === 0) continue; // reco/portal agent — no table
    checked++;
    const table = tableNameFor(agent.name);
    const problems = [];

    // 1. API read
    try {
      const res = await fetch(`http://localhost:${PORT}/api/brands/${brand.id}/agents/${agent.id}/working-files`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) problems.push(`API ${res.status}: ${(await res.text()).slice(0, 160)}`);
    } catch (e) { problems.push(`API unreachable: ${e.message}`); }

    // 2. DB write as the app role, rolled back
    const cols = [...new Set([...BASE_COLUMNS, ...agent.columns.map((c) => c && c.name).filter((n) => n && n !== 'id' && n !== 'brand_id' && n !== 'created_at')])];
    const t = await appDb.transaction();
    try {
      await appDb.query(`SELECT set_config('app.brand_id', $1, true)`, { bind: [brand.id], transaction: t });
      await appDb.query(
        `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => 'NULL').join(', ')}) RETURNING id, brand_id`,
        { transaction: t }
      );
    } catch (e) { problems.push(`DB insert: ${e.message}`); }
    finally { await t.rollback(); }

    if (problems.length) { failed++; console.log(`  ❌ ${agent.name.padEnd(24)} ${table}\n       ${problems.join('\n       ')}`); }
    else console.log(`  ✅ ${agent.name.padEnd(24)} ${table}`);
  }

  console.log(`\n${checked - failed}/${checked} agents OK${failed ? ` — ${failed} FAILED` : ''}.`);
  await appDb.close(); await masterSequelize.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('smoke-agents error:', e.message); process.exit(2); });
