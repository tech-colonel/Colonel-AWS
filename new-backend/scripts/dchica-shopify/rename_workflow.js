// Renames the existing 'shopify-dchica' AgentWorkflow row to 'shopify dchica'
// (and refreshes it from workflow.json in case the definition changed since).
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { Agent, AgentWorkflow } = require('../../src/models/master');

const DIR = __dirname;

(async () => {
  const workflow = JSON.parse(fs.readFileSync(path.join(DIR, 'workflow.json'), 'utf8'));
  const agent = await Agent.findOne({ where: { name: 'Sales-Shopify' } });
  if (!agent) throw new Error("Agent 'Sales-Shopify' not found");

  const wf = await AgentWorkflow.findOne({ where: { agent_id: agent.id, name: 'shopify-dchica' } })
    || await AgentWorkflow.findOne({ where: { agent_id: agent.id, name: 'shopify dchica' } });

  if (!wf) throw new Error("Workflow not found under either name");

  await wf.update({
    name: workflow.name,
    description: workflow.description,
    sheets: workflow.sheets,
    file_inputs: workflow.fileInputs,
  });

  console.log(`[rename] workflow ${wf.id} is now named '${wf.name}'`);
  process.exit(0);
})().catch(err => {
  console.error('[rename] FAILED:', err);
  process.exit(1);
});
