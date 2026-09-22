// One-off local seeder: creates the D'Chica brand, links it to the existing
// Sales-Shopify agent, uploads the SKU/HSN masters derived from the answer-key
// working file, and registers the validated "shopify-dchica" workflow so it's
// usable from the Sales-Shopify agent workspace in the running app.
//
// Idempotent — safe to re-run (findOrCreate / ON CONFLICT DO NOTHING throughout).
//
// Usage: cd new-backend && node scripts/dchica-shopify/seed_brand_and_workflow.js
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { Brand, Agent, BrandAgent, AgentWorkflow } = require('../../src/models/master');
const { getBrandConnection, createBrandDatabase } = require('../../src/config/database');
const { getBrandAgentModel } = require('../../src/models/brand');

const DIR = __dirname;
const BRAND_NAME = "D'Chica";
// The brand has gone through renames across environments — AWS prod had it as
// the misspelled "Dichika", corrected to "Dchica" (no apostrophe) on 2026-09-17;
// local dev has it as "D'Chica". Match ANY of these (by known id first, then by
// name) before ever creating a new brand, so this script attaches the workflow
// to the one real brand in whichever DB it's run against instead of spawning a
// duplicate.
const KNOWN_BRAND_IDS = ['6419fcf0-b961-4f48-a726-15c111bda75d']; // AWS prod
const KNOWN_BRAND_NAME_VARIANTS = ["d'chica", 'dchica', 'dichika'];

(async () => {
  const skuMaster = JSON.parse(fs.readFileSync(path.join(DIR, 'sku_master.json'), 'utf8'));
  const ledgerMaster = JSON.parse(fs.readFileSync(path.join(DIR, 'hsn_master.json'), 'utf8'));
  const workflow = JSON.parse(fs.readFileSync(path.join(DIR, 'workflow.json'), 'utf8'));

  const agent = await Agent.findOne({ where: { name: 'Sales-Shopify' } });
  if (!agent) throw new Error("Agent 'Sales-Shopify' not found — expected to already exist.");

  let brand = null;
  for (const id of KNOWN_BRAND_IDS) {
    brand = await Brand.findByPk(id);
    if (brand) break;
  }
  if (!brand) {
    const all = await Brand.findAll();
    brand = all.find(b => KNOWN_BRAND_NAME_VARIANTS.includes(String(b.name).trim().toLowerCase())) || null;
  }
  if (!brand) {
    const db_name = `colonel_${BRAND_NAME.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    await createBrandDatabase(db_name);
    brand = await Brand.create({ name: BRAND_NAME, description: "D'Chica Fashion Lifestyle Private Limited — Shopify D2C", db_name });
    console.log(`[seed] no existing D'Chica/Dchica/Dichika brand found — created '${BRAND_NAME}' (${brand.id})`);
  } else {
    console.log(`[seed] matched existing brand '${brand.name}' (${brand.id}) — attaching, not creating`);
  }

  const brandDb = getBrandConnection(brand.db_name);
  const BrandAgentModel = getBrandAgentModel(brandDb);
  await brandDb.sync();

  await BrandAgent.findOrCreate({ where: { brand_id: brand.id, agent_id: agent.id } });
  console.log(`[seed] linked brand to agent 'Sales-Shopify'`);

  const [record] = await BrandAgentModel.findOrCreate({ where: { brand_id: brand.id, agent_id: agent.id } });
  await record.update({ sku_master: skuMaster, ledger_master: ledgerMaster });
  console.log(`[seed] uploaded masters — sku_master: ${skuMaster.length} rows, ledger_master: ${ledgerMaster.length} rows`);

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

  console.log(`\nDone. Open the app as admin/accountant → ${brand.name} brand → Sales-Shopify agent → Workflows → "shopify-dchica".`);
  process.exit(0);
})().catch(err => {
  console.error('[seed] FAILED:', err);
  process.exit(1);
});
