# CLAUDE.md — Colonel Reconciliation Suite

## What This Repo Is

RECO branch of `colonel-automation`. Adds **4 reconciliation agents** on top of the existing platform:

| Agent key | What it does |
|---|---|
| `gstr_2b_books` | GSTR-2B portal vs Purchase Register + Debit Note Register |
| `gstr_2b_books_multistate` | Same as above for brands with multiple GSTINs/states — adds Remark 3 |
| `gstr_3b_tally_entry` | Parses GSTR-3B → generates ready-to-post Tally journal entries |
| `universal_bank_statement` | Classifies any Indian bank statement against Tally chart of accounts |

The rest of the platform (sales agents, invoice agents, admin panel, CFO dashboards) is unchanged and lives in the same codebase.

---

## Servers & Ports

| Service | Port | Location | How to start |
|---|---|---|---|
| React Frontend | 3000 | `frontend/` | `cd frontend && npx craco start` |
| Node.js Backend | 8001 | `new-backend/` | `cd new-backend && node server.js` |
| Python Reco Engine | 8765 | `reco-engine/` | `cd reco-engine && python3 server.py` |
| PostgreSQL | 5432 | localhost | must be running before backend starts |

**All three must be running** for the RECO agents to work. The Python engine handles all GST agents. `universal_bank_statement` uses `classify.py` (subprocess) — does NOT need the Python engine.

---

## CRITICAL: After Merging This Branch — Do These 4 Steps

> If you already have the colonel-automation repo with users, brands, and sales agents set up, run these after pulling/merging:

```bash
# 1. Install new Node dependencies (safe to re-run)
cd new-backend && npm install

# 2. Run the RECO seeder — adds 4 agents to DB + creates reco tables on all brand DBs
#    ONLY touches agents table and brand_agents. Never modifies users/brands/existing agents.
cd new-backend && node seed.js

# 3. Install Python dependencies and start the reco engine
cd reco-engine
pip install -r requirements.txt
python3 server.py   # keep running — GST agents need this on port 8765

# 4. Restart the Node backend (picks up new routes + runs migrations automatically)
cd new-backend && node server.js

# 5. Restart the frontend
cd frontend && npm install && npx craco start
```

**If `node seed.js` succeeds** you will see:
```
[SEED] ✅ RECO agents + brand assignments done
[MIGRATE] ✅ colonel-stroom — hero tables ready
[MIGRATE] ✅ colonel-koparo — hero tables ready
... (one line per brand)
Done. The 4 RECO agents are now active for all brands.
```

**If the 4 agents don't appear in the UI** after this, check:
- `node seed.js` completed without error
- Backend is restarted (new routes need a fresh process)
- User's account has brands assigned (`brand_users` table)

---

## Key Files

| File | Purpose |
|---|---|
| `reco-engine/server.py` | Python HTTP server — handles all GST reco agents on port 8765 |
| `reco-engine/recon/gstr_2b_books.py` | Core GSTR-2B vs Books engine (1000+ lines) |
| `reco-engine/recon/gstr_2b_books_multistate.py` | Multi-state engine — imports from gstr_2b_books.py |
| `reco-engine/recon/gstr_3b_tally_entry.py` | GSTR-3B → Tally journal entry generator |
| `reco-engine/recon/bank_reco.py` | Bank statement classifier |
| `reco-engine/requirements.txt` | Python deps: pandas, openpyxl, xlrd, thefuzz |
| `new-backend/scripts/classify.py` | Universal Bank Statement standalone CLI (subprocess, not HTTP) |
| `new-backend/seed.js` | RECO delta seeder runner — run once after merge |
| `new-backend/seeders/01-reco-agents.js` | Inserts 4 agent rows + brand assignments |
| `new-backend/src/controllers/recoController.js` | Upload handler, Python proxy, DB saves, Layer 0 corrections |
| `new-backend/src/controllers/bankCorrectionsController.js` | Corrections CRUD — `saveCorrections`, `uploadOutputExcel` |
| `new-backend/src/controllers/dashboardController.js` | Job history, analytics, `getJobById` |
| `new-backend/src/db/migrations/001_reco_tables.sql` | Idempotent SQL — all 8 reco tables. Runs on every backend startup |
| `frontend/src/pages/accountant/RecoSuite.jsx` | 4-agent card grid |
| `frontend/src/pages/accountant/RecoWorkspace.jsx` | Upload + run + results for all agents |
| `frontend/src/pages/accountant/RecoMultiStateWorkspace.jsx` | Multi-state file slot UI |
| `frontend/src/pages/accountant/RecoJobDashboard.jsx` | Job analytics + row-level results |

---

## Database Design

**One PostgreSQL DB per brand** — complete isolation via Row Level Security (RLS).

```
colonel-master        ← users, brands, brand_users, agents, brand_agents
colonel-stroom        ← reco_jobs, bank_reco_results, gstr_2b_results,
colonel-koparo          gstr_3b_tally_results, bank_reco_corrections, ...
...                     (8 tables, created by 001_reco_tables.sql)
```

### RLS — MUST read before writing any DB query

All 8 tables use `FORCE ROW LEVEL SECURITY`. Policy checks `app.brand_id` session variable.

```javascript
// ✅ Correct — bypass MUST be inside a transaction
await seq.transaction(async (t) => {
  await seq.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
  // your queries here
});

// ❌ Wrong — SET LOCAL outside transaction is a PostgreSQL no-op
await seq.query(`SET LOCAL app.bypass_rls = 'true'`);
await seq.query(`SELECT * FROM reco_jobs`);  // still blocked by RLS
```

### NULL-safe queries
```javascript
// ✅ Correct — month/year are nullable integers
WHERE month IS NOT DISTINCT FROM $3 AND year IS NOT DISTINCT FROM $4

// ❌ Wrong — NULL = NULL is false in PostgreSQL
WHERE month = $3 AND year = $4
```

### Reco tables (per brand DB)

| Table | Purpose |
|---|---|
| `reco_jobs` | One row per agent run — file hash, row counts, output file ID |
| `bank_reco_results` | Bank statement rows — confidence: High/Medium/Low |
| `gstr_2b_results` | GSTR-2B vs Books invoice rows |
| `gstr_2a_2b_results` | 3-way reco rows |
| `gstr_3b_results` | GSTR-3B vs 2B rows |
| `gstr_1_results` | GSTR-1 vs Books rows |
| `gstr_3b_tally_results` | Tally journal entry rows |
| `bank_reco_corrections` | Accountant corrections — narration → correct ledger |

---

## Universal Bank Statement — Corrections System (Layer 0)

The bank classifier has a learning loop. Every run applies saved corrections BEFORE the ML engine.

```
Upload bank statement
        │
        ▼
Layer 0: bank_reco_corrections table (per brand)
  Narration key found → use saved ledger → confidence = High (corrected = true)
  Not found → continue ↓
        │
        ▼
Layer 1: classify.py
  Rule-based (GST/TDS/EPF/salary/bank charges)
  → fuzzy match against Chart of Accounts (if saved for brand)
  Confidence: High ≥87  |  Medium 72–86  |  Low <72
        │
        ▼
Fallback: Suspense A/c (Low)
```

### Three ways corrections are saved to `bank_reco_corrections`

| Source | How | `source` value |
|---|---|---|
| Accountant edits a row in the results table and clicks Save | `POST /api/bank-reco/corrections/:brandId` | `'ui'` |
| Accountant uploads reviewed Excel (with CHANGES column) | `POST /api/bank-reco/corrections/:brandId/upload-excel` | `'excel'` |
| Accountant uploads a previous output file | `POST /api/bank-reco/corrections/:brandId/upload-output` | `'output_upload'` |

**Rule**: High confidence rows from classify.py are NEVER auto-saved to corrections. Only explicit accountant actions save to corrections.

### Chart of Accounts (CoA) Lock

When a brand uploads a CoA (Ledger Master) file, it is saved to disk at:
```
new-backend/output/ledgers/<brandId>.xlsx
```

On every future run for that brand, the saved CoA is auto-loaded — the accountant does not need to re-upload it. Uploading a new CoA overwrites the saved one (no duplicates).

The `GET /api/reco/ledger-status/:brandId` endpoint returns `{ hasLedger: true/false }` — the UI uses this to show "✓ Saved" in the Files panel.

---

## Reco Controller Flow

```
POST /api/reco/upload
  ├── universal_bank_statement
  │     └── subprocess: python3 classify.py --bank <file> --ledger <coa>
  │           └── Layer 0 corrections applied → save to bank_reco_results
  │
  └── all other agents
        └── axios POST to http://localhost:8765/api/reconcile
              └── response.data.results → save based on agent type:
                    GST_2B_FRONTEND_TYPES → gstr_2b_results
                    gstr_3b_tally_entry   → gstr_3b_tally_results
                    gstr_3b_vs_2b         → gstr_3b_results
                    gstr_2a_2b_books      → gstr_2a_2b_results
                    gstr_1_vs_books       → gstr_1_results
```

**DB saves are non-blocking** — wrapped in `setImmediate()`. Response sent to frontend immediately; DB write happens in background. Never delay the download response.

---

## Remark System (GSTR-2B vs Books)

| Column | Values | Rule |
|---|---|---|
| Remark 1 | `Matched` / `Showing in 2B but Not in Books` / `Showing in Books but Not in 2B` | Primary match status ONLY |
| Remark 2 | Tax mismatch / value mismatch / RCM / duplicate / date mismatch | Secondary observations |
| Remark 3 | Cross-state booking error | Multi-state engine ONLY — never set in single-state |

**Never mix secondary observations into Remark 1.**

---

## RecoJobDashboard Sub-Views

| `agent_type` | View Component |
|---|---|
| `bank_reco`, `universal_bank_statement` | `BankRecoView` — TXN Date, Description, Debit, Credit, Ledger, Confidence |
| `gstr_3b_vs_2b` | `Gst3bView` — ITC Type, Claimed, Available, Difference, Remark |
| `gstr_2b_books_multistate` | `GstMultistateView` — Supplier, GSTIN, Invoice #, Remark 1/2/3 |
| `gstr_3b_tally_entry` | `TallyEntryView` — S.No, Particulars, Debit ₹, Credit ₹ |
| all other GST | `GstInvoiceView` — Supplier, GSTIN, Invoice #, Date, Tax amounts, Remark 1/2 |

---

## Session Persistence (Frontend)

Results survive page refresh via sessionStorage. Key pattern:
```
reco_result_<agentType>_<effectiveBrandId>
```
Always use `effectiveBrandId` (from brand selector) not the URL param `brandId`.

---

## Adding a New Agent — Checklist

1. `reco-engine/recon/<agent>.py` — add engine logic
2. `reco-engine/server.py` — wire new route
3. `new-backend/src/controllers/recoController.js` — add to `RECO_TYPE_MAP` + DB save branch
4. `new-backend/src/controllers/dashboardController.js` — add to `RESULTS_TABLE_MAP`
5. `new-backend/src/db/migrations/001_reco_tables.sql` — add result table (idempotent)
6. `frontend/src/pages/accountant/RecoSuite.jsx` — add to `RECO_AGENTS` array
7. `frontend/src/pages/accountant/RecoWorkspace.jsx` — add to `AGENT_CONFIG` if custom file inputs
8. `frontend/src/pages/accountant/RecoJobDashboard.jsx` — add sub-view + `AGENT_META` entry

---

## Development Rules

1. **Never push to main branch** — RECO work stays on the `RECO` branch
2. **DB saves are non-blocking** — always `setImmediate` after response
3. **RLS bypass MUST be inside a `seq.transaction()`** — `SET LOCAL` outside a transaction is a no-op in PostgreSQL
4. **`IS NOT DISTINCT FROM`** for nullable `month`/`year` columns
5. **`toSqlDate()`** in `recoController.js` converts Python `"nan"` strings → `null` before INSERT — never skip this for date fields
6. **Never auto-save High confidence rows to `bank_reco_corrections`** — only UI edits, upload-excel, and upload-output write to corrections
7. **CoA files live on disk** at `new-backend/output/ledgers/<brandId>.xlsx` — not in DB
8. **`output/` and `output/ledgers/`** are gitignored — CoA files are per-deployment, not committed
9. **classify.py** is a subprocess (not HTTP) — the Python engine on 8765 is NOT involved in universal_bank_statement
10. **Python engine imports** use `from recon.<module>` (relative to `reco-engine/`) — do not revert to `from app.recon.<module>`
