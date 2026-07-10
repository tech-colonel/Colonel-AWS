// 008_apply_agent_ids_to_code.js — companion to 008_regen_agent_ids.js.
// Applies the old→new agent-id mapping (008-agent-id-remap.json) to the source
// files that hardcode agent ids. Only d-series ids appear in code (c/f-series are
// DB-only); brand ids (b-series) are NOT in the mapping so they're never touched.
// Backs up each modified file (.bak-<ts>) and reports per-file replacement counts.
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const map = JSON.parse(fs.readFileSync(path.join(__dirname, '008-agent-id-remap.json'), 'utf8'));
const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

const FILES = [
  'frontend/src/pages/accountant/AgentDispatch.jsx',
  'frontend/src/pages/accountant/BrandAgentsInventory.jsx',
  'frontend/src/pages/accountant/ComplianceTracker.jsx',
  'frontend/src/pages/accountant/RecoSuite.jsx',
  'frontend/src/pages/admin/AgentsPage.jsx',
  'new-backend/seed-accountants.js',
  'new-backend/seeders/01-reco-agents.js',
  'new-backend/src/data/complianceTemplate.js',
];

let grand = 0;
for (const rel of FILES) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { console.log(`  (skip missing) ${rel}`); continue; }
  let txt = fs.readFileSync(p, 'utf8');
  let n = 0;
  for (const m of map) {
    const parts = txt.split(m.old);
    if (parts.length > 1) { n += parts.length - 1; txt = parts.join(m.neu); }
  }
  if (n > 0) {
    fs.copyFileSync(p, `${p}.bak-${ts}`);
    fs.writeFileSync(p, txt);
    grand += n;
    console.log(`  ✅ ${rel.padEnd(58)} ${n} id(s)`);
  } else {
    console.log(`  ·  ${rel.padEnd(58)} 0`);
  }
}
console.log(`\nDone. ${grand} id references rewritten across code.`);
