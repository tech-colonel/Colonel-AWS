#!/bin/bash
# start-reco.sh — bring the whole RECO stack back up after a Mac restart.
# Permanent URL: https://eggbeater-thesis-crowbar.ngrok-free.dev
#
# Usage:  cd "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation" && ./start-reco.sh
# (first time: chmod +x start-reco.sh)

set -e
ROOT="/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation"
NGROK_URL="https://eggbeater-thesis-crowbar.ngrok-free.dev"

echo "── Stopping any old processes ──"
pkill -f "ngrok http" 2>/dev/null || true
kill -9 $(lsof -t -i:8765) 2>/dev/null || true
kill -9 $(lsof -t -i:8001) 2>/dev/null || true
sleep 2

echo "── 1/3  Python reco engine (port 8765) ──"
cd "$ROOT/reco-engine"
nohup python3 server.py > /tmp/reco_engine.log 2>&1 &
sleep 3

echo "── 2/3  Node backend (port 8001, serves the React build) ──"
cd "$ROOT/new-backend"
nohup node server.js > /tmp/colonel_backend.log 2>&1 &
# wait for backend health
for i in $(seq 1 30); do
  curl -s http://localhost:8001/api/health >/dev/null 2>&1 && break
  sleep 1
done

echo "── 3/3  ngrok tunnel (permanent URL) ──"
cd /tmp
nohup ngrok http 8001 --url "$NGROK_URL" > /tmp/ngrok.log 2>&1 &
sleep 5

echo ""
echo "✅ Stack up. Share this link with accountants:"
echo "   $NGROK_URL"
echo ""
echo "Health checks:"
curl -s http://localhost:8001/api/health  && echo "  ← backend"
curl -s http://localhost:8765/ >/dev/null 2>&1 && echo "ok  ← python engine" || echo "python engine: check /tmp/reco_engine.log"
echo "ngrok log: /tmp/ngrok.log   (if URL is offline, check this)"
