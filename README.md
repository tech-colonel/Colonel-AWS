# Colonel Reconciliation Suite

AI-powered reconciliation platform for Indian CA firms. Four production-ready agents that automate the manual work accountants do today — upload files, run matching, download Excel.

---

## Agents

| Agent | What It Does | Input Files |
|---|---|---|
| **GSTR-2B vs Books** | Matches GSTR-2B portal data against Purchase Register + Debit Note Register. Invoice-level Remark 1 (match status) + Remark 2 (mismatches, RCM, duplicates) + Vendor Summary tab | GSTR-2B (Excel/JSON/CSV), Purchase Register, Debit Note Register |
| **GSTR-2B vs Books (Multi-State)** | Same as above for brands with multiple GSTINs/states. Runs N state pairs simultaneously, adds Remark 3 for cross-state booking errors | GSTR-2B × N states, Purchase Register × N states, Debit Note × N states |
| **GSTR-3B Journal Entry** | Parses a GSTR-3B file and generates ready-to-post Tally journal entries — ITC credit transfer, output liability set-off, and RCM | GSTR-3B (Excel) |
| **Universal Bank Statement** | Brand-agnostic classifier that maps any Indian bank statement to your Tally chart of accounts. Learns from accountant corrections over time | Bank Statement (Excel), Ledger Master (Tally export) |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, React Router v6, TailwindCSS, Recharts, shadcn/ui |
| Backend | Node.js + Express, PostgreSQL (pg), JWT auth, Multer, ExcelJS |
| Reco Engine | Python 3, pandas, openpyxl, xlrd (standalone HTTP server on port 8765) |
| Database | PostgreSQL — one database per brand, Row Level Security enforced |

---

## Project Structure

```
colonel-automation/
├── frontend/                        ← React 18 SPA (port 3000)
│   └── src/
│       ├── pages/accountant/
│       │   ├── RecoSuite.jsx              ← 4-agent card grid (3 sections)
│       │   ├── RecoWorkspace.jsx          ← upload + run + results table
│       │   ├── RecoMultiStateWorkspace.jsx ← multi-state file slots
│       │   └── RecoJobDashboard.jsx       ← analytics + download
│       ├── context/AuthContext.jsx
│       └── components/layout/DashboardLayout.jsx
│
├── new-backend/                     ← Node.js / Express API (port 8001)
│   └── src/
│       ├── controllers/
│       │   ├── recoController.js              ← proxy to Python engine + DB save
│       │   ├── dashboardController.js         ← job history + analytics
│       │   └── bankCorrectionsController.js   ← correction store (Layer 0)
│       ├── db/migrations/001_reco_tables.sql  ← idempotent, runs on startup
│       └── routes/
│
└── scripts/
    └── classify.py                  ← Universal Bank Statement standalone CLI
```

**Python Reco Engine** (runs separately on port 8765):
```
recon/
├── server.py                         ← HTTP server entry point
├── core.py                           ← NormalizedInvoice, MatchResult dataclasses
├── parsers.py                        ← .xlsx/.xls/.csv/.json reader
├── gstr_2b_books.py                  ← GSTR-2B vs Books engine
├── gstr_2b_books_multistate.py       ← Multi-State engine
├── gstr_3b_tally_entry.py            ← Tally Journal Entry generator
└── bank_reco.py                      ← Bank statement classifier
```

---

## Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Python 3.10+ with: `pandas openpyxl xlrd thefuzz`

---

## Setup & Running

### 1. PostgreSQL

```sql
CREATE DATABASE "colonel-master";
CREATE DATABASE "colonel-stroom";   -- one per brand
```

### 2. Backend

```bash
cd new-backend
cp .env.example .env    # set DB credentials, PORT=8001, JWT_SECRET
npm install
node server.js          # auto-runs DB migrations on startup
```

### 3. Python Reco Engine

```bash
pip install pandas openpyxl xlrd thefuzz
cd <path-to-recon-folder>
python3 server.py       # listens on port 8765
```

### 4. Frontend

```bash
cd frontend
npm install
npx craco start         # opens on port 3000
```

---

## Key API Endpoints

```
POST /api/reco/upload                                   ← upload files + run agent
GET  /api/reco/export/:jobId                            ← download Excel output

GET  /api/dashboard/reco/job/:jobId?brandId=xxx         ← job + row-level results
GET  /api/dashboard/reco/history/:brandId               ← last 50 jobs for brand

POST /api/bank-reco/corrections/:brandId                ← save inline corrections
POST /api/bank-reco/corrections/:brandId/upload-excel   ← upload reviewed Excel
POST /api/bank-reco/corrections/:brandId/upload-output  ← bulk-import High rows as corrections

POST /api/auth/login                                    ← JWT login
GET  /api/brands                                        ← brands for current user
```

---

## Database Schema (per-brand PostgreSQL)

Migrations run automatically on backend startup (`001_reco_tables.sql` — idempotent).

| Table | Purpose |
|---|---|
| `reco_jobs` | One row per agent run — agent type, file hash, row counts, output file ID |
| `bank_reco_results` | Bank statement classifications (High / Medium / Low confidence) |
| `gstr_2b_results` | Invoice-level GSTR-2B vs Books reconciliation rows |
| `gstr_3b_tally_results` | Journal entry rows from GSTR-3B Tally Entry agent |
| `bank_reco_corrections` | Accountant corrections — narration → correct ledger (Layer 0) |

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
