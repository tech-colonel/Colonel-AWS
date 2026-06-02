# CLAUDE.md — Colonel Reconciliation Suite

## What This Repo Is

RECO branch of `colonel-automation`. Contains **4 reconciliation agents** for Indian CA firms:
- **GSTR-2B vs Books** (`gstr_2b_books`)
- **GSTR-2B vs Books Multi-State** (`gstr_2b_books_multistate`)
- **GSTR-3B Journal Entry** (`gstr_3b_tally_entry`)
- **Universal Bank Statement** (`universal_bank_statement`)

No admin panel. No sales agents. No CFO dashboards. Only the 4 reco tools.

---

## Servers & Ports

| Service | Port | Location |
|---|---|---|
| React Frontend | 3000 | `frontend/` |
| Node.js Backend | 8001 | `new-backend/` |
| Python Reco Engine | 8765 | external `recon/` folder |
| PostgreSQL | 5432 | localhost |

### Start All Three

```bash
# 1. Backend
cd new-backend && node server.js

# 2. Python Reco Engine
cd <recon-folder> && python3 server.py

# 3. Frontend
cd frontend && npx craco start
```

---

## Key Files

| File | Purpose |
|---|---|
| `new-backend/src/controllers/recoController.js` | Proxy to Python engine, DB persistence, corrections Layer 0 |
| `new-backend/src/controllers/dashboardController.js` | Job history, analytics, `getJobById` with `RESULTS_TABLE_MAP` |
| `new-backend/src/controllers/bankCorrectionsController.js` | Correction store: `saveCorrections`, `uploadCorrectionsExcel`, `uploadOutputExcel` |
| `new-backend/src/db/migrations/001_reco_tables.sql` | Idempotent — creates all reco tables on startup |
| `scripts/classify.py` | Universal Bank Statement standalone CLI classifier |
| `frontend/src/pages/accountant/RecoSuite.jsx` | 4-agent card grid — 3 sections: GST Reconciliation, Journal Entry, Bank & Finance |
| `frontend/src/pages/accountant/RecoWorkspace.jsx` | Upload + run + results table (GSTR-2B, GSTR-3B Tally Entry, Universal Bank) |
| `frontend/src/pages/accountant/RecoMultiStateWorkspace.jsx` | Multi-state file slot UI |
| `frontend/src/pages/accountant/RecoJobDashboard.jsx` | Job analytics + download — sub-views per agent type |

---

## Database Design

**One PostgreSQL DB per brand** — complete isolation via Row Level Security (RLS).

```
colonel-master      ← users, brands, brand_users
colonel-stroom      ← per-brand reco tables
colonel-koparo      ← per-brand reco tables
```

**RLS bypass** — MUST be inside a transaction:
```javascript
await seq.transaction(async (t) => {
  await seq.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
  // queries here
});
```

**Idempotency** — `reco_jobs` partial unique index: `(brand_id, agent_type, month, year, file_hash) WHERE file_hash IS NOT NULL`. Duplicate run → `updateOutputFileId()` only.

**NULL-safe** — `IS NOT DISTINCT FROM` for nullable `month`/`year` columns.

---

## Reco Controller Flow

```
POST /api/reco/upload
  ├── universal_bank_statement → classify.py CLI (subprocess)
  │     └── parse Excel → apply Layer 0 corrections → save to bank_reco_results
  └── all other agents → proxy to Python engine (port 8765)
        └── response.data.results → save based on recoType:
              ├── GST_2B_FRONTEND_TYPES → gstr_2b_results
              ├── gstr_3b_tally_entry   → gstr_3b_tally_results
              └── gstr_3b_vs_2b, gstr_2a_2b_books, gstr_1_vs_books → own tables
```

DB saves are **fire-and-forget** (`setImmediate`) — response never blocked.

**Duplicate path for gstr_3b_tally_entry**: deletes old tally rows, re-inserts fresh — no unique constraint on that table so safe to replace.

---

## Session Persistence (Frontend)

Both `RecoWorkspace` and `RecoMultiStateWorkspace` have two dedicated effects:

```javascript
// 1. Mount-only restore — runs once per mount
useEffect(() => {
  const cached = sessionStorage.getItem(cacheKey);
  if (cached) setResult(JSON.parse(cached));
}, []);

// 2. Result-change saver — always stays in sync
useEffect(() => {
  if (result) sessionStorage.setItem(cacheKey, JSON.stringify(result));
}, [result]);
```

Key: `reco_result_<agentType>_<effectiveBrandId>`. Reset button clears it.

---

## RecoJobDashboard Sub-Views

| `agent_type` | View Component | Columns |
|---|---|---|
| `bank_reco`, `universal_bank_statement` | `BankRecoView` | TXN Date, Description, Debit, Credit, Ledger, Confidence |
| `gstr_3b_vs_2b` | `Gst3bView` | ITC Type, Claimed, Available, Difference, Remark |
| `gstr_2b_books_multistate` | `GstMultistateView` | Supplier, GSTIN, Invoice #, Remark 1, Remark 2, Remark 3 |
| `gstr_3b_tally_entry` | `TallyEntryView` | S.No, Particulars, Debit (₹), Credit (₹) |
| all other GST | `GstInvoiceView` | Supplier, GSTIN, Invoice #, Date, Taxable Value, IGST, CGST, SGST, Remark 1, Remark 2 |

---

## Remark System (GSTR-2B vs Books)

| Column | Values |
|---|---|
| Remark 1 | `Matched` · `Showing in 2B but Not in Books` · `Showing in Books but Not in 2B` |
| Remark 2 | Tax/value mismatches, RCM, duplicates, date mismatch |
| Remark 3 | Multi-state only — cross-state booking error (amber `FF6600`) |

**Rule**: Remark 1 = primary match status ONLY. Never put secondary observations in Remark 1.

---

## Corrections Loop (Universal Bank Statement)

```
classify.py → all rows (High/Medium/Low) → DB (bank_reco_results)
                                                     ↑
Layer 0: bank_reco_corrections ←── UI edits / Excel upload / Upload Previous Output
                      ↓
          Applied on every run before response sent
```

Three correction sources: `'ui'`, `'excel'` (CHANGES col), `'output_upload'` (High rows from past output).

---

## Adding a New Agent

1. **Python engine**: add `recon/<agent>.py` + wire in `server.py`
2. **recoController**: add to `RECO_TYPE_MAP`; add DB save branch if needed
3. **dashboardController**: add to `RESULTS_TABLE_MAP`
4. **Migration SQL**: add result table to `001_reco_tables.sql`; run on all brand DBs
5. **RecoSuite**: add to `RECO_AGENTS` array with correct `category`
6. **RecoWorkspace**: add to `AGENT_CONFIG` if it needs custom file inputs
7. **RecoJobDashboard**: add sub-view component + `AGENT_META` entry

---

## Development Rules

1. **Never push to main branch**
2. DB saves are **non-blocking** — `setImmediate` after response
3. **RLS bypass MUST be inside a transaction**
4. **`IS NOT DISTINCT FROM`** for nullable month/year
5. **`toSqlDate()`** converts Python `"nan"` → `null` before INSERT
6. **Session cache key**: always use `effectiveBrandId` not URL `brandId` for navigate
7. **View Analytics button**: navigate with `effectiveBrandId || brandId` so analytics queries the correct brand DB
