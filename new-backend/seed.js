/**
 * seed.js — Colonel RECO delta seeder
 *
 * Run this once after cloning the RECO branch onto a machine that already has
 * the colonel-master DB populated (users, brands, sales agents, etc.).
 *
 * What it does:
 *   1. Inserts the 5 RECO agent rows into colonel-master (agents table)
 *   2. Assigns those 5 agents to every brand (brand_agents table)
 *   3. Creates the 8 reco result tables on every brand DB via 001_reco_tables.sql
 *
 * Safe to re-run — all operations are idempotent (ON CONFLICT DO NOTHING).
 *
 * Usage:
 *   node seed.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { masterSequelize } = require('./src/config/database');
const { migrateAllBrands } = require('./src/db/migrate');

(async () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   Colonel RECO — Delta Seeder                ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // Step 1: Verify connection to colonel-master
  try {
    await masterSequelize.authenticate();
    console.log('[DB] ✅ Connected to colonel-master\n');
  } catch (err) {
    console.error('[DB] ❌ Cannot connect to colonel-master:', err.message);
    console.error('     Make sure PostgreSQL is running and .env is correct.');
    process.exit(1);
  }

  // Step 2: Insert the 4 RECO agents + assign them to all brands
  console.log('Step 1: Seeding RECO agents...');
  try {
    const seeder = require('./seeders/01-reco-agents');
    await seeder.up(masterSequelize.getQueryInterface());
    console.log('[SEED] ✅ RECO agents + brand assignments done\n');
  } catch (err) {
    console.error('[SEED] ❌ Seeder failed:', err.message);
    process.exit(1);
  }

  // Step 3: Create reco tables on every brand DB
  console.log('Step 2: Running reco table migrations on all brand DBs...');
  try {
    await migrateAllBrands();
    console.log('[MIGRATE] ✅ All brand DBs migrated\n');
  } catch (err) {
    console.error('[MIGRATE] ❌ Migration failed:', err.message);
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   ✅  Done! RECO branch is ready.            ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log('The 5 RECO agents are now active for all brands:');
  console.log('  • gstr_2b_books              (d0000000-...-000000000001)');
  console.log('  • gstr_2b_books_multistate   (d0000000-...-000000000002)');
  console.log('  • gstr_3b_tally_entry        (d0000000-...-000000000003)');
  console.log('  • universal_bank_statement   (d0000000-...-000000000004)');
  console.log('  • gstr_1_vs_books            (d0000000-...-000000000005)\n');
  console.log('Start the server:');
  console.log('  cd new-backend && node server.js\n');

  process.exit(0);
})().catch(err => {
  console.error('\n❌ Unexpected error:', err.message);
  process.exit(1);
});
