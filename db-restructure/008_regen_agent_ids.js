// 008_regen_agent_ids.js  —  Phase 1 of the ID-hardening initiative.
//
// Replaces the GUESSABLE / enumerable sequential agent IDs
// (c0000000-…-000N, d0000000-…-000N, f0000000-…-0001) with random UUIDv4s —
// the SAME non-guessable format the Sales-* agents already use. Column type stays
// `uuid`; no schema/RLS change. (Brand IDs are Phase 2 — not touched here.)
//
// Cascade: agents.id → { agent_workflows.agent_id (ON UPDATE CASCADE, auto),
//                        brand_agents.agent_id (NO ACTION → drop/recreate FK) }.
// reco_jobs is keyed by agent_type STRING, not agent id → unaffected.
// Frontend detection is by agent NAME (not id) → unaffected; only
// AgentDispatch.RECO_ID_TO_TYPE (d-series) needs the new ids (done by the
// companion 008_apply_agent_ids_to_code.js using the mapping this writes).
//
// Idempotent-ish: only remaps ids still matching the sequential pattern, so a
// re-run after success is a no-op. Writes the old→new mapping to
// 008-agent-id-remap.json (single source of truth for the code edits).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const NB = path.join(__dirname, '..', 'new-backend');
require(path.join(NB, 'node_modules', 'dotenv')).config({ path: path.join(NB, '.env') });
const { masterSequelize, UNIFIED } = require(path.join(NB, 'src', 'config', 'database'));
const { QueryTypes } = require(path.join(NB, 'node_modules', 'sequelize'));

const SEQ_RE = "^[cdf]0000000-0000-0000-";
const MAP_FILE = path.join(__dirname, '008-agent-id-remap.json');

(async () => {
  if (!UNIFIED) { console.error('Refusing: USE_UNIFIED_DB not true.'); process.exit(1); }
  const s = masterSequelize;

  const seqAgents = await s.query(
    `SELECT id, name FROM agents WHERE id::text ~ :re ORDER BY id`,
    { replacements: { re: SEQ_RE }, type: QueryTypes.SELECT });
  if (!seqAgents.length) { console.log('No sequential agent ids remain — nothing to do.'); process.exit(0); }

  // Build old→new mapping (random UUIDv4).
  const map = seqAgents.map((a) => ({ old: a.id, name: a.name, neu: crypto.randomUUID() }));
  fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));
  console.log(`Remapping ${map.length} agent ids. Mapping → ${path.basename(MAP_FILE)}\n`);

  const before = await s.query(
    `SELECT (SELECT count(*) FROM agents)::int a, (SELECT count(*) FROM brand_agents)::int ba`,
    { type: QueryTypes.SELECT });

  const fkDef = (await s.query(
    `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='brand_agents_agent_id_fkey'`,
    { type: QueryTypes.SELECT }))[0]?.d;

  await s.transaction(async (t) => {
    const q = (sql, r) => s.query(sql, { transaction: t, replacements: r });
    // brand_agents FK is NO ACTION → drop, remap both tables, recreate.
    await q(`ALTER TABLE brand_agents DROP CONSTRAINT IF EXISTS brand_agents_agent_id_fkey`);
    for (const m of map) {
      await q(`UPDATE agents SET id = :neu WHERE id = :old`, m);            // agent_workflows cascades
      await q(`UPDATE brand_agents SET agent_id = :neu WHERE agent_id = :old`, m);
    }
    if (fkDef) await q(`ALTER TABLE brand_agents ADD CONSTRAINT brand_agents_agent_id_fkey ${fkDef}`);
  });

  // ---- verify ----
  const after = await s.query(
    `SELECT (SELECT count(*) FROM agents)::int a, (SELECT count(*) FROM brand_agents)::int ba`,
    { type: QueryTypes.SELECT });
  const stillSeq = (await s.query(`SELECT count(*)::int n FROM agents WHERE id::text ~ :re`,
    { replacements: { re: SEQ_RE }, type: QueryTypes.SELECT }))[0].n;
  const orphans = (await s.query(
    `SELECT count(*)::int n FROM brand_agents ba LEFT JOIN agents a ON a.id=ba.agent_id WHERE a.id IS NULL`,
    { type: QueryTypes.SELECT }))[0].n;

  console.log('Verification:');
  console.log(`  agents: ${before[0].a} → ${after[0].a}   brand_agents: ${before[0].ba} → ${after[0].ba}`);
  console.log(`  sequential ids remaining: ${stillSeq}   orphaned brand_agents: ${orphans}`);
  const ok = after[0].a === before[0].a && after[0].ba === before[0].ba && stillSeq === 0 && orphans === 0;
  console.log(ok ? '\n✅ Migration OK.' : '\n❌ Mismatch — investigate (transaction already committed).');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
