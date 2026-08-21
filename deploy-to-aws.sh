#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-to-aws.sh — run from the Mac, from the repo root, on the `main` branch.
#
# Safely ships local `main` to the agent.accountant box (AWS account #2,
# i-07d81d3f4da578d28). Bakes in every rule learned the hard way (see
# CLAUDE.md "Golden rules — agent.accountant"):
#   - named-file/scoped rsync only, never a blind directory sync
#   - new-backend/src/data/ and reco-engine/format_templates/ are NEVER
#     touched — they're gitignored real production data, not code
#   - frontend is always built locally, never on the box
#   - restarts are always plain `pm2 restart <name>` — never --update-env
#   - both reco engines restart together
#   - backs up before touching anything; verifies after
#
# Usage:
#   ./deploy-to-aws.sh                 # dry run — shows exactly what would change, does nothing
#   ./deploy-to-aws.sh --apply         # actually deploy (backend + reco-engine + frontend)
#   ./deploy-to-aws.sh --apply --backend-only
#   ./deploy-to-aws.sh --apply --frontend-only
#   ./deploy-to-aws.sh --apply --reco-only
#   ./deploy-to-aws.sh --apply --push  # also `git push origin main` on success
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HOST="ubuntu@13.127.171.66"
KEY="$HOME/.ssh/colonel2-key.pem"
REMOTE_APP="/opt/colonel"
SG_ID="sg-077f835ef2a41e10e"
TS="$(date +%Y%m%d-%H%M%S)"

APPLY=false
PUSH=false
DO_BACKEND=true
DO_FRONTEND=true
DO_RECO=true

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --push) PUSH=true ;;
    --backend-only) DO_FRONTEND=false; DO_RECO=false ;;
    --frontend-only) DO_BACKEND=false; DO_RECO=false ;;
    --reco-only) DO_BACKEND=false; DO_FRONTEND=false ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

RSYNC_DRY=""
if [ "$APPLY" = false ]; then
  RSYNC_DRY="-n"
  echo "══════════════════════════════════════════════════════"
  echo " DRY RUN — nothing will change. Re-run with --apply"
  echo "           to actually deploy."
  echo "══════════════════════════════════════════════════════"
fi

SSH_CMD=(ssh -i "$KEY" -o ConnectTimeout=10)
RSYNC_SSH="ssh -i $KEY"

# ── 0. Preflight ─────────────────────────────────────────────────────────────
BRANCH="$(git branch --show-current)"
if [ "$BRANCH" != "main" ]; then
  echo "⚠️  You're on branch '$BRANCH', not 'main'. Deploying from a non-main branch is unusual."
  read -p "Continue anyway? [y/N] " ans
  [ "$ans" = "y" ] || exit 1
fi

if ! "${SSH_CMD[@]}" -o BatchMode=yes "$HOST" "echo ok" >/dev/null 2>&1; then
  echo "SSH unreachable — your IP probably rotated. Adding it to $SG_ID..."
  MYIP=$(curl -s https://checkip.amazonaws.com)
  aws ec2 authorize-security-group-ingress --profile colonel2 --region ap-south-1 \
    --group-id "$SG_ID" \
    --ip-permissions IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges="[{CidrIp=${MYIP}/32,Description='deploy-script auto-add ${TS}'}]" \
    >/dev/null 2>&1 || true
  sleep 3
  if ! "${SSH_CMD[@]}" -o BatchMode=yes "$HOST" "echo ok" >/dev/null 2>&1; then
    echo "Still unreachable. Check connectivity manually."; exit 1
  fi
  echo "  → IP $MYIP added, connected."
fi

echo
echo "Local HEAD:  $(git log -1 --oneline)"
echo "Branch:      $BRANCH"
echo

# ── 1. Migration reminder (box has no db-restructure/ dir — files there are
#      applied by hand via psql, never rsynced. This is just a memory jog.) ──
if [ -d db-restructure ] && [ -n "$(ls db-restructure/*.sql 2>/dev/null)" ]; then
  echo "📋 db-restructure/*.sql present locally — confirm each is already applied to prod"
  echo "   (the box has no db-restructure/ dir; migrations are applied by hand via psql)."
  echo "   Recent ones (newest first):"
  git log --diff-filter=A --format="   %ad  %h  %s" --date=short -- db-restructure/*.sql 2>/dev/null | sort -r | head -5
  echo "   Check a table exists with:"
  echo "     ssh -i $KEY $HOST \"sudo -u postgres psql -d colonel_agent_accountant -c '\\\\d <table>'\""
  echo
fi

# ── 2. Backend ────────────────────────────────────────────────────────────────
if [ "$DO_BACKEND" = true ]; then
  echo "── Backend: new-backend/src/ ──────────────────────────────────────────"
  if [ "$APPLY" = true ]; then
    "${SSH_CMD[@]}" "$HOST" \
      "tar czf ~/backups/pre-deploy-backend-src-${TS}.tar.gz -C ${REMOTE_APP} new-backend/src && echo '  → backed up to ~/backups/pre-deploy-backend-src-${TS}.tar.gz'"
  fi
  rsync -rc $RSYNC_DRY -i \
    --exclude 'node_modules' --exclude '.env' --exclude 'output' \
    --exclude '*.bak*' --exclude '.git' \
    --exclude 'data/' \
    -e "$RSYNC_SSH" \
    new-backend/src/ "${HOST}:${REMOTE_APP}/new-backend/src/"

  echo "── Backend: root files (package.json, package-lock.json, server.js, seeders/, scripts/) ──"
  rsync -rc $RSYNC_DRY -i \
    --exclude 'node_modules' --exclude '.env' --exclude 'output' \
    --exclude '*.bak*' --exclude '.git' --exclude 'src' \
    --exclude 'migrations' --exclude 'test input files' --exclude 'tests' \
    -e "$RSYNC_SSH" \
    new-backend/package.json new-backend/package-lock.json new-backend/server.js new-backend/nodemon.json \
    new-backend/seed.js new-backend/seeders new-backend/scripts \
    "${HOST}:${REMOTE_APP}/new-backend/"

  if [ "$APPLY" = true ]; then
    echo "  → npm install --omit=dev on box"
    "${SSH_CMD[@]}" "$HOST" "cd ${REMOTE_APP}/new-backend && npm install --omit=dev"
  fi
fi

# ── 3. Reco-engine ───────────────────────────────────────────────────────────
if [ "$DO_RECO" = true ]; then
  echo "── reco-engine ────────────────────────────────────────────────────────"
  if [ "$APPLY" = true ]; then
    "${SSH_CMD[@]}" "$HOST" \
      "tar --exclude=reco-engine/format_templates --exclude=reco-engine/exports -czf ~/backups/pre-deploy-reco-engine-${TS}.tar.gz -C ${REMOTE_APP} reco-engine && echo '  → backed up to ~/backups/pre-deploy-reco-engine-${TS}.tar.gz'"
  fi
  rsync -rc $RSYNC_DRY -i \
    --exclude 'exports' --exclude '__pycache__' --exclude '*.bak*' --exclude '.git' \
    --exclude 'tests' --exclude 'static' --exclude 'format_templates' \
    -e "$RSYNC_SSH" \
    reco-engine/ "${HOST}:${REMOTE_APP}/reco-engine/"
fi

# ── 4. Frontend — ALWAYS build locally, never on the box ────────────────────
if [ "$DO_FRONTEND" = true ]; then
  echo "── Frontend: building locally from current main ────────────────────────"
  if [ "$APPLY" = true ]; then
    (cd frontend && CI=false npx craco build)
    BUNDLE=$(ls frontend/build/static/js/main.*.js | xargs -n1 basename)
    echo "  → built $BUNDLE"

    "${SSH_CMD[@]}" "$HOST" \
      "cp -a ${REMOTE_APP}/frontend/build ${REMOTE_APP}/frontend/build.bak-${TS} && echo '  → box build/ backed up to build.bak-${TS}'"

    rsync -az --delete -e "$RSYNC_SSH" \
      frontend/build/ "${HOST}:${REMOTE_APP}/frontend/build/"
  else
    echo "  (dry run — skipping actual build; run with --apply to build + compare bundle hash)"
  fi
fi

# ── 5. Restart — plain, both engines together ────────────────────────────────
if [ "$APPLY" = true ]; then
  echo
  echo "── Restarting (plain, never --update-env) ──────────────────────────────"
  "${SSH_CMD[@]}" "$HOST" "pm2 restart reco-engine reco-engine-2 colonel-backend && pm2 save"

  echo
  echo "── Waiting for backend to come back healthy (up to 30s) ────────────────"
  UP=false
  for i in $(seq 1 10); do
    if "${SSH_CMD[@]}" "$HOST" "curl -sf -o /dev/null http://localhost:8001/api/health" 2>/dev/null; then
      UP=true; break
    fi
    sleep 3
  done
  [ "$UP" = true ] && echo "  → backend healthy" || echo "  ⚠️  backend did not come up within 30s — check 'pm2 logs colonel-backend' on the box"

  echo
  echo "── Verify ────────────────────────────────────────────────────────────"
  "${SSH_CMD[@]}" "$HOST" "
    echo -n 'backend      : '; curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8001/api/health
    echo -n 'reco-engine  : '; curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8765/
    echo -n 'reco-engine-2: '; curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8766/
    pm2 status
  "
  echo -n "live site    : "
  curl -s -o /dev/null -w "%{http_code}\n" https://agent.accountant/ || true
  if [ "$DO_FRONTEND" = true ]; then
    LIVE_BUNDLE=$(curl -s https://agent.accountant/ | grep -o 'main\.[a-f0-9]*\.js' || true)
    echo "live bundle  : ${LIVE_BUNDLE:-<none found>}"
    if [ "$LIVE_BUNDLE" = "$BUNDLE" ]; then
      echo "  ✅ matches what we just built"
    else
      echo "  ⚠️  MISMATCH — investigate before calling this done"
    fi
  fi

  if [ "$PUSH" = true ]; then
    echo
    echo "── Pushing to GitHub (deploy == commit + push) ──────────────────────────"
    git push origin main
  else
    echo
    echo "⚠️  Not pushed to GitHub. Deploy == commit + push — run 'git push origin main' yourself,"
    echo "   or re-run this script with --push next time."
  fi
else
  echo
  echo "Dry run complete. Nothing was changed. Re-run with --apply to deploy for real."
fi
