# CLAUDE.md — Colonel Reconciliation Suite

## What This Repo Is

RECO branch of `colonel-automation`. Adds **5 reconciliation agents** on top of the existing platform:

| Agent key | What it does |
|---|---|
| `gstr_2b_books` | GSTR-2B portal vs Purchase Register + Debit Note Register |
| `gstr_2b_books_multistate` | Same as above for brands with multiple GSTINs/states — adds Remark 3 |
| `gstr_3b_tally_entry` | Parses GSTR-3B → generates ready-to-post Tally journal entries |
| `universal_bank_statement` | Classifies any Indian bank statement against Tally chart of accounts |
| `gstr_1_vs_books` | GSTR-1 outward supplies vs Tally sales register + Amazon RTF data |

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

> This is the **port-3000 / production** app. Main & RECO logic is developed/tested first in
> **Colonel Full (port 3001)**, then ported here. Reco logic lives in BOTH `recon/` trees — keep in
> sync. See the root `Colonel Full/CLAUDE.md` for the 3-app workflow.

---

## Tech Stack

- **Frontend** (3000): React 18 + CRA via **craco**, Tailwind, axios (`src/lib/api.js`).
- **Backend** (8001): Node + Express, **Sequelize** over PostgreSQL, JWT auth (**bcryptjs**),
  serves `frontend/build` as static (single-origin for tunnels).
- **DB**: master `colonel-master` (users, brands, agents, brand_users, brand_agents) + **one DB per
  brand** (`reco_jobs` + result tables, RLS-protected).
- **Reco engine** (8765): pure Python 3 stdlib HTTP, pandas/openpyxl/xlrd. `universal_bank_statement`
  runs `new-backend/scripts/classify.py` as a subprocess (not via 8765).
- **Tunnel**: ngrok permanent URL (default) or cloudflared quick tunnel.

---

## Sharing the RECO link (tunnel)

- `./start-reco.sh` → starts reco engine (8765) + backend (8001) + **ngrok permanent URL**
  `https://eggbeater-thesis-crowbar.ngrok-free.dev`. Backend serves `frontend/build`, so ONE tunnel
  serves UI + API on one origin. Use after a Mac restart.
- ngrok free shows a one-time "Visit Site" interstitial. App XHR bypasses it via the
  `ngrok-skip-browser-warning` header (set in `src/lib/api.js`); the first page navigation can't, so
  accountants click "Visit Site" once. **Blank page** = an extension blocking `cdn.ngrok.com` → use incognito.
- No-interstitial alternative: `cloudflared tunnel --url http://localhost:8001` (but its
  `*.trycloudflare.com` URL changes on every restart).

---

## Runtime config — NO build-time env vars (IMPORTANT)

- Backend URL and RECO-only mode resolve at **runtime by hostname**, never baked into the build:
  - `src/lib/api.js` `resolveApiUrl()`: `localhost` → `http://localhost:8001`; any other host (a
    tunnel) → same-origin (`''`). **Never set `REACT_APP_BACKEND_URL`** in the build — a baked
    `localhost` breaks the tunnel (Chrome blocks public-origin → loopback) and CRA empty-value
    precedence is unreliable.
  - `BrandAgentsInventory.jsx` `isRecoOnly()`: `localhost` → show ALL agents (dev on :3000); tunnel
    host → show ONLY the 5 RECO agents (accountant view). Override via `REACT_APP_RECO_ONLY` in `.env.local`.
- `frontend/.env` + `.env.production` are comment-only (no `REACT_APP_*`) and gitignored.
- After ANY frontend change, run `npx craco build` so the tunnel serves it; dev (:3000) uses live source.
- **Service-worker gotcha**: `index.html` loads `assets.emergent.sh/.../emergent-main.js`, which
  registers a SW that caches the app and **survives hard-refresh**. After a rebuild, test in incognito
  (or DevTools → Application → Service Workers → Unregister).

---

## Accountant & brand provisioning

- Brand access is gated by the **`brand_users`** table; `GET /api/brands/my-brands` returns only a
  user's assigned brands (admin sees all). Per-brand agent runnability = **`brand_agents`** rows.
- **Password convention**: `<name-before-dot>123` (e.g. `jayesh.colonel@gmail.com` → `jayesh123`).
- Provision via LOCAL idempotent Node scripts that reuse `src/models/master` + `bcryptjs`
  (`seed-accountants.js`, `add-prashant.js`, `update-users.js`). They hold plaintext passwords →
  **gitignored, never pushed**.
- **Create a brand fully**: `createBrandDatabase()` (config/database.js) + `migrateBrandDb()`
  (db/migrate.js → the 8 reco tables) + assign the 5 RECO agents via `BrandAgent`. A brand is unusable
  without its per-brand DB + reco tables + agent rows. New-brand `db_name` = `colonel_<slug>`
  (underscores); legacy brands use hyphens (`colonel-stroom`).
- Renaming a brand's `name` is safe (FKs use `brand_id`/`db_name`) EXCEPT invoice-agent `.env` webhook
  keys (keyed by brand name) — irrelevant for RECO-only accountants.

### Current DB state (snapshot — June 2026; passwords follow the convention, set via local scripts)

- **Brands (15):** Plenaire, Stroom, Koparo, Nestroots, M Brands, Biglilpeople, Urban Plant, Zaydn,
  D'Chicha, Shumee Toys, Shumee Playroom, Flo Mattress, Amama, Flipside, Nailinit.
  *(Renamed: Zayden→Zaydn, DChica→D'Chicha; Shumee→Shumee Toys + new Shumee Playroom;
  new brands: Flo Mattress, Amama, Flipside, Nailinit.)*
- **Accountants → brands:** jayesh→Koparo · varshita→M Brands, Urban Plant · amjad→Shumee Toys,
  Shumee Playroom, Biglilpeople · vidhi→Zaydn · pankajrathore→D'Chicha · kunal→Flo Mattress, Amama ·
  riya→Nestroots · shrikant→Stroom · manisha→Flipside · akshat→Stroom · prashant→Koparo, Nestroots,
  Biglilpeople, Zaydn, Shumee Toys, Shumee Playroom, Nailinit.

---

## Changelog — Updates (June 2026)

- Frontend backend-URL + RECO-only mode now resolve at **runtime by hostname** (removed build-time env vars).
- Backend serves `frontend/build`; a single tunnel (ngrok permanent URL / cloudflared) serves UI + API.
- `start-reco.sh` one-command startup; accountant **share-link is live**.
- Accountant + brand provisioning via local idempotent scripts; `brand_users` gating; `<name>123` passwords.
- New/renamed brands with full per-brand DB + reco tables + 5 RECO agents (see DB snapshot).
- GST Reco sheet freeze-pane removed in `reco-engine/server.py` (was pinning the April summary row).

---

## CRITICAL: After Merging This Branch — Do These 4 Steps

> If you already have the colonel-automation repo with users, brands, and sales agents set up, run these after pulling/merging:

```bash
# 1. Install new Node dependencies (safe to re-run)
cd new-backend && npm install

# 2. Run the RECO seeder — adds 5 RECO agents to DB + creates reco tables on all brand DBs
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
Done. The 5 RECO agents are now active for all brands.
```

**If the 5 RECO agents don't appear in the UI** after this, check:
- `node seed.js` completed without error
- Backend is restarted (new routes need a fresh process)
- User's account has brands assigned (`brand_users` table)

---

## RECO Agent UUIDs

These stable UUIDs are seeded by `seed.js` and never change. Every RECO agent workspace is
now accessed at `/brands/:brandId/agents/:agentId` — the same pattern as sales agents.
`AgentDispatch.jsx` maps UUID → workspace component.

| Agent | DB name | UUID |
|---|---|---|
| GSTR-2B vs Books | `gstr_2b_books` | `d0000000-0000-0000-0000-000000000001` |
| GSTR-2B vs Books (Multi-State) | `gstr_2b_books_multistate` | `d0000000-0000-0000-0000-000000000002` |
| GSTR-3B Tally Entry | `gstr_3b_tally_entry` | `d0000000-0000-0000-0000-000000000003` |
| Universal Bank Statement | `universal_bank_statement` | `d0000000-0000-0000-0000-000000000004` |
| GSTR-1 vs Books | `gstr_1_vs_books` | `d0000000-0000-0000-0000-000000000005` |

> **Frontend routing**: `/brands/:brandId/agents/:agentId` → `AgentDispatch` → RECO workspace or `AgentWorkspace`
> Results deep-links still use `/brands/:brandId/reco/:agentType/results/:jobId`

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
| `new-backend/seeders/01-reco-agents.js` | Inserts 5 RECO agent rows + brand assignments |
| `frontend/src/pages/accountant/AgentDispatch.jsx` | Routes `/agents/:agentId` → RECO workspace or AgentWorkspace based on UUID |
| `new-backend/src/controllers/recoController.js` | Upload handler, Python proxy, DB saves, Layer 0 corrections |
| `new-backend/src/controllers/bankCorrectionsController.js` | Corrections CRUD — `saveCorrections`, `uploadOutputExcel` |
| `new-backend/src/controllers/dashboardController.js` | Job history, analytics, `getJobById` |
| `new-backend/src/db/migrations/001_reco_tables.sql` | Idempotent SQL — all 8 reco tables. Runs on every backend startup |
| `frontend/src/pages/accountant/RecoSuite.jsx` | RECO agent card grid |
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
11. **No build-time backend URL / RECO flag** — both resolve at runtime by hostname (see *Runtime config*). Never reintroduce `REACT_APP_BACKEND_URL` into the build.
12. **GST Reco sheet freeze**: `reco-engine/server.py` GST Reco sheet must use `freeze_panes = None` (stacked multi-section sheet — freezing pinned the April summary). Restart the engine after edits.
13. **Logic is ported FROM Colonel Full (port 3001)** — develop/verify main & RECO logic there first, then port the same change here. Keep both `recon/` trees in sync.
