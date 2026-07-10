/**
 * seed-statutory-stroom.js — one-time local seeding (gitignored).
 * Ensures the statutory table exists, then materialises the statutory register
 * for the Stroom brand. Idempotent — safe to re-run.  node seed-statutory-stroom.js
 */
const { masterSequelize } = require('./src/config/database');
const { migrateStatutory } = require('./src/db/statutoryMigrate');
const { seedStatutoryForBrand } = require('./src/controllers/statutoryController');

const STROOM_BRAND_ID = 'a882ea99-5650-40be-9b6b-c28d99db131a';

(async () => {
  try {
    await masterSequelize.authenticate();
    await migrateStatutory();
    const result = await seedStatutoryForBrand({ brandId: STROOM_BRAND_ID });
    console.log(`[SEED] ✅ Statutory register for Stroom — ${result.inserted} new / ${result.total} total rows`);
    console.log('[SEED] Done. Log in as chauhandhaval932@gmail.com → Stroom → Statutory Compliance.');
    process.exit(0);
  } catch (err) {
    console.error('[SEED] ❌', err.message);
    process.exit(1);
  }
})();
