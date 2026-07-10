// 009_regen_brand_ids.js  —  Phase 2 of the ID-hardening initiative.
//
// Replaces the GUESSABLE / enumerable sequential BRAND ids (b0000000-…-000N) with
// random UUIDv4s. Column type stays `uuid`; RLS policies compare brand_id to the
// session var app.brand_id (set per-connection from brands.db_name, which does NOT
// change) — so policies need no rewrite, they just start matching the new ids once
// every row's brand_id moves in lockstep with brands.id.
//
// Cascade — brand_id lives in 43 tables plus the 2 FK children:
//   brands.id  →  { brand_users.brand_id (FK, NO ACTION),
//                   brand_agents.brand_id (FK, NO ACTION),
//                   + every other table carrying a brand_id column }
// Both FKs are dropped, all values remapped, FKs recreated — one atomic transaction
// on the superuser connection (bypasses RLS natively, incl. FORCE).
//
// IMPORTANT: restart the backend after this — pooled connections opened before the
// remap still carry the OLD app.brand_id and would see 0 rows until reconnect.
//
// Idempotent-ish: only remaps ids still matching the sequential pattern.
// Writes old→new mapping to 009-brand-id-remap.json (source of truth for code edits).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const NB = path.join(__dirname, '..', 'new-backend');
require(path.join(NB, 'node_modules', 'dotenv')).config({ path: path.join(NB, '.env') });
const { masterSequelize, UNIFIED } = require(path.join(NB, 'src', 'config', 'database'));
const { QueryTypes } = require(path.join(NB, 'node_modules', 'sequelize'));

const SEQ_RE = "^b0000000-0000-0000-0000-";
const MAP_FILE = path.join(__dirname, '009-brand-id-remap.json');
const FKS = ['brand_agents_brand_id_fkey', 'brand_users_brand_id_fkey'];

(async () => {
  if (!UNIFIED) { console.error('Refusing: USE_UNIFIED_DB not true.'); process.exit(1); }
  const s = masterSequelize;

  const seq = await s.query(`SELECT id, name FROM brands WHERE id::text ~ :re ORDER BY id`,
    { replacements: { re: SEQ_RE }, type: QueryTypes.SELECT });
  if (!seq.length) { console.log('No sequential brand ids remain — nothing to do.'); process.exit(0); }

  const map = seq.map((b) => ({ old: b.id, name: b.name, neu: crypto.randomUUID() }));
  fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));
  console.log(`Remapping ${map.length} brand ids. Mapping → ${path.basename(MAP_FILE)}`);
  map.forEach((m) => console.log(`  ${m.old}  →  ${m.neu}  (${m.name})`));
  console.log('');

  // Every table carrying a brand_id column (sweep info_schema — not a hardcoded list).
  const bidTables = (await s.query(
    `SELECT table_name FROM information_schema.columns
      WHERE column_name='brand_id' AND table_schema='public' ORDER BY table_name`,
    { type: QueryTypes.SELECT })).map((r) => r.table_name);

  // Capture FK defs to recreate faithfully.
  const fkDefs = {};
  for (const fk of FKS) {
    fkDefs[fk] = (await s.query(
      `SELECT conrelid::regclass::text tbl, pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname=:n`,
      { replacements: { n: fk }, type: QueryTypes.SELECT }))[0];
  }

  const before = await s.query(
    `SELECT (SELECT count(*) FROM brands)::int b, (SELECT count(*) FROM brand_users)::int bu,
            (SELECT count(*) FROM brand_agents)::int ba`, { type: QueryTypes.SELECT });

  let rowsUpdated = 0;
  await s.transaction(async (t) => {
    const q = (sql, r) => s.query(sql, { transaction: t, replacements: r });
    for (const fk of FKS) if (fkDefs[fk]) await q(`ALTER TABLE ${fkDefs[fk].tbl} DROP CONSTRAINT IF EXISTS "${fk}"`);

    for (const m of map) await q(`UPDATE brands SET id = :neu WHERE id = :old`, m);

    for (const tbl of bidTables) {
      for (const m of map) {
        const [, meta] = await q(`UPDATE "${tbl}" SET brand_id = :neu WHERE brand_id = :old`, m);
        rowsUpdated += (meta && meta.rowCount) ? meta.rowCount : 0;
      }
    }

    for (const fk of FKS) if (fkDefs[fk]) await q(`ALTER TABLE ${fkDefs[fk].tbl} ADD CONSTRAINT "${fk}" ${fkDefs[fk].d}`);
  });

  // ---- verify ----
  const after = await s.query(
    `SELECT (SELECT count(*) FROM brands)::int b, (SELECT count(*) FROM brand_users)::int bu,
            (SELECT count(*) FROM brand_agents)::int ba`, { type: QueryTypes.SELECT });
  const stillSeqBrands = (await s.query(`SELECT count(*)::int n FROM brands WHERE id::text ~ :re`,
    { replacements: { re: SEQ_RE }, type: QueryTypes.SELECT }))[0].n;
  // scan EVERY brand_id table for leftover sequential ids
  let stillSeqRows = 0;
  for (const tbl of bidTables) {
    stillSeqRows += (await s.query(`SELECT count(*)::int n FROM "${tbl}" WHERE brand_id::text ~ :re`,
      { replacements: { re: SEQ_RE }, type: QueryTypes.SELECT }))[0].n;
  }
  const orphanBU = (await s.query(
    `SELECT count(*)::int n FROM brand_users bu LEFT JOIN brands b ON b.id=bu.brand_id WHERE b.id IS NULL`,
    { type: QueryTypes.SELECT }))[0].n;
  const orphanBA = (await s.query(
    `SELECT count(*)::int n FROM brand_agents ba LEFT JOIN brands b ON b.id=ba.brand_id WHERE b.id IS NULL`,
    { type: QueryTypes.SELECT }))[0].n;

  console.log('Verification:');
  console.log(`  brands: ${before[0].b}→${after[0].b}  brand_users: ${before[0].bu}→${after[0].bu}  brand_agents: ${before[0].ba}→${after[0].ba}`);
  console.log(`  data rows remapped (across ${bidTables.length} brand_id tables): ${rowsUpdated}`);
  console.log(`  sequential remaining — brands: ${stillSeqBrands}  data rows: ${stillSeqRows}`);
  console.log(`  orphans — brand_users: ${orphanBU}  brand_agents: ${orphanBA}`);
  const ok = after[0].b === before[0].b && after[0].bu === before[0].bu && after[0].ba === before[0].ba
    && stillSeqBrands === 0 && stillSeqRows === 0 && orphanBU === 0 && orphanBA === 0;
  console.log(ok ? '\n✅ Migration OK. RESTART THE BACKEND now (stale pooled connections carry old app.brand_id).'
                 : '\n❌ Mismatch — investigate.');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
