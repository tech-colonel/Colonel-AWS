const app = require('./src/app');
const { masterSequelize } = require('./src/config/database');
const { migrateAllBrands } = require('./src/db/migrate');
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
      ('d0000000-0000-0000-0000-000000000001', 'gstr_2b_books',
       'GSTR-2B vs Purchase Register + Debit Note Register reconciliation', '[]'),
      ('d0000000-0000-0000-0000-000000000002', 'gstr_2b_books_multistate',
       'GSTR-2B vs Books for multi-state brands — detects cross-state booking errors', '[]'),
      ('d0000000-0000-0000-0000-000000000003', 'gstr_3b_tally_entry',
       'Parse GSTR-3B and generate ready-to-post Tally journal entries', '[]'),
      ('d0000000-0000-0000-0000-000000000004', 'universal_bank_statement',
       'Brand-agnostic bank statement classifier mapped to Tally chart of accounts', '[]'),
      ('d0000000-0000-0000-0000-000000000005', 'gstr_1_vs_books',
       'GSTR-1 outward supplies vs Tally sales register reconciliation', '[]')
    ON CONFLICT (name) DO NOTHING
  `);
  console.log('[SEED] 5 RECO agents seeded into colonel-master.');
};

/**
 * Start the application
 */
const start = async () => {
  try {
    // 1. Authenticate Master DB
    await masterSequelize.authenticate();
    console.log('[MASTER DB] Connection established.');

    // 2. Sync Master Models
    await masterSequelize.sync({ alter: false });
    console.log('[MASTER DB] Models synchronized.');

    // 3. Seed RECO agents into master agents table (idempotent)
    await seedMasterAgents();

    // 4. Run reco table migrations on all brand DBs (idempotent)
    await migrateAllBrands();

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
