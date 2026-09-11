# PO Extractor — n8n workflow

Scans **Purchase Order** PDFs from a per‑brand Google Drive folder, extracts the
header + every line item with **Google Gemini**, appends **one row per line item**
to that brand's **master Google Sheet** (the 8‑column *PO Data for Automation*
layout), and pushes the same rows back to the app so the **PO Extractor** agent
card's table + live "X of N" counter work.

File: [`po-extract.workflow.json`](./po-extract.workflow.json) — a **template**.
Duplicate it once per brand (same model as the `KOPARO INVOICE` workflows).

Backend for this agent (already in the repo):

| piece | path |
|---|---|
| DB table | `db-restructure/031_po_extractor.sql` — run once as postgres superuser |
| agent + assignment | `new-backend/seed-po-agent.js` — `node seed-po-agent.js [BrandName ...]` |
| trigger / history API | `new-backend/src/controllers/agents/po-extract/poController.js` + `routes/poRoutes.js` |
| n8n → DB feed | `POST /api/n8n/po/feed` — `controllers/agents/po-extract/n8n-po-feed-db.js` |
| live progress | `POST /api/n8n/progress` — reused as‑is (already generic) |
| UI | `frontend/src/pages/accountant/PoExtractWorkspace.jsx` (dispatched via `AgentDispatch.jsx`) |

---

## Node flow

```
PO Webhook (POST /webhook/po-extract)      ← fired by /api/brands/:b/agents/:a/po/process
  → Config            (per-brand constants — EDIT THIS NODE)
  → List PO PDFs       (Drive: PDFs in driveFolderId)
  → Progress: start    (POST /api/n8n/progress  phase=start  total=<file count>)
  → Split Files        (1 item per PDF, carries batch_total)
  → Loop Over POs      (batch size 1)
       ├─ done  → Progress: done  (POST /api/n8n/progress  phase=done)
       └─ loop  → Download PDF          (Drive: alt=media, binary)
                → Build Gemini Body     (base64 + extraction prompt → JSON schema)
                → Gemini: extract PO    (generativelanguage.googleapis.com generateContent)
                → Build Rows            (parse JSON → 1 row per line item; 8 sheet cols)
                → Append to Sheet       (Sheets: values.append  Sheet1!A:H)
                → Feed backend          (POST /api/n8n/po/feed  [rows...])
                → Move to Processed     (Drive: move file to processedFolderId)
                → back to Loop Over POs
```

`Progress: *`, `Feed backend`, `Move to Processed` are **continue‑on‑error**, so a
Drive/permissions hiccup never blocks the Sheet write.

---

## The 8 Google‑Sheet columns (row per line item)

Pre‑create one empty Sheet per brand. The workflow appends to `Sheet1!A:H` in this
exact order (put a header row in row 1 if you want labels — append ignores it):

```
PO number | Po date | Suppiler gtsn number | Buyer gstn number | Billing address / Deliverd to | Product description/Item Description | Basic Cost price/Unit Cost | GST rate
```

- **Suppiler gtsn number** = GSTIN in the supplier / "Vendor Details" block.
- **Buyer gstn number** = GSTIN in the "Billing Address" / buyer block.
- **Basic Cost price/Unit Cost** = the per‑unit *Unit Cost* (not MRP, not taxable value, not line total).
- **GST rate** = GST % as a number (e.g. `18`).

---

## One‑time setup in n8n

1. **Import** `po-extract.workflow.json`.
2. **Credentials**:
   - `Google Drive account (n8n)` — Google Drive OAuth2 API (*List PO PDFs*, *Download PDF*, *Move to Processed*).
   - `Google Sheets account (n8n)` — Google Sheets OAuth2 API (*Append to Sheet*).
   - Gemini uses an API key in the `x-goog-api-key` header — set `geminiApiKey` in the **Config** node.
3. **Edit the `Config` node** for this brand:
   | field | value |
   |---|---|
   | `backendBaseUrl` | `https://agent.accountant` (or `http://localhost:8001` in dev) |
   | `geminiModel` | `gemini-2.0-flash` |
   | `geminiApiKey` | your Gemini API key |
   | `driveFolderId` | the brand's **PO input** Drive folder id |
   | `processedFolderId` | a **Processed** subfolder id |
   | `spreadsheetId` | the brand's pre‑created Sheet id |
   | `sheetName` | tab name, default `Sheet1` |
   | `brandName` / `agentName` | fallback only — arrives in the webhook body |
4. **Share** the Drive folders + the Sheet with the Google account behind the n8n credentials (Editor).
5. **Activate**, copy the **Production webhook URL**.
6. Backend `.env` (same convention as `<Brand>_invoice_url`):
   ```
   <BrandName>_po_url=https://<n8n-host>/webhook/po-extract
   <BrandName>_po_sheet=https://docs.google.com/spreadsheets/d/<spreadsheetId>
   ```
   `<BrandName>` matches the brand's `name` (spaces → `_`, e.g. `Koparo_po_url`).

---

## Dedupe / re‑runs

Files move to `processedFolderId` after each PO, so a re‑run only sees new files.
`/api/n8n/po/feed` also skips rows whose `po_number + product_description + unit_cost`
already exist, so a manual re‑drop can't double‑post to the DB. The Google Sheet
append is not deduped by n8n — keep "Move to Processed" enabled.
