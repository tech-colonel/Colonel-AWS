#!/usr/bin/env bash
# db-seed/restore.sh — restore the full Colonel-AWS superset databases from the
# committed pg_dump snapshots in ./dumps/.
#
# Recreates colonel-master + every per-brand DB (colonel-<brand>) with the real
# superset data (16 brands, reco history, ledgers, users, agents, assignments).
#
# Usage:
#   cd db-seed && ./restore.sh
#
# Connection (override via env, sensible local defaults):
#   PGHOST (127.0.0.1)  PGPORT (5432)  PGUSER (postgres)  PGPASSWORD (postgres)
#
# WARNING: this DROPs and recreates each colonel* database it finds a dump for.
# It only touches databases present in ./dumps/. Back up first if you have local data.
set -euo pipefail

export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"

DIR="$(cd "$(dirname "$0")/dumps" && pwd)"
echo "Restoring superset DBs from: $DIR"
echo "Target: $PGUSER@$PGHOST:$PGPORT"
echo

shopt -s nullglob
dumps=("$DIR"/*.dump)
if [ ${#dumps[@]} -eq 0 ]; then echo "No .dump files found in $DIR"; exit 1; fi

for dump in "${dumps[@]}"; do
  db="$(basename "$dump" .dump)"
  echo "==> $db"
  # terminate any live connections so DROP can proceed
  psql -d postgres -tAc \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$db' AND pid<>pg_backend_pid()" \
    >/dev/null 2>&1 || true
  dropdb --if-exists "$db"
  createdb "$db"
  pg_restore --no-owner --no-privileges -d "$db" "$dump" 2>&1 | grep -vi "already exists" || true
  echo "    restored $db"
done

echo
echo "Done. All superset databases restored."
echo "Start the backend (new-backend: node server.js) — boot migrations will (re)ensure"
echo "the per-brand reco tables + master zoho/compliance/statutory tables idempotently."
