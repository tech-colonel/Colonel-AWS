# Bank Reco Tool — Design Spec

**Date:** 2026-07-21
**App:** colonel-automation (production branch, port 3000 / backend 8001) — build **local only**, no AWS deploy, no git push.
**Author context:** Colonel Full / Indian CA-firm automation platform.

---

## 1. Goal

A new reconciliation agent, **Bank Reco** (`reco_type: bank_tally_reco`), that reconciles the **books/Tally side** against the **bank side** (already COA-mapped by the existing Universal Bank Statement tool) and produces one colourful, multi-sheet Excel workbook: matched entries with clearing-date updates, bank-only entries ready to paste into Tally, and a backup catch for Tally-only entries.

It chains **after** Universal Bank Statement (Approach A — see §3). It does **not** re-run classification; it consumes Universal's output.

---

## 2. Inputs

| Input | Format | Source | Notes |
|---|---|---|---|
| **Tally daybook** (books side) | `.xls` / `.xlsx` | User upload | Bank-ledger daybook export. Header row is dynamic (found by scanning for `Date`/`Particulars`/`Debit`/`Credit`). Party/ledger sits in the *Particulars* column; amounts in *Debit* (money in) / *Credit* (money out); plus *Narration*, *Vch Type*, *Vch No.* Has an *Opening Balance* row. **No hardcoded row indices.** |
| **Bank output** (bank side) | `.xlsx` | Universal Bank Statement output — via handoff `source_job_id` **or** manual upload | Sheet `"Bank Statement"`, columns (read by header name, not position): `Txn Date · Description · Chq / Ref No. · Debit · Credit · Balance · Type · Ledger Name · Confidence`. Date format `dd-mm-yyyy`. `Ledger Name` = mapped COA ledger. `Type` ∈ {Payment, Receipt, Contra}. Here **Debit = withdrawal/money out, Credit = deposit/money in** (bank-statement convention). |
| **COA** | `.xlsx` | Auto-loaded from saved `ledger_master` (DB) via `getLedgerMasterBuffer(brandId)`; upload option if none saved | Used to validate/normalize ledger names and to build the Ready-to-Paste contra ledger. |

---

## 3. Architecture — Approach A (chained + handoff button)

Two focused tools. Universal stays untouched; Bank Reco is small (match + report). Node-orchestrated Python CLI, mirroring the proven `universal_bank_statement` pattern (Node `execFile` → standalone Python script; **no** port-8765 engine).

```
Universal results screen (ToolResultDashboard)
   └─ "→ Reconcile with Tally" button  ──▶ navigate to Bank Reco agent route with ?source_job_id=<jobId>

Bank Reco (RecoWorkspace, AGENT_CONFIG block, file slots)
   ├─ bank side: source_job_id (fetch saved {jobId}.xlsx server-side)  OR  manual upload 'bank_output'
   ├─ books side: upload 'tally_daybook'  (required)
   └─ COA: auto from ledger_master  OR  upload 'coa' (optional)
        │
   POST /api/reco/run (reco_type=bank_tally_reco, multipart)
        │
   recoController branch 'bank_tally_reco':
        write files to temp job dir ──▶ execFile python3 scripts/bank_reco.py
            --tally <path> --bank <path> [--coa <path>] --output <path> --brand <name>
        ──▶ read styled .xlsx back (ExcelJS) ──▶ persist to RECO_OUTPUT_DIR/{jobId}.xlsx
        ──▶ return { job_id, summary, counts, results }
        │
   ToolResultDashboard renders summary + counts; download via GET /api/reco/export/:jobId
```

**Handoff detail:** the Universal output is already saved server-side as `RECO_OUTPUT_DIR/{jobId}.xlsx` and downloadable via `GET /api/reco/export/:jobId`. The button passes that `jobId`; the Bank Reco controller reads the saved file directly as the bank input — nothing re-uploads. If `source_job_id` is absent, the user uploads the bank output manually.

**New file:** `new-backend/scripts/bank_reco.py` (pure `pandas` + `openpyxl`; `thefuzz` for party fuzzy-match — all already available). Everything else is **additive** edits to existing files.

---

## 4. Matching algorithm

**Step 1 — Parse both sides into normalized rows.**
- Bank rows (from `Bank Statement` sheet): keyed by header name. Derive `direction`: `Credit>0 or Type=Receipt` → **money_in**; `Debit>0 or Type=Payment` → **money_out**. `Contra` handled by sign of the populated column.
- Tally rows: `Debit>0` → **money_in**; `Credit>0` → **money_out**. Skip the Opening Balance row (tracked separately for the closing sheet). Party = Particulars ledger.

**Step 2 — Direction-aware amount+party match.**
- **Tally Debit (money in) ↔ bank Credit / Deposit (Receipt).**
- **Tally Credit (money out) ↔ bank Debit / Withdrawal (Payment).**
- **Amount:** exact, float tolerance ₹0.01.
- **Party:** fuzzy. Normalize both (lowercase; strip `Pvt Ltd`/`Pvt.Ltd.`/`Private Limited`; drop trailing location suffixes like `-Delhi`/`-Telangana`/`-Bangalore`; strip punctuation & collapse whitespace) then `thefuzz` ratio ≥ ~85.
- **Pairing:** greedy 1:1 (a bank row and a Tally row consume each other once matched). **Duplicates left as-is for now** — a UTR/cheque-no tiebreaker is an explicit later upgrade; extra same-amount/same-party rows simply fall into the buckets below.

**Step 3 — Bucket + remark.**

| Bucket | Condition | Date handling | Remark |
|---|---|---|---|
| ✅ **Matched** | in both | Compare bank **Txn Date** vs Tally date. If different → **new date = bank Txn Date**, set *date-updated* flag. If same → *OK*. | *"Already in Tally"* (+ *date updated* where applicable) |
| ➕ **Bank-only** | bank row, no Tally match | — | *"In bank statement, not in Tally — add"* → feeds Ready-to-Paste |
| ⚠️ **Tally-only** | Tally row, no bank match | — | *"In Tally, not in bank — check duplicate / wrong-brand entry"* (backup catch; expected rare) |

Agent logic never mutates the source files; date "updates" are written into the output workbook only.

---

## 5. Output workbook (colourful — Claude palette: dark header `#263238` + white-bold, green `#C8E6C9` / amber `#FFF9C4` / red `#FFCDD2` status fills, thin `#CCCCCC` borders, frozen header panes, number format `#,##0.00`, auto width, title banner)

1. **Summary** — brand · bank · period; counts (Matched / Date-updated / Bank-only / Tally-only); total money in/out; overall "reconciled?" banner.
2. **Reconciliation** *(main, Table-1-like)* — every bank row + `Ledger Name` + **Reco Status**, **Matched Tally Party**, **Tally Date**, **Date Flag**; colour-coded by status.
3. **Date Updates (old → new)** — matched books entries whose date changed: Party · Amount · Vch No. · **Old Date → New (bank) Date**.
4. **Add to Tally (Ready-to-Paste)** — bank-only entries in Tally-import shape: `Date · Dr Ledger · Cr Ledger · Amount · Narration` (Dr/Cr derived from direction + the bank account ledger + mapped `Ledger Name`).
5. **Tally-only (Check)** — the backup bucket's home (rows in Tally with no bank match). *[Addition beyond the user's original 7 — confirmed reasonable; can be folded into the main sheet instead if preferred.]*
6. **Pivot** — month-wise Withdrawal/Deposit totals (bank side).
7. **Query** — per-ledger/vendor month-wise debit/credit summary (**dynamic** — no hardcoded vendor names; marketplace grouping like Flipkart/Amazon can be layered on later).
8. **Bank vs Tally (Closing)** — month-wise **As-per-Tally / As-per-Bank / DIFF** closing-balance scorecard (automates the existing manual `Bank Tally vs bank PDF` sheet). Tally closing = opening + cumulative Debit − Credit; bank closing from the `Balance` column.
9. **Universal Output** — the raw Universal `Bank Statement` sheet, included verbatim for reference.

---

## 6. Registration checklist (exact files — each shared file **backed up** with `cp -a` before editing; additive changes only)

Base: `/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation/`

1. **`new-backend/seeders/01-reco-agents.js`** — add object to `RECO_AGENTS` (fresh UUID + unique `name`, e.g. "Bank Reco"; pattern = e-invoice block); add that `name` to the `brand_agents` CROSS JOIN `WHERE a.name IN (...)` list. (`agent_type` is free-text `VARCHAR(50)` — **no enum/CHECK to change**.)
2. **`frontend/src/pages/accountant/AgentDispatch.jsx`** — add `'<new-uuid>': 'bank_tally_reco'` to `RECO_ID_TO_TYPE`; reuse `RecoWorkspace` (2 file slots) via the generic dispatch.
3. **`frontend/src/pages/accountant/BrandAgentsInventory.jsx`** — add `RECO_AGENT_META.bank_tally_reco` (displayName, icon, category `Bank & Finance`); ensure `sectionOf()` → `bank`.
4. **`frontend/src/pages/accountant/RecoWorkspace.jsx`** — add `AGENT_CONFIG.bank_tally_reco` block: name/icon/color + `files` slots `tally_daybook` (required), `bank_output` (required unless `source_job_id` present), `coa` (optional). Read `source_job_id` from route query and skip the bank_output slot when present.
5. **`new-backend/src/controllers/recoController.js`** — new branch in `runReco` keyed on `bank_tally_reco` (mirror the `universal_bank_statement` branch): temp dir → save `tally_daybook` + resolve bank input (`source_job_id` → read `RECO_OUTPUT_DIR/{id}.xlsx`, else uploaded `bank_output`) → resolve COA (`getLedgerMasterBuffer(brandId)` or uploaded `coa`) → `execFile python3 scripts/bank_reco.py …` → read output with ExcelJS → persist to `RECO_OUTPUT_DIR/{jobId}.xlsx` → fire-and-forget DB save → return `{ job_id, summary, counts, results }`.
6. **`frontend/src/components/reco/ToolResultDashboard.jsx`** — when `reco_type === 'universal_bank_statement'`, render a **"→ Reconcile with Tally"** button that navigates to the Bank Reco agent route with `?source_job_id=<jobId>`.
7. **`new-backend/scripts/bank_reco.py`** — NEW. CLI: `--tally --bank [--coa] --output [--brand]`. Parse (dynamic), match (§4), write styled workbook (§5). `.xls` read via pandas+`xlrd` (mirror `_ensure_xlsx` OLE2 magic-byte guard if needed).

No new route file (`POST /api/reco/run` already dispatches by `reco_type`; `recoRoutes` is mounted in `app.js`). DB persistence stays fire-and-forget / optional (new results table not required for v1).

Key strings: `reco_type = bank_tally_reco` (distinct from legacy engine `bank_reco` and agent `bank_statement`). Universal output sheet `"Bank Statement"`, mapped-COA column `Ledger Name`, date `dd-mm-yyyy`. Endpoints: `POST /api/reco/run`, `GET /api/reco/export/:jobId`.

---

## 7. Testing

1. **Standalone Python first** — run `bank_reco.py` against the real sample files in `/Users/dhavalchauhan/Dhaval/Bank RECO/`:
   - `Bank Statement Apr 24-25 Tally.xls` (books side),
   - a bank-side `.xlsx` in Universal-output shape (derive from `Table 1` columns, or generate by running Universal on the RBL statement),
   - `Master.xlsx` (COA).
2. **Validate:** bucket counts and date flags; spot-check matched pairs; **eyeball the closing-balance sheet against the existing manual `Bank Statement RBL.xlsx`** (ground truth) — the monthly DIFF should track.
3. **End-to-end on 3000** — seed the agent, run Universal, click the handoff button, confirm bank output + COA auto-load, add the Tally daybook, run, download the styled workbook, verify all 9 sheets render and colour correctly.

---

## 8. Non-goals / later

- UTR/NEFT/cheque-no tiebreaker for duplicate pairing (v2).
- Marketplace grouping (Flipkart/Amazon/…) in the Query sheet (configurable mapping, later).
- Integrated single-tool mode (upload raw bank PDF into Bank Reco and classify internally) — deferred; Approach A's button gives the convenience without it.
- AWS deploy and git push — **out of scope for this build** (golden rules #1, #2).

---

## 9. Constraints (golden rules)

- Local colonel-automation only — **no AWS/EC2 actions, no `git push`** this session.
- `cp -a <file> <file>.bak-$(date +%Y%m%d-%H%M%S)` before editing any existing shared file; prefer new files + minimal additive changes.
- Never modify Universal Bank Statement's classification/agent logic; Bank Reco is downstream and additive.
- Keep all parsing **dynamic** — no hardcoded sheet names, row indices, or ledger names.
