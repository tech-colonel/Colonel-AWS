# DB Restructure — Phase 1 (Schema)  ✅

Target: physical DB **colonel_agent_accountant** (display: Colonel-Agent.Accountant).
Strategy: build NEW DB beside the 17 existing DBs (untouched); backfill+verify; cut over later.

## What Phase 1 did
- Multi-agent workflow extracted real columns of 21 dynamic agent tables across all 16 brand DBs → `002_dynamic_agent_tables.sql` (each table gets id UUID PK + brand_id + index + RLS). Adversarial verifier: PASS.
- Captured live master schema (`schema_01_master.sql`, from colonel-master) and reco/gstr3b schema (`schema_02_reco_gstr3b.sql`, from colonel-stroom).
- `003_gstr3b_rls.sql` adds RLS to gstr3b_* (had brand_id, lacked RLS).
- `build.sh` creates the DB and applies all four layers.

## Verified
- 61 tables = exact union of every table across all existing DBs (0 missing, 0 extra).
- RLS on 34 tables (21 dynamic + 10 reco + 3 gstr3b); none mis-configured.
- New DB empty (0 rows). Existing 17 DBs untouched (stroom reco_jobs=26, colonel_other sales_amazon=96).

## Data to backfill (Phase 2) — only 3 tables have rows
- sales_amazon: 96 (colonel_other) · invoice_agent: 27 · invoice_process: 25 · plus master org data + reco_jobs per brand.

## Not-yet (later phases)
- Optional RLS on statutory_filings + compliance_* (defense-in-depth; currently faithful to source = no RLS).
- Backend code changes + cutover = Phases 4-5.
