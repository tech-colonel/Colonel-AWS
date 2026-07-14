# 🪖 CLAUDE.md — Colonel-AWS (index for AI assistants)

> **Lean index — detail lives in the focused docs.** Open the one that matches your task; each is
> self-contained. Full human walkthrough is in **[README.md](README.md)**.
>
> | Doc | Read it when… |
> |---|---|
> | **[README.md](README.md)** | You want the full clone→run walkthrough, tech stack, tree, agent catalog |
> | **[ARCHITECTURE.md](ARCHITECTURE.md)** | Full app map — pages, route mounts, controllers, services, agents |
> | **[SERVERS.md](SERVERS.md)** | Ports, start/restart, pm2, health checks, fresh-machine bring-up |
> | **[RECO.md](RECO.md)** | Python reco engine + every agent (2B/2A-2B/3B/GSTR-1/E-Invoice/bank/GSTR-3B Tally/Zepto) |
> | **[DATABASES.md](DATABASES.md)** | Schema, RLS, migrations, per-brand tables, seed/restore |
> | **[AWS.md](AWS.md)** | Deploying/operating the live EC2 site — deploy flow, crons, backups |

---

## What this repo is
Full end-to-end automation platform for an **Indian CA firm** managing many D2C / e-commerce brands:
GST reconciliation, sales MIS, CFO dashboards, compliance & statutory trackers, Zoho Books mirror,
bank classifier, and an AI copilot — behind a clean, role-based web app. **This repo is a runnable
superset of the live production app**, shipped with a snapshot of the real database (`db-seed/`).

## Overview & tech stack
- **Frontend** — React 18 + craco, Tailwind, Recharts, `@xyflow/react` — **:3000** (`frontend/`)
- **Backend** — Node/Express + Sequelize + JWT — **:8001** (`new-backend/`, entry `server.js`)
- **Reco engine** — Python 3 stdlib HTTP, pandas/openpyxl — **:8765** (`reco-engine/`)
- **DB** — PostgreSQL 16, **single unified DB `colonel_agent_accountant`** (default), brands isolated by a `brand_id` column + Row-Level Security; app connects as non-superuser `colonel_app`. Legacy per-brand DBs are an escape hatch (`USE_UNIFIED_DB=false`). See [DATABASES.md](DATABASES.md).
- **External** — Gemini + Claude, Zoho Books, Fireflies, Google Drive/Sheets, n8n, Shopify
- **Deploy** — AWS EC2 (t3.small, Mumbai) via ngrok; pm2

## Tree (high level)
```
frontend/      React SPA (:3000)          — src/{pages,components,lib,context,hooks}
new-backend/   Express API (:8001)        — server.js · seed.js · seeders/ · src/{controllers,routes,services,models,db,middleware} · scripts/classify.py
reco-engine/   Python reco (:8765)        — server.py · recon/*.py
db-seed/       DB snapshot + restore.sh   — dumps/colonel_agent_accountant.dump (single unified DB = real AWS prod data)
docs           README · CLAUDE · AWS · SERVERS · RECO · DATABASES · ARCHITECTURE
```

## Flow (one line)
Browser → `POST /api/reco/upload` (Node, `recoController`) → axios proxy `POST /api/reconcile` (Python
`:8765`, dispatch on `reco_type`) → `recon/<agent>.py` builds Excel → download; **fire-and-forget**
`setImmediate` DB save writes `reco_jobs` + `*_results` to the unified DB, tagged by `brand_id` (admin-analytics feed).
Sales agents run in Node → `bulkCreate` to the brand's dynamic tables + `agentRunTracker` → `reco_jobs`.

## Roles (`frontend/src/lib/adminNav.js` → `sidebarFor()`)
- **admin** — Dashboard · Colonel AI · Brands · Agents · Users · Tasks · Chats · Plans · Feedback · Integrations · Assignments (sees all brands + analytics)
- **accountant** — brand-scoped Dashboard/Agents/Tracker + base (Colonel AI · Meetings · Tasks · Feedback · Integrations · Zoho Books · Plans · Switch brands)
- **developer** — Colonel AI · Feedback · Plans

## ⛔ Golden rules (non-negotiable)
1. **Never touch AWS/EC2** (deploy, restart, migration, DB op) without explicit human permission this session — see [AWS.md](AWS.md).
2. **Back up before editing any shared file** — `cp -a <file> <file>.bak-$(date +%Y%m%d-%H%M%S)`. Prefer new files + minimal additive changes.
3. **DB persistence is fire-and-forget** — never change agent logic when adding DB/UI; DB writes are additive only.
4. **RLS: no client-settable bypass.** The old `SET LOCAL app.bypass_rls='true'` escape hatch was removed by hardening (`db-restructure/005_harden_rls.sql`) — only the real `postgres` superuser bypasses RLS now (migrations/admin ops). App queries are scoped by `app.brand_id`; use `IS NOT DISTINCT FROM` for nullable month/year.
5. **Keep reco logic dynamic** — no hardcoded sheet names, row indices, or tax-ledger names. Preserve the Remark 1 / Remark 2 split (Remark 3 = multistate only). `.xls`→`.xlsx` in-memory conversion must never break.
6. **Restart the right process** after a change — backend `pm2 restart` / `node server.js`; Python re-run `server.py`; frontend `npx craco build`/`start`. If login/data looks broken, check the backend first.

## Quick facts
- **33 agents.** ⚠️ Agent + brand IDs are now **random UUIDv4** (old sequential `d0000000-…`/`b0000000-…` were regenerated for security). Any `d0000000-…-00NN` reco-UUID table is **LEGACY** — query the `agents` table or read the mapping (`db-restructure/008-agent-id-remap.json` / `009-brand-id-remap.json`; new ids live in `AgentDispatch.RECO_ID_TO_TYPE` + the seeder).
- **`app.js` must mount EVERY route group** (a stripped mount list makes API calls return the SPA HTML → empty UI). See [ARCHITECTURE.md](ARCHITECTURE.md) for the verified list.
- **GSTR-3B Tally Entry** has a standalone tool (`gstr3bController.js` → `/api/brands/:brandId/gstr3b/*`, self-creates `gstr3b_coa_master/vt_master/runs`) surfaced via `Gstr3bTallyWorkspace.jsx`.
- **`chauhandhaval932@gmail.com` is an ACCOUNTANT** (owner of the gated Statutory / Zoho Books / Composio features — do **not** make it admin).
- **Bootstrap:** `cd db-seed && ./restore.sh` (single unified dump = real AWS prod data; creates `colonel_app` role + RLS) → `cp new-backend/.env.example new-backend/.env` (unified mode is the default, no flag needed) → `npm install` → start engine (8765), backend (8001), frontend (3000). No per-brand restore. See [README.md](README.md) / [SERVERS.md](SERVERS.md).
- **Admin analytics** read `reco_jobs` (kept by the nightly purge); heavy `*_results` rows are transient. See [DATABASES.md](DATABASES.md).

## Recent changes
- **Unified DB (17 → 1)** is now the default — one `colonel_agent_accountant` DB with `brand_id` + RLS replaces the old `colonel-master` + 16 per-brand DBs; in unified mode `createBrandDatabase`/`migrateAllBrands` are no-ops.
- **Random-UUID hardening** — agent + brand IDs regenerated from the sequential `d0000000…`/`b0000000…` scheme; `app.bypass_rls` client escape hatch removed.
- **Agent consolidation** — sales / order-cycle / invoice agents + invoice tool consolidated into **"Invoice Process"**.
- **Workflow manager** — AI draft (GenSpark) + multi-file input + admin **"Manage Workflows"**.
- **Brand switcher** added on sales agents; **"Other"** brand data is ephemeral (not persisted).
- Fixes — order-cycle amount, statutory bounce; **admin Database explorer** page; **PDF → Bank** now has an OCR fallback.

## Only invoke skills when genuinely needed
Don't burn tokens on low-probability skill invocations; use them when the task clearly calls for it.
