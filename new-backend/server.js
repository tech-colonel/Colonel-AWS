const app = require('./src/app');
const { masterSequelize } = require('./src/config/database');
const { migrateAllBrands } = require('./src/db/migrate');
const dotenv = require('dotenv');

dotenv.config();

const PORT = process.env.PORT || 8001;

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

    // 3. Run reco table migrations on all brand DBs (idempotent)
    await migrateAllBrands();

    // 4. Start Express Server
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
