#!/usr/bin/env node
/**
 * Import an updated Chart of Accounts workbook into ledger_master for a brand.
 *
 * Uses classify.py's own loader so the app and the import can never disagree about which
 * column is the ledger name — that mattered: a Tally "List of Ledgers" export carries both
 * a "Name of Ledger" column and an "Under" (group) column, and the group column often has
 * one MORE non-empty cell. A raw-count heuristic therefore picked the groups, and Urban
 * Plant's 862-row export loaded as 96 "ledgers".
 *
 * Dry run by default. Reports added / removed and, critically, whether any ledger the
 * brand's side rules depend on would disappear.
 *
 * Usage:
 *   node scripts/import_coa.js --brand "Urban Plant" --file ~/Downloads/coa.xlsx
 *   node scripts/import_coa.js --brand "Urban Plant" --file ~/Downloads/coa.xlsx --apply
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const path = require('path');
const { execFileSync } = require('child_process');
const { Brand } = require('../src/models/master');
const { getBrandConnection } = require('../src/config/database');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const brandName = arg('--brand');
const file = arg('--file');

if (!brandName || !file) {
  console.error('usage: node scripts/import_coa.js --brand "<name>" --file <coa.xlsx> [--apply]');
  process.exit(1);
}

// Reuse classify.py's loader — single source of truth for COA parsing.
const readLedgers = (xlsx) => {
  const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(__dirname))})
from classify import load_ledger_master
print(json.dumps(load_ledger_master(${JSON.stringify(xlsx)})))
`;
  return JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8', maxBuffer: 32e6 }));
};

(async () => {
  const brand = await Brand.findOne({ where: { name: brandName } });
  if (!brand) { console.error(`brand not found: ${brandName}`); process.exit(1); }
  const seq = getBrandConnection(brand.db_name);

  const incoming = readLedgers(file);
  const [rows] = await seq.query(
    `SELECT ledger_name FROM ledger_master WHERE brand_id = $1`, { bind: [brand.id] });
  const current = new Set(rows.map((r) => r.ledger_name));
  const next = new Set(incoming);

  const added = [...next].filter((l) => !current.has(l));
  const removed = [...current].filter((l) => !next.has(l));
  console.log(`${brandName}: ${current.size} in DB -> ${next.size} in file  (+${added.length} / -${removed.length})`);

  // Guard rail: a COA import that silently drops a ledger a side rule points at would make
  // that rule stop firing with no error anywhere.
  const [sideRules] = await seq.query(
    `SELECT tokens, credit_ledger, debit_ledger FROM bank_side_rules
      WHERE brand_id = $1 AND status = 'active'`, { bind: [brand.id] }).catch(() => [[]]);
  const ci = new Map([...next].map((l) => [l.toLowerCase().replace(/\s+/g, ' ').trim(), l]));
  const broken = [];
  for (const r of sideRules || []) {
    for (const led of [r.credit_ledger, r.debit_ledger]) {
      if (!ci.has(String(led).toLowerCase().replace(/\s+/g, ' ').trim())) {
        broken.push(`${r.tokens} -> ${led}`);
      }
    }
  }
  if (broken.length) {
    console.log(`\n!! ${broken.length} side-rule ledger(s) are NOT in the new COA:`);
    broken.forEach((b) => console.log('   ' + b));
  } else if (sideRules && sideRules.length) {
    console.log(`side rules: all ${sideRules.length * 2} ledgers present in the new COA`);
  }

  // Removals matter beyond the COA itself: any learned directory entry pointing at a
  // ledger that no longer exists stops firing (it fails COA validation silently), so the
  // accountant would have to re-teach that vendor. Report it before it happens.
  const [dirRows] = await seq.query(
    `SELECT key_type, key_value, ledger FROM bank_payee_directory WHERE brand_id = $1`,
    { bind: [brand.id] });
  const orphaned = dirRows.filter(
    (r) => !ci.has(String(r.ledger).toLowerCase().replace(/\s+/g, ' ').trim()));
  if (orphaned.length) {
    const byLedger = new Map();
    for (const o of orphaned) byLedger.set(o.ledger, (byLedger.get(o.ledger) || 0) + 1);
    console.log(`\n${orphaned.length} learned directory entr(ies) point at a ledger not in ` +
      `the new COA and will stop firing:`);
    [...byLedger.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .forEach(([l, n]) => console.log(`   ${String(n).padStart(4)}x  ${l}`));
  }

  if (!APPLY) {
    console.log('\nsample added:  ' + added.slice(0, 6).join(' | '));
    console.log('sample removed:' + removed.slice(0, 6).join(' | '));
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
    process.exit(0);
  }
  if (broken.length) {
    console.error('\nrefusing to apply while side rules would break — fix the COA or the rules first.');
    process.exit(1);
  }

  const t = await seq.transaction();
  try {
    await seq.query(`DELETE FROM ledger_master WHERE brand_id = $1`,
      { bind: [brand.id], transaction: t });
    for (const l of next) {
      await seq.query(
        `INSERT INTO ledger_master (brand_id, ledger_name, ledger_name_key, source, created_at, updated_at)
         VALUES ($1, $2, $3, 'coa_upload', NOW(), NOW())
         ON CONFLICT DO NOTHING`,
        { bind: [brand.id, l, l.toLowerCase().replace(/\s+/g, ' ').trim()], transaction: t });
    }
    await t.commit();
    console.log(`\nAPPLIED: ledger_master for ${brandName} replaced with ${next.size} ledgers.`);
  } catch (e) { await t.rollback(); throw e; }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
