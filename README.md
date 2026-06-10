# Colonel Automation — RECO Branch

AI-powered reconciliation platform for Indian CA firms. Five production-ready agents that automate the manual work accountants do today — upload files, run matching, download Excel.

---

## Agents

| Agent | What It Does | Input Files |
|---|---|---|
| **GSTR-2B vs Books** | Matches GSTR-2B portal data against Purchase Register + Debit Note Register. Invoice-level Remark 1 (match status) + Remark 2 (mismatches, RCM, duplicates) + Vendor Summary tab | GSTR-2B (Excel/JSON/CSV), Purchase Register, Debit Note Register |
| **GSTR-2B vs Books (Multi-State)** | Same as above for brands with multiple GSTINs/states. Adds Remark 3 for cross-state booking errors | GSTR-2B × N states, Purchase Register × N states, Debit Note × N states |
| **GSTR-3B Journal Entry** | Parses a GSTR-3B file and generates ready-to-post Tally journal entries — ITC credit transfer, output liability set-off, RCM | GSTR-3B (Excel) |
| **Universal Bank Statement** | Brand-agnostic classifier that maps any Indian bank statement to your Tally chart of accounts. Learns from accountant corrections over time | Bank Statement (Excel), Ledger Master/Chart of Accounts (Tally export, optional after first upload) |
| **GSTR-1 vs Books** | Matches GSTR-1 outward supplies against Tally sales register + Amazon RTF data | Tally Sales Export, GSTR-1 File, Amazon RTF (optional) |

---

## RECO Agent UUIDs

Stable UUIDs seeded by `seed.js` — never change. Every agent opens at `/brands/:brandId/agents/:agentId`.

| Agent | DB name | UUID |
|---|---|---|
| GSTR-2B vs Books | `gstr_2b_books` | `d0000000-0000-0000-0000-000000000001` |
| GSTR-2B vs Books (Multi-State) | `gstr_2b_books_multistate` | `d0000000-0000-0000-0000-000000000002` |
| GSTR-3B Tally Entry | `gstr_3b_tally_entry` | `d0000000-0000-0000-0000-000000000003` |
| Universal Bank Statement | `universal_bank_statement` | `d0000000-0000-0000-0000-000000000004` |
| GSTR-1 vs Books | `gstr_1_vs_books` | `d0000000-0000-0000-0000-000000000005` |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, React Router v6, TailwindCSS, Recharts, craco |
| Backend | Node.js + Express, PostgreSQL (pg), JWT auth, Multer, ExcelJS |
| Reco Engine | Python 3, pandas, openpyxl, xlrd, thefuzz (HTTP server on port 8765) |
| Database | PostgreSQL — one database per brand, Row Level Security enforced |

---

## Project Structure

```
colonel-automation/
├── frontend/                              ← React 18 SPA (port 3000)
│   └── src/pages/accountant/
│       ├── AgentDispatch.jsx              ← routes /agents/:agentId → correct RECO workspace
│       ├── BrandAgentsInventory.jsx       ← agent card grid (all agents)
│       ├── RecoWorkspace.jsx              ← upload + run + results for GST/bank agents
│       ├── RecoMultiStateWorkspace.jsx    ← multi-state file slot UI
│       ├── RecoJobDashboard.jsx           ← job analytics + row-level results + download
│       └── Gstr1Dashboard.jsx            ← GSTR-1 results inline view
│
├── new-backend/                           ← Node.js / Express API (port 8001)
│   ├── server.js                          ← entry point — auto-seeds agents + runs migrations
│   ├── seed.js                            ← RECO delta seeder (run once after merging)
│   ├── seeders/01-reco-agents.js          ← inserts 5 RECO agents + brand assignments
│   ├── .env.example                       ← copy to .env, fill in credentials
│   ├── scripts/
│   │   └── classify.py                    ← Universal Bank Statement CLI (subprocess)
│   └── src/
│       ├── controllers/
│       │   ├── recoController.js          ← upload handler, Python proxy, DB saves, Layer 0
│       │   ├── bankCorrectionsController.js ← corrections CRUD (Layer 0)
│       │   └── dashboardController.js     ← job history + analytics
│       └── db/migrations/001_reco_tables.sql ← 8 tables, auto-runs on backend start
│
└── reco-engine/                           ← Python Reco Engine (port 8765)
    ├── server.py                          ← HTTP server entry point
    ├── requirements.txt                   ← pip install -r this
    └── recon/
        ├── gstr_2b_books.py              ← GSTR-2B vs Books core engine (1000+ lines)
        ├── gstr_2b_books_multistate.py   ← multi-state engine (imports from gstr_2b_books)
        ├── gstr_3b_tally_entry.py        ← GSTR-3B → Tally journal entries
        ├── gstr_3b_vs_2b.py             ← GSTR-3B vs 2B comparison
        ├── gstr_1_vs_books.py           ← GSTR-1 vs Books engine
        ├── bank_reco.py                 ← bank statement classifier
        ├── core.py                      ← shared dataclasses
        └── parsers.py                   ← generic xlsx/xls/csv/json reader
```

---

## Prerequisites

- Node.js 18+
- Python 3.10+
- PostgreSQL 14+ (running locally)

---

## Setup — Adding RECO to an Existing colonel-automation DB

> This is the common case — you already have users, brands, and sales agents in the DB.
> The seeder only adds the 5 new RECO agents and never touches existing data.

```bash
# 1. Pull this branch
git pull origin RECO

# 2. Backend — install new deps + run the RECO seeder
cd new-backend
npm install
node seed.js

# Expected output:
# [DB] ✅ Connected to colonel-master
# [SEED] ✅ RECO agents + brand assignments done
# [MIGRATE] ✅ colonel-stroom — hero tables ready
# [MIGRATE] ✅ colonel-koparo — hero tables ready
# ... one line per brand ...
# Done. The 5 RECO agents are now active for all brands.

# 3. Install Python deps + start the reco engine (keep it running)
cd ../reco-engine
pip install -r requirements.txt
python3 server.py

# 4. Restart the Node backend (picks up new routes + runs migrations on start)
cd ../new-backend
node server.js

# 5. Restart frontend
cd ../frontend
npm install
npx craco start
```

---

## Setup — Fresh Install (No Existing DB)

```bash
# 1. Clone
git clone <repo-url>
cd colonel-automation

# 2. Configure
cd new-backend
cp .env.example .env
# Edit .env — set DB_PASSWORD and JWT_SECRET at minimum
npm install

# 3. Create PostgreSQL databases
psql -U postgres -c 'CREATE DATABASE "colonel-master"'
psql -U postgres -c 'CREATE DATABASE "colonel-stroom"'
psql -U postgres -c 'CREATE DATABASE "colonel-koparo"'
# Add one per brand — see list in seeders/01-reco-agents.js

# 4. Python deps
cd ../reco-engine
pip install -r requirements.txt

# 5. Start all three (3 separate terminals)

# Terminal 1 — Python reco engine (must stay running for GST agents)
cd reco-engine && python3 server.py

# Terminal 2 — Node backend (auto-creates all tables + seeds agents on first run)
cd new-backend && node server.js

# Terminal 3 — Frontend
cd frontend && npm install && npx craco start
```

> On first start, `server.js` automatically creates all 8 reco tables and seeds the 5 RECO
> agent rows. You do NOT need to run `node seed.js` on a completely fresh install.
> Run `seed.js` only when merging RECO onto an existing DB that already has users/brands.

---

## Environment Variables

Copy `new-backend/.env.example` → `new-backend/.env`:

| Variable | Required | Default | Description |
|---|---|---|---|
| `DB_PASSWORD` | ✅ | — | PostgreSQL password |
| `JWT_SECRET` | ✅ | — | Any long random string |
| `DB_HOST` | — | `localhost` | PostgreSQL host |
| `DB_PORT` | — | `5432` | PostgreSQL port |
| `DB_USER` | — | `postgres` | PostgreSQL user |
| `DB_NAME` | — | `colonel-master` | Master DB name |
| `PORT` | — | `8001` | Backend port |
| `PYTHON_RECO_URL` | — | `http://localhost:8765` | Python reco engine URL |
| `BANK_CLASSIFIER_PATH` | — | `scripts/classify.py` (project-relative) | Path to classify.py |
| `RECO_TEMP_DIR` | — | `output/temp` (project-relative) | Temp dir for reco jobs |
| `RECO_OUTPUT_DIR` | — | `output/reco` (project-relative) | Excel output dir |
| `LEDGER_MASTER_DIR` | — | `output/ledgers` (project-relative) | Saved CoA files per brand |
| `MAX_CONCURRENT_RECO` | — | `8` | Max parallel reco jobs |

---

## Verify Everything is Running

```bash
curl http://localhost:8001/api/health   # → {"status":"ok","env":"development"}
curl http://localhost:8765/             # → HTML (Python engine up)
# Frontend at http://localhost:3000
```

---

## Key API Endpoints

```
POST /api/reco/upload                                    ← upload files + run agent
GET  /api/reco/export/:jobId                             ← download Excel output
GET  /api/reco/ledger-status/:brandId                    ← check if CoA saved for brand

GET  /api/dashboard/reco/job/:jobId?brandId=xxx          ← job metadata + row-level results
GET  /api/dashboard/reco/history/:brandId                ← last 50 jobs for brand

POST /api/bank-reco/corrections/:brandId                 ← save inline UI corrections
POST /api/bank-reco/corrections/:brandId/upload-excel    ← upload reviewed Excel (CHANGES col)
POST /api/bank-reco/corrections/:brandId/upload-output   ← bulk-import from previous output

POST /api/auth/login                                     ← JWT login
GET  /api/brands/my-brands                               ← brands assigned to logged-in user
GET  /api/brands/:brandId/agents                         ← agents for a brand
```

---

## Frontend Routing

All agents (RECO and sales) use the same URL pattern:

```
/brands/:brandId/agents                          ← agent card grid
/brands/:brandId/agents/:agentId                 ← AgentDispatch → correct workspace
/brands/:brandId/reco/:agentType/results/:jobId  ← job results / analytics
```

`AgentDispatch.jsx` maps UUID → workspace:
- `d0000000-...-000000000002` → `RecoMultiStateWorkspace`
- Any other RECO UUID → `RecoWorkspace` (with `agentTypeProp`)
- Sales agent UUID → `AgentWorkspace`

---

## Database Schema (per-brand PostgreSQL)

Auto-created on backend startup via `001_reco_tables.sql` (idempotent).

| Table | Purpose |
|---|---|
| `reco_jobs` | One row per agent run — agent type, file hash, row counts, Excel download ID |
| `bank_reco_results` | Bank statement rows — ledger, confidence (High/Medium/Low), corrected flag |
| `gstr_2b_results` | GSTR-2B vs Books invoice rows (also used by multi-state + 2A+2B agents) |
| `gstr_2a_2b_results` | 3-way reco rows |
| `gstr_3b_results` | GSTR-3B vs 2B rows |
| `gstr_1_results` | GSTR-1 vs Books rows |
| `gstr_3b_tally_results` | Tally journal entry rows |
| `bank_reco_corrections` | Per-brand narration → correct ledger corrections (Layer 0) |

Row Level Security on all tables — each brand's data is fully isolated.

---

## Universal Bank Statement — How the Learning Loop Works

```
Run 1: Upload bank statement + Chart of Accounts (Tally ledger export)
         → CoA saved to disk for this brand — auto-loads on all future runs
         → Layer 0: checks saved corrections first (instant High confidence)
         → Layer 1: CoA fuzzy match (thefuzz) → High ≥87 | Medium 72–86 | Low <72
         → Fallback: Suspense A/c

Accountant reviews results → corrects wrong ledger names → Save
         → Stored in bank_reco_corrections table

Run 2+: Upload only the bank statement (CoA loads automatically)
         → More Layer 0 hits → higher percentage of High confidence rows
         → Accuracy improves with every correction session
```

CoA files live at `new-backend/output/ledgers/<brandId>.xlsx` — gitignored, not committed.

---

## Troubleshooting

**5 RECO agents don't appear after pulling**
```bash
cd new-backend && node seed.js
# Then restart: node server.js
```

**GST agent fails — "Reconciliation engine is not running"**
```bash
cd reco-engine && python3 server.py
curl http://localhost:8765/   # must return HTML
```

**Universal Bank Statement fails**
- Python engine does NOT need to be running (uses subprocess, not HTTP)
- Check `new-backend/scripts/classify.py` exists
- Check backend logs for `[RECO-UNIVERSAL]` or `[RECO-CORRECTIONS]` lines

**`node seed.js` fails — DB connection error**
```bash
brew services list | grep postgresql   # macOS
# Ensure DB_PASSWORD and DB_USER are correct in new-backend/.env
```

**CoA not loading for Universal Bank Statement**
- First run: upload a multi-tab Excel (one tab = bank statement, other = Chart of Accounts)
- Or use the "Upload Ledger Master" button in the workspace
- Confirm in backend logs: `[RECO] Ledger master saved for brand ...`

**Migration errors on startup**
- All SQL uses `IF NOT EXISTS` — safe to restart; existing tables are skipped

---

## Demo Credentials

| Role | Email | Password |
|---|---|---|
| Admin | `chauhandhaval932@gmail.com` | `Admin@123` |
| Accountant | `priya@colonel.app` | `Accountant@123` |
| Accountant | `rahul@colonel.app` | `Accountant@123` |

---

## License

Private — Colonel Automation © 2025
