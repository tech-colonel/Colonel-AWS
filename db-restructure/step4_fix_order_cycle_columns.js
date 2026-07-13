// step4_fix_order_cycle_columns.js
// Fix: Shopify-Order-Cycle showed ₹0 / 0 matched after processing.
// Root cause: our agents.columns for 'Shopify-Order-Cycle' was [] (the friend's
// seed columns were never applied to our DB), so getDynamicModel built the table +
// model with ONLY the base columns. bulkCreate then silently dropped every amount/
// status field (Sequelize only writes defined attributes) → 133k shell rows with no
// amounts → summary sums null → ₹0. (sync() is a no-op in unified mode, so the table
// was never altered to add the columns either.)
//
// Fix: (1) set agents.columns to the friend's 36-col order-cycle schema, then
// (2) ALTER the existing shopify_order_cycle table to add every missing data column
// (Sequelize type mapping), keeping brand_id/RLS/grants already in place.
// Future runs then persist amounts and the summary computes for real.
const path = require('path');
const fs = require('fs');
const NB = path.join(__dirname, '..', 'new-backend');
require(path.join(NB, 'node_modules', 'dotenv')).config({ path: path.join(NB, '.env') });
const { masterSequelize, UNIFIED } = require(path.join(NB, 'src', 'config', 'database'));
const { QueryTypes } = require(path.join(NB, 'node_modules', 'sequelize'));
const { getDynamicModel } = require(path.join(NB, 'src', 'models', 'brand'));
const { Agent } = require(path.join(NB, 'src', 'models', 'master'));

// Extract the `columns: [ ... ]` array literal from the origin seed text.
function extractColumns(text) {
  const i = text.indexOf('columns:');
  const start = text.indexOf('[', i);
  let depth = 0, end = -1;
  for (let j = start; j < text.length; j++) {
    if (text[j] === '[') depth++;
    else if (text[j] === ']') { depth--; if (depth === 0) { end = j; break; } }
  }
  // eslint-disable-next-line no-eval
  return eval('(' + text.slice(start, end + 1) + ')');
}

(async () => {
  if (!UNIFIED) { console.error('Refusing: USE_UNIFIED_DB not true.'); process.exit(1); }
  const seedText = fs.readFileSync('/tmp/origin-seed-oc.js', 'utf8');
  const columns = extractColumns(seedText);
  console.log(`Parsed ${columns.length} columns from origin seed.`);

  // 1. Update our agent's columns (keep our agent id).
  const [n] = await masterSequelize.query(
    `UPDATE agents SET columns = :cols WHERE name = 'Shopify-Order-Cycle'`,
    { replacements: { cols: JSON.stringify(columns) } });
  console.log('agents.columns updated for Shopify-Order-Cycle.');

  // 2. Build the intended model (base + brand_id + custom cols) and ALTER the table
  //    to add any missing columns.
  const agent = await Agent.findOne({ where: { name: 'Shopify-Order-Cycle' } });
  const table = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase(); // shopify_order_cycle
  const model = getDynamicModel(masterSequelize, table, agent.columns);
  const qi = masterSequelize.getQueryInterface();
  const existing = await qi.describeTable(table);

  let added = 0;
  for (const [name, attr] of Object.entries(model.rawAttributes)) {
    if (existing[name]) continue;            // already present
    if (name === 'id' || name === 'brand_id') continue; // managed already
    await qi.addColumn(table, name, { type: attr.type, allowNull: true });
    added++;
    console.log(`  + ${table}.${name}`);
  }
  console.log(`\nAdded ${added} column(s) to ${table}.`);

  // 3. Report the empty shell rows (the failed run) so the user can re-run.
  const [{ n: shells }] = await masterSequelize.query(
    `SELECT count(*)::int n FROM "${table}"`, { type: QueryTypes.SELECT });
  console.log(`\nNOTE: ${table} has ${shells} existing rows with NO amounts (from the broken run).`);
  console.log('Re-run the agent to populate amounts; or clear them with:');
  console.log(`  DELETE FROM ${table};   (all brands)   — decide with the user.`);
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
