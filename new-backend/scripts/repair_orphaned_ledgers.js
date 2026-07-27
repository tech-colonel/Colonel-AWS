#!/usr/bin/env node
/**
 * Repair learned directory entries whose ledger no longer exists in the brand's CoA.
 *
 * WHY: when a CoA is re-imported, ledgers get RENAMED as often as removed
 * ("Rajesh Singh" -> "Rajesh Singh-Salary"). Every bank_payee_directory row pointing at
 * the old name silently stops firing — _coa_resolve finds nothing and the row falls
 * through — so the accountant has to teach that vendor all over again. Deleting those
 * rows loses the knowledge; remapping keeps it.
 *
 * Strategy, most-confident first:
 *   1. exact (case/space-insensitive) match            -> auto
 *   2. exactly ONE CoA ledger starts with the old name -> auto ("Taruna" -> "Taruna-Salary")
 *   3. exactly ONE CoA ledger contains all its words   -> auto
 *   4. anything else (0 or 2+ candidates)              -> REPORTED, never guessed
 *
 * Dry run by default; --apply writes. Ambiguous cases are always listed for a human.
 *
 * Usage:
 *   node scripts/repair_orphaned_ledgers.js
 *   node scripts/repair_orphaned_ledgers.js --apply
 *   node scripts/repair_orphaned_ledgers.js --brand "Urban Plant" --apply
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Brand } = require('../src/models/master');
const { getBrandConnection } = require('../src/config/database');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const brandArgs = argv.reduce((a, x, i) => (x === '--brand' ? [...a, argv[i + 1]] : a), []);
const BRANDS = brandArgs.length ? brandArgs : ['Urban Plant', 'M Brands'];

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const words = (s) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2);

(async () => {
  let totalFixed = 0; let totalAmbiguous = 0;

  for (const name of BRANDS) {
    const brand = await Brand.findOne({ where: { name } });
    if (!brand) { console.log(`!! brand not found: ${name}`); continue; }
    const seq = getBrandConnection(brand.db_name);

    const [coaRows] = await seq.query(
      `SELECT ledger_name FROM ledger_master WHERE brand_id = $1`, { bind: [brand.id] });
    const coa = coaRows.map((r) => r.ledger_name);
    const coaByNorm = new Map(coa.map((l) => [norm(l), l]));

    const [orphans] = await seq.query(
      `SELECT key_type, key_value, ledger FROM bank_payee_directory d
        WHERE brand_id = $1
          AND NOT EXISTS (SELECT 1 FROM ledger_master lm
                           WHERE lm.brand_id = d.brand_id
                             AND lower(btrim(lm.ledger_name)) = lower(btrim(d.ledger)))`,
      { bind: [brand.id] });

    console.log(`\n${'='.repeat(72)}\n${name} — ${orphans.length} orphaned entr(ies)\n${'='.repeat(72)}`);
    if (!orphans.length) continue;

    // Resolve each DISTINCT old ledger once.
    const distinct = [...new Set(orphans.map((o) => o.ledger))];
    const plan = new Map();
    const ambiguous = [];

    for (const old of distinct) {
      const exact = coaByNorm.get(norm(old));
      if (exact) { plan.set(old, exact); continue; }

      const prefix = coa.filter((l) => norm(l).startsWith(norm(old)));
      if (prefix.length === 1) { plan.set(old, prefix[0]); continue; }

      const ws = words(old);
      const contains = ws.length
        ? coa.filter((l) => ws.every((w) => norm(l).includes(w)))
        : [];
      if (contains.length === 1) { plan.set(old, contains[0]); continue; }

      ambiguous.push({ old, candidates: (prefix.length ? prefix : contains).slice(0, 6) });
    }

    for (const [old, next] of plan) {
      const n = orphans.filter((o) => o.ledger === old).length;
      console.log(`  REMAP  ${String(n).padStart(2)}x  "${old}"  ->  "${next}"`);
    }
    for (const a of ambiguous) {
      const n = orphans.filter((o) => o.ledger === a.old).length;
      console.log(`  MANUAL ${String(n).padStart(2)}x  "${a.old}"  -> ${a.candidates.length} candidates:`);
      a.candidates.forEach((c) => console.log(`             ${c}`));
    }
    totalAmbiguous += ambiguous.length;

    if (!APPLY) continue;

    const t = await seq.transaction();
    try {
      let fixed = 0;
      for (const [old, next] of plan) {
        const [, meta] = await seq.query(
          `UPDATE bank_payee_directory SET ledger = $1, updated_at = NOW()
            WHERE brand_id = $2 AND ledger = $3`,
          { bind: [next, brand.id, old], transaction: t });
        fixed += (meta && (meta.rowCount ?? 0)) || 0;
      }
      // bank_reco_corrections can hold the same stale ledger.
      for (const [old, next] of plan) {
        await seq.query(
          `UPDATE bank_reco_corrections SET correct_ledger = $1, updated_at = NOW()
            WHERE brand_id = $2 AND correct_ledger = $3`,
          { bind: [next, brand.id, old], transaction: t }).catch(() => {});
      }
      await t.commit();
      totalFixed += fixed;
      console.log(`  APPLIED: ${fixed} directory row(s) remapped.`);
    } catch (e) { await t.rollback(); throw e; }
  }

  console.log(`\n${APPLY ? `Done — ${totalFixed} row(s) remapped.` : 'DRY RUN — nothing written.'}` +
    (totalAmbiguous ? `  ${totalAmbiguous} ledger(s) need a human decision (listed above).` : ''));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
