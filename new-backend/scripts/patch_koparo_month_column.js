// One-off, idempotent patch: adds the "gt_invno_month" computed column to the
// shopify-koparo workflow's "GST & Tax" sheet on whatever DB it's run against.
// Run from new-backend/:
//
//   node scripts/patch_koparo_month_column.js
//
// Safe to re-run: does nothing if the column is already present. Backs up the
// row's current `sheets` JSON to a timestamped file (in this same directory)
// before writing.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const WORKFLOW_ID = '61608940-dad5-4be0-a697-5f77c35eff66'; // shopify-koparo

const NEW_COLUMN = {
  id: 'gt_invno_month',
  type: 'computed',
  label: 'Invoice Number',
  order: 201.5,
  formula: "{Invoice Number}.replace(/-\\d+$/, '') + '-' + String({MonthNumber}).padStart(2, '0')",
};

(async () => {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    database: 'colonel_agent_accountant',
  });
  await client.connect();

  const { rows } = await client.query(
    'SELECT sheets FROM agent_workflows WHERE id = $1',
    [WORKFLOW_ID]
  );
  if (rows.length === 0) {
    console.error('shopify-koparo workflow row not found — id', WORKFLOW_ID);
    process.exit(1);
  }

  const sheets = rows[0].sheets;
  const gstSheet = sheets.find(s => s.name === 'GST & Tax');
  if (!gstSheet) {
    console.error('"GST & Tax" sheet not found in this workflow — aborting, needs manual review');
    process.exit(1);
  }

  if (gstSheet.columns.some(c => c.id === 'gt_invno_month')) {
    console.log('Already patched (gt_invno_month present) — nothing to do.');
    await client.end();
    return;
  }

  const backupPath = path.join(
    __dirname,
    `koparo_workflow_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );
  fs.writeFileSync(backupPath, JSON.stringify(rows[0].sheets, null, 2));
  console.log('Backed up current sheets JSON to', backupPath);

  gstSheet.columns.push(NEW_COLUMN);

  await client.query(
    'UPDATE agent_workflows SET sheets = $1::jsonb WHERE id = $2',
    [JSON.stringify(sheets), WORKFLOW_ID]
  );

  const verify = await client.query('SELECT sheets FROM agent_workflows WHERE id = $1', [WORKFLOW_ID]);
  const verifyGst = verify.rows[0].sheets.find(s => s.name === 'GST & Tax');
  console.log('Verified — gt_invno_month present:', verifyGst.columns.some(c => c.id === 'gt_invno_month'));

  await client.end();
})().catch(e => { console.error(e); process.exit(1); });
