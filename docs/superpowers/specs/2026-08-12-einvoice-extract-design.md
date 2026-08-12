# E-Invoice Extractor — design spec (2026-08-12)

## Goal
A new agent **E-Invoice Extraction** (`einvoice_extract`) that turns GST **e-invoice PDFs** into the standard **3-sheet GST e-Invoice Register** — deterministically (pdfplumber, tesseract fallback), with **no LLM / no n8n / no per-invoice cost**. Batch of PDFs, **one at a time**, with a live **"Processing X of N"** counter like Invoice Process.

Golden fixture: `~/Downloads/E-Invoice Extraction/` (Click2Shop PDFs + merged 16-invoice PDF → `1. DChica_ Reseller Data.xlsx`). Hard check: register Grand Totals **taxable ₹27,04,346.56 / IGST ₹1,35,217.58**.

## Why deterministic (not n8n+Gemini)
Vendor purchase invoices are heterogeneous → Invoice Process needs an LLM. **E-invoices are IRP-standardized** → a fixed-section parser reads them perfectly for ₹0. Mirrors `pdf_bank_extract` / `credit_card_booking`, not the n8n invoice pipeline.

## Input → one invoice per PDF
Real usage = one e-invoice per PDF (multi-page OK). Accountant uploads several / pastes a Drive folder. Merged multi-invoice PDF = test fixture only (optional split by IRN boundary).

## Architecture (backend orchestrates for the counter)
1. Frontend `EInvoiceWorkspace.jsx` → upload N PDFs (or Drive folder) → `POST /api/brands/:b/agents/:a/einvoice/process`.
2. Backend `einvoiceController.js`: `startRun(total=N)`; **loop files, one at a time** → `POST` engine `/api/einvoice/parse` with ONE pdf → engine returns `{header, line_items[]}`; `feedTick` (SSE "X of N"); accumulate rows.
3. After all parsed → build the 3-sheet workbook from accumulated rows (engine `/api/einvoice/build` or in-parse aggregate), persist to `RECO_OUTPUT_DIR/<job_id>.xlsx` via `_JobStore`; `completeRun`.
4. SSE `/einvoice/status` drives the counter (reuse the `invoiceEvents.js` util pattern → new `einvoiceEvents.js`, or generalize). Frontend shows "Processing X of N" → preview table + **Download Excel**.

## Engine parser `reco-engine/recon/einvoice_extract.py`
Per PDF, pdfplumber text (tesseract only if empty text = scan). Section-anchored:
- **Header:** `IRN :` **+ wrapped continuation stitched** (64 hex), `Ack No.`, `Ack Date`, `Document No.`→Invoice No, `Document Date`→Invoice Date, `Document Type`→Invoice Type, `Supply type Code`, RCM (default N), Supplier/Recipient `GSTIN`+name+address, `Place of Supply` → State Code (state map), E-Way Bill/Vehicle (blank if absent).
- **Line items** (`4.Details of Goods/Services`): regex per item on leading SlNo; **reassemble multi-line descriptions**; split 6–8-digit HSN out of the description tail. Capture SlNo, desc, HSN, Qty, Unit, UnitPrice→Rate, Discount, Taxable, `Tax Rate(GST + Cess)`→gst%+cess%, Other Charges, line Total.
- **Tax split:** Supplier-GSTIN state (chars 1–2) vs POS state code → **differ → IGST (rate, taxable×rate); same → CGST+SGST (rate/2 each)**. Cess from `+` part. Total Tax = sum. Round Off = Total − (Taxable+Tax+Other).

## Output builder — 3 sheets exactly matching the fixture
- **Invoice Details GSTR** — 39 cols, one row per line item (header repeated), title row `"<Supplier> — GST e-Invoice Register (Sheet 1: Invoice Details)"`; running S.No.
- **GSTR HSN** — pivot (HSN, Unit, Tax Rate) → Σ Qty, Σ Taxable, Σ IGST/CGST/SGST + Grand Total.
- **GSTR B2B** — pivot (Invoice No, Date, Recipient GSTIN, Tax Rate) → Σ Taxable, Σ IGST/CGST/SGST + Grand Total.

## Wiring (local 3000 first, backups on every touched file)
- NEW: `recon/einvoice_extract.py`, `einvoiceController.js`, `einvoiceRoutes.js`, `einvoiceEvents.js`, `EInvoiceWorkspace.jsx`.
- EDIT (backup first): `server.py` (parse/build endpoints), `app.js` (mount route), `frontend/src/lib/recoAgentSpecs.js` (spec), `BrandAgentsInventory.jsx` (`RECO_AGENT_META` card, group), `AgentDispatch.jsx` (`RECO_ID_TO_TYPE` + component), `App.js` (route).
- DB: insert `einvoice_extract` agent row (new UUID matching AgentDispatch) + assign to brands (like credit-card).

## Test
Parse the 2 Click2Shop PDFs (+ merged 16) → assert register rows + both pivots == fixture Grand Totals (₹27,04,346.56 / ₹1,35,217.58). Local only; AWS deploy + push only after user verifies.
