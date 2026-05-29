const fs = require('fs');
const path = require('path');
const { getBrandConnection, masterSequelize } = require('../config/database');

const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, 'migrations/001_reco_tables.sql'),
  'utf8'
);

/**
 * Run Hero DB migration on a single brand database.
 * Sets app.bypass_rls = 'true' so the migration itself is never blocked by RLS.
 */
const migrateBrandDb = async (dbName) => {
  const sequelize = getBrandConnection(dbName);
  try {
    await sequelize.transaction(async (t) => {
      await sequelize.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
      await sequelize.query(MIGRATION_SQL, { transaction: t });
    });
    console.log(`[MIGRATE] ✅ ${dbName} — hero tables ready`);
  } catch (err) {
    console.error(`[MIGRATE] ❌ ${dbName} — ${err.message}`);
  }
};

/**
 * Run migration on all brand databases found in colonel-master.
 * Called once on app startup — safe to re-run (all SQL is idempotent).
 */
const migrateAllBrands = async () => {
  try {
    const [brands] = await masterSequelize.query(
      `SELECT db_name FROM brands WHERE db_name IS NOT NULL`
    );
    console.log(`[MIGRATE] Running hero DB migration on ${brands.length} brand(s)...`);
    for (const { db_name } of brands) {
      await migrateBrandDb(db_name);
    }
    console.log(`[MIGRATE] All brand migrations complete.`);
  } catch (err) {
    console.error(`[MIGRATE] Could not fetch brand list: ${err.message}`);
  }
};

/**
 * Run migration for a single brand by brand_id.
 * Called when a new brand is created.
 */
const migrateSingleBrand = async (brandId) => {
  try {
    const [rows] = await masterSequelize.query(
      `SELECT db_name FROM brands WHERE id = $1`,
      { bind: [brandId] }
    );
    if (!rows.length) return;
    await migrateBrandDb(rows[0].db_name);
  } catch (err) {
    console.error(`[MIGRATE] migrateSingleBrand error: ${err.message}`);
  }
};

module.exports = { migrateAllBrands, migrateSingleBrand, migrateBrandDb };
