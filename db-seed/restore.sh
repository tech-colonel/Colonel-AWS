#!/usr/bin/env bash
# db-seed/restore.sh — restore the SINGLE unified Colonel database.
#
# The app is unified by default now: all brands share ONE database
# (colonel_agent_accountant) with Postgres RLS isolation, instead of one DB per
# brand. Just restore this one dump and go.
#
# Usage:   cd db-seed && ./restore.sh
# Connection (override via env; sensible local defaults):
#   PGHOST (127.0.0.1)  PGPORT (5432)  PGSUPER (postgres)  PGPASSWORD (postgres)
#
# WARNING: DROPs and recreates the unified database. Back up first if you have local data.
set -euo pipefail

export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-5432}"
export PGSUPER="${PGSUPER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"

HERE="$(cd "$(dirname "$0")" && pwd)"
DB="${UNIFIED_DB_NAME:-colonel_agent_accountant}"
APP_USER="${DB_APP_USER:-colonel_app}"
APP_PASS="${DB_APP_PASSWORD:-colonel_app_local}"
DUMP="$HERE/dumps/colonel_agent_accountant.dump"

[ -f "$DUMP" ] || { echo "ERROR: dump not found at $DUMP"; exit 1; }
echo "Restoring unified DB '$DB' from $DUMP"
echo "Target: $PGSUPER@$PGHOST:$PGPORT"
echo

echo "==> Ensuring non-superuser app role '$APP_USER' (RLS bites only for non-superusers)"
psql -U "$PGSUPER" -d postgres -tc "SELECT 1 FROM pg_roles WHERE rolname='$APP_USER'" | grep -q 1 \
  || psql -U "$PGSUPER" -d postgres -c "CREATE ROLE \"$APP_USER\" LOGIN PASSWORD '$APP_PASS';"

echo "==> (Re)creating database $DB"
psql -U "$PGSUPER" -d postgres -tAc \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB' AND pid<>pg_backend_pid()" >/dev/null 2>&1 || true
dropdb -U "$PGSUPER" --if-exists "$DB"
createdb -U "$PGSUPER" "$DB"

echo "==> Restoring (schema + data + RLS policies + brand_id defaults)"
pg_restore -U "$PGSUPER" --no-owner -d "$DB" "$DUMP" 2>&1 | grep -vi "already exists" || true

echo "==> Ensuring $APP_USER privileges (RLS policies in the dump scope it per-brand)"
psql -U "$PGSUPER" -d "$DB" -c "GRANT USAGE ON SCHEMA public TO \"$APP_USER\";"
psql -U "$PGSUPER" -d "$DB" -c "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \"$APP_USER\";"
psql -U "$PGSUPER" -d "$DB" -c "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO \"$APP_USER\";"

echo
echo "✅ Done. Unified DB '$DB' restored."
echo "   Next: cp new-backend/.env.example new-backend/.env  (unified mode is the default),"
echo "         fill in the API keys, then start the backend (node server.js)."
