#!/usr/bin/env bash
#
# nightly-data-purge.sh
#
# Nightly cleanup of the HEAVY, re-generatable reco row data so the box never
# fills up, even if a user forgot to click Reset. Runs AFTER the nightly DB
# backup (02:00 IST) so a day's data is always recoverable from the dump.
#
# CLEARS (heavy row-level output only — re-generatable by re-running a file):
#   - result tables: bank_reco_results, gstr_2b_results, gstr_2a_2b_results,
#     gstr_3b_results, gstr_1_results, gstr_3b_tally_results,
#     receivable_cycle_results
#   - MTR workbooks in new-backend/output/mtr/
#
# PRESERVES (important — never touched):
#   - reco_jobs  ← run METADATA: agent, user (created_by), month/year, row
#     counts, match rate, timestamp. One tiny row per run and the ONLY source
#     for the admin analytics dashboards (who ran what agent, when, how much).
#     Deleting it nightly left every dashboard permanently empty — so KEEP IT.
#   - ledger_master table + output/ledgers/ (Chart of Accounts)
#   - bank_reco_corrections (accountant-trained learning)
#   - sales tables (amazon, flipkart, meesho, myntra, nykaa), invoice_* tables
#   - brand_agents, and the whole colonel-master DB (users/brands/agents)
#
# Usage: nightly-data-purge.sh [--dry-run]
#   --dry-run  → only report what WOULD be cleared; deletes nothing.

set -uo pipefail
export PGPASSWORD=postgres

MODE="${1:-run}"
DRY=0; [ "$MODE" = "--dry-run" ] && DRY=1
TS=$(date +%Y-%m-%d_%H:%M:%S)
echo "[purge] ===== $TS START (dry_run=$DRY) ====="

# Result tables (children of reco_jobs). Cleared explicitly + via CASCADE.
RESULT_TABLES="bank_reco_results gstr_2b_results gstr_2a_2b_results gstr_3b_results gstr_1_results gstr_3b_tally_results receivable_cycle_results"

# Brand DBs only — never colonel-master / colonel_v2.
DBS=$(psql -h localhost -U postgres -d postgres -Atqc \
  "SELECT datname FROM pg_database WHERE datname LIKE 'colonel%' AND datname NOT IN ('colonel_v2','colonel-master','colonel_master');")

TOTAL=0
for db in $DBS; do
  jobs=$(psql -h localhost -U postgres -d "$db" -Atqc "SELECT count(*) FROM reco_jobs;" 2>/dev/null || echo 0)
  jobs=${jobs:-0}
  if [ "$DRY" = "1" ]; then
    echo "[purge]   $db — would clear heavy result rows for $jobs reco run(s) (reco_jobs metadata kept)"
  else
    for t in $RESULT_TABLES; do
      psql -h localhost -U postgres -d "$db" -qc "DELETE FROM \"$t\";" >/dev/null 2>&1
    done
    # NOTE: reco_jobs is intentionally NOT deleted — it is the analytics source.
    echo "[purge]   $db — cleared heavy result rows; kept $jobs reco_jobs row(s) for analytics"
  fi
  TOTAL=$((TOTAL + jobs))
done

# MTR workbooks on disk (CoA dir output/ledgers/ is deliberately untouched).
MTR_DIR=/opt/colonel/new-backend/output/mtr
if [ -d "$MTR_DIR" ]; then
  cnt=$(find "$MTR_DIR" -maxdepth 1 -name '*.xlsx' 2>/dev/null | wc -l | tr -d ' ')
  if [ "$DRY" = "1" ]; then
    echo "[purge]   would delete $cnt MTR file(s)"
  else
    find "$MTR_DIR" -maxdepth 1 -name '*.xlsx' -delete 2>/dev/null
    echo "[purge]   deleted $cnt MTR file(s)"
  fi
fi

echo "[purge] ===== DONE (reco runs across brands: $TOTAL) ====="
