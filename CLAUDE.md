# 🪖 CLAUDE.md — Colonel-AWS (index for AI assistants)

> ## 🚨 AWS2 IS THE DEFAULT AWS — read it before ANY infra work
> **📍 File path: `/Users/dhavalchauhan/Colonel Full/AWS2.md`** (i.e. `../../AWS2.md` from this repo —
> it lives one level ABOVE the repo and is **not tracked in git**, so a fresh clone will not have it).
> **AWS2.md is the single source of truth for the live site** — full mapping, security hardening,
> deploy, and rollback. Read it first; treat anything below that contradicts it as historical.
>
> | | Current (AWS **#2** — DEFAULT) | Old (AWS #1 — **STOPPED**) |
> |---|---|---|
> | URL | `https://agent.accountant` | `eggbeater-thesis-crowbar.ngrok-free.dev` (ngrok, retired) |
> | Account | `679930074502` | `364503394269` |
> | IP / size | `13.127.171.66` · t3.large · Mumbai `ap-south-1` | `43.205.60.250` · t3.small |
> | SSH | `ssh -i ~/.ssh/colonel2-key.pem ubuntu@13.127.171.66` | — |
> | CLI profile | `colonel2` | — |
>
> **Latest AMI (rollback):** **`ami-07e1584aec7fd0db9`** (`colonel-prod-2-invoice-8brands-20260804`,
> `--no-reboot`, 2026-08-04) — full live box: 8 brands live on Invoice Process + sales/GSTR-1 backend +
> the proper frontend build. Older Node-20 rollback: `ami-0a41e4da9e52b6db9`. DB dumps in `~/backups/`.
> Full rollback table in `../../AWS2.md`.
>
> **Serving path:** nginx (`:80/:443`) → backend `:8001` → `reco-engine` `:8765`; unified DB
> `colonel_agent_accountant`. **App root on the box is `/opt/colonel` and is NOT a git checkout** —
> it is rsync-deployed, so drift accumulates in BOTH directions. Deploy named files only and
> checksum-compare against the box first; never rsync a whole directory (a wholesale sync has
> already nearly reverted two production-only fixes). **ngrok is retired.** Never operate the old
> account without asking.

> **Live frontend bundle (2026-08-04):** the live frontend is now a **proper build from `main`** —
> bundle **`main.5a329a2d.js`** (11 brands live incl. **Nailinit**; delete-invoice route + brand-PAN checkpoint active) — **NOT**
> hot-patched anymore. All Invoice Process per-brand
> maintenance / Shumee-Toys message / Google-Drive-Folder button / "Processing X of N" wording now
> live in `frontend/src/pages/accountant/InvoiceAgentWorkspace.jsx` **source**, so a rebuild reproduces
> the live UI (no more white-off). ⚠️ The hash **changes on every frontend deploy** — get the current
> one with `curl -s https://agent.accountant/ | grep -o 'main\.[a-f0-9]*\.js'`. Deploy = build from
> `main` → `rsync -az --delete frontend/build/` to `/opt/colonel/frontend/build/` (backup `build/` first).

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
> | **`../../AWS2.md`** | 🟢 **CURRENT live infra — READ FIRST for anything touching AWS.** agent.accountant, account #2, nginx/HTTPS, security hardening, deploy + rollback. Absolute path: `/Users/dhavalchauhan/Colonel Full/AWS2.md` |
> | **[AWS.md](AWS.md)** | ⚠️ **HISTORICAL** — the OLD ngrok box (now stopped). Deploy flow, crons, backups. Superseded by `AWS2.md`; cross-check before trusting any IP/account/URL here |

---

## What this repo is
Full end-to-end automation platform for an **Indian CA firm** managing many D2C / e-commerce brands:
GST reconciliation, sales MIS, CFO dashboards, compliance & statutory trackers, Zoho Books mirror,
bank classifier, and an AI copilot — behind a clean, role-based web app. **This repo is a runnable
superset of the live production app**, shipped with a snapshot of the real database (`db-seed/`).

## Overview & tech stack
- **Frontend** — React 18 + craco, Tailwind, Recharts, `@xyflow/react` — **:3000** (`frontend/`)
- **Backend** — Node/Express + Sequelize + JWT — **:8001** (`new-backend/`, entry `server.js`). **Node 24** (`.nvmrc` = 24, `engines.node >=24`); AWS runs `v24.18.0`, dev `v24.15.0`
- **Reco engine** — Python 3 stdlib HTTP, pandas/openpyxl — **:8765** (`reco-engine/`). AWS runs the **system Python 3.12** — do NOT upgrade it (`apt` depends on it); use a venv if a newer one is ever needed
- **DB** — PostgreSQL 16, **single unified DB `colonel_agent_accountant`** (default), brands isolated by a `brand_id` column + Row-Level Security; app connects as non-superuser `colonel_app`. Legacy per-brand DBs are an escape hatch (`USE_UNIFIED_DB=false`). See [DATABASES.md](DATABASES.md).
- **External** — Gemini + Claude, Zoho Books, Fireflies, Google Drive/Sheets, n8n, Shopify
- **Deploy** — AWS EC2 **t3.large** (Mumbai, account `679930074502`) at **`https://agent.accountant`**, nginx + pm2. **ngrok is retired.** rsync to `/opt/colonel` (not a git checkout) — see `../../AWS2.md`

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
1. **Never touch AWS/EC2** (deploy, restart, migration, DB op) without explicit human permission this session — see **`../../AWS2.md`** (`/Users/dhavalchauhan/Colonel Full/AWS2.md`) for the live box; [AWS.md](AWS.md) is the old, stopped one.
1b. **Deploy named files, never whole directories.** `/opt/colonel` is rsync-deployed and drifts in both directions. Checksum-compare each file against the box (`md5sum` there vs `git show HEAD:<path> | md5 -q` here) before overwriting, and re-audit with `rsync -rcn` after.
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
