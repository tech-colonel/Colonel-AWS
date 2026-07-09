#!/usr/bin/env bash
# Phase 2 backfill: copy data from the 17 existing DBs into colonel_agent_accountant.
# Existing DBs are READ-ONLY here (pg_dump only). Sequential = no race on shared tables.
set -euo pipefail
export PGPASSWORD="${PGPASSWORD:-postgres}"
NEW=colonel_agent_accountant
H=(-U postgres -h localhost)
FIXED=(reco_jobs bank_reco_results bank_reco_corrections bank_payee_directory gstr_2b_results gstr_2a_2b_results gstr_3b_results gstr_1_results gstr_3b_tally_results ledger_master gstr3b_runs gstr3b_coa_master gstr3b_vt_master)
DYNAMIC=(invoice_process invoice_agent flipkart amazon nykaa myntra meesho sales_amazon ajio sales_cread total_sales_analyzer shopify_order_cycle settlement_amazon sales_shopify sales_mirrow sales_zepto sales_myntra sales_jiomart sales_flipkart sales_blinkit gstr_2b_books)

pipe_load() {  # $1=sourcedb $2=table  — load with RLS bypass
  ( echo "SET app.bypass_rls='true';"; pg_dump "${H[@]}" --data-only --disable-triggers --no-owner -t "$2" -d "$1" ) \
    | psql "${H[@]}" -v ON_ERROR_STOP=1 -d "$NEW" -q
}
has_table() { [ "$(psql "${H[@]}" -d "$1" -tAc "SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='$2'")" = "1" ]; }

echo "== MASTER (all org tables, FKs deferred) =="
( echo "SET app.bypass_rls='true';"; pg_dump "${H[@]}" --data-only --disable-triggers --no-owner -d "colonel-master" ) \
  | psql "${H[@]}" -v ON_ERROR_STOP=1 -d "$NEW" -q
echo "   master loaded"

psql "${H[@]}" -d colonel-master -tAc "SELECT db_name || '|' || id FROM brands ORDER BY db_name" | while IFS='|' read -r db bid; do
  [ -z "$db" ] && continue
  [ "$(psql "${H[@]}" -tAc "SELECT 1 FROM pg_database WHERE datname='$db'")" = "1" ] || { echo "skip $db (no db)"; continue; }
  echo "== $db  ($bid) =="
  for t in "${FIXED[@]}"; do has_table "$db" "$t" && pipe_load "$db" "$t"; done
  for t in "${DYNAMIC[@]}"; do
    has_table "$db" "$t" || continue
    rows=$(psql "${H[@]}" -d "$db" -tAc "SELECT count(*) FROM \"$t\"")
    [ "$rows" = "0" ] && continue
    psql "${H[@]}" -v ON_ERROR_STOP=1 -d "$NEW" -q -c "ALTER TABLE $t ALTER COLUMN brand_id SET DEFAULT '$bid';"
    pipe_load "$db" "$t"
    psql "${H[@]}" -v ON_ERROR_STOP=1 -d "$NEW" -q -c "ALTER TABLE $t ALTER COLUMN brand_id DROP DEFAULT;"
    echo "   dynamic $t: +$rows (brand_id=$bid)"
  done
done
echo "BACKFILL DONE"
