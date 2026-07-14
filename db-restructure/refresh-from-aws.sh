#!/usr/bin/env bash
# refresh-from-aws.sh — build a copy of the unified DB with AWS PRODUCTION data,
# keeping OUR structure (org layer, 32 agents, random UUIDs, schema) intact.
#
# Strategy (non-destructive to the live DB until the final manual swap):
#   1. Clone live colonel_agent_accountant → colonel_agent_accountant_awsdata
#      (guarantees identical structure).
#   2. Restore AWS per-brand dumps → scratch DBs (awssrc__<db>).
#   3. TRUNCATE only the reco/sales DATA tables in the clone (FIXED+DYNAMIC) —
#      org/feature tables (brand_agents, brand_users, compliance_*, statutory_*,
#      zoho_*) are left as-is = our structure.
#   4. Per brand: load AWS data into the clone, stamping OUR brand_id
#      (map AWS db_name → our brands.db_name → our id).
#
# Live DB is untouched. Verify the clone, then swap manually.
set -uo pipefail
export PGPASSWORD="${PGPASSWORD:-postgres}"
H=(-U postgres -h localhost)
LIVE=colonel_agent_accountant
CLONE=colonel_agent_accountant_awsdata
AWSDIR="${AWSDIR:?set AWSDIR to the AWS dump dir}"
BK="${BK:?set BK to a backup dir}"

FIXED=(reco_jobs bank_reco_results bank_reco_corrections bank_payee_directory gstr_2b_results gstr_2a_2b_results gstr_3b_results gstr_1_results gstr_3b_tally_results ledger_master gstr3b_runs gstr3b_coa_master gstr3b_vt_master)
DYNAMIC=(invoice_process invoice_agent flipkart amazon nykaa myntra meesho sales_amazon ajio sales_cread total_sales_analyzer shopify_order_cycle settlement_amazon sales_shopify sales_mirrow sales_zepto sales_myntra sales_jiomart sales_flipkart sales_blinkit gstr_2b_books)

has_table() { [ "$(psql "${H[@]}" -d "$1" -tAc "SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='$2'")" = "1" ]; }
q() { psql "${H[@]}" -v ON_ERROR_STOP=1 -d "$CLONE" -q -c "$1"; }

echo "== 1. clone live → $CLONE (from fresh dump) =="
psql "${H[@]}" -tAc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$CLONE' AND pid<>pg_backend_pid()" >/dev/null 2>&1
dropdb "${H[@]}" --if-exists "$CLONE"; createdb "${H[@]}" "$CLONE"
pg_restore "${H[@]}" --no-owner -d "$CLONE" "$BK/colonel_agent_accountant.CURRENT.dump" >/dev/null 2>&1
echo "   clone tables: $(psql "${H[@]}" -d "$CLONE" -tAc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")  agents: $(psql "${H[@]}" -d "$CLONE" -tAc 'SELECT count(*) FROM agents')"

echo "== 2. restore AWS per-brand dumps → scratch DBs =="
for f in "$AWSDIR"/colonel*.dump; do
  base="$(basename "$f" .dump)"; [ "$base" = "colonel-master" ] && continue
  scr="awssrc__$base"
  dropdb "${H[@]}" --if-exists "$scr" 2>/dev/null; createdb "${H[@]}" "$scr"
  pg_restore "${H[@]}" --no-owner -d "$scr" "$f" >/dev/null 2>&1
done
echo "   restored $(psql "${H[@]}" -tAc "SELECT count(*) FROM pg_database WHERE datname LIKE 'awssrc__%'") scratch DBs"

echo "== 3. TRUNCATE only reco/sales DATA tables in clone (org/features kept) =="
for t in "${FIXED[@]}" "${DYNAMIC[@]}"; do has_table "$CLONE" "$t" && q "TRUNCATE TABLE \"$t\" CASCADE;" >/dev/null 2>&1; done

echo "== 4. load AWS data per brand, stamping OUR brand_id =="
# AWS master brands: db_name | aws_id
dropdb "${H[@]}" --if-exists aws_master 2>/dev/null; createdb "${H[@]}" aws_master
pg_restore "${H[@]}" --no-owner -d aws_master "$AWSDIR/colonel-master.dump" >/dev/null 2>&1
psql "${H[@]}" -d aws_master -tAc "SELECT db_name||'|'||id FROM brands WHERE db_name IS NOT NULL ORDER BY db_name" | while IFS='|' read -r db awsid; do
  [ -z "$db" ] && continue
  scr="awssrc__$db"
  [ "$(psql "${H[@]}" -tAc "SELECT 1 FROM pg_database WHERE datname='$scr'")" = "1" ] || { echo "   skip $db (no scratch)"; continue; }
  ourid=$(psql "${H[@]}" -d "$CLONE" -tAc "SELECT id FROM brands WHERE db_name='$db'")
  [ -z "$ourid" ] && { echo "   ⚠️ $db: no matching brand in clone — skip"; continue; }
  # FIXED: source rows carry brand_id=awsid → load then remap awsid→ourid
  for t in "${FIXED[@]}"; do
    has_table "$scr" "$t" || continue
    ( echo "SET session_replication_role=replica;"; pg_dump "${H[@]}" --data-only --no-owner -t "$t" -d "$scr" ) | psql "${H[@]}" -d "$CLONE" -q >/dev/null 2>&1
    q "UPDATE \"$t\" SET brand_id='$ourid' WHERE brand_id='$awsid';" >/dev/null 2>&1
  done
  # DYNAMIC: source has no brand_id → set default=ourid, load, drop default
  for t in "${DYNAMIC[@]}"; do
    has_table "$scr" "$t" || continue
    rows=$(psql "${H[@]}" -d "$scr" -tAc "SELECT count(*) FROM \"$t\"")
    [ "$rows" = "0" ] && continue
    q "ALTER TABLE \"$t\" ALTER COLUMN brand_id SET DEFAULT '$ourid';" >/dev/null 2>&1
    ( echo "SET session_replication_role=replica;"; pg_dump "${H[@]}" --data-only --no-owner -t "$t" -d "$scr" ) | psql "${H[@]}" -d "$CLONE" -q >/dev/null 2>&1
    q "ALTER TABLE \"$t\" ALTER COLUMN brand_id DROP DEFAULT;" >/dev/null 2>&1
  done
  echo "   loaded $db → ourid $ourid"
done
echo "== DONE building $CLONE (live DB untouched) =="
