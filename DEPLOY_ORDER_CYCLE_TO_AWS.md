# Deploy Shopify-Order-Cycle to AWS — Runbook (DO NOT RUN until approved)

Prepared on port-3000. AWS already has the order-cycle **backend code** (`order-cycle-shopify`
controller, `orderCycleRoutes` mounted) and the component is in the live frontend build — but there
is **no `agents` row**, so it never appears. This runbook registers the agent + assigns it to all
brands, and refreshes the code only if AWS's version is older than 3000's.

Box: `ssh -i ~/.ssh/colonel-key.pem ubuntu@43.205.60.250` · app root `/opt/colonel`.

---

## 0. Pre-flight (read-only — confirm before any change)
```bash
# Confirm the agent is NOT yet registered
sudo -u postgres psql -d colonel-master -tA -c \
  "SELECT name FROM agents WHERE name='Shopify-Order-Cycle';"   # expect: empty

# Confirm brand count (assignment target)
sudo -u postgres psql -d colonel-master -tA -c "SELECT count(*) FROM brands;"   # expect: 16

# Compare AWS order-cycle code vs 3000 (run the size diff from the Mac):
#   ssh ... 'wc -c /opt/colonel/new-backend/src/controllers/agents/order-cycle-shopify/orderCycleShopifyController.js \
#            /opt/colonel/new-backend/src/services/processors/orderCycleShopifyProcessor.js \
#            /opt/colonel/new-backend/src/routes/orderCycleRoutes.js'
#   then compare to the matching files on 3000.
```

## 1. Backups (MANDATORY before any write)
```bash
cp -a /opt/colonel/frontend/build /tmp/fe_backup_$(date +%s)
cp /opt/colonel/new-backend/src/app.js /tmp/app.js.bak
# DB safety: pg_dump colonel-master before the seeder
sudo -u postgres pg_dump colonel-master > /tmp/colonel-master_$(date +%s).sql
```

## 2. Refresh backend code — ONLY if step 0 shows AWS is older
From the Mac, scp the 3000 (main-latest) versions up:
```bash
scp -i ~/.ssh/colonel-key.pem \
  "colonol git/colonel-automation/new-backend/src/controllers/agents/order-cycle-shopify/orderCycleShopifyController.js" \
  ubuntu@43.205.60.250:/opt/colonel/new-backend/src/controllers/agents/order-cycle-shopify/
scp -i ~/.ssh/colonel-key.pem \
  "colonol git/colonel-automation/new-backend/src/services/processors/orderCycleShopifyProcessor.js" \
  ubuntu@43.205.60.250:/opt/colonel/new-backend/src/services/processors/
scp -i ~/.ssh/colonel-key.pem \
  "colonol git/colonel-automation/new-backend/src/routes/orderCycleRoutes.js" \
  ubuntu@43.205.60.250:/opt/colonel/new-backend/src/routes/
```
If `orderCycleRoutes` is newly added, confirm it is required + mounted in `/opt/colonel/new-backend/src/app.js` (it already is on AWS — verify with `grep -n orderCycle /opt/colonel/new-backend/src/app.js`).

## 3. Register the agent + assign to all brands
Copy the seeder up, then run it on the box:
```bash
scp -i ~/.ssh/colonel-key.pem \
  "colonol git/colonel-automation/new-backend/seeders/02-order-cycle-agent.js" \
  ubuntu@43.205.60.250:/opt/colonel/new-backend/seeders/
scp -i ~/.ssh/colonel-key.pem \
  "colonol git/colonel-automation/new-backend/seed-order-cycle.js" \
  ubuntu@43.205.60.250:/opt/colonel/new-backend/
# on the box:
cd /opt/colonel/new-backend && node seed-order-cycle.js   # idempotent; prints "assigned to 16 brand(s)"
```

## 4. Frontend — ONLY if the live build lacks the order-cycle UI
The string `order-cycle-shopify` is already in the live build, so a rebuild is likely NOT needed.
If a rebuild is required, follow the CLAUDE.md frontend recipe: back up `build/`, deploy `origin/RECO`
frontend, `npm install --legacy-peer-deps`, `npm run build` (NEVER build from a stale `src/`).

## 5. Restart + verify
```bash
pm2 restart colonel-backend
pm2 logs colonel-backend --lines 30 --nostream     # clean boot, all routes mounted
# API check (with a valid admin JWT): GET /api/agents includes "Shopify-Order-Cycle"
```
Then in the live UI: an admin/accountant opens a brand → Shopify-Order-Cycle card appears → opens the
proper workspace → upload a real file → preview/commit works → `shopify_order_cycle` table auto-creates
in that brand's DB.

## Rollback
- Code: restore from `/tmp/*.bak` / `/tmp/fe_backup_*`, `pm2 restart colonel-backend`.
- DB: the seeder only ADDS rows; to undo, delete the `Shopify-Order-Cycle` agent row
  (`brand_agents` rows cascade) — or restore `/tmp/colonel-master_*.sql`.

## Guardrails
- Per-user access needs nothing extra — accountants see the agent via their existing `brand_users`
  brand membership once `brand_agents` is assigned.
- Do not touch RECO agents, reco-engine, or any other agent's code during this deploy.
