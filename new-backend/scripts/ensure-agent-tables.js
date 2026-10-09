#!/usr/bin/env node
/**
 * ensure-agent-tables.js — run the per-agent dynamic-table migration on demand.
 *
 * The backend runs the same thing on every boot (server.js → migrateDynamicTables),
 * so this is only needed to fix a running system without restarting it — e.g.
 * right after seeding a new sales agent, or to repair
 * `relation "sales_<x>" does not exist` on a box that has not been redeployed yet.
 * Tables are looked up at query time, so no restart is needed afterwards.
 *
 * Idempotent and additive (creates missing tables, adds missing columns).
 * Needs only this file + src/db/dynamicTablesMigrate.js on the box.
 *
 * Run from new-backend/:  node scripts/ensure-agent-tables.js
 * Then verify:            node scripts/smoke-agents.js
 */
const { migrateDynamicTables } = require('../src/db/dynamicTablesMigrate');
const { masterSequelize } = require('../src/config/database');

migrateDynamicTables()
  .then(() => masterSequelize.close())
  .then(() => process.exit(0))
  .catch((e) => { console.error('ensure-agent-tables error:', e.message); process.exit(1); });
