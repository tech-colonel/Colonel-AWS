// 009_apply_brand_ids_to_code.js — companion to 009_regen_brand_ids.js.
// Applies the old→new BRAND-id mapping (009-brand-id-remap.json) to source files
// that hardcode brand ids (KOPARO_BRAND_ID in recoController, STROOM_BRAND_ID in
// the statutory seeder). Scans the code dirs so nothing is missed; backs up each
// modified file (.bak-<ts>). Agent ids (c/d/f-series) are not in this mapping so
// they're never touched.
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const map = JSON.parse(fs.readFileSync(path.join(__dirname, '009-brand-id-remap.json'), 'utf8'));
const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

// Walk a dir for .js/.jsx (skip node_modules/.bak/build).
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/node_modules|build|\.git/.test(p)) walk(p, out); }
    else if (/\.(js|jsx)$/.test(e.name) && !/\.bak/.test(e.name)) out.push(p);
  }
  return out;
}

const targets = [
  ...walk(path.join(ROOT, 'frontend', 'src')),
  ...walk(path.join(ROOT, 'new-backend', 'src')),
  ...fs.readdirSync(path.join(ROOT, 'new-backend'))
      .filter((f) => /\.js$/.test(f) && !/\.bak/.test(f))
      .map((f) => path.join(ROOT, 'new-backend', f)),
];

let grand = 0;
for (const p of targets) {
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
    console.log(`  ✅ ${path.relative(ROOT, p).padEnd(52)} ${n} id(s)`);
  }
}
console.log(`\nDone. ${grand} brand-id reference(s) rewritten.`);
