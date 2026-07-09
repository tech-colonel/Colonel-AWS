# DB Restructure — Phase 2 (Backfill + Verify)  ✅

## What Phase 2 did
- `backfill.sh` — sequential, deterministic load into colonel_agent_accountant (existing DBs read-only via pg_dump).
  - Master org data copied from colonel-master (FKs deferred).
  - Per brand: reco/gstr3b tables copied (brand_id already present); dynamic sales tables loaded with brand_id stamped via a per-brand column DEFAULT (safe because sequential).
- `reconcile.sh` — row-count reconciliation, source vs new, per table.

## Verified against REAL data
- **19,853 rows = 19,853 rows, 0 mismatches** across all 34 data tables + master.
- brand_id mapping validated: every brand DB's reco_jobs.brand_id matched master.brands.id.
- RLS isolation PROVEN under a non-superuser role: Stroom sees its 27 reco_jobs & 0 sales_amazon; Other sees its 96 sales_amazon; no brand context => 0 rows.

## Two findings (important)
1. **LIVE-SOURCE DRIFT:** the local backend (pm2/node on :8001) is running and wrote a new reco_job to colonel-stroom *after* the copy (26 -> 27). Caught by reconciliation; delta-loaded. **Phase 5 cutover MUST do a final delta-sync (or brief write-freeze) right before flipping.**
2. **RLS needs a NON-SUPERUSER role:** the app connects as `postgres` (superuser), which bypasses RLS entirely — so today isolation is physical-DB + WHERE brand_id, not RLS. In the single DB, RLS only enforces if the backend connects as a non-superuser role with app.brand_id set per request. **Phase 4 must add a `colonel_app` non-superuser role.** (Policies themselves verified correct.)

## State
- New DB fully populated + verified. Existing 17 DBs untouched. App still runs on old DBs.
