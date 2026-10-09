#!/usr/bin/env bash
# Export the data the two seeders in this folder load, from YOUR local unified DB
# into seed-share/data/. Run it on the machine that has the data, then share the
# whole seed-share/ folder.
#
#   cd new-backend && bash seed-share/export-data.sh
#
# Writes one gzipped NDJSON file per table (one row_to_json() row per line,
# sorted by brand) plus the Flo Mattress order-cycle workbook. Read-only against
# the database.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
DATA="$HERE/data"
mkdir -p "$DATA"

env_val() { grep -E "^$1=" "$ROOT/.env" | head -1 | cut -d= -f2- || true; }
export PGHOST="$(env_val DB_HOST)"; PGHOST="${PGHOST:-localhost}"
export PGPORT="$(env_val DB_PORT)"; PGPORT="${PGPORT:-5432}"
export PGUSER="$(env_val DB_USER)"
export PGPASSWORD="$(env_val DB_PASSWORD)"
export PGDATABASE="$(env_val UNIFIED_DB_NAME)"; PGDATABASE="${PGDATABASE:-colonel_agent_accountant}"

BRANDS="'Flo Mattress','Amama'"

dump() { # table, order-by
  echo "exporting $1 ..."
  psql -X -q -At -c "SELECT row_to_json(t) FROM (
      SELECT x.* FROM $1 x JOIN brands b ON b.id = x.brand_id
      WHERE b.name IN ($BRANDS) ORDER BY $2) t" | gzip -9 > "$DATA/$1.ndjson.gz"
  echo "  $(gzip -dc "$DATA/$1.ndjson.gz" | wc -l | tr -d ' ') rows"
}

dump shopify_order_cycle         "x.brand_id, x.date, x.id"
dump receivable_ledger           "x.brand_id, x.order_date, x.id"
dump receivable_ledger_unmatched "x.brand_id, x.source, x.id"
dump receivable_cycle_imports    "x.brand_id, x.source_file, x.sheet_name, x.row_index, x.id"

WORKBOOK="order_cycle_shopify_Flo Mattress_October_2026_49db009b-fef3-467f-ad68-0adf0b3c18bf.xlsx"
if [ -f "$ROOT/outputs/$WORKBOOK" ]; then
  cp "$ROOT/outputs/$WORKBOOK" "$DATA/"
  echo "copied workbook"
else
  echo "WARN: outputs/$WORKBOOK not found — the Download button will 404 on the other machine"
fi

ls -lh "$DATA"
