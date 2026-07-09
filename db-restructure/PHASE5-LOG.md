# DB Restructure — Phase 5 (Cutover) — boot-test DONE, real cutover PENDING

## Boot-test (parallel instance, safe) — PASS
- Booted a 2nd backend on :8009 with USE_UNIFIED_DB=true (new DB). Live app on :8001 untouched.
- Boot clean: master connected@unified, models synced, per-brand migration skipped (gate works), zoho/compliance/statutory ready.
- Route smoke test (admin token): /api/agents 200 (33), /api/brands 200, dashboard tool-analytics 200 (sane totals, not 16x), reco/history Stroom 200 (isolated), zoho orgs 200, agents-per-brand 200 (31), statutory admin summary 200 (15), mtr config 200. Koparo statutory 403 = correct owner-gating. No DB errors anywhere.

## Data completeness re-confirmed
- COA (ledger_master), bank_reco_results, bank_reco_corrections, bank_payee_directory: per-brand source==new, exact. Grand total 19853==19853, 0 mismatch. Old DBs untouched.

## REAL cutover (pending user go-ahead)
1. Final DELTA-SYNC: live app kept writing to old DBs during the work, so re-run build.sh+backfill.sh (fast) or delta right before flip to make new DB current.
2. Set USE_UNIFIED_DB=true on the live backend (:8001) + restart. Reversible: unset flag + restart => back on old DBs instantly.
3. User tests every route/UI. If good, keep; else revert.
4. Old DBs NOT deleted — deletion decided only after confidence (user's call). Then port to AWS + GitHub.
