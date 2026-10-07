#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Weekly pull of Amazon settlement ledgers.
#
# WHY THIS EXISTS. The SP-API serves settlement reports for 90 days and then
# refuses them outright — "RequestedFromDate … is more than 90 days old". We hit
# that wall trying to complete January 2026 nine months after the fact: the
# three ledgers we had survived only because somebody happened to pull them in
# time, and the missing one is now unreachable through the API for good.
#
# Amazon settles roughly every seven days, so a weekly run with a 90-day lookback
# gives about twelve chances to catch each settlement before its window closes.
# Missing one run, or ten, costs nothing.
#
# It delegates to fetch-missing-settlements.js, which skips reports already on
# disk, paces itself around Amazon's one-document-a-minute quota, and writes
# FILES ONLY — no database writes, nothing to corrupt, safe to re-run at will.
# ──────────────────────────────────────────────────────────────────────────────
set -uo pipefail
set +m          # no job-control chatter ("Terminated: 15") in the log

BASE="/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation/new-backend"
LEDGERS="$BASE/outputs/amazon-ledgers/Koparo"
LOGDIR="$BASE/outputs/amazon-ledgers/_logs"
LOCK="/tmp/colonel-amazon-settlements.lock"
NODE="$(command -v node || echo /opt/homebrew/bin/node)"

mkdir -p "$LOGDIR" "$LEDGERS"
LOG="$LOGDIR/pull-$(date +%Y%m%d-%H%M%S).log"

# A run can take an hour when several settlements are outstanding — the quota
# forces a minute between documents. Never let a second run start on top of it.
exec 9>"$LOCK"
if ! flock -n 9 2>/dev/null; then
  # macOS has no flock(1); fall back to a pid check
  if [ -f "$LOCK.pid" ] && kill -0 "$(cat "$LOCK.pid" 2>/dev/null)" 2>/dev/null; then
    echo "$(date '+%F %T')  a pull is already running (pid $(cat "$LOCK.pid")); skipping" >> "$LOG"
    exit 0
  fi
fi
echo $$ > "$LOCK.pid"
trap 'rm -f "$LOCK.pid"' EXIT

BEFORE=$(ls -1 "$LEDGERS"/*.tsv 2>/dev/null | wc -l | tr -d ' ')

# The fetch script finishes its work and then does not exit — it logs
# "downloaded N of M" and sits there, holding an open handle, for as long as
# anything will let it. Observed at 11m29s after it had already finished.
# Unkilled, that process keeps the lock and every later run skips, which would
# defeat the whole point of the job. So it runs under a watchdog: generous
# enough for a real backlog (a dozen settlements at a minute apiece), hard
# enough that a hang cannot outlive the week.
#
# macOS ships no timeout(1), so the watchdog is a background sleep that kills
# the process group if it is still there when the clock runs out.
MAX_SECONDS=${MAX_SECONDS:-5400}          # 90 minutes

{
  echo "=== $(date '+%F %T %Z')  weekly settlement pull ==="
  echo "ledgers held before: $BEFORE"
  cd "$BASE" || exit 1
  "$NODE" scripts/fetch-missing-settlements.js &
  PULL_PID=$!
  ( sleep "$MAX_SECONDS"
    if kill -0 "$PULL_PID" 2>/dev/null; then
      echo "watchdog: still running after ${MAX_SECONDS}s — terminating"
      kill -TERM "$PULL_PID" 2>/dev/null
      sleep 10
      kill -KILL "$PULL_PID" 2>/dev/null
    fi ) &
  WATCHDOG=$!
  wait "$PULL_PID"; RC=$?
  kill "$WATCHDOG" 2>/dev/null; wait "$WATCHDOG" 2>/dev/null
  echo "exit: $RC"
} >> "$LOG" 2>&1

AFTER=$(ls -1 "$LEDGERS"/*.tsv 2>/dev/null | wc -l | tr -d ' ')
echo "ledgers held after:  $AFTER  (+$((AFTER - BEFORE)))" >> "$LOG"

# The point of the job is that nothing ages out unseen. If the newest ledger is
# older than three weeks, settlements are not arriving and somebody should look
# before the 90-day window takes them.
NEWEST=$(ls -t "$LEDGERS"/*.tsv 2>/dev/null | head -1)
if [ -n "$NEWEST" ]; then
  AGE_D=$(( ( $(date +%s) - $(stat -f %m "$NEWEST") ) / 86400 ))
  echo "newest ledger is ${AGE_D}d old" >> "$LOG"
  [ "$AGE_D" -gt 21 ] && echo "WARNING: no new settlement ledger in ${AGE_D} days — check the Amazon connection" >> "$LOG"
fi

# Keep the log directory from growing without bound.
ls -1t "$LOGDIR"/pull-*.log 2>/dev/null | tail -n +27 | while read -r f; do rm -f "$f"; done
exit 0
