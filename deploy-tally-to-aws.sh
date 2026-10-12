#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-tally-to-aws.sh — ship ONLY the Tally feature to agent.accountant.
# Run from the repo root on a machine that has ~/.ssh/colonel2-key.pem (the Mac).
#
#   ./deploy-tally-to-aws.sh            # dry run: shows what differs, changes nothing
#   ./deploy-tally-to-aws.sh --apply    # backs up, copies named files, restarts, verifies
#
# Why a separate script: the Tally branch is a SLICE of the live app. It copies
# named files only (CLAUDE.md golden rule 1b), never whole directories, and
# refuses to build the frontend from a tree that lacks `main` (a frontend built
# from a stale branch + rsync --delete would revert live features).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HOST="ubuntu@13.127.171.66"
KEY="$HOME/.ssh/colonel2-key.pem"
APP="/opt/colonel"
TS="$(date +%Y%m%d-%H%M%S)"
APPLY=false; [ "${1:-}" = "--apply" ] && APPLY=true
SSH=(ssh -i "$KEY" -o ConnectTimeout=10)

BACKEND_FILES=(
  new-backend/server.js
  new-backend/src/app.js
  new-backend/src/db/tallyMigrate.js
  new-backend/src/controllers/tallyController.js
  new-backend/src/controllers/tallyReportsController.js
  new-backend/src/routes/tallyRoutes.js
  new-backend/src/services/tallyBrandMatch.js
  new-backend/src/config/tallyBrandAliases.json
  new-backend/seed-tally-connector.js
)

# ── 0. Preflight ─────────────────────────────────────────────────────────────
git merge-base --is-ancestor main HEAD || {
  echo "✋ HEAD does not contain main. Merge main into this branch first, so the build"
  echo "   and the shared files (server.js, app.js) include everything already live."; exit 1; }
[ -z "$(git status --porcelain -- new-backend frontend/src)" ] || {
  echo "✋ Uncommitted changes in new-backend/ or frontend/src/ — commit first so the deploy is reproducible."; exit 1; }
"${SSH[@]}" -o BatchMode=yes "$HOST" true || { echo "SSH failed — see AWS2.md (security-group IP)."; exit 1; }

# ── 1. Compare named files against the box ───────────────────────────────────
echo "── Backend files: local vs box (md5) ──"
CHANGED=()
for f in "${BACKEND_FILES[@]}"; do
  L=$(md5sum "$f" | cut -d' ' -f1)
  R=$("${SSH[@]}" "$HOST" "md5sum $APP/$f 2>/dev/null | cut -d' ' -f1" || true)
  if [ "$L" = "$R" ]; then echo "  same     $f"
  else echo "  ${R:+DIFFERS}${R:-NEW}  $f"; CHANGED+=("$f"); fi
done
# server.js and app.js are shared with live code: show the box-vs-local diff so a
# production-only fix is never silently reverted.
for f in new-backend/server.js new-backend/src/app.js; do
  echo "── diff box → local: $f ──"
  diff <("${SSH[@]}" "$HOST" "cat $APP/$f") "$f" || true
done

if [ "$APPLY" = false ]; then
  echo; echo "Dry run only. Review the diffs above (anything removed that is not Tally = STOP), then re-run with --apply."
  exit 0
fi

# ── 2. Backup, then copy the named files ─────────────────────────────────────
"${SSH[@]}" "$HOST" "mkdir -p ~/backups && tar czf ~/backups/pre-tally-backend-${TS}.tar.gz -C $APP new-backend/server.js new-backend/src \
  && cp -a $APP/frontend/build ~/backups/pre-tally-frontend-build-${TS} \
  && sudo -u postgres pg_dump -Fc colonel_agent_accountant > ~/backups/pre-tally-db-${TS}.dump && echo '  backups in ~/backups (*-${TS}*)'"
"${SSH[@]}" "$HOST" "mkdir -p $APP/new-backend/src/config"
for f in "${CHANGED[@]}"; do scp -i "$KEY" "$f" "$HOST:$APP/$f"; done

# ── 3. Frontend: built locally, never on the box ─────────────────────────────
(cd frontend && CI=false npx craco build)
rsync -az --delete -e "ssh -i $KEY" frontend/build/ "$HOST:$APP/frontend/build/"

# ── 4. Restart (plain, no --update-env) + verify ─────────────────────────────
"${SSH[@]}" "$HOST" "pm2 restart colonel-backend && pm2 save"
for i in $(seq 1 10); do "${SSH[@]}" "$HOST" "curl -sf -o /dev/null http://localhost:8001/api/health" && break; sleep 3; done
echo -n "health: "; curl -s -o /dev/null -w '%{http_code}\n' https://agent.accountant/api/health
echo -n "connector login route (expect 400/401, NOT 404/HTML): "
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://agent.accountant/api/tally/connector/login -H 'Content-Type: application/json' -d '{}'
"${SSH[@]}" "$HOST" "sudo -u postgres psql -d colonel_agent_accountant -c '\dt tally_*'"
echo "Tables self-create on boot. Now run the seed ONCE to add the Tally Connector agent to every brand:"
echo "  ssh -i $KEY $HOST 'cd $APP/new-backend && node seed-tally-connector.js --all'"
echo "Rollback: restore ~/backups/pre-tally-*-${TS}* (backend tar, frontend build dir, DB dump), pm2 restart colonel-backend."
