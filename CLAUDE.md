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
- **DB** — PostgreSQL 16, `colonel-master` + 16 per-brand DBs, Row-Level Security
- **External** — Gemini + Claude, Zoho Books, Fireflies, Google Drive/Sheets, n8n, Shopify
- **Deploy** — AWS EC2 (t3.small, Mumbai) via ngrok; pm2

## Tree (high level)
```
frontend/      React SPA (:3000)          — src/{pages,components,lib,context,hooks}
new-backend/   Express API (:8001)        — server.js · seed.js · seeders/ · src/{controllers,routes,services,models,db,middleware} · scripts/classify.py
reco-engine/   Python reco (:8765)        — server.py · recon/*.py
db-seed/       DB snapshots + restore.sh  — dumps/*.dump (master + 16 brand DBs)
docs           README · CLAUDE · AWS · SERVERS · RECO · DATABASES · ARCHITECTURE
```

## Flow (one line)
Browser → `POST /api/reco/upload` (Node, `recoController`) → axios proxy `POST /api/reconcile` (Python
`:8765`, dispatch on `reco_type`) → `recon/<agent>.py` builds Excel → download; **fire-and-forget**
`setImmediate` DB save writes `reco_jobs` + `*_results` to the per-brand DB (admin-analytics feed).
Sales agents run in Node → `bulkCreate` to per-brand dynamic tables + `agentRunTracker` → `reco_jobs`.

## Roles (`frontend/src/lib/adminNav.js` → `sidebarFor()`)
- **admin** — Dashboard · Colonel AI · Brands · Agents · Users · Tasks · Chats · Plans · Feedback · Integrations · Assignments (sees all brands + analytics)
- **accountant** — brand-scoped Dashboard/Agents/Tracker + base (Colonel AI · Meetings · Tasks · Feedback · Integrations · Zoho Books · Plans · Switch brands)
- **developer** — Colonel AI · Feedback · Plans

## ⛔ Golden rules (non-negotiable)
1. **Never touch AWS/EC2** (deploy, restart, migration, DB op) without explicit human permission this session — see [AWS.md](AWS.md).
2. **Back up before editing any shared file** — `cp -a <file> <file>.bak-$(date +%Y%m%d-%H%M%S)`. Prefer new files + minimal additive changes.
3. **DB persistence is fire-and-forget** — never change agent logic when adding DB/UI; DB writes are additive only.
4. **RLS bypass must be inside a `sequelize.transaction()`** (`SET LOCAL app.bypass_rls='true'`) — outside a transaction it's a no-op. Use `IS NOT DISTINCT FROM` for nullable month/year.
5. **Keep reco logic dynamic** — no hardcoded sheet names, row indices, or tax-ledger names. Preserve the Remark 1 / Remark 2 split (Remark 3 = multistate only). `.xls`→`.xlsx` in-memory conversion must never break.
6. **Restart the right process** after a change — backend `pm2 restart` / `node server.js`; Python re-run `server.py`; frontend `npx craco build`/`start`. If login/data looks broken, check the backend first.

## Quick facts
- **33 agents.** Reco agent UUIDs: `einvoice_reco = d0000000-…-008`, `zepto_receivables = d0000000-…-010` (zepto moved off 008 so einvoice matches AWS).
- **`app.js` must mount EVERY route group** (a stripped mount list makes API calls return the SPA HTML → empty UI). See [ARCHITECTURE.md](ARCHITECTURE.md) for the verified list.
- **GSTR-3B Tally Entry** has a standalone tool (`gstr3bController.js` → `/api/brands/:brandId/gstr3b/*`, self-creates `gstr3b_coa_master/vt_master/runs`) surfaced via `Gstr3bTallyWorkspace.jsx`.
- **`chauhandhaval932@gmail.com` is an ACCOUNTANT** (owner of the gated Statutory / Zoho Books / Composio features — do **not** make it admin).
- **Bootstrap:** `db-seed/restore.sh` → `.env` from `.env.example` → `npm install` → start engine (8765), backend (8001), frontend (3000). See [README.md](README.md) / [SERVERS.md](SERVERS.md).
- **Admin analytics** read `reco_jobs` (kept by the nightly purge); heavy `*_results` rows are transient. See [DATABASES.md](DATABASES.md).

## Only invoke skills when genuinely needed
Don't burn tokens on low-probability skill invocations; use them when the task clearly calls for it.
