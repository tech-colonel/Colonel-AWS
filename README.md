# Colonel Reconciliation Suite

AI-powered reconciliation platform for Indian CA firms. Four production-ready agents that automate the manual work accountants do today — upload files, run matching, download Excel.

---

## Agents

| Agent | What It Does | Input Files |
|---|---|---|
| **GSTR-2B vs Books** | Matches GSTR-2B portal data against Purchase Register + Debit Note Register. Invoice-level Remark 1 (match status) + Remark 2 (mismatches, RCM, duplicates) + Vendor Summary tab | GSTR-2B (Excel/JSON/CSV), Purchase Register, Debit Note Register |
| **GSTR-2B vs Books (Multi-State)** | Same as above for brands with multiple GSTINs/states. Adds Remark 3 for cross-state booking errors | GSTR-2B × N states, Purchase Register × N states, Debit Note × N states |
| **GSTR-3B Journal Entry** | Parses a GSTR-3B file and generates ready-to-post Tally journal entries — ITC credit transfer, output liability set-off, RCM | GSTR-3B (Excel) |
| **Universal Bank Statement** | Brand-agnostic classifier that maps any Indian bank statement to your Tally chart of accounts. Learns from accountant corrections over time | Bank Statement (Excel), Ledger Master/Chart of Accounts (Tally export, optional after first upload) |

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
├── frontend/                        ← React 18 SPA (port 3000)
│   └── src/pages/accountant/
│       ├── RecoSuite.jsx            ← 4-agent card grid
│       ├── RecoWorkspace.jsx        ← upload + run + results table
│       ├── RecoMultiStateWorkspace.jsx
│       └── RecoJobDashboard.jsx     ← job analytics + row-level results + download
│
├── new-backend/                     ← Node.js / Express API (port 8001)
│   ├── seed.js                      ← RECO delta seeder (run once — see setup below)
│   ├── seeders/01-reco-agents.js    ← inserts 4 RECO agents + brand assignments
│   ├── .env.example                 ← copy to .env, fill in credentials
│   └── src/
│       ├── controllers/
│       │   ├── recoController.js          ← upload handler, Python proxy, DB saves
│       │   ├── bankCorrectionsController.js ← corrections CRUD (Layer 0)
│       │   └── dashboardController.js     ← job history + analytics
│       └── db/migrations/001_reco_tables.sql ← auto-runs on backend start
│
├── reco-engine/                     ← Python Reco Engine (port 8765)
│   ├── server.py                    ← HTTP server entry point
│   ├── requirements.txt             ← pip install -r this
│   └── recon/
│       ├── gstr_2b_books.py         ← GSTR-2B vs Books (core engine)
│       ├── gstr_2b_books_multistate.py
│       ├── gstr_3b_tally_entry.py
│       ├── gstr_3b_vs_2b.py
│       ├── gstr_1_vs_books.py
│       ├── bank_reco.py
│       ├── core.py
│       └── parsers.py
│
└── new-backend/scripts/
    └── classify.py                  ← Universal Bank Statement CLI (subprocess)
```

---

## Prerequisites

- Node.js 18+
- Python 3.10+
- PostgreSQL 14+ (running locally)

---

## Setup

### If you already have the colonel-automation repo (base DB exists)

> This is the common case — you have users, brands, and sales agents already in the DB.
> The seeder only adds the 4 new RECO agents. It never touches your existing data.

```bash
# 1. Pull / merge this branch
git pull origin RECO   # or merge however your team does it

# 2. Backend — install any new deps + run the RECO seeder
cd new-backend
npm install
node seed.js           # adds 4 agents to DB + creates reco tables on all brand DBs

# Expected output from seed.js:
# [DB] ✅ Connected to colonel-master
# [SEED] ✅ RECO agents + brand assignments done
# [MIGRATE] ✅ colonel-stroom — hero tables ready
# [MIGRATE] ✅ colonel-koparo — hero tables ready
# ... one line per brand ...
# Done. The 4 RECO agents are now active for all brands.

# 3. Restart the backend (picks up new routes)
node server.js

# 4. Install Python dependencies and start the reco engine (NEW service — must keep running)
cd ../reco-engine
pip install -r requirements.txt
python3 server.py      # runs on port 8765 — needed for all GST agents

# 5. Restart frontend
cd ../frontend
npm install            # safe to re-run
npx craco start        # port 3000
```

That's it. The 4 RECO agents will appear in the UI for every brand.

---

### Fresh install (no existing DB)

```bash
# 1. Clone the repo
git clone <repo-url>
cd colonel-automation

# 2. Backend
cd new-backend
cp .env.example .env   # fill in: DB_PASSWORD, JWT_SECRET (others can stay as default)
npm install

# 3. Create PostgreSQL databases
# Connect to psql and run:
psql -U postgres -c 'CREATE DATABASE "colonel-master"'
psql -U postgres -c 'CREATE DATABASE "colonel-stroom"'
psql -U postgres -c 'CREATE DATABASE "colonel-koparo"'
# ... one per brand (see list in seeders/01-reco-agents.js)

# 4. Sync master tables + seed data
node server.js &    # starts backend, auto-creates reco tables via migration
node seed.js        # inserts the 4 RECO agents into colonel-master
pkill -f "node server.js"  # stop temp backend

# 5. Start everything properly (3 terminals)

# Terminal 1 — Python reco engine
cd reco-engine
pip install -r requirements.txt
python3 server.py

# Terminal 2 — Node backend
cd new-backend
node server.js

# Terminal 3 — Frontend
cd frontend
npm install
npx craco start
```

---

## Environment Variables

Copy `new-backend/.env.example` to `new-backend/.env` and fill in:

| Variable | Required | Default | Description |
|---|---|---|---|
| `DB_PASSWORD` | ✅ | — | Your PostgreSQL password |
| `JWT_SECRET` | ✅ | — | Any long random string |
| `DB_HOST` | — | `localhost` | PostgreSQL host |
| `DB_PORT` | — | `5432` | PostgreSQL port |
| `DB_USER` | — | `postgres` | PostgreSQL user |
| `PORT` | — | `8001` | Backend port |
| `PYTHON_RECO_URL` | — | `http://localhost:8765` | Python engine URL |
| `MAX_CONCURRENT_RECO` | — | `8` | Max parallel reco jobs |

Invoice webhook variables (`<BrandName>_invoice_url`, `<BrandName>_invoice_sheet`) are only needed if you use the invoice agent.

---

## Running All Three Services

```bash
# Terminal 1 — Python reco engine (MUST start before running GST agents)
cd reco-engine && python3 server.py

# Terminal 2 — Node backend
cd new-backend && node server.js

# Terminal 3 — Frontend
cd frontend && npx craco start
```

Verify all three are up:
```bash
curl http://localhost:8001/api/health   # → {"status":"ok"}
curl http://localhost:8765/             # → HTML page (engine running)
# Frontend auto-opens at http://localhost:3000
```

---

## Key API Endpoints

```
POST /api/reco/upload                                    ← upload files + run agent
GET  /api/reco/export/:jobId                             ← download Excel output
GET  /api/reco/ledger-status/:brandId                    ← check if CoA saved for brand

GET  /api/dashboard/reco/job/:jobId?brandId=xxx          ← job + row-level results
GET  /api/dashboard/reco/history/:brandId                ← last 50 jobs for brand

POST /api/bank-reco/corrections/:brandId                 ← save inline UI corrections
POST /api/bank-reco/corrections/:brandId/upload-excel    ← upload reviewed Excel (CHANGES col)
POST /api/bank-reco/corrections/:brandId/upload-output   ← bulk-import from previous output

POST /api/auth/login                                     ← JWT login
GET  /api/brands                                         ← brands for current user
```

---

## Database Schema (per-brand PostgreSQL)

All tables are created automatically by `001_reco_tables.sql` on backend startup (idempotent — safe to re-run).

| Table | Purpose |
|---|---|
| `reco_jobs` | One row per agent run — agent type, file hash, row counts, Excel download ID |
| `bank_reco_results` | Bank statement rows — ledger name, confidence (High/Medium/Low) |
| `gstr_2b_results` | GSTR-2B vs Books invoice-level rows |
| `gstr_2a_2b_results` | 3-way reco rows |
| `gstr_3b_results` | GSTR-3B vs 2B comparison rows |
| `gstr_1_results` | GSTR-1 vs Books rows |
| `gstr_3b_tally_results` | Tally journal entry rows |
| `bank_reco_corrections` | Accountant corrections — narration → correct ledger (Layer 0) |

Row Level Security is enforced on all tables. Each brand's data is completely isolated.

---

## Universal Bank Statement — How the Learning Loop Works

```
Run 1: Upload bank statement + Chart of Accounts (Tally ledger export)
         → CoA saved to disk for this brand (auto-loads on future runs)
         → classify.py matches narrations against CoA via fuzzy matching
         → Results: High / Medium / Low confidence

Accountant reviews results, corrects wrong ledger names → Save to DB
         → Corrections stored in bank_reco_corrections table

Run 2: Upload only bank statement (CoA auto-loads from disk)
         → Layer 0: previously corrected narrations → instantly High confidence
         → Remaining rows → classify.py + CoA fuzzy matching
         → Accuracy improves with every correction
```

The Chart of Accounts file is saved per brand at `new-backend/output/ledgers/<brandId>.xlsx`. This folder is gitignored — it lives on the server, not in the repo.

---

## Troubleshooting

**4 RECO agents don't appear in the UI**
- Run `node seed.js` in `new-backend/` — the agent rows may not be in the DB yet
- Restart the backend after the seeder completes

**GST agent fails with "Reconciliation engine is not running"**
- Start the Python engine: `cd reco-engine && python3 server.py`
- Verify it's up: `curl http://localhost:8765/` should return HTML

**Universal Bank Statement fails**
- Python engine does NOT need to be running for this agent
- Check `new-backend/scripts/classify.py` exists
- Check the backend log for `[CLASSIFY]` lines

**`node seed.js` fails with DB connection error**
- PostgreSQL must be running: `pg_ctl status` or `brew services list | grep postgresql`
- Check `new-backend/.env` has correct `DB_PASSWORD` and `DB_USER`

**Migration errors on startup**
- The migration SQL (`001_reco_tables.sql`) is idempotent — safe to re-run
- If a table already exists it is skipped, not recreated

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
