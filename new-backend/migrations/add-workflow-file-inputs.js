/**
 * Migration: Add `file_inputs` JSONB column to agent_workflows table
 *
 * Run this if the backend was started before the multi-file-input workflow
 * feature was added and the column does not yet exist (mirrors
 * add-workflow-sheets.js for the `sheets` column).
 *
 * Usage:
 *   cd new-backend
 *   node migrations/add-workflow-file-inputs.js
 */

require('dotenv').config();
const { masterSequelize } = require('../src/config/database');

(async () => {
  try {
    await masterSequelize.authenticate();
    console.log('[master DB] Connected.');

    const [rows] = await masterSequelize.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'agent_workflows'
        AND column_name  = 'file_inputs'
    `);

    if (rows.length > 0) {
      console.log('[agent_workflows] ✓ "file_inputs" column already exists — skipping.');
    } else {
      await masterSequelize.query(`
        ALTER TABLE agent_workflows
        ADD COLUMN file_inputs JSONB NOT NULL DEFAULT '[]'
      `);
      console.log('[agent_workflows] ✅ Added "file_inputs" JSONB column.');
    }

    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
})();
