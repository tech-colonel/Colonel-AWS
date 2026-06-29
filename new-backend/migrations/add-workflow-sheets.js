/**
 * Migration: Add `sheets` JSONB column to agent_workflows table
 *
 * Run this if the backend was started before the multi-sheet workflow feature
 * was added and the column does not yet exist.
 *
 * Usage:
 *   cd new-backend
 *   node migrations/add-workflow-sheets.js
 */

require('dotenv').config();
const { masterSequelize } = require('../src/config/database');

(async () => {
  try {
    await masterSequelize.authenticate();
    console.log('[master DB] Connected.');

    // Check if column already exists
    const [rows] = await masterSequelize.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'agent_workflows'
        AND column_name  = 'sheets'
    `);

    if (rows.length > 0) {
      console.log('[agent_workflows] ✓ "sheets" column already exists — skipping.');
    } else {
      await masterSequelize.query(`
        ALTER TABLE agent_workflows
        ADD COLUMN sheets JSONB NOT NULL DEFAULT '[]'
      `);
      console.log('[agent_workflows] ✅ Added "sheets" JSONB column.');
    }

    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
})();
