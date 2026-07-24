-- ============================================================
-- 100_invoice_code_agent.sql
-- In-app "Invoice code" engine (code replacement for the n8n invoice flow).
--
-- PURELY ADDITIVE — creates a NEW agent + NEW table, isolated from the live
-- "Invoice Process" agent / invoice_process table (which is left 100% untouched
-- so accountants keep using the existing n8n workflows).
--
--   psql -U postgres -d colonel_agent_accountant -f db-restructure/100_invoice_code_agent.sql
--
-- Rollback: see 100_invoice_code_agent_rollback.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── 1. invoice_code table ───────────────────────────────────────────────
-- Mirror of invoice_process (same column types/text convention) PLUS two new
-- nullable columns: batch_no (Koparo batch invoices) and creditors (Urban Plant).
CREATE TABLE IF NOT EXISTS invoice_code (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id       UUID NOT NULL,
    processed_on   TIMESTAMPTZ,
    company        TEXT,
    vendor_name_tally TEXT,
    invoice_number TEXT,
    invoice_date   TEXT,
    due_date       TEXT,
    seller_gstin   TEXT,
    buyer_gstin    TEXT,
    voucher_type   TEXT,
    category       TEXT,
    product_name   TEXT,
    hsn_code       TEXT,
    quantity       INTEGER,
    unit           TEXT,
    rate           TEXT,
    cgst_rate      TEXT,
    sgst_rate      TEXT,
    igst_rate      TEXT,
    cgst_amount    TEXT,
    sgst_amount    TEXT,
    igst_amount    TEXT,
    gst_amount     TEXT,
    taxable_value  TEXT,
    invoice_link   TEXT,
    status         TEXT,
    tds_section    TEXT,
    tds_rate       TEXT,
    tds_amount     TEXT,
    batch_no       TEXT,
    creditors      TEXT,
    created_at     TIMESTAMPTZ,
    updated_at     TIMESTAMPTZ,
    created_by     UUID,
    month          INTEGER,
    year           INTEGER,
    file_type      TEXT,
    inventory_type TEXT,
    filename       TEXT
);

CREATE INDEX IF NOT EXISTS invoice_code_brand_idx ON invoice_code (brand_id);
CREATE INDEX IF NOT EXISTS invoice_code_filename_idx ON invoice_code (filename);

-- RLS — identical hardened form to invoice_process (no bypass clause).
ALTER TABLE invoice_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_code FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoice_code_tenant_isolation ON invoice_code;
CREATE POLICY invoice_code_tenant_isolation ON invoice_code
    USING ((brand_id)::text = current_setting('app.brand_id', true));

-- App role must be able to read/write (postgres owns the table & bypasses RLS).
GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_code TO colonel_app;

-- ── 2. brand_agents.invoice_config (Pattern A: per brand+agent JSONB) ────
ALTER TABLE brand_agents ADD COLUMN IF NOT EXISTS invoice_config jsonb DEFAULT '{}'::jsonb;

-- ── 3. The new "Invoice code" agent ─────────────────────────────────────
-- columns = Invoice Process's 26 columns + batch_no + creditors, so the dynamic
-- model (getDynamicModel) attaches exactly the invoice_code data columns.
INSERT INTO agents (id, name, description, columns, "createdAt", "updatedAt")
SELECT
    gen_random_uuid(),
    'Invoice code',
    'In-app code engine replacing the n8n invoice automation (parallel to Invoice Process).',
    '[
      {"name":"processed_on","type":"DATE"},
      {"name":"company","type":"STRING"},
      {"name":"vendor_name_tally","type":"STRING"},
      {"name":"invoice_number","type":"STRING"},
      {"name":"invoice_date","type":"DATE"},
      {"name":"due_date","type":"DATE"},
      {"name":"seller_gstin","type":"STRING"},
      {"name":"buyer_gstin","type":"STRING"},
      {"name":"voucher_type","type":"STRING"},
      {"name":"category","type":"STRING"},
      {"name":"product_name","type":"TEXT"},
      {"name":"hsn_code","type":"STRING"},
      {"name":"quantity","type":"INTEGER"},
      {"name":"unit","type":"STRING"},
      {"name":"rate","type":"FLOAT"},
      {"name":"cgst_rate","type":"FLOAT"},
      {"name":"sgst_rate","type":"FLOAT"},
      {"name":"igst_rate","type":"FLOAT"},
      {"name":"cgst_amount","type":"FLOAT"},
      {"name":"sgst_amount","type":"FLOAT"},
      {"name":"igst_amount","type":"FLOAT"},
      {"name":"gst_amount","type":"FLOAT"},
      {"name":"taxable_value","type":"FLOAT"},
      {"name":"invoice_link","type":"TEXT"},
      {"name":"status","type":"STRING"},
      {"name":"tds_section","type":"STRING"},
      {"name":"tds_rate","type":"FLOAT"},
      {"name":"tds_amount","type":"FLOAT"},
      {"name":"batch_no","type":"STRING"},
      {"name":"creditors","type":"STRING"}
    ]'::jsonb,
    NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM agents WHERE name = 'Invoice code');

-- ── 4. Koparo config for the Invoice code agent (Pattern A JSONB) ────────
-- variant + Drive intake folder + Vendor Master sheet. TDS master & category
-- master live in code (brands/koparo.js), selected by "variant".
INSERT INTO brand_agents (id, brand_id, agent_id, sku_master, ledger_master, invoice_config, "createdAt", "updatedAt")
SELECT
    gen_random_uuid(),
    b.id,
    a.id,
    '[]'::jsonb,
    '[]'::jsonb,
    '{
      "variant": "koparo",
      "enabled": true,
      "intake": "drive-poll",
      "driveFolderId": "1ywK4YwD6Jhh9OFpo87z10_g6ALijnM5Y",
      "vendorMaster": {
        "sheetId": "1YxpTZSnpus_B8vK4VvFytVkbsj3LOJwTWsuQhjQTr2g",
        "gid": "1330282311",
        "sheetName": "Vendor Master"
      }
    }'::jsonb,
    NOW(), NOW()
FROM brands b, agents a
WHERE b.name ILIKE 'koparo' AND a.name = 'Invoice code'
  AND NOT EXISTS (
      SELECT 1 FROM brand_agents ba WHERE ba.brand_id = b.id AND ba.agent_id = a.id
  );

-- If the (Koparo, Invoice code) brand_agents row already existed, make sure its
-- invoice_config is set (idempotent top-up).
UPDATE brand_agents ba
SET invoice_config = '{
      "variant": "koparo",
      "enabled": true,
      "intake": "drive-poll",
      "driveFolderId": "1ywK4YwD6Jhh9OFpo87z10_g6ALijnM5Y",
      "vendorMaster": {
        "sheetId": "1YxpTZSnpus_B8vK4VvFytVkbsj3LOJwTWsuQhjQTr2g",
        "gid": "1330282311",
        "sheetName": "Vendor Master"
      }
    }'::jsonb
FROM brands b, agents a
WHERE ba.brand_id = b.id AND ba.agent_id = a.id
  AND b.name ILIKE 'koparo' AND a.name = 'Invoice code'
  AND (ba.invoice_config IS NULL OR ba.invoice_config = '{}'::jsonb);
