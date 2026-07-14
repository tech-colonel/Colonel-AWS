# 🚀 AWS.md — Colonel-AWS Production on EC2 (Main AWS Reference)

> **The single source of truth for the live site.** Read this **before touching production**.
> The public link **`https://eggbeater-thesis-crowbar.ngrok-free.dev`** is served by an **AWS EC2 box** at `/opt/colonel`.
>
> **This repo (Colonel-AWS) is the code — a superset of what's live.** It carries every production feature plus local-only work not yet deployed. The **running production** lives on EC2 at `/opt/colonel` and is a subset compiled/rsynced from here. When in doubt, **the code in this repo is the source of truth**; the box is where a chosen slice of it runs.
>
> App architecture (pages, controllers, agents) is documented in [ARCHITECTURE.md](ARCHITECTURE.md); this doc is the **deployment + operations** reference. See also [SERVERS.md](SERVERS.md) for ports/process management, [RECO.md](RECO.md) for the reco engine, [DATABASES.md](DATABASES.md) for the schema, and [CLAUDE.md](CLAUDE.md) / [README.md](README.md) for the top-level index.

---

## ⛔ Golden Rules (non-negotiable)
1. **Never do ANYTHING on AWS without explicit user permission** this session — no deploy, restart, migration, or DB op.
2. **Change the LIVE site ONLY on EC2, over SSH.** Editing this repo never changes production on its own — deploy is a deliberate rsync/scp step.
3. **Never `git push` to GitHub (any branch) unless the user explicitly says so.** The deploy path is SSH/rsync, not GitHub. (A prior push to `main` had to be force-reverted.)
4. **Back up before every destructive op:** `src/app.js`, `frontend/build`, any file you overwrite, and DBs → `cp -a … /tmp/…_$(date +%s)` / `pg_dump` first.
5. **Restart the right process** after a change: backend → `pm2 restart colonel-backend`; Python → `pm2 restart reco-engine`; frontend → `npm run build` (no restart, backend serves the build) then hard-refresh.
6. **This repo is a superset** — never assume every file here is live. Confirm what's actually deployed before editing production behavior.

---

## Serving topology (memorize this shape)
```
  Public internet
        │  https://eggbeater-thesis-crowbar.ngrok-free.dev
        ▼
  ┌──────────── pm2: ngrok ────────────┐        (only 22/SSH + ngrok reach the box;
  │           tunnels  →  :8001         │         5432 / 8001 / 8765 blocked publicly)
  └─────────────────┬───────────────────┘
                    ▼
  ┌───── pm2: colonel-backend   Node/Express   :8001  (new-backend/server.js → src/app.js) ─────┐
  │                                                                                               │
  │   /api/auth ─────────────────────────────► authRoutes                                         │
  │   /api/{brand,user,agent,reco,dashboard,task,sales,invoice,orderCycle,settlement,             │
  │         cfoAnalytics,mtr,plans,integration,chat,workflow,meeting,zoho,compliance,attachments} │
  │   /api/bank-reco ────────────────────────► bankCorrectionsRoutes                              │
  │   /api/files ────────────────────────────► static ../output                                  │
  │   express.static(../../frontend/build) ──► serves the compiled React SPA                      │
  │   app.get('/{*path}') ───────────────────► SPA fallback → index.html   (MUST be last)         │
  └──────────┬──────────────────────────────────────────────────┬────────────────────────────────┘
             │ pg (localhost:5432)                                │ axios proxy (600s timeout)
             ▼                                                    ▼
  ┌── PostgreSQL (local, 127.0.0.1) ──┐         ┌── pm2: reco-engine  Python stdlib  :8765 ──┐
  │  17 DBs: colonel-master           │         │  POST /api/reconcile  (dispatch reco_type)  │
  │  + 16 per-brand DBs               │         │  GET  /api/jobs/{id}[/export.xlsx]          │
  │  (mixed hyphen/underscore names)  │         │  recon/*.py   MAX_CONCURRENT_RECO=1         │
  └───────────────────────────────────┘         └─────────────────────────────────────────────┘
```
> **Only TWO ports listen: 8001 + 8765.** No nginx, no `serve`, no separate static server. ngrok → 8001; the Node backend serves BOTH the REST API and the React `build/`. Frontend is React 18 + craco (dev server on :3000; production is the compiled `build/`).

---

## AWS resources & connection
| What | Value |
|---|---|
| Account / Region | **`364503394269`** · **ap-south-1 (Mumbai)** |
| Instance | **`i-0e3aa71ed74f03aed`** · type **t3.small (2 GB RAM)** *(started t3.micro; resized — 2 GB stopped swap)* |
| Elastic IP | **`43.205.60.250`** · alloc **`eipalloc-0e4df2c0e53077b90`** — **static across stop/start** |
| SSH key | **`~/.ssh/colonel-key.pem`** |
| SSH | `ssh -i ~/.ssh/colonel-key.pem ubuntu@43.205.60.250` |
| App root | **`/opt/colonel`** — plain files, **NOT a git repo** (rsync/scp/`git archive`+tar only) |
| Security group | **SSH(22) from your current IP only** + ngrok. `5432` / `8001` / `8765` blocked on the public IP. Postgres binds `127.0.0.1` only. `.env` is `chmod 600` and not web-served. |
| IAM deploy user | **`colonel-deploy`** (AmazonEC2FullAccess); access key in local `aws` CLI (`/opt/homebrew/bin/aws`) — **keep it** (needed for future pushes). |
| Postgres creds | local `postgres`/`postgres` |
| `dhaval.colonel@gmail.com` | **ADMIN on AWS** (pw `dhaval123`) — note: admin here, not "developer" |

> **SSH times out?** Your public IP changed → re-add it to the SG:
> `aws ec2 authorize-security-group-ingress --group-id <sg> --protocol tcp --port 22 --cidr <your.ip>/32`

---

## 💰 Funding & the November 7 2026 deadline (CRITICAL)
- **Free-plan HARD DEADLINE = November 7, 2026** — this is the **binding** date (earlier than credit expiry 05/07/2027). On that date remaining credits (~$110–130 of $200) are **forfeited**; to keep the app running the account must **upgrade to paid (add card → standard pricing)** OR migrate/shut down — otherwise the instance is suspended/terminated (**downtime + data-loss risk, NOT a surprise bill**).
- Cost ~**$15/mo** at t3.small. On the free plan the account **cannot be charged** (no card on file). Forecast usage ~$23.25/mo is **credit-covered, $0 out of pocket**.
- **AWS Budgets** (us-east-1): `My Monthly Cost Budget` ($40, alerts 85/100/forecast) + `My Zero-Spend Budget` ($1). Budgets track **pre-credit usage**, so Zero-Spend shows "Exceeded" at ~$0.23 MTD — that is credit-covered, not a real charge.
- **Resize is BLOCKED on the free plan**: `modify-instance-attribute` → `FreeTierRestrictionError`. Can't change instance type without upgrading. Not needed yet — **4 GB swap covers MTR's ~1 GB peak** (verified: 230k-row MTR run finished with 871 Mi free, swap untouched). Stop/start is safe (pm2 auto-resurrects via `pm2-ubuntu.service` + `~/.pm2/dump.pm2`).

## ⏰ AMI / snapshot reminder duty (documented — proactive)
> **In any session from ~Oct 1 2026 onward (and definitely within a month of Nov 7 2026), remind the user UNPROMPTED:** free plan ends **Nov 7 2026** → **take an AMI / EBS snapshot** and **decide upgrade (add card) vs migrate** before the box is suspended. Verify today's date is before Nov 7 first, and offer to run the AMI snapshot when asked.
- Calendar reminders already set on `chauhandhaval932@gmail.com`: **Oct 7** (1-month), **Oct 24** (~2-week, take AMI), **Nov 7** (deadline), + weekly Mondays (credit check, until Nov 2).
- Future plan: move to a **real domain** "shortly" (ngrok stays for now).

---

## On-box layout — `/opt/colonel` (full tree)
```
/opt/colonel/                        ← plain files, NOT a git repo
├── frontend/                        ← React 18 (craco)
│   ├── src/                         ← SOURCE (⚠ can be an OLDER snapshot than build/ — see trap)
│   │   ├── App.js · index.js
│   │   ├── lib/adminNav.js          ← sidebarFor(): ADMIN / DEVELOPER / accountant menus
│   │   ├── lib/{api,recoAgentSpecs,demoSamples,sampleCalendar,utils}.js
│   │   ├── context/AuthContext.js · hooks/use-toast.js
│   │   ├── components/{layout/DashboardLayout, ProtectedRoute, MeetingDetailModal,
│   │   │               reco/ToolResultDashboard, ui/*}
│   │   └── pages/{Login, ColonelChat, accountant/*, admin/*, cfo/*, developer/FeedbackPage}
│   └── build/                       ← ★ SERVED by the Node backend (compiled). NO other copy on the box.
│                                       BACK UP before any rebuild → /tmp/fe_backup_$(date +%s)
├── new-backend/                     ← Express API + Sequelize + JWT, port 8001
│   ├── server.js                    ← entry (app.listen 8001)
│   └── src/
│       ├── app.js                   ← mounts EVERY route group + static build + SPA fallback
│       ├── config/database.js       ← multi-DB Sequelize (master + per-brand)
│       ├── routes/                  ← auth, brand, user, agent, reco, dashboard, bankCorrections,
│       │                              task, sales, invoice, orderCycle, settlement, cfoAnalytics,
│       │                              mtr, plans, integration, chat, workflow, meeting, zoho,
│       │                              compliance, attachments   (cfoRoutes = dead/unmounted)
│       ├── controllers/             ← + agents/{sales-amazon…zepto, settlement-amazon,
│       │                              total-sales, order-cycle-shopify, invoice-process}
│       │   └── gstr3bController.js   ← GSTR-3B Tally agent (writes gstr3b_runs)
│       ├── services/ (+ processors/) · models/{master,brand,reco,task} · middleware/
│       ├── db/migrations/           ← 001_hero_database.sql (11 tables + RLS)
│       └── output/                  ← generated Excel (served at /api/files); output/mtr/*.xlsx
├── reco-engine/                     ← Python 3 stdlib, port 8765
│   ├── server.py                    ← http.server; _reclaim_memory (gc + malloc_trim); MAX_CONCURRENT_RECO=1
│   └── recon/*.py                   ← agent logic (incl. zepto_receivables.py) — see RECO.md
└── backups/                         ← nightly pg_dump per DB (7-day retention) — DB ONLY, no code
```
See [ARCHITECTURE.md](ARCHITECTURE.md) for the full page/route/agent breakdown, and [RECO.md](RECO.md) for the 33-agent catalog (e.g. `einvoice_reco` = `d0000000-0000-0000-0000-000000000008`, `zepto_receivables` = `d0000000-0000-0000-0000-000000000010`).

### 🔴 Frontend source-of-truth trap (broke the site once)
- On the box, **`/opt/colonel/frontend/src` is NOT reliably what the live UI was built from.** The live `build/` may have been compiled from a newer snapshot than the box's `src/`. In this repo, `frontend/src/` **is** the canonical source — deploy it deliberately (see below).
- **NEVER `npm run build` on EC2 without backing up `build/` first** — CRA/craco deletes and recompiles `build/`, there is **no other copy on the box**, and nightly backups are **DB-only**. A stale `src/` silently replaces the live UI. Deploy from this repo, not from whatever happens to be in the box's `src/`.

### 🔴 `app.js` must mount EVERY route group
A stripped `app.js` once made data "disappear" (API calls returned the SPA HTML fallback → empty UI). Verified mounts (bare `/api` unless noted):
`auth (→/api/auth)` · `brand` · `user` · `agent` · `reco` · `dashboard` · `bank-reco (→/api/bank-reco)` · `task` · `sales` · `invoice` · `orderCycle` · `settlement` · `cfoAnalytics` · `mtr` · `plans` · `integration` · `chat` · `workflow` · `meeting` · `zoho` · `compliance` · `attachments`.
- **No `gstr3b` route** — GSTR-3B is inside `recoRoutes`/`recoController` + `gstr3bController.js`. **`cfoRoutes.js` unmounted** (dead). **No `feedbackRoutes`** (task/compliance controllers back it).
- New route file → also `require` + `app.use` it, **before** the static/SPA block.

---

## Deploy flow

### Frontend (safe path)
```
 Repo: git archive --format=tar.gz -o /tmp/fe.tgz HEAD frontend
       scp -i ~/.ssh/colonel-key.pem /tmp/fe.tgz ubuntu@43.205.60.250:/tmp/
 EC2:  cp -a /opt/colonel/frontend/build /tmp/fe_backup_$(date +%s)      ← BACK UP FIRST
       rm -rf /opt/colonel/frontend/src && tar xzf /tmp/fe.tgz -C /opt/colonel
       # preserve frontend/.env (gitignored, not in the archive)
       cd /opt/colonel/frontend && npm install --legacy-peer-deps && npm run build
       # backend already serves build/ → just hard-refresh; no restart needed
```
Known extra deps the build needs: `react-is`, `html-to-image`, `@xyflow/react`.

### Backend / full app (rsync)
- `/opt/colonel` is rsync-deployed. To redeploy after code changes here: rsync `new-backend/` (and `reco-engine/`) → `/opt/colonel`, re-migrate/re-seed DBs if needed, `pm2 restart colonel-backend` / `reco-engine`.
- Because this repo is a **superset**, deploy only the slice you intend to make live — don't blindly push local-only features onto the box.
- **EC2 → local mirror** (make a local checkout a true clone of live): SSH in, `pg_dump -Fc --no-owner --no-privileges` every `colonel%` DB (read-only, AWS untouched) → tar → scp down → restore locally (DROP+CREATE local DBs — destructive to local only). Both PG are v16. See [DATABASES.md](DATABASES.md) and `db-seed/restore.sh` (restores all 17 DBs).

### Reco-engine notes (why the small box works)
`gc.collect()` + `malloc_trim(0)` in `reco-engine/server.py` (`_CappedJobs`/`_reclaim_memory`) stops CPython hoarding openpyxl/pandas memory; `MAX_CONCURRENT_RECO=1`; backend→engine axios timeout raised to **600s** in `recoController.js`; `pdfplumber` (GSTR-3B PDF) + pinned deps (pandas etc.) required on EC2. Multi-state is the heavy case. Details in [RECO.md](RECO.md).

---

## Nightly crons (ubuntu crontab; UTC → IST)
| UTC | IST | Script | Effect |
|---|---|---|---|
| `30 20 * * *` | 02:00 | `nightly-backup.sh` | `pg_dump` every DB → `/opt/colonel/backups/<TS>/` (7-day retention) |
| `0 21 * * *` | 02:30 | `nightly-data-purge.sh` | clears **result rows** (`bank_reco_results`, `gstr_2b/2a_2b/3b/1_results`, `gstr_3b_tally_results`) + `output/mtr/*.xlsx` across brand DBs |
| `30 21 * * *` | 03:00 | `memory-hygiene.sh` | drops OS page cache + restarts **reco-engine only** (DB + backend untouched) |

- Purge runs **after** the backup (recoverable) and **before** hygiene. Runs as `postgres` (bypasses RLS). Supports `--dry-run`. Source kept in repo: `nightly-data-purge.sh`.
- **🔴 The purge KEEPS `reco_jobs`** (admin analytics feed — one tiny row/run) plus `ledger_master` + `output/ledgers/`, `bank_reco_corrections` (learning), sales tables, `invoice_*`, `brand_agents`, and all of `colonel-master`. **NEVER re-add `DELETE FROM reco_jobs`** — it wiped every dashboard once. Hero/analytics data is intentionally daily-transient; `reco_jobs` metadata persists. See [DATABASES.md](DATABASES.md).

## Backup / recovery recipe
- Dumps: `/opt/colonel/backups/<YYYYMMDD-HHMMSS>/colonel_<brand>_.dump` (custom format, no `.name` sidecars).
- **Map dump → DB**: replace `_`→`-` and drop the trailing `_` (e.g. `colonel_stroom_.dump` → DB `colonel-stroom`; `colonel_other_` → `colonel_other`). ⚠ DB names are mixed hyphen/underscore — always `\l` to confirm.
- Restore just the analytics source: `pg_restore --data-only --no-owner -t reco_jobs -d "<livedb>" <dump>` as `postgres` (superuser bypasses FORCE RLS). Restoring `reco_jobs` without result tables → aggregate dashboards work; a job's row-level detail shows 0 rows (expected).

---

## Roles, nav & data attribution
- Nav from `frontend/src/lib/adminNav.js` → `sidebarFor()`:
  - **admin** → `ADMIN_SIDEBAR`: Dashboard · Colonel AI · Brands · Agents · Users · Tasks · Chats · Plans · Feedback · Integrations · Assignments.
  - **accountant** → brand-scoped Dashboard/Agents/Tracker + base: Colonel AI · Meetings · Tasks · Feedback · Integrations · Zoho Books · Plans · Switch brands (keep the base identical on every page). `chauhandhaval932@gmail.com` is an **accountant** and owns the gated Statutory Compliance / Zoho / Composio surfaces.
  - **developer** → `DEVELOPER_SIDEBAR`: Colonel AI · Feedback · Plans.
- Admin dashboards are **real-time**: `dashboardController` loops `Brand.findAll()` and aggregates `reco_jobs` across all brand DBs (any admin sees every user's runs). Endpoints: `/api/dashboard/admin/tool-analytics`, `/tool-details/:agentType`, `/users-overview`, `/user-activity/:userId`.
- `reco_jobs.created_by` = the JWT user (`req.user.id`). JWT is in **localStorage, shared across all tabs** → to attribute a run to a specific user, use a separate browser profile/incognito per user (last login wins otherwise).

## Deferred fixes (do not re-discover)
- **Pending**: `brand_agents` table missing on the **"Other"** brand DB (`colonel_other`) → `relation "brand_agents" does not exist` when opening Nykaa there. Fix: `getBrandAgentModel(db).sync()`; back up first.
- **Done**: GSTR-3B `period` `VARCHAR(50)`→`TEXT` truncation (fixed 2026-07-01, all 5 brand DBs with the table). Per-user Google OAuth (`user_google_accounts`; scopes unchanged).
