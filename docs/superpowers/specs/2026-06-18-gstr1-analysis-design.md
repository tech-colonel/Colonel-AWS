# GSTR-1 vs Books — Analysis View Design

**Date:** 2026-06-18
**App:** `colonel-automation` (live, Mac/ngrok) — built directly here per user.
**Agent:** `gstr_1_vs_books` (UUID `d0000000-0000-0000-0000-000000000005`)

## Context / problem

The GSTR-1 vs Books results page (`/brands/:brandId/reco/gstr_1_vs_books/results/:jobId`,
`RecoJobDashboard.jsx`) renders **empty** (Total 0, Matched 0, empty charts, "No records") even
though the job is "Completed" and the Excel downloads fine. Root cause is a wiring gap across layers:

1. **Engine returns no rows:** `reco-engine/server.py` (GSTR-1 branch, ~line 293) sets
   `"results": []` and keeps the reconciled data in private fields (`_b2b_reco_rows`,
   `_b2c_reco_rows`, `_gst_reco_sections`) used only to build the Excel.
2. **Backend never saves GSTR-1:** `recoController.js` save block only handles
   `GST_2B_FRONTEND_TYPES` (→ `gstr_2b_results`) and `gstr_3b_tally_entry`; `gstr_1_vs_books`
   falls through to the no-op `else`, so `gstr_1_results` stays empty → `reco_jobs.total_rows = 0`.
3. **Wrong orientation:** GSTR-1 is **outward/sales (customer-side)**; the generic view uses
   supplier/"2B-vs-Books" labels.

GSTR-1 was scaffolded (AGENT_META, RECO_TYPE_MAP, RESULTS_TABLE_MAP, a `gstr_1_results` table) but
the data path was never completed.

## Goal

Make the GSTR-1 results page show a real, sales-side analysis — matching the GSTR-2B pattern but
flipped to customers — populated from saved data so the `/results/:jobId` deep link and job history
work like the other agents. **Do not change the reco logic or the Excel output.**

## Decisions (confirmed with user)

- Build **directly in `colonel-automation`** (not the 3001 sandbox first).
- **B2B detailed + B2C summary**: rich invoice-level table/charts/stats for B2B; B2C shown as
  summary totals only (B2C has no invoice/GSTIN, doesn't fit the invoice table).
- **Save GSTR-1 results** to `gstr_1_results` (non-blocking `setImmediate`), like other agents.

## Design

### Layer 1 — Reco engine (`reco-engine/server.py`, GSTR-1 branch)
- Populate `results` with normalized **B2B** rows derived from the already-computed
  `_b2b_reco_rows` (no recompute, no Excel change). Each row:
  `{ customer_name, gstin, invoice_no, invoice_date, taxable_value, igst, cgst, sgst, remark_1, remark_2 }`.
- Map the engine's existing per-row status/remark into:
  - **Remark 1** ∈ `Matched` / `Showing in GSTR-1 but Not in Books` / `Showing in Books but Not in GSTR-1`.
  - **Remark 2**: amount/tax-mismatch detail (e.g. "Taxable Value Mismatch", "Tax Amount Mismatch").
- Add a `b2c_summary` object to `summary`/`counts` (e.g. `{ taxable, igst, cgst, sgst, status counts }`)
  from `_b2c_reco_rows`. Keep `_b2b_reco_rows`/`_b2c_reco_rows`/Excel build untouched.
- Confirm the reconcile HTTP response forwards `results` + `summary` (not the `_`-private fields).

### Layer 2 — Backend save (`new-backend/src/controllers/recoController.js`)
- Add a save branch: `else if (savedJobId && recoType === 'gstr_1_vs_books')` →
  `saveGstr1Results(seq, savedJobId, brandId, response.data.results)`.
- New `saveGstr1Results()` (modeled on `saveGstRecoResults`, per-row try/catch, `toSqlDate()` for
  dates) inserting into `gstr_1_results` columns
  (`invoice_number, invoice_date, customer_name, gstin, taxable_value, igst, cgst, sgst, remark_1, remark_2`).
  Verify/adjust column names against `001_reco_tables.sql` `gstr_1_results` (add a migration only if a
  needed column is missing — migration is idempotent).
- Persist `total_rows/matched/unmatched` into `reco_jobs` from the B2B counts (+ optionally store
  B2C summary; minimal: drive stat cards from rows).

### Layer 3 — Dashboard endpoint (`new-backend/src/controllers/dashboardController.js`)
- Ensure `RESULTS_TABLE_MAP['gstr_1_vs_books'] = 'gstr_1_results'` and the `getJobById` SELECT
  returns the customer-side columns. Return `b2c_summary` if stored.

### Layer 4 — Frontend (`frontend/src/pages/accountant/RecoJobDashboard.jsx`)
- Add/branch a **GSTR-1 sub-view** (reuse `GstInvoiceView` with GSTR-1 labels, or a thin `Gstr1View`):
  - Stat cards: **Total · Matched · Amount Mismatch · In GSTR-1 not in Books · In Books not in GSTR-1**
    (computed from `remark_1`/`remark_2`).
  - Charts: **Remark Distribution** (pie, by remark_1) + **Top Customers by Taxable Value** (bar).
  - Filter tabs: All / Matched / In GSTR-1 not in Books / In Books not in GSTR-1.
  - Table columns: Customer · GSTIN · Invoice # · Date · Taxable · IGST · CGST · SGST · Remark 1 · Remark 2.
  - **B2C summary** strip (taxable + tax totals) above/below the table when present.
- Rebuild frontend (`npx craco build`) and restart backend + engine on the Mac.

## Out of scope
- Reco/matching algorithm changes; Excel layout; the 3001 sandbox port (live app only for now).

## Verification
1. Run GSTR-1 vs Books for a brand on the live URL → workspace shows rows.
2. Open `/results/:jobId` → stat cards non-zero, both charts populated, table shows customer rows
   with correct Remark 1/2, filter tabs work, B2C summary shows.
3. `gstr_1_results` has rows for the job; `reco_jobs.total_rows` > 0.
4. Download Excel still identical to before (unchanged).
5. Other agents (GSTR-2B, multi-state, bank, 3B) still work (no regression in the shared save path).
