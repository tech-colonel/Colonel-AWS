#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Colonel service watchdog  —  runs every minute from cron.
#
# WHY THIS EXISTS
#   On 2026-08-21 the live box went dark while every process was still "online".
#   The backend sat at 99.9% CPU on its main thread with 2.4 GB resident and the
#   reco engines completely idle: the node event loop was blocked doing
#   synchronous JSON work on an oversized engine response, so every request
#   queued behind it and nginx timed out. Nothing caught it — pm2 saw a healthy
#   process, and `--max-memory-restart 4G` never fired because 2.4 GB is under
#   the threshold. Memory was never the trigger.
#
#   So this probes RESPONSIVENESS, not memory. It asks the same question a user
#   asks — "does the site answer?" — and only that question catches a stall.
#
# BEHAVIOUR
#   * Probe backend /health and both reco engines with a short timeout.
#   * Require FAIL_THRESHOLD consecutive failures before acting, so one slow
#     moment (or a GC pause) never causes a restart.
#   * Capture diagnostics BEFORE restarting. A restart destroys the evidence,
#     and without it we are guessing about the next stall.
#   * Honour a cooldown so a genuinely broken deploy cannot become a restart loop.
#   * Restart only what is actually unresponsive.
#
# DELIBERATELY NOT DONE HERE
#   No nightly backend restart. A restart drops in-flight reconciliations, so it
#   is a response to a stall, never a routine.
# ---------------------------------------------------------------------------
set -uo pipefail

BACKEND_URL="${WATCHDOG_BACKEND_URL:-http://127.0.0.1:8001/health}"
# Overridable so the failure path can be exercised against a throwaway pm2 name
# instead of the real backend. Never point this at a live service to "test".
BACKEND_SERVICE="${WATCHDOG_BACKEND_SERVICE:-colonel-backend}"
ENGINE_PORTS="${WATCHDOG_ENGINE_PORTS:-8765 8766}"
ENGINE_PREFIX="${WATCHDOG_ENGINE_PREFIX:-reco-engine}"
PROBE_TIMEOUT="${WATCHDOG_PROBE_TIMEOUT:-10}"   # seconds per probe
FAIL_THRESHOLD="${WATCHDOG_FAIL_THRESHOLD:-3}"  # consecutive failures before acting
COOLDOWN="${WATCHDOG_COOLDOWN:-900}"            # min seconds between restarts of one service

# BUSY vs WEDGED.
#
# The first version of this script restarted after 3 failed probes, full stop. That
# was wrong, and it made things worse: a workflow apply legitimately pegs the event
# loop for minutes building a 136 MB workbook, and this script kept killing it at the
# 3-minute mark, so the job could never finish. It turned a slow request into a job
# that was impossible to complete.
#
# Being unresponsive says nothing on its own about whether work is happening. CPU
# does. A process burning a core is making progress and has earned patience; a
# process that answers nothing while sitting idle is wedged and should be restarted
# promptly. So the grace period depends on which one it is — with a hard ceiling, so
# a genuine runaway loop is still caught eventually rather than spinning forever.
BUSY_CPU_PCT="${WATCHDOG_BUSY_CPU_PCT:-50}"          # >= this = actively working
BUSY_FAIL_THRESHOLD="${WATCHDOG_BUSY_FAIL_THRESHOLD:-20}"  # probes to tolerate while busy

STATE_DIR="${WATCHDOG_STATE_DIR:-/opt/colonel/ops/state}"
DIAG_DIR="${WATCHDOG_DIAG_DIR:-/opt/colonel/ops/diags}"
DIAG_KEEP="${WATCHDOG_DIAG_KEEP:-40}"           # newest diagnostics kept on disk
LOG_MAX_BYTES="${WATCHDOG_LOG_MAX_BYTES:-5242880}"   # rotate watchdog.log past 5 MB
LOG_FILE="${WATCHDOG_LOG_FILE:-/opt/colonel/ops/watchdog.log}"
mkdir -p "$STATE_DIR" "$DIAG_DIR" 2>/dev/null || true

log() { echo "[watchdog] $(date -u +%FT%TZ) $*"; }

# cron appends our stdout to LOG_FILE, so rotate it here rather than adding a
# logrotate config. Healthy runs are silent, so this only ever trips after a
# long run of incidents — but "only grows" is exactly what we are fixing.
if [ -f "$LOG_FILE" ] && [ "$(stat -c %s "$LOG_FILE" 2>/dev/null || echo 0)" -gt "$LOG_MAX_BYTES" ]; then
  mv -f "$LOG_FILE" "${LOG_FILE}.1" 2>/dev/null || true
fi

# --- diagnostics ------------------------------------------------------------
# Written before any restart. This is the post-mortem for the next incident:
# which thread was hot, what the process was holding, what nginx was seeing.
capture_diags() {
  local service="$1" stamp out
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  out="$DIAG_DIR/${stamp}-${service}.txt"
  {
    echo "=== watchdog diagnostics: $service unresponsive at $stamp ==="
    echo; echo "--- uptime / load ---"; uptime
    echo; echo "--- memory ---"; free -m
    echo; echo "--- disk ---"; df -h / 2>/dev/null | tail -2
    # pm2's own table, not a parsed one. An embedded python one-liner here was a
    # SyntaxError whose output 2>/dev/null quietly swallowed, so this section came
    # back empty in the very incident it exists to explain. Keep it unbreakable.
    echo; echo "--- pm2 ---"; pm2 list --no-color 2>&1
    echo; echo "--- top processes by RSS ---"
    ps -eo pid,pcpu,pmem,rss,etime,comm --sort=-rss 2>/dev/null | head -12
    echo; echo "--- per-thread CPU for the pm2-managed node/python procs ---"
    for pid in $(pgrep -f "new-backend/server.js|reco-engine/server.py" 2>/dev/null); do
      echo "  [pid $pid]"
      top -H -b -n1 -p "$pid" 2>/dev/null | tail -12 | sed 's/^/    /'
    done
    echo; echo "--- socket counts ---"
    echo "  established to :8001 = $(ss -tn state established '( sport = :8001 )' 2>/dev/null | tail -n +2 | wc -l)"
    for p in $ENGINE_PORTS; do
      echo "  established to :$p = $(ss -tn state established "( sport = :$p )" 2>/dev/null | tail -n +2 | wc -l)"
    done
    echo; echo "--- nginx access tail ---"; sudo tail -25 /var/log/nginx/access.log 2>/dev/null
    echo; echo "--- nginx error tail ---"; sudo tail -15 /var/log/nginx/error.log 2>/dev/null
    echo; echo "--- backend log tail ---"; tail -40 "$HOME/.pm2/logs/colonel-backend-error.log" 2>/dev/null
  } > "$out" 2>&1
  log "diagnostics -> $out"

  # Prune. This script exists because unbounded growth took the box down; a
  # diagnostics directory that grows forever would be the same mistake in
  # miniature. Keep the most recent DIAG_KEEP files and drop the rest.
  ls -1t "$DIAG_DIR"/*.txt 2>/dev/null | tail -n +"$(( DIAG_KEEP + 1 ))" | while read -r old; do
    rm -f "$old"
  done
}

# --- probe / act ------------------------------------------------------------
probe_http() {  # url -> 0 healthy, 1 not
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$PROBE_TIMEOUT" "$1" 2>/dev/null)
  [ "$code" = "200" ]
}

# Whole-process CPU% for a pm2 service, sampled over one second. `ps` alone reports
# the average since the process started, which is useless here — a backend that has
# been up an hour and is pegged right now still averages near zero.
service_cpu() {  # service -> integer CPU%, or 0 if it cannot be determined
  local service="$1" pid pat
  case "$service" in
    colonel-backend) pat="new-backend/server.js" ;;
    *)               pat="reco-engine/server.py" ;;
  esac
  pid=$(pgrep -f "$pat" 2>/dev/null | head -1)
  [ -n "$pid" ] || { echo 0; return; }
  top -b -n2 -d1 -p "$pid" 2>/dev/null \
    | awk -v p="$pid" '$1==p {v=$9} END {printf "%d", v+0}'
}

# service_name  probe_url  -> restarts via pm2 once it has failed for long enough,
# where "long enough" depends on whether the process is doing work (see BUSY vs WEDGED)
check() {
  local service="$1" url="$2"
  local fail_file="$STATE_DIR/${service}.fails" last_file="$STATE_DIR/${service}.last_restart"
  local fails=0 last=0 now cpu threshold

  if probe_http "$url"; then
    # Recovered on its own — reset the counter and say so, so the log shows a blip.
    if [ -s "$fail_file" ] && [ "$(cat "$fail_file" 2>/dev/null || echo 0)" -gt 0 ]; then
      log "$service recovered after $(cat "$fail_file") failed probe(s)"
    fi
    echo 0 > "$fail_file"
    return 0
  fi

  fails=$(( $(cat "$fail_file" 2>/dev/null || echo 0) + 1 ))
  echo "$fails" > "$fail_file"

  # Busy or wedged? Decides how long we are willing to wait.
  cpu=$(service_cpu "$service")
  if [ "$cpu" -ge "$BUSY_CPU_PCT" ]; then
    threshold="$BUSY_FAIL_THRESHOLD"
    log "$service probe FAILED ($fails/$threshold) cpu=${cpu}% — BUSY, work in progress, holding off -> $url"
  else
    threshold="$FAIL_THRESHOLD"
    log "$service probe FAILED ($fails/$threshold) cpu=${cpu}% — idle and not answering -> $url"
  fi

  [ "$fails" -ge "$threshold" ] || return 0

  now=$(date +%s)
  last=$(cat "$last_file" 2>/dev/null || echo 0)
  if [ $(( now - last )) -lt "$COOLDOWN" ]; then
    log "$service still down but within cooldown ($(( now - last ))s < ${COOLDOWN}s) — NOT restarting; needs a human"
    return 0
  fi

  capture_diags "$service"
  log "$service unresponsive for $fails consecutive probes (cpu=${cpu}%) — restarting"
  if pm2 restart "$service" >/dev/null 2>&1; then      # plain restart: keeps NODE_OPTIONS
    echo "$now" > "$last_file"
    echo 0 > "$fail_file"
    sleep 8
    if probe_http "$url"; then
      log "$service restarted and healthy again"
    else
      log "$service restarted but STILL not answering — escalate"
    fi
  else
    log "$service pm2 restart FAILED"
  fi
}

check "$BACKEND_SERVICE" "$BACKEND_URL"

i=1
for port in $ENGINE_PORTS; do
  name="$ENGINE_PREFIX"; [ "$i" -gt 1 ] && name="${ENGINE_PREFIX}-$i"
  check "$name" "http://127.0.0.1:${port}/"
  i=$(( i + 1 ))
done
