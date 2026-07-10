const app = require('./src/app');
const { masterSequelize } = require('./src/config/database');
const { migrateAllBrands } = require('./src/db/migrate');
const { migrateZoho } = require('./src/db/zohoMigrate');
const { migrateCompliance } = require('./src/db/complianceMigrate');
const { migrateStatutory } = require('./src/db/statutoryMigrate');
const dotenv = require('dotenv');

dotenv.config();

const PORT = process.env.PORT || 8001;

/**
 * Ensure all 5 RECO agents exist in the master agents table.
 * Safe to run on every startup — ON CONFLICT (name) DO NOTHING is idempotent.
 */
const seedMasterAgents = async () => {
  await masterSequelize.query(`
    INSERT INTO agents (id, name, description, columns) VALUES
      ('4e02cc5b-8fc8-4c79-8013-e7f510c850d5', 'gstr_2b_books',
       'GSTR-2B vs Purchase Register + Debit Note Register reconciliation', '[]'),
      ('855fe095-84c6-4947-a5e4-a73da83b2fd6', 'gstr_2b_books_multistate',
       'GSTR-2B vs Books for multi-state brands — detects cross-state booking errors', '[]'),
      ('b2d3fad4-0d90-4b49-acdc-d243cfa9c8d5', 'gstr_3b_tally_entry',
       'Parse GSTR-3B and generate ready-to-post Tally journal entries', '[]'),
      ('93d027ac-4333-403b-b448-9c637ebfc13c', 'universal_bank_statement',
       'Brand-agnostic bank statement classifier mapped to Tally chart of accounts', '[]'),
      ('8b8d0876-3169-4511-96d8-2a7467478007', 'gstr_1_vs_books',
       'GSTR-1 outward supplies vs Tally sales register reconciliation', '[]')
    ON CONFLICT (name) DO NOTHING
  `);
  console.log('[SEED] 5 RECO agents seeded into colonel-master.');
};

/**
 * Idempotent schema extras that Sequelize sync({alter:false}) won't apply:
 *  - add the 'developer' role to the users + task_messages enums
 *  - add tasks.category + tasks.source_meta columns (feedback loop)
 * `ADD VALUE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` are safe to re-run.
 */
const ensureSchemaExtras = async () => {
  const stmts = [
    `ALTER TYPE "enum_users_role" ADD VALUE IF NOT EXISTS 'developer'`,
    `ALTER TYPE "enum_task_messages_sender_role" ADD VALUE IF NOT EXISTS 'developer'`,
    // legacy CHECK constraints predate the enum and still pin the old value set
    `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`,
    `ALTER TABLE task_messages DROP CONSTRAINT IF EXISTS task_messages_sender_role_check`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS category VARCHAR(32) NOT NULL DEFAULT 'task'`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_meta JSONB`,
  ];
  for (const sql of stmts) {
    try { await masterSequelize.query(sql); }
    catch (e) { console.warn('[MASTER DB] schema-extra skipped:', e.message); }
  }
  console.log('[MASTER DB] Schema extras ensured (developer role, task.category/source_meta).');
};

/**
 * Start the application
 */
const start = async () => {
  try {
    // 1. Authenticate Master DB
    await masterSequelize.authenticate();
    console.log('[MASTER DB] Connection established.');

    // 1b. Enum + column extras (idempotent) BEFORE sync so models line up.
    await ensureSchemaExtras();

    // 2. Sync Master Models
    await masterSequelize.sync({ alter: false });
    console.log('[MASTER DB] Models synchronized.');

    // 3. Seed RECO agents into master agents table (idempotent)
    await seedMasterAgents();

    // 4. Run reco table migrations on all brand DBs (idempotent)
    await migrateAllBrands();

    // 4b. Zoho Books mirror tables (master DB, idempotent)
    await migrateZoho();

    // 4c. Compliance Tracker tables (master DB, idempotent)
    await migrateCompliance();

    // 4d. Statutory Compliance table (master DB, idempotent)
    await migrateStatutory();

    // 5. Start Express Server
    app.listen(PORT, () => {
      console.log(`[SERVER] Colonel Backend running on port ${PORT}`);
      console.log(`[SERVER] Environment: ${process.env.NODE_ENV}`);
    });

  } catch (error) {
    console.error('[SERVER ERROR] Failed to start:', error);
    process.exit(1);
  }
};

// Handle process termination
process.on('SIGINT', async () => {
  console.log('[SERVER] Shutting down...');
  await masterSequelize.close();
  process.exit(0);
});

start();
