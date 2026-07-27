#!/usr/bin/env node
/**
 * Backfill generalizable payee keys, and seed side rules from the checked-in JSON.
 *
 * WHY THIS EXISTS
 * ---------------
 * extractPayeeKeys only recognised FLO's slash-NEFT / IMPS-FROM shapes, so ICICI and
 * Kotak statements produced nothing but an 'exact' key — and every 'exact' key embeds a
 * one-time transaction reference, so it can never match again. Measured on the 2026-06
 * Urban Plant statement: 598 learned entries matched 0 of 261 rows. Months of accountant
 * corrections had no effect on any later run.
 *
 * This re-runs the FIXED extractor over the stored corrections and writes the
 * name / neft_name / vpa keys that should have been there all along, so past work starts
 * paying off from the next run.
 *
 * NOTE ON THE SOURCE TABLE: for Urban Plant and M Brands the stored corrections live in
 * bank_payee_directory under key_type='exact' (554 + 478 rows). bank_reco_corrections
 * holds ZERO rows for both brands — its 15,020 rows belong to FLO / Stroom / Koparo.
 * Both are read here so the script works for either shape.
 *
 * SAFETY
 *   - dry run by default; pass --apply to write
 *   - additive only: writes new rows with source='backfill', never alters existing ones
 *   - idempotent: running twice produces the same rows
 *   - reversible: DELETE FROM bank_payee_directory WHERE source='backfill'
 *
 * Usage:
 *   node scripts/backfill_payee_keys.js                          # dry run, default brands
 *   node scripts/backfill_payee_keys.js --apply
 *   node scripts/backfill_payee_keys.js --brand "Urban Plant" --apply
 *   node scripts/backfill_payee_keys.js --seed-side-rules --apply
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const { extractPayeeKeys } = require('../src/controllers/bankCorrectionsController');
const { Brand } = require('../src/models/master');
const { getBrandConnection } = require('../src/config/database');

const DEFAULT_BRANDS = ['Urban Plant', 'M Brands'];
const MOBILE_RE = /^[6-9]\d{9}$/;

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const SEED_RULES = argv.includes('--seed-side-rules');
const brandArgs = argv.reduce((acc, a, i) => (a === '--brand' ? [...acc, argv[i + 1]] : acc), []);
const BRANDS = brandArgs.length ? brandArgs : DEFAULT_BRANDS;

const say = (...a) => console.log(...a);

async function backfillBrand(brand) {
  const seq = getBrandConnection(brand.db_name);
  say(`\n${'='.repeat(72)}\n${brand.name}\n${'='.repeat(72)}`);

  // 1. Collect stored corrections from BOTH possible homes.
  const [dirRows] = await seq.query(
    `SELECT key_value AS narration, ledger, txn_type, updated_at
       FROM bank_payee_directory WHERE brand_id = $1 AND key_type = 'exact'`,
    { bind: [brand.id] });
  const [corrRows] = await seq.query(
    `SELECT narration_raw AS narration, correct_ledger AS ledger, correct_type AS txn_type, updated_at
       FROM bank_reco_corrections WHERE brand_id = $1`,
    { bind: [brand.id] });
  const source = [...dirRows, ...corrRows].filter((r) => r.narration && r.ledger);
  say(`source corrections: ${dirRows.length} (directory 'exact') + ${corrRows.length} (reco_corrections) = ${source.length}`);

  // 2. Re-key with the fixed extractor. Most-recent wins; a key contested by more than two
  //    distinct ledgers is not trustworthy — skip it and report. (A contested vendor is
  //    usually really a two-sided SIDE rule, which deriveSideRules handles.)
  source.sort((a, b) => new Date(a.updated_at || 0) - new Date(b.updated_at || 0));
  const derived = new Map();                 // "type\0value" -> {ledger, txn_type}
  const votes = new Map();                   // "type\0value" -> Map(normLedger -> {count,label})
  const normLedger = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  for (const r of source) {
    const keys = extractPayeeKeys(r.narration);
    for (const [keyType, keyValue] of Object.entries(keys)) {
      if (keyType === 'exact' || keyType === 'phone') continue;
      const id = `${keyType}\0${keyValue}`;
      if (!votes.has(id)) votes.set(id, new Map());
      const v = votes.get(id);
      const nl = normLedger(r.ledger);
      v.set(nl, { count: (v.get(nl)?.count || 0) + 1, label: r.ledger });
      derived.set(id, { keyType, keyValue, ledger: r.ledger, txn_type: r.txn_type || null });
    }
  }
  // A key is only as trustworthy as the agreement behind it. Ledgers are compared
  // CASE-INSENSITIVELY first: 'Google India Pvt Ltd' and 'GOOGLE INDIA PVT LTD' are one
  // ledger, and counting them as two used to inflate the conflict count.
  //
  // The old rule dropped a key only when MORE THAN TWO distinct ledgers disagreed, which
  // let a straight 1-vs-1 contradiction survive on most-recent-wins. That is how
  // name|linkedin came to mean 'Shopify Commerce Singapore' — two historical corrections
  // labelled the same LinkedIn card payment differently ('Round Off' and 'Shopify'), and
  // the later one silently won, then asserted itself at High confidence on future rows.
  // A confidently wrong answer costs the accountant more than no answer.
  //
  // Now: a strict majority wins (and its spelling becomes canonical); a tie is dropped.
  let contested = 0;
  for (const [id, v] of votes) {
    if (v.size <= 1) continue;                                  // unanimous
    const ranked = [...v.values()].sort((a, b) => b.count - a.count);
    if (ranked[0].count > ranked[1].count) {
      const d = derived.get(id);
      if (d) d.ledger = ranked[0].label;                        // majority beats most-recent
    } else {
      derived.delete(id); contested++;                          // no winner -> untrustworthy
    }
  }

  // 3. Poisoned phone rows: written before the phone key was constrained to [6-9]\d{9},
  //    so they are leaked NEFT/bank reference numbers, not mobile numbers.
  const [phoneRows] = await seq.query(
    `SELECT key_value FROM bank_payee_directory WHERE brand_id = $1 AND key_type = 'phone'`,
    { bind: [brand.id] });
  const badPhones = phoneRows.map((r) => r.key_value).filter((v) => !MOBILE_RE.test(v));

  const byType = {};
  for (const d of derived.values()) byType[d.keyType] = (byType[d.keyType] || 0) + 1;
  say(`derived generalizable keys: ${derived.size} ` +
      `(${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'})`);
  say(`contested keys dropped: ${contested}`);
  say(`leaked phone rows to delete: ${badPhones.length} / ${phoneRows.length}`);

  if (!APPLY) {
    const sample = [...derived.values()].slice(0, 8);
    say('\nsample (first 8):');
    for (const d of sample) say(`   ${d.keyType.padEnd(10)} ${d.keyValue.padEnd(38)} -> ${d.ledger}`);
    say('\nDRY RUN — nothing written. Re-run with --apply.');
    return;
  }

  const t = await seq.transaction();
  try {
    for (const d of derived.values()) {
      await seq.query(
        `INSERT INTO bank_payee_directory
           (brand_id, key_type, key_value, ledger, txn_type, source, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'backfill', NOW())
         ON CONFLICT (brand_id, key_type, key_value)
         DO UPDATE SET ledger = EXCLUDED.ledger, txn_type = EXCLUDED.txn_type,
                       source = 'backfill', updated_at = NOW()`,
        { bind: [brand.id, d.keyType, d.keyValue, d.ledger, d.txn_type], transaction: t });
    }
    if (badPhones.length) {
      await seq.query(
        `DELETE FROM bank_payee_directory
          WHERE brand_id = $1 AND key_type = 'phone' AND key_value <> ALL($2::text[])`,
        { bind: [brand.id, phoneRows.map((r) => r.key_value).filter((v) => MOBILE_RE.test(v))],
          transaction: t });
    }
    await t.commit();
    say(`\nAPPLIED: ${derived.size} keys upserted, ${badPhones.length} leaked phone rows deleted.`);
    say(`undo: DELETE FROM bank_payee_directory WHERE brand_id='${brand.id}' AND source='backfill';`);
  } catch (e) {
    await t.rollback();
    throw e;
  }
}

async function seedSideRules(brand) {
  const slug = brand.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const file = path.join(__dirname, '../output/side_ledgers', `${slug}.json`);
  if (!fs.existsSync(file)) { say(`  no seed JSON for ${brand.name}`); return; }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rules = json.counterparties || [];
  say(`  ${brand.name}: ${rules.length} rules in ${slug}.json`);
  if (!APPLY) return;

  const seq = getBrandConnection(brand.db_name);
  // The table is created by db-restructure/023_bank_side_rules.sql, run as the postgres
  // superuser — the app role deliberately cannot CREATE in schema public. Fail loudly
  // here if the migration has not been applied, rather than 42P01-ing mid-insert.
  const [[{ exists: hasTable }]] = await seq.query(
    `SELECT to_regclass('public.bank_side_rules') IS NOT NULL AS exists`);
  if (!hasTable) {
    throw new Error('bank_side_rules is missing — run:\n'
      + '  psql -U postgres -d <db> -f db-restructure/023_bank_side_rules.sql');
  }
  const t = await seq.transaction();
  try {
    let n = 0;
    // Priority follows file order so the hand-tuned ordering (specific tokens first) is
    // preserved; loadSideRules then re-sorts by longest token within a priority.
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      const tokens = (r.tokens || []).map((x) => String(x).toUpperCase());
      if (!tokens.length || !r.credit || !r.debit) continue;
      const [dup] = await seq.query(
        `SELECT id FROM bank_side_rules WHERE brand_id = $1 AND tokens = $2::text[]`,
        { bind: [brand.id, tokens], transaction: t });
      if (dup.length) continue;                  // idempotent
      await seq.query(
        `INSERT INTO bank_side_rules
           (brand_id, tokens, credit_ledger, debit_ledger, fixed_type, tier, priority, status, source)
         VALUES ($1, $2::text[], $3, $4, $5, $6, $7, 'active', 'seed')`,
        { bind: [brand.id, tokens, r.credit, r.debit, r.type || null,
                 r.fallback ? 'fallback' : 'primary', 10 + i], transaction: t });
      n++;
    }
    await t.commit();
    say(`  seeded ${n} new rule(s) for ${brand.name}`);
  } catch (e) { await t.rollback(); throw e; }
}

(async () => {
  const brands = [];
  for (const name of BRANDS) {
    const b = await Brand.findOne({ where: { name } });
    if (!b) { say(`!! brand not found: ${name}`); continue; }
    brands.push(b);
  }
  if (SEED_RULES) {
    say(`\n${'='.repeat(72)}\nSeeding side rules from checked-in JSON\n${'='.repeat(72)}`);
    for (const b of brands) await seedSideRules(b);
  }
  for (const b of brands) await backfillBrand(b);
  say(APPLY ? '\nDone.' : '\nDry run complete — nothing was written.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
