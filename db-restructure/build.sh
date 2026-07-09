#!/usr/bin/env bash
# Rebuild colonel_agent_accountant from the captured schema layers. Existing DBs untouched.
set -euo pipefail
export PGPASSWORD="${PGPASSWORD:-postgres}"
NEWDB=colonel_agent_accountant
DIR="$(cd "$(dirname "$0")" && pwd)"
psql -U postgres -h localhost -tAc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$NEWDB' AND pid<>pg_backend_pid()" >/dev/null 2>&1 || true
dropdb -U postgres -h localhost --if-exists "$NEWDB"
createdb -U postgres -h localhost "$NEWDB"
for f in schema_01_master.sql schema_02_reco_gstr3b.sql 002_dynamic_agent_tables.sql 003_gstr3b_rls.sql; do
  echo "applying $f"; psql -U postgres -h localhost -v ON_ERROR_STOP=1 -d "$NEWDB" -f "$DIR/$f" >/dev/null
done
echo "Built $NEWDB: $(psql -U postgres -h localhost -d "$NEWDB" -tAc "SELECT count(*) FROM pg_tables WHERE schemaname='public'") tables"
