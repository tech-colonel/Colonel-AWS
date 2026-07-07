# 🐍 RECO.md — Reconciliation Engine & Agent Inventory (colonel-automation)

> Reconciliation logic + the full agent inventory for **colonel-automation** — the port-3000 / port-8001 app served **live on AWS EC2**. This repo is the **superset**: it carries every reco agent, including three that are absent from the sandbox (`einvoice_reco`, the standalone GSTR-3B Tally Entry tool, and `zepto_receivables`).
>
> Companion docs: [README.md](README.md) · [CLAUDE.md](CLAUDE.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [AWS.md](AWS.md) · [SERVERS.md](SERVERS.md) · [DATABASES.md](DATABASES.md).
> Deep GSTR-2B-vs-Books edge-case reference (Pass 1–5 pipeline, color codes, invariants): see `RECO CLAUDE.md`.

---

## Reconciliation data flow (upload → Excel + DB)

```
 Browser (RecoWorkspace / RecoMultiStateWorkspace / Gstr3bTallyWorkspace)
        │  multipart upload (files + reco_type / agent)
        ▼
 Node backend (8001)   recoController.js  runReco()          ──┐  fire-and-forget DB save
   POST /api/reco/run                                          │  (setImmediate) → per-brand
        │  RECO_TYPE_MAP: frontend key → engine reco_type      │  Postgres tables (see DATABASES.md)
        │  _activeRecoJobs gate → 429 if ≥ MAX_CONCURRENT_RECO │
        │  axios/FormData proxy                                ▼
        ▼                                            reco_jobs + <agent>_results
 Python engine (8765)  POST /api/reconcile   ── dispatch on multipart field reco_type
   _RECO_SEMAPHORE (503 if busy)
        │
        ▼
   recon/<agent>.py  ── parse → normalize → match (Pass 1–5) → build workbook
        │
        ▼
   in-memory JOBS[id]  ──▶ GET /api/jobs/{id}/export.xlsx  ──▶ download to browser
```

Two flows **bypass the 8765 engine**:

- **`universal_bank_statement`** → `runReco()` runs `new-backend/scripts/classify.py` as a **subprocess** (`execFile python3`), not an HTTP call. Layer-0 corrections + CoA are injected here (see below).
- **GSTR-3B Tally Entry standalone tool** → its own controller `gstr3bController.js` proxies to the engine with `reco_type=gstr_3b_tally_entry` (see its dedicated section).

---

## `recon/` package (engine internals)

All 12 core `.py` files are present in this repo at `reco-engine/recon/`:

```
recon/
├── __init__.py
├── core.py                     ← NormalizedInvoice, MatchResult, reconcile, summarize; normalize_doc_no, parse_date, round_money
├── parsers.py                  ← generic .xlsx/.xls/.csv/.json reader → normalized records
├── gstr_2b_books.py            ← MAIN engine (~88 KB): parse + Pass 1–5 + Excel export
├── gstr_2b_books_multistate.py ← imports ALL of ↑; adds _file_idx tag + Phase-2 Remark 3
├── gstr_2a_2b_books.py         ← 3-way 2A + 2B + Books
├── gstr_3b_vs_2b.py            ← 3B filed vs 2B ITC (+ build_month_pivot)
├── gstr_3b_tally_entry.py      ← 3B → Tally journal entries (~45 KB)
├── gstr_1_vs_books.py          ← GSTR-1 outward vs Tally + Amazon books (B2B + B2C)
├── bank_reco.py                ← bank statement classifier (AI ledger tagging)
├── pdf_bank_extractor.py       ← PDF bank statement → transactions (~51 KB, deterministic pdfplumber)
├── einvoice_reco.py            ← e-invoice register vs Books (Sales + Credit Note)
├── zepto_receivables.py        ← Zepto receivables (Drive-fed, multi-file)
└── data/                       ← reference data
```

- Pure **Python 3 stdlib** HTTP server (`server.py`, no Flask/FastAPI). **pandas** parses `.xlsx/.xls/.csv`; **openpyxl** writes/styles workbooks; **xlrd** reads legacy `.xls` (Tally); **xlwt** writes legacy `.xls` (fixtures only). `pdfplumber` powers the PDF bank extractor.
- Engine imports use `from recon.<module>` (relative to `reco-engine/`) — never `from app.recon.<module>`.
- `.xls` (Tally exports) auto-convert to `.xlsx` in-memory (`_ensure_xlsx`) — never break this flow.

### Engine locations & drift

| App | Engine path |
|---|---|
| Sandbox (3001) | `~/.gemini/antigravity/scratch/RECOFULL/app/` |
| colonel-automation (3000) — **this repo** | `colonol git/colonel-automation/reco-engine/` |
| AWS EC2 (live) | `/opt/colonel/reco-engine/` |

**Drift:** this repo is the superset. `einvoice_reco.py`, `zepto_receivables.py`, and the newer `pdf_bank_extractor.py` are 3000-native and may be missing or older in the sandbox. Keep the two `recon/` trees in sync when porting core logic (develop/verify in the sandbox first, then port here).

---

## `server.py` HTTP API (port 8765)

Stdlib `http.server` / `BaseHTTPRequestHandler`, class `ReconciliationHandler`. Routes:

- `GET /` → serves `static/index.html`
- `GET /static/*` → static assets
- `GET /api/jobs/{id}` → cached job JSON from in-memory `JOBS` dict (404 if unknown)
- `GET /api/jobs/{id}/export.xlsx` → download the generated Excel workbook
- `POST /api/reconcile` → **the single work endpoint.** Guarded by `_RECO_SEMAPHORE` (**503 when busy**). Dispatches on the multipart field **`reco_type`**.

`read_multipart()` accumulates repeated file fields into a list; single-vs-list is normalised by the `_file_list()` helper (used by the multistate + zepto agents).

### `reco_type` dispatch values (engine, port 8765)

Each is an `if reco_type == "…"` branch in `do_POST`:

| `reco_type` | Handler | Files expected |
|---|---|---|
| `gstr_3b_vs_2b` | `reconcile_3b_vs_2b` | GSTR-3B + GSTR-2B |
| `gstr_2a_2b_books` | `reconcile_three_way` | GSTR-2A + GSTR-2B + Books |
| `gstr_1_vs_books` | `reconcile_b2b_new` / `reconcile_b2c_new` | GSTR-1 + Tally + Amazon RTF |
| `bank_reco` | `bank_reco` classifier | Bank statement + ledger master |
| `gstr_2b_books` | `reconcile_gstr2b_vs_books` | GSTR-2B + Purchase + Debit Note |
| `gstr_2b_books_multistate` | `reconcile_gstr2b_vs_books_multistate` | N files/type |
| `einvoice_reco` | `reconcile_einvoice_top` | `einvoice` + `books` |
| `gstr_3b_tally_entry` | `gstr_3b_tally_entry` | `gstr3b` (+ optional `coa`, `vouchertype`) |
| `pdf_bank_extract` | `extract_bank_statement` + `build_pdf_bank_excel` | PDF bank statement |
| `zepto_receivables` | `reconcile_zepto` + `build_zepto_workbook` | Drive-fetched classified files |

Default fallback: **`gst_2b_purchase`** (calls `reconcile`). Unknown path (≠ `/api/reconcile`) → 404.

---

## Node-side `reco_type` mapping (recoController.js)

Frontend keys are mapped to engine `reco_type` names by **`RECO_TYPE_MAP`** before proxying:

```
bank_statement            → bank_reco
universal_bank_statement  → universal_bank_reco   (actually runs classify.py subprocess, not 8765)
gstr_2b_vs_purchase       → gstr_2b_vs_purchase
gstr_2a_2b_books          → gstr_2a_2b_books
gstr_2a_vs_2b_vs_books    → gstr_2b_books          (3-file: 2B + Purchase + Debit Note)
gstr_2b_books             → gstr_2b_books
gstr_3b_vs_2b             → gstr_3b_vs_2b
gstr_3b_tally_entry       → gstr_3b_tally_entry
gstr_1_vs_books           → gstr_1_vs_books
gstr_2b_books_multistate  → gstr_2b_books_multistate
zepto_receivables         → zepto_receivables
einvoice_reco             → einvoice_reco
```

**DB-save routing** in `runReco()` (all fire-and-forget via `setImmediate`, inside an RLS-bypass transaction):

| Engine result set | Save fn | Table |
|---|---|---|
| `GST_2B_FRONTEND_TYPES` (`gstr_2b_books`, `gstr_2a_vs_2b_vs_books`, `gstr_2b_vs_purchase`, `gstr_2b_books_multistate`, `einvoice_reco`) | `saveGstRecoResults` | `gstr_2b_results` |
| `gstr_2a_2b_books` | `saveGstRecoResults` | `gstr_2a_2b_results` |
| `gstr_3b_vs_2b` | `saveGstRecoResults` | `gstr_3b_results` |
| `gstr_3b_tally_entry` | `saveTallyEntryResults` | `gstr_3b_tally_results` |
| `gstr_1_vs_books` | `saveGstr1Results` + `saveGstr1B2cSummary` | `gstr_1_results` |
| `bank_reco` / `universal_bank_statement` | `saveBankRecoResults` | `bank_reco_results` |

- **Idempotency:** `hashFiles()` (SHA-256 of file buffers) is the key. `findExistingJob()` matches on `brand_id + agent_type + month + year + file_hash` (`IS NOT DISTINCT FROM` for nullable month/year). A duplicate run reuses the job (`updateOutputFileId`); a zero-row prior job is deleted (`deleteJob`) and re-saved.
- **Date safety:** `toSqlDate()` / `parseIndianDate()` convert `"nan"`/`"nat"`/DD-MM-YYYY → ISO or `null` before INSERT — never skip for date fields.
- **Concurrency:** `MAX_CONCURRENT_RECO` (default 8) gates `runReco`; over the cap → **429** (retry_after 30). Independent of the Python `_RECO_SEMAPHORE` 503.

---

## Reco agent catalog (frontend keys → UUIDs)

| Agent | DB name / key | UUID |
|---|---|---|
| GSTR-2B vs Books | `gstr_2b_books` | `d0000000-0000-0000-0000-000000000001` |
| GSTR-2B vs Books (Multi-State) | `gstr_2b_books_multistate` | `d0000000-0000-0000-0000-000000000002` |
| GSTR-3B Tally Entry | `gstr_3b_tally_entry` | `d0000000-0000-0000-0000-000000000003` |
| Universal Bank Statement | `universal_bank_statement` | `d0000000-0000-0000-0000-000000000004` |
| GSTR-1 vs Books | `gstr_1_vs_books` | `d0000000-0000-0000-0000-000000000005` |
| **E-Invoice Reco** | `einvoice_reco` | `d0000000-0000-0000-0000-000000000008` |
| **Zepto Receivables** | `zepto_receivables` | `d0000000-0000-0000-0000-000000000010` |

> Frontend routing: `/brands/:brandId/agents/:agentId` → `AgentDispatch.jsx` maps UUID → workspace. GST-family agents run through `RecoWorkspace.jsx` / `RecoMultiStateWorkspace.jsx`; results deep-links use `/brands/:brandId/reco/:agentType/results/:jobId` → `RecoJobDashboard.jsx`.

Also present (engine-only, no seeded card): `gstr_3b_vs_2b`, `gstr_2a_2b_books`, `pdf_bank_extract`.

---

## E-Invoice Reco (`einvoice_reco`) — superset agent

- Engine: `recon/einvoice_reco.py`, entry `reconcile_einvoice_top(einv_bytes, books_bytes, tolerance)` → returns a `bundle`; workbook built by `build_einvoice_workbook`.
- Files: multipart fields **`einvoice`** + **`books`** (E-Invoice register vs Books Sales + Credit Note). Server base64-caches the raw uploads (`_einvoice_b64`) so export can rebuild.
- Node persistence: part of `GST_2B_FRONTEND_TYPES` → rows land in **`gstr_2b_results`** via `saveGstRecoResults`.

---

## Zepto Receivables (`zepto_receivables`) — superset agent

- Engine: `recon/zepto_receivables.py` — `reconcile_zepto(files)`, `summarize_zepto`, `build_zepto_workbook`.
- **Drive-fed input** (not direct upload): `runReco()` detects `reco_type === 'zepto_receivables'`, requires `folder_url`/`folderLink`, calls `zeptoDrive.downloadClassified(folderUrl)` → `{ type: [{filename, buffer}] }`, and re-appends each classified file to the multipart form so the engine reads them as lists. `tolerance` defaults to 100 (₹100 Paid / Not-Paid gate).
- Logic: GRN-gate PO match → invoice enrichment (Invoice Details / Payment Advice / Credit Note) → live Excel formulas + Paid/Not-Paid classification.
- Response passed straight through to the frontend (`{ job_id, summary, counts, results }`).

---

## GSTR-3B Tally Entry — standalone tool (`gstr3bController.js`)

A self-contained subsystem separate from `recoController`. Frontend: **`frontend/src/pages/accountant/Gstr3bTallyWorkspace.jsx`**. Routes mounted from `new-backend/src/routes/gstr3bRoutes.js`:

| Route | Handler | Purpose |
|---|---|---|
| `POST /api/brands/:brandId/gstr3b/upload` | `upload` | Multipart (`gstr3b` ×≤15, optional `coa`, `vouchertype`) → proxies to engine `reco_type=gstr_3b_tally_entry` via `fetch` |
| `GET /api/brands/:brandId/gstr3b/download/:jobId` | `download` | Streams `GET /api/jobs/:jobId/export.xlsx` from engine |
| `GET /api/brands/:brandId/gstr3b/coa-status` | `getCoaStatus` | `{ hasLedger, count, hasVt, vtCount }` |
| `GET /api/brands/:brandId/gstr3b/history` | `getHistory` | Last 20 `gstr3b_runs` rows |

- **Self-creating tables** (per-brand DB, via `ensureTables()` on every call, RLS-bypassed): `gstr3b_coa_master` (brand_id + ledger_name), `gstr3b_vt_master` (brand_id + voucher_name), `gstr3b_runs` (job_id, period, totals, `monthly_data` JSONB).
- **CoA/VT reuse:** if no `coa`/`vouchertype` file is uploaded, `tryAttachSavedCoa` / `tryAttachSavedVt` inject saved ledger/voucher lists as `coa_ledgers` / `vt_ledgers` form fields. After a run, `persistAfterRun` (fire-and-forget) saves any newly-uploaded CoA/VT (`data.coa_ledgers_parsed` / `vt_ledgers_parsed`) and records a `gstr3b_runs` summary. **Note:** this tool records to `gstr3b_runs`, NOT to `reco_jobs`.
- Engine down → 503 `"Python reco engine is not running (port 8765)"`.

---

## Universal Bank Statement — classify.py subprocess + Layer 0

`universal_bank_statement` does NOT use the 8765 engine. `runReco()`:

1. Splits a multi-tab Excel into bank + ledger sheets (SheetJS, name-keyword then content-score fallback).
2. Resolves the CoA: uploaded `ledger_master` → DB-backed `getLedgerMasterBuffer()` (union of `ledger_master` table + `bank_reco_corrections`) → disk fallback.
3. Writes brand corrections to `corrections.json`, runs `classify.py` via `execFile` (Claude `claude-haiku-4-5` preferred, Gemini fallback, else rules-only).
4. Reads the output workbook by header-map (column order irrelevant), applies **Layer 0** `bank_reco_corrections` (narration key → ledger, confidence forced High), then persists to `bank_reco_results` and re-ingests CoA to `ledger_master`.

**Corrections order inside classify.py:** Layer 0 (DB corrections) → CoA fuzzy → keyword rules → Suspense A/c. High-confidence classifier rows are **never** auto-saved to corrections — only explicit accountant actions (UI edit / upload-excel / upload-output) write there. KOPARO brand (`b0000000-…-003`) gets a special Tally Debit/Credit / Contra output format via `generateKoparoExcel`.

---

## Remark 1 / 2 / 3 system (GSTR-2B vs Books)

| Column | Values | Rule |
|---|---|---|
| **Remark 1** | `Matched` · `Showing in 2B but Not in Books` · `Showing in Books but Not in 2B` | **Primary match status ONLY** — never mix in secondary observations |
| **Remark 2** | Tax Amount Mismatch (Excess in 2B / Books) · Taxable Value Mismatch · Invoice Date Mismatch · Duplicate Entry in Books / Duplicate Upload by Vendor · RCM | Secondary observations |
| **Remark 3** | Cross-state booking error | **Multi-state engine ONLY** — set exclusively by `gstr_2b_books_multistate.py` Phase-2; never in the single-state engine |

- Node maps engine `suggested_action` → Remark 1 and `suggested_action_2` → Remark 2 when persisting (`saveGstRecoResults`). GSTR-1 has its own map (`mapGstr1Remark`: Match→Matched, Diff→Amount Mismatch, Not in GSTR-1 / Not in Books).
- RCM entries: "RCM" goes to **Remark 2 only**; Remark 1 stays "Showing in 2B but Not in Books".

### Key `gstr_2b_books.py` behaviours

- Dynamic sheet-name + header-row detection (scans first 20 rows for `Date` + `Particulars`); no hardcoded "Sheet1" / row indices.
- Dynamic tax-ledger summing: any column containing `igst`/`cgst`/`sgst`/`utgst`/`cess` is aggregated.
- GSTIN via `_GSTIN_RE` + `_extract_gstin()` raw-row scan fallback; merged-cell `ffill()` on GSTIN + supplier-name.
- Duplicate rows retained and flagged in Remark 2.
- **Vendor Summary tab** = the **second sheet**, 20-column layout (Common Name | GSTIN | 2B block | Books block | Difference | Remark 1 | Remark 2), grouped Matched → Amount Mismatch → 2B-not-Books → Books-not-2B, each A→Z. Never remove/break it.

### Multi-state — `gstr_2b_books_multistate.py`

Imports ALL parsers + matching from `gstr_2b_books.py` (never duplicated). Only new logic: (a) tag each record with `_file_idx` in `raw`; (b) Phase-2 cross-state loop sets `suggested_action_3`. Remark 3 = column W (23rd) in "Reco 2B vs Books", column U (21st) in "Vendor Summary", amber-orange font `FF6600`.

---

## Sales / other agents (Node side)

Located in `new-backend/src/controllers/agents/`. These parse raw marketplace reports and store normalised data — they do **not** touch the Python engine.

**Sales agents (14):** Amazon, Blinkit, Cread, Firstcry, Flipkart, JioMart, Limeroad, Mirrow, Myntra, Nykaa, Shopify, Zepto, plus **settlement-amazon** and **total-sales**. Also **order-cycle-shopify** and **invoice-process**.

**Persistence pattern (confirmed):**
- Normalised rows are written to **per-brand dynamic tables** via Sequelize **`bulkCreate`** (`getDynamicModel` in `models/brand`).
- Each successful commit records **one `reco_jobs` row** via **`services/agentRunTracker.js` → `recordAgentRun()`** — so admin analytics (which read `reco_jobs`) show who / when / which brand for every agent run. It mirrors `saveRecoJob`'s RLS-bypass pattern, never throws, and does not touch agent tables/logic. `output_file_id` (varchar(36)) only stores the value if it fits a UUID, else NULL.
- Sales data itself carries **no user attribution** — only the `reco_jobs` row records `created_by`.

**MTR Consolidator** (`mtrController` / `mtrProcessor`): single B2C/B2B/Log workbook across all months (Drive-fed). **Invoice processing** fires a per-brand n8n webhook → per-brand Google Sheet.

---

## Rules (reco)

1. Keep everything **dynamic** — no hardcoded sheet names, row indices, or tax-ledger names.
2. Preserve the two-column Remark split (Remark 1 + Remark 2); Remark 1 = primary status only; Remark 3 is multistate-only.
3. `.xls`→`.xlsx` in-memory conversion must never break.
4. **Never change agent logic** when adding DB persistence or UI — DB writes are fire-and-forget (`setImmediate`) additions only.
5. RLS bypass **must** be inside a `seq.transaction()` (`SET LOCAL` outside a transaction is a Postgres no-op). Use `IS NOT DISTINCT FROM` for nullable `month`/`year`.
6. `toSqlDate()` before every date INSERT.
7. Restart the right process after edits: engine (re-run `server.py` on 8765) for `recon/*.py`; backend for controllers ([SERVERS.md](SERVERS.md)). Never touch AWS/EC2 without explicit permission ([AWS.md](AWS.md)).
8. Adding a new agent = touch engine (`recon/` + `server.py`) → `recoController.js` (`RECO_TYPE_MAP` + save branch) → `dashboardController.js` (`RESULTS_TABLE_MAP`) → migration → frontend (`RecoSuite`, `RecoWorkspace`, `RecoJobDashboard`).
