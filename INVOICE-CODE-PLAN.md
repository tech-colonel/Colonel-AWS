# Invoice Code — In-App Invoice Engine (replaces n8n)

> **Status:** PLAN (approved approach; not yet built). No code edited until Phase 1a is greenlit.
> **Owner app:** `colonel-automation` (backend `new-backend`, port 8001 / frontend 3000).
> **Local only** — no AWS/EC2, no deploy, no git push. Backups before any edit.

## 1. Goal
Replace the per-brand **n8n** invoice-automation workflows (≈ €59/mo) with an in-app
Node engine that produces the **same output**, using the existing paid Anthropic key.
n8n stays live as fallback; nothing existing is disturbed.

## 2. Hard isolation rule (non-negotiable)
- Build everything under a **NEW agent `Invoice code`** → new shared table **`invoice_code`**.
- The existing **`Invoice Process`** agent + **`invoice_process`** table are **NEVER touched** —
  accountants keep using the current n8n workflows exactly as today.
- New agent card gated to admin/developer first.

## 3. Brand inventory & feature matrix
Source of truth JSONs: `/Users/dhavalchauhan/Dhaval/N8N Invoice automation Final/`

| Brand | JSON file | TDS | TDS key mode | Gmail intake | Vendor-wise Drive move | OCR fallback |
|---|---|---|---|---|---|---|
| Koparo | `KOPARO INVOICE (6).json` | ✅ | GSTIN exact | ✅ (Phase 2) | ✅ (Phase 2) | ✅ (Phase 2) |
| Urban Plant | `URBEN-PLANT TDS (1).json` | ✅ | PAN substring | — | — | — |
| Plenaire | `PLENAIRE FINAL.json` | ❌ | — | — | — | — |
| Stroom | `STROOM INVOICE 2.json` | ❌ | — | — | — | — |
| DChica | `Dichika Invoice.json` | ❌ | — | — | — | — |
| M Brands | `M-Brands.json` | ❌ | — | — | — | — |
| Shumee | `Shumee.json` | ❌ | — | — | — | — |
| Biglilpeople | `BIGLIL.json` | ❌ | — | — | — | — |
| Zayden | `Zyden.json` | ❌ | — | — | — | — |
| ADC (new) | `ADC BRANDS.json` | ❌ | — | — | — | — |
| Nailinit (new) | `NAILINIT.json` | ❌ | — | — | — | — |

> Per-brand exact category/output specifics for the 9 non-TDS brands are read from their JSONs
> when their modules are built (after Koparo + Urban Plant are proven). Brand-name→`brands.id`
> mapping is resolved against the `brands` master table at build time (ADC/Nailinit may be new rows).

## 4. What the diff proved (Koparo ↔ Urban Plant)
**~95% identical.** Shared, written once (ported verbatim from n8n Code node):
JSON parse/fence-strip, empty/invalid guards, **3-tier batch-aware dedup**,
**invoice-total reconciliation** (₹1 tolerance), `voucher_type` + GST state map,
`safeGST`/`isValidVendor`/`normalizeText`, company-keyword detector, LLM = **Claude Haiku 4.5, temp 0**.

Per-brand hooks (the only real divergence):
1. **TDS lookup mode** — GSTIN-exact (Koparo) vs PAN-substring `[2,12)` (Urban Plant); none for the rest.
2. **`tds_rate` output** — `"2.00%"` string (Koparo) vs raw `0.02` decimal (Urban Plant).
3. **Category matcher** — table shape, vendor scope, threshold (45 vs 70), keyword boosts (Koparo-only).
4. **Extra field** — `creditors` (Urban Plant only).
5. **Intake topology** — Drive-poll + Gmail + OCR + move (Koparo) vs webhook-array (Urban Plant).

## 5. Architecture — one engine + per-brand modules
```
new-backend/src/services/invoiceEngine/
  core/
    parse.js         # AI-JSON parse + markdown-fence strip + guards
    dedup.js         # 3-tier batch-aware dedup (verbatim)
    reconcile.js     # invoice_total reconciliation → status review/success/failed
    voucher.js       # getVoucherType + GST_STATE_MAP
    vendorLookup.js  # reads Vendor Master sheet → GSTIN-exact / name-fuzzy match
    category.js      # shared getCategory(config) — threshold/boosts/table from brand module
    tds.js           # shared getTDS(config) — keyMode gstin|pan, rateFormat percent|decimal
    extract.js       # Claude Haiku call (prompt from brand module), temp 0
    orchestrator.js  # list → skip-processed → download → extract → process → write → cleanup
  brands/
    koparo.js        # verbatim prompt + TDS_MASTER(gstin) + CATEGORY_MASTER + output flags
    urbanplant.js    # verbatim prompt + TDS_MASTER(pan) + category(4 mkts) + creditors:true
    <others>.js      # added after Koparo+UP proven
  sheetsService.js   # Google Sheets API read via colonel-drive service account
```
- **LLM is a pure reader.** It extracts raw invoice line items; **code does all vendor/category/TDS
  resolution deterministically** (accuracy + cost). Per-brand prompt + TDS/category masters are
  **ported verbatim** from that brand's n8n — additive only, no quality reduction.
- Multi-line invoices: LLM returns an array of every line; engine loops all, skips tax/total rows;
  reconciliation flags `review` if the line sum ≠ grand total (guarantees full scan).

## 6. Config — Pattern A: `invoice_config` JSONB on `brand_agents`
Keyed by `brand_id` + the **new** `Invoice code` agent id. Small (switches only; heavy logic in code module):
```json
{
  "variant": "koparo",
  "enabled": true,
  "intake": "drive-poll",
  "driveFolderId": "1ywK4YwD6Jhh9OFpo87z10_g6ALijnM5Y",
  "vendorMaster": { "sheetId": "1YxpTZSnpus_B8vK4VvFytVkbsj3LOJwTWsuQhjQTr2g", "gid": "1330282311" }
}
```

## 7. Auth model (answers the Gmail/Drive/Sheets question)
- **Drive + Sheets → one service account** `colonel-drive@zeta-cortex-499810-k8.iam.gserviceaccount.com`
  (already used for Drive). Share each folder + the Vendor Master sheet **with the SA email**; owner
  identity is irrelevant. *(Action: `tech@colonel.co.in` shares the Vendor Master sheet with the SA.)*
- **Gmail → `team@colonel.co.in`** via Composio (Phase 2 only; SA can't read a mailbox w/o DWD).
- Preflight on brand setup (`drive.files.get` / `sheets.get`) → clear "share with SA" error, no silent fail.

## 8. DB migration (ADDITIVE ONLY — no ALTER/DROP on existing objects)
New migration file under `new-backend/db-restructure/`:
1. `CREATE TABLE invoice_code` — mirrors `invoice_process` columns (base bookkeeping + invoice fields
   + `tds_section/tds_rate/tds_amount`) **plus `creditors` (nullable)**; RLS policy `brand_id::text = current_setting('app.brand_id')`.
2. `ALTER TABLE brand_agents ADD COLUMN invoice_config jsonb DEFAULT '{}'::jsonb;`
3. `INSERT` the `Invoice code` agent row (name + columns JSONB mirroring the new table).
Run as the migration/`postgres` role (app role `colonel_app` can't DDL in unified mode).

## 9. Code changes
- **New:** `services/invoiceEngine/**`, `services/sheetsService.js`.
- **New:** route + controller to trigger the engine for a brand (mirrors `processInvoice`, local; old route untouched).
- **Additive to `driveService.js`:** `moveFile`, `renameFile`, `createFolder`.
- **Refactor `controllers/agents/invoice-process/n8n-invoice-feed-db.js`:** extract core into
  `ingestProcessedInvoices({agentId, brandId, rows})` so the engine reuses the exact DB-write path.
  (The HTTP route keeps working via the same extracted function.)

## 10. Sequence
- **Step 0 — Backups:** `pg_dump` unified DB `colonel_agent_accountant` → timestamped `.sql`;
  `cp -a <file> <file>.bak-<ts>` on every existing file touched.
- **Phase 1a — Koparo:** engine core + Koparo module + new agent/table/config, Drive-poll intake.
  Run real Koparo invoices → verify `invoice_code` output matches n8n output.
- **Phase 1b — Urban Plant:** add module (proves per-brand hooks) → verify.
- **Phase 1c — remaining 9 brands:** add modules from their JSONs (no TDS) → verify each.
- **Phase 2 — Koparo extras:** Gmail intake + OCR.space fallback + vendor-wise Drive move/label.
- **Phase 3 (optional):** deploy to AWS (separate, explicitly-approved step).

## 11. Verification
Per brand: run the same sample invoices through the engine and compare `invoice_code` rows against the
current n8n output sheet (field-by-field: amounts, GST, vendor, category, TDS, voucher, status, dedup count).

## 12. Notes / risks
- Urban Plant prompt dropped `batch_no`/`invoice_total` but its code still reads them (dormant) — shared
  table keeps both columns; each brand's prompt decides.
- Brand JSONs still reference retired **ngrok** hosts for `/api/n8n/feed` — irrelevant; engine writes to DB directly.
- **Security (flag, not acting):** `new-backend/config/google-credentials.json` (live SA key) and several
  live secrets in `.env` are committed — worth rotating / removing from version control.
