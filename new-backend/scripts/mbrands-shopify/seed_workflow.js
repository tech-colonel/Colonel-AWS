// One-off local seeder: registers the validated "shopify mbrands" workflow
// (workflow.json in this directory) under the existing Sales-Shopify agent,
// so it's usable from the M Brands → Sales-Shopify agent workspace's
// "Apply Workflow" picker in the running app.
//
// Unlike the D'Chica Shopify workflow, this one doesn't touch sku_master/
// ledger_master — Source (state -> Debtor/Inv no.) and Stock Master (SKU ->
// Stock Name) are carried forward directly from the uploaded "template"
// file input (last month's own Working file) via `type: "template"` sheets,
// per the M Brands SOP.
//
// Idempotent — safe to re-run (updates the existing workflow row by name).
//
// Usage: cd new-backend && node scripts/mbrands-shopify/seed_workflow.js
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { Brand, Agent, BrandAgent, AgentWorkflow } = require('../../src/models/master');

const DIR = __dirname;
const BRAND_NAME = 'M Brands';

(async () => {
  const workflow = JSON.parse(fs.readFileSync(path.join(DIR, 'workflow.json'), 'utf8'));

  const agent = await Agent.findOne({ where: { name: 'Sales-Shopify' } });
  if (!agent) throw new Error("Agent 'Sales-Shopify' not found — expected to already exist.");

  const brand = await Brand.findOne({ where: { name: BRAND_NAME } });
  if (!brand) throw new Error(`Brand '${BRAND_NAME}' not found — expected to already exist.`);

  const linked = await BrandAgent.findOne({ where: { brand_id: brand.id, agent_id: agent.id } });
  if (!linked) throw new Error(`${BRAND_NAME} is not linked to the Sales-Shopify agent — expected it already was.`);
  console.log(`[seed] confirmed '${brand.name}' is linked to agent 'Sales-Shopify'`);

  const existingWf = await AgentWorkflow.findOne({ where: { agent_id: agent.id, name: workflow.name } });
  if (existingWf) {
    await existingWf.update({
      description: workflow.description,
      sheets: workflow.sheets,
      file_inputs: workflow.fileInputs,
    });
    console.log(`[seed] updated existing workflow '${workflow.name}' (${existingWf.id})`);
  } else {
    const wf = await AgentWorkflow.create({
      agent_id: agent.id,
      name: workflow.name,
      description: workflow.description,
      sample_columns: [],
      columns: [],
      sheets: workflow.sheets,
      file_inputs: workflow.fileInputs,
    });
    console.log(`[seed] created workflow '${workflow.name}' (${wf.id})`);
  }

  console.log(`\nDone. Open the app as admin/accountant -> ${brand.name} brand -> Sales-Shopify agent -> Workflows -> "shopify mbrands".`);
  process.exit(0);
})().catch(err => {
  console.error('[seed] FAILED:', err);
  process.exit(1);
});
