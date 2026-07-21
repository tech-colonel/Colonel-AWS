// new-backend/seed-flo-brand.js
// One-off: ensure FLO brand exists, grant chauhandhaval932@gmail.com access, seed FLO COA.
// Run: node seed-flo-brand.js
const { execFileSync } = require('child_process');
const path = require('path');
const { masterSequelize } = require('./src/config/database');

const BRAND_NAME = 'FLO';
const USER_EMAIL = 'chauhandhaval932@gmail.com';
const COA_FILE = '/Users/dhavalchauhan/Dhaval/Bank RECO/Master.xlsx';

// UPPER + trim + collapse internal whitespace — matches ledger_master.ledger_name_key convention.
const keyOf = (s) => String(s).toUpperCase().trim().replace(/\s+/g, ' ');

// classify.py --list-ledgers prints the Tally report's own company/address block
// before the real ledger names begin (verified once against Master.xlsx: indices
// 0-3 are exactly this header, every real ledger follows). Drop it by exact
// content match so a differently-ordered or regenerated file can't silently
// swallow a real ledger — this is a small denylist, not a positional slice.
const HEADER_LINES = new Set([
  'Flo Sleep Solutions Pvt Ltd',
  'Level 4 A Wing, Regus Suburb Centre Pvt Ltd,',
  'Dynasty Business Park, Andheri Kurla Road,',
  'Andheri East, Mumbai',
]);

(async () => {
  await masterSequelize.authenticate();

  // 1. Ensure FLO brand exists
  const db_name = `colonel_${BRAND_NAME.toLowerCase().replace(/[^a-z0-9]/g, '_')}`; // colonel_flo
  let [rows] = await masterSequelize.query(
    `SELECT id, name FROM brands WHERE name = $1`, { bind: [BRAND_NAME] });
  let brandId;
  if (rows.length) {
    brandId = rows[0].id;
    console.log(`[FLO] brand exists: ${brandId}`);
  } else {
    const [ins] = await masterSequelize.query(
      `INSERT INTO brands (id, name, description, db_name, "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, now(), now()) RETURNING id`,
      { bind: [BRAND_NAME, 'FLO Sleep Solutions Pvt Ltd', db_name] });
    brandId = ins[0].id;
    console.log(`[FLO] brand created: ${brandId}`);
  }

  // 2. Ensure user exists (accountant) and grant brand access
  let [urows] = await masterSequelize.query(
    `SELECT id, role FROM users WHERE email = $1`, { bind: [USER_EMAIL] });
  if (!urows.length) {
    // Provision as accountant if missing. Password hash: reuse an existing known-good hash pattern.
    // NOTE: prefer the user already exists; only create if truly absent.
    throw new Error(`User ${USER_EMAIL} not found — create it via the normal signup/admin flow first, then re-run.`);
  }
  const userId = urows[0].id;
  console.log(`[FLO] user ${USER_EMAIL} = ${userId} (role ${urows[0].role})`);
  await masterSequelize.query(
    `INSERT INTO brand_users (id, brand_id, user_id, "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, now(), now())
     ON CONFLICT DO NOTHING`,
    { bind: [brandId, userId] });
  console.log(`[FLO] access granted (brand_users)`);

  // 3. Seed COA into ledger_master (direct insert; ingestLedgerMasterToTable is missing upstream)
  const out = execFileSync('python3',
    [path.join(__dirname, 'scripts', 'classify.py'), '--list-ledgers', '--ledger', COA_FILE],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const rawLedgers = JSON.parse(out);
  const ledgers = rawLedgers.filter((name) => !HEADER_LINES.has(name));
  console.log(`[FLO] COA cleaned: ${ledgers.length} ledgers (dropped ${rawLedgers.length - ledgers.length} header/address lines)`);
  let inserted = 0;
  for (const name of ledgers) {
    const [r] = await masterSequelize.query(
      `INSERT INTO ledger_master (id, brand_id, ledger_name, ledger_name_key, source, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'upload', now(), now())
       ON CONFLICT (brand_id, ledger_name_key) DO NOTHING RETURNING id`,
      { bind: [brandId, name, keyOf(name)] });
    if (r.length) inserted++;
  }
  console.log(`[FLO] ledger_master: +${inserted} new of ${ledgers.length}`);
  console.log(`\nFLO_BRAND_ID=${brandId}`);   // <-- copy this into RecoWorkspace (Task 12)
  await masterSequelize.close();
})().catch((e) => { console.error(e); process.exit(1); });
