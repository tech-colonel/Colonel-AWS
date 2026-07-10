// 009_rename_coa_files.js — completeness fix for the Phase-2 brand-id remap.
//
// COA / Ledger-Master files are saved on disk keyed by brand id at
// new-backend/output/ledgers/<brandId>.xlsx (recoController.saveLedgerMaster).
// After 009 remapped brand ids, these files still had the OLD ids → the app
// looked them up by the NEW id and reported "no COA saved" (accountant would have
// to re-upload). This renames each file old→new using the 009 mapping.
//
// Idempotent: only renames files whose basename matches an OLD id in the mapping.
// Run on any environment (incl. AWS) right after applying the 009 brand-id mapping.
const fs = require('fs');
const path = require('path');
const map = require('./009-brand-id-remap.json');
const m = Object.fromEntries(map.map((x) => [x.old, x.neu]));
const dir = path.join(__dirname, '..', 'new-backend', 'output', 'ledgers');

if (!fs.existsSync(dir)) { console.log('No ledgers dir — nothing to do.'); process.exit(0); }
let n = 0;
for (const f of fs.readdirSync(dir)) {
  const full = path.join(dir, f);
  if (f.endsWith('.bak') || fs.statSync(full).isDirectory()) continue;
  const ext = path.extname(f), base = path.basename(f, ext);
  if (m[base]) {
    fs.renameSync(full, path.join(dir, m[base] + ext));
    console.log(`  ${f}  →  ${m[base]}${ext}`);
    n++;
  }
}
console.log(`Done. Renamed ${n} COA file(s).`);
