const path = require('path');
const { Sequelize } = require('sequelize');
const dotenv = require('dotenv');

// Resolve .env from new-backend root regardless of where the script is run from
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ─────────────────────────────────────────────────────────────────────────────
// UNIFIED-DB MODE (DB restructure).  Default OFF → behaviour identical to before
// (one physical DB per brand). When USE_UNIFIED_DB=true, every brand shares ONE
// database (colonel_agent_accountant); tenant isolation is enforced by Postgres
// RLS + a per-request `app.brand_id`, and the app connects as a NON-superuser
// role so RLS actually bites.
// ─────────────────────────────────────────────────────────────────────────────
const UNIFIED = process.env.USE_UNIFIED_DB === 'true';
const UNIFIED_DB_NAME = process.env.UNIFIED_DB_NAME || 'colonel_agent_accountant';
const APP_USER = process.env.DB_APP_USER || 'colonel_app';
const APP_PASSWORD = process.env.DB_APP_PASSWORD || 'colonel_app_local';

const basePool = { max: 15, min: 1, acquire: 30000, idle: 10000, keepAlive: true, keepAliveInitialDelayMillis: 0 };

/**
 * Master Database Connection.
 * UNIFIED: points at the shared DB as the SUPERUSER (postgres) — master/org tables
 * have no RLS, and boot-time schema sync/migrations need DDL privileges.
 */
const masterSequelize = new Sequelize(
  UNIFIED ? UNIFIED_DB_NAME : (process.env.DB_NAME_MASTER || process.env.DB_NAME),
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: 'postgres',
    logging: false,
    pool: basePool,
  }
);

// Map to store brand-specific connections
const brandConnections = new Map();

/**
 * Get or create a connection for a specific brand database.
 *
 * OFF:      one Sequelize per physical brand DB (as before).
 * UNIFIED:  one Sequelize per brand, all pointed at the shared DB as the
 *           NON-superuser app role, each connection presetting `app.brand_id`
 *           (looked up from brands.db_name) via an afterConnect hook. RLS then
 *           scopes every read, and brand_id auto-stamps on insert via column
 *           DEFAULT — so controllers need no changes.
 *
 * @param {string} dbName - brands.db_name for the brand
 * @returns {Sequelize}
 */
const getBrandConnection = (dbName) => {
  if (brandConnections.has(dbName)) {
    return brandConnections.get(dbName);
  }

  let sequelize;
  if (UNIFIED) {
    sequelize = new Sequelize(UNIFIED_DB_NAME, APP_USER, APP_PASSWORD, {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      dialect: 'postgres',
      logging: false,
      pool: { max: 5, min: 0, acquire: 30000, idle: 10000, keepAlive: true, keepAliveInitialDelayMillis: 0 },
      hooks: {
        // Runs once per physical connection in this brand's pool. Presets the
        // brand context so RLS scopes all queries on this connection.
        afterConnect: async (connection) => {
          try {
            const res = await connection.query('SELECT id FROM brands WHERE db_name = $1 LIMIT 1', [dbName]);
            const id = res && res.rows && res.rows[0] && res.rows[0].id;
            if (id) {
              await connection.query("SELECT set_config('app.brand_id', $1, false)", [id]);
            } else {
              console.warn(`[UNIFIED] no brands row for db_name=${dbName}; app.brand_id left unset (queries will return nothing).`);
            }
          } catch (e) {
            console.error(`[UNIFIED] afterConnect brand-context set failed for ${dbName}: ${e.message}`);
          }
        },
      },
    });
  } else {
    sequelize = new Sequelize(dbName, process.env.DB_USER, process.env.DB_PASSWORD, {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      dialect: 'postgres',
      logging: false,
      pool: { max: 5, min: 0, acquire: 30000, idle: 10000, keepAlive: true, keepAliveInitialDelayMillis: 0 },
    });
  }

  brandConnections.set(dbName, sequelize);
  return sequelize;
};

/**
 * Helper to create a new Postgres database for a brand.
 * OFF:     CREATE DATABASE "<dbName>" (as before).
 * UNIFIED: no-op — all brands share one DB; a new brand is just a brands row +
 *          its brand_id. Tables already exist and are shared.
 * @param {string} dbName
 */
const createBrandDatabase = async (dbName) => {
  if (UNIFIED) {
    console.log(`[UNIFIED] createBrandDatabase no-op for ${dbName} (shared DB).`);
    return;
  }

  // Use a temporary connection to postgres/master db to run CREATE DATABASE
  const tempSequelize = new Sequelize(
    'postgres',
    process.env.DB_USER,
    process.env.DB_PASSWORD,
    {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      dialect: 'postgres',
      logging: false
    }
  );

  try {
    // Check if database already exists
    const [results] = await tempSequelize.query(
      `SELECT 1 FROM pg_database WHERE datname = '${dbName}'`
    );

    if (results.length === 0) {
      await tempSequelize.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Database created: ${dbName}`);
    } else {
      console.log(`Database already exists: ${dbName}`);
    }
  } catch (error) {
    console.error(`Error creating database ${dbName}:`, error);
    throw error;
  } finally {
    await tempSequelize.close();
  }
};

module.exports = {
  masterSequelize,
  getBrandConnection,
  createBrandDatabase,
  UNIFIED,
};
