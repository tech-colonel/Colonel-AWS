# 🪖 Colonel-AWS

**Full-stack automation platform for an Indian CA firm** — GST reconciliation, sales MIS, CFO
dashboards, compliance & statutory trackers, a Zoho Books mirror, a bank-statement classifier, and
an AI copilot. This repo is a **complete, runnable superset of the live production app** (the
port-3000 `colonel-automation` / AWS-EC2 deployment), shipped with a snapshot of the real database
so you can stand up an exact working copy.

> **New here? Read this top to bottom** — it walks you from clone → running app. Deep dives live in
> the focused docs (see [Documentation map](#-documentation-map)). For AI assistants working in this
> repo, start at **[CLAUDE.md](CLAUDE.md)**.

---

## 📑 Table of contents
1. [What it is](#-what-it-is)
2. [Tech stack](#-tech-stack)
3. [Architecture at a glance](#-architecture-at-a-glance)
4. [Repository tree](#-repository-tree)
5. [Quick start (clone → running app)](#-quick-start-clone--running-app)
6. [Environment variables](#-environment-variables)
7. [The database & the seed data](#-the-database--the-seed-data)
8. [Agent catalog (33 agents)](#-agent-catalog)
9. [Feature map](#-feature-map)
10. [Roles & login](#-roles--login)
11. [Request flow (end to end)](#-request-flow-end-to-end)
12. [Documentation map](#-documentation-map)
13. [What's NOT in the repo](#-whats-not-in-the-repo)

---

## 🎯 What it is
Automates the work accountants do by hand — GST reconciliation, sales MIS, invoice processing, CFO
dashboards, compliance workflows — behind a clean, role-based web app. One backend serves many D2C /
e-commerce **brands** out of a **single unified database**, isolated per-tenant by a `brand_id`
column + PostgreSQL Row-Level Security.

This **Colonel-AWS** repo is the **superset**: it merges the live AWS production app + all local
features into one tree, and ships committed database dumps (`db-seed/`) of the real data. Clone it,
restore the DB, start three services, and you have a byte-for-byte working copy of production.

---

## 🧱 Tech stack
| Layer | Technology |
|---|---|
| **Frontend** | React 18, React Router v6, TailwindCSS, Recharts, `@xyflow/react`, **craco** — port **3000** |
| **Backend** | Node.js + Express, **Sequelize** over PostgreSQL, JWT auth (bcryptjs), Multer, ExcelJS — port **8001** |
| **Reco engine** | Python 3 **stdlib** HTTP server, pandas / openpyxl / xlrd / thefuzz — port **8765** |
| **Database** | PostgreSQL 16 — **single unified DB** `colonel_agent_accountant` (`brand_id` + Row-Level Security); app connects as non-superuser `colonel_app` |
| **AI / external** | Gemini + Claude (bank classifier + PDF→Bank fallback), Zoho Books, Fireflies, Google Drive/Sheets, n8n, Shopify |
| **Deploy** | AWS EC2 (t3.small, Mumbai) → served publicly via ngrok; `pm2` process manager |

---

## 🏛 Architecture at a glance
```
┌─────────────────────┐   axios    ┌───────────────────────┐  axios proxy  ┌─────────────────────┐
│  React SPA (craco)   │ ─────────▶ │  Express REST API      │ ────────────▶ │ Python Reco Engine   │
│  frontend/  :3000    │ ◀───────── │  new-backend/ :8001    │ ◀──────────── │ stdlib http :8765    │
│  Tailwind + xyflow   │   JSON     │  Sequelize + pg + JWT  │  Excel/JSON   │ pandas / openpyxl    │
└─────────────────────┘            └──────────┬────────────┘               └─────────────────────┘
                                              │ pg (5432)
                                    ┌─────────▼──────────┐   external: Zoho · Fireflies · n8n ·
                                    │ PostgreSQL          │            Google Drive/Sheets · Shopify
                                    │ single unified DB   │
                                    │ colonel_agent_...   │
                                    │ brand_id + RLS      │
                                    └────────────────────┘
```
On EC2 the Node backend also serves the compiled React `build/` — no separate frontend server.
Full breakdown → **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## 🌳 Repository tree
```
Colonel-AWS/
├── frontend/                     ← React 18 SPA (craco, :3000)
│   └── src/{pages,components,lib,context,hooks}
├── new-backend/                  ← Express API (:8001) — entry: server.js
│   ├── server.js                 ← boots, runs migrations, seeds agents, app.listen(8001)
│   ├── seed.js · seeders/        ← agent + assignment seeders
│   ├── scripts/classify.py       ← Universal Bank Statement CLI (subprocess)
│   └── src/{controllers,routes,services,models,db,middleware}
├── reco-engine/                  ← Python reco engine (:8765)
│   ├── server.py                 ← stdlib HTTP; POST /api/reconcile dispatch on reco_type
│   └── recon/*.py                ← per-agent reconciliation logic
├── db-seed/                      ← ★ committed DB snapshot + restore script
│   ├── dumps/colonel_agent_accountant.dump  ← single unified DB (pg_dump custom format)
│   └── restore.sh                ← one command to rebuild the DB + colonel_app role
├── README.md · CLAUDE.md · AWS.md · SERVERS.md · RECO.md · DATABASES.md · ARCHITECTURE.md
└── start-reco.sh · nightly-data-purge.sh · .gitignore
```

---

## 🚀 Quick start (clone → running app)
**Prerequisites:** Node.js 18+, Python 3.10+, PostgreSQL 16 running locally.

```bash
# 1. Clone
git clone https://github.com/tech-colonel/Colonel-AWS.git
cd Colonel-AWS

# 2. Restore the real database (single unified DB + creates the colonel_app role)
cd db-seed && ./restore.sh          # uses postgres/postgres @ 127.0.0.1:5432 by default
cd ..

# 3. Backend config + deps
cd new-backend
cp .env.example .env                # then edit: DB_PASSWORD, JWT_SECRET, (optional) API keys
                                    # unified DB is the default — no flag needed
npm install
cd ..

# 4. Python reco-engine deps
cd reco-engine && pip install -r requirements.txt && cd ..

# 5. Start all three services (three terminals)
#    Terminal 1 — Python reco engine (must stay running for GST agents)
cd reco-engine && python3 server.py
#    Terminal 2 — Node backend (runs migrations on boot, then listens on 8001)
cd new-backend && node server.js
#    Terminal 3 — Frontend
cd frontend && npm install && npx craco start     # opens http://localhost:3000
```
Then log in (see [Roles & login](#-roles--login)). Ports/process management → **[SERVERS.md](SERVERS.md)**.

**Verify:**
```bash
curl http://localhost:8001/api/health   # {"status":"ok",...}
curl http://localhost:8765/             # HTML → engine up
# Frontend → http://localhost:3000
```

---

## 🔐 Environment variables
Copy `new-backend/.env.example` → `new-backend/.env`. Minimum to run: `DB_PASSWORD`, `JWT_SECRET`.

| Variable | Required | Purpose |
|---|---|---|
| `DB_PASSWORD` | ✅ | PostgreSQL password |
| `JWT_SECRET` | ✅ | Any long random string (login tokens) |
| `DB_HOST` / `DB_PORT` / `DB_USER` | — | default `localhost` / `5432` / `postgres` (superuser for admin ops) |
| `UNIFIED_DB_NAME` / `DB_APP_USER` / `DB_APP_PASSWORD` | — | default `colonel_agent_accountant` / `colonel_app` / `colonel_app_local` — the unified DB + non-superuser role the app runs as |
| `USE_UNIFIED_DB` | — | unified is the default (`!== 'false'`); set `=false` only to fall back to the legacy per-brand path |
| `PYTHON_RECO_URL` | — | default `http://localhost:8765` |
| `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | optional | bank classifier + PDF→Bank LLM fallback |
| Zoho / Google / n8n keys | optional | Zoho Books mirror, Drive/Sheets, invoice webhooks |
| `SEED_USER_PASSWORD` | optional | password used by `seed-user.js` (was hardcoded; now env-driven) |

> The core app + reco agents run with just DB + JWT set. Gemini/Anthropic/Zoho/Google keys unlock
> those specific features. Full DB/connection detail → **[DATABASES.md](DATABASES.md)**.

---

## 🗄 The database & the seed data
This repo ships the **real database** as a single `pg_dump` snapshot,
`db-seed/dumps/colonel_agent_accountant.dump` — the whole app in **one unified DB** (users, brands,
agents, assignments, Zoho/compliance/statutory data **plus** every brand's reco jobs, ledgers, bank
corrections, GSTR-3B and sales data), each row carrying a `brand_id` and protected by RLS. Rebuild
with:
```bash
cd db-seed && ./restore.sh
```
This creates the non-superuser `colonel_app` role, **DROP+CREATE**s `colonel_agent_accountant` from
the dump, and restores schema + data + RLS policies + `brand_id` defaults. Unified mode is the
default — no flag needed. Schema, RLS, retention, and the superset agent-UUID notes →
**[DATABASES.md](DATABASES.md)**.

---

## 🤖 Agent catalog
**33 agents** total. Reco + Bank agents run through the Python engine (`reco_type` dispatch);
sales/marketplace agents run in Node and persist to per-brand dynamic tables. Deep dive → **[RECO.md](RECO.md)**.

**GST Reconciliation**
- `gstr_2b_books` — GSTR-2B vs Purchase Register + Debit Note Register
- `gstr_2b_books_multistate` — multi-state variant (adds Remark 3, cross-state)
- `gstr_1_vs_books` — GSTR-1 outward vs Tally sales + Amazon RTF
- `einvoice_reco` — E-Invoice Register (B2B/SEZ/DE + CDNR) vs Books  *(UUID `…-008`)*
- `gstr_3b_tally_entry` — GSTR-3B → ready-to-post Tally journal entries *(standalone tool: multi-file, COA + voucher-type masters, run history)*

**Bank & Finance**
- `universal_bank_statement` — any Indian bank statement → Tally CoA (learning loop; Gemini/Claude assist)
- `pdf_bank_extract` — bank statement PDF → Excel (deterministic + Claude fallback)

**Marketplace MIS / Sales** (Node, per-brand tables)
- Amazon, Blinkit, Cread, FirstCry, Flipkart, JioMart, Limeroad, Mirrow, Myntra, Nykaa, Shopify, Zepto
- Settlement-Amazon, Total-Sales-Analyzer, Amazon MTR Consolidator
- `zepto_receivables` — Zepto receivables tracker (Drive-fed)  *(UUID `…-010`)*
- Order-Cycle (Shopify), Invoice Process (consolidated single invoice agent; n8n → Google Sheet)

---

## 🧩 Feature map
Beyond agents, the platform includes:
- **CFO dashboards** — brand financial analytics
- **Colonel AI** — chat copilot over reconciliations/ledgers (chat/conversation/mcp controllers)
- **Meetings** — Fireflies meeting notes, per-user
- **Zoho Books** — read-only mirror of the firm's Zoho org (vendors/customers/vouchers/CoA/items)
- **Compliance Tracker** — per-brand monthly workflow board (Kanban / List / Calendar)
- **Statutory Compliance** — 15 filing types, per-brand register (owner-gated)
- **Composio Marketplace** — 1000+ connectable apps on the Integrations page
- **Plans / Feedback / Tasks** — admin plan builder, feedback loop, task board
- **Admin analytics** — real-time cross-brand usage (fed by `reco_jobs`; sales runs recorded via `agentRunTracker`)

> Statutory / Zoho / Composio are **owner-gated to `chauhandhaval932@gmail.com` (an accountant)** —
> don't change that user's role to admin.

### Recent changes
- **Single unified DB** — moved from `colonel-master` + per-brand DBs to one `colonel_agent_accountant` (`brand_id` + RLS, app runs as `colonel_app`); unified is the default.
- **Random-UUID hardening** — old sequential agent/brand IDs regenerated as random UUIDs.
- New **sales / order-cycle / invoice** agents; the invoice agents consolidated into one **Invoice Process**.
- **Workflow** feature — AI-drafted workflows via GenSpark + multi-file input + admin **Manage Workflows**.
- **Brand switcher** on the sales agents.
- Ephemeral **"Other" brand** data with a **Reset**.
- **Shopify Order-Cycle** amount fix; **Statutory** bounce fix.
- Admin **Database** explorer page.
- **PDF→Bank** OCR fallback.

---

## 👤 Roles & login
Four roles: **admin**, **accountant**, **brand_executive**, **developer** (sidebar from
`frontend/src/lib/adminNav.js` → `sidebarFor()`). Admin sees all brands + analytics; accountant is
brand-scoped; brand_executive is scoped to its own brand; developer sees Colonel AI / Feedback / Plans.

Seed logins (users ship in the DB as **bcrypt hashes — no plaintext passwords are committed**).
Passwords are set by the gitignored provisioning scripts (`seed-accountants.js`, `seed-user.js`)
using the `<name-before-dot>123` convention:
| Role | Email | Password |
|---|---|---|
| Admin | `admin@colonel.app` | `<set via seed script>` |
| Admin | `dhaval.colonel@gmail.com` | `<set via seed script>` |
| **Accountant (feature owner)** | `chauhandhaval932@gmail.com` | `<set via seed script>` |

---

## 🔄 Request flow (end to end)
```
Browser (RecoWorkspace / Gstr3bTallyWorkspace / sales workspace)
   │  multipart upload (files + agent type)
   ▼
Node backend  new-backend/src/controllers/*      ──┐ fire-and-forget DB save (setImmediate)
   POST /api/reco/upload  |  /api/brands/:id/gstr3b/upload  │  → unified Postgres (brand_id + RLS)
   │  axios proxy, field reco_type                          ▼
   ▼                                              reco_jobs + *_results  (admin analytics feed)
Python engine :8765  POST /api/reconcile
   dispatch on reco_type → recon/<agent>.py → build Excel
   │
   ▼  GET /api/jobs/{id}/export.xlsx → download
```
Reco internals → [RECO.md](RECO.md) · persistence → [DATABASES.md](DATABASES.md).

---

## 📚 Documentation map
| Doc | Read it when… |
|---|---|
| **[CLAUDE.md](CLAUDE.md)** | You're an AI assistant / new dev — lean index: overview, stack, tree, flow, golden rules, doc pointers |
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | You need the full app map — every page, route mount, controller, service, agent |
| **[SERVERS.md](SERVERS.md)** | Starting/restarting services, ports, pm2, health checks, fresh-machine bring-up |
| **[RECO.md](RECO.md)** | Working on the Python reco engine or any agent (2B/2A-2B/3B/GSTR-1/E-Invoice/bank/GSTR-3B Tally/Zepto) |
| **[DATABASES.md](DATABASES.md)** | Touching the DB — schema, RLS, migrations, per-brand tables, seed/restore |
| **[AWS.md](AWS.md)** | Deploying/operating the live EC2 site — deploy flow, crons, backups, the Nov 7 2026 deadline |

---

## 🚫 What's NOT in the repo
Standard for any project — regenerate/provide these locally:
- `node_modules/` — run `npm install` (frontend + new-backend)
- `new-backend/.env` — copy from `.env.example` and fill in secrets (DB, JWT, API keys)
- `new-backend/output/ledgers/*.xlsx` — per-deployment Chart-of-Accounts files
- Real third-party API keys (Gemini, Anthropic, Zoho, Google service account) — supply your own

Everything else — full source, seeders, and the real database snapshot — is here.

---
*Private — Colonel Automation. Superset of the live production platform.*
