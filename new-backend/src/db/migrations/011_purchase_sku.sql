-- ============================================================
-- Colonel Migration — 011  ·  Purchase-Invoice → Tally
-- Two tables backing the SKU-mapping ladder for the Purchase
-- Invoice mode (Urban Plant first). Unified DB — brand-scoped
-- by brand_id. Idempotent (IF NOT EXISTS).
--   • purchase_sku          — the master (Description → Name-as-per-Tally)
--   • purchase_sku_learned  — every manual pick, so it auto-maps next time
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ────────────────────────────────────────────────────────────
-- 1.  purchase_sku  — the editable master (imported from the CA's sheet)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_sku (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id     UUID        NOT NULL,
    description  TEXT        NOT NULL,          -- vendor's invoice line text (col A)
    sku          TEXT,                          -- internal SKU (col B)
    tally_name   TEXT        NOT NULL,          -- "Name as per Tally" (col C) → Stock Item
    created_by   UUID,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_purchase_sku_brand      ON purchase_sku (brand_id);
CREATE INDEX IF NOT EXISTS idx_purchase_sku_brand_desc ON purchase_sku (brand_id, lower(description));

-- ────────────────────────────────────────────────────────────
-- 2.  purchase_sku_learned  — write-back of every manual resolution
--     keyed by vendor + normalized description (+ rate) → the chosen Tally name,
--     so the SAME vendor line is an EXACT hit on the next invoice.
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_sku_learned (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id          UUID        NOT NULL,
    vendor_gstin      TEXT,                      -- seller GSTIN this pick applies to
    description_norm  TEXT        NOT NULL,       -- normalized invoice line (match key)
    description_raw   TEXT,                       -- as seen on the invoice (audit)
    rate              NUMERIC,                    -- unit rate at pick time (disambiguates)
    sku               TEXT,
    tally_name        TEXT        NOT NULL,
    created_by        UUID,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_psl_lookup ON purchase_sku_learned (brand_id, vendor_gstin, description_norm);

-- ────────────────────────────────────────────────────────────
-- 3.  Row-Level Security (unified DB) — same pattern as reco_jobs:
--     the app connects as non-superuser colonel_app with app.brand_id preset;
--     each brand sees ONLY its own rows. Only the postgres superuser bypasses
--     (no client-settable bypass — golden rule #4). Safe to re-run.
-- ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'colonel_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_sku TO colonel_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_sku_learned TO colonel_app';
  END IF;
END $$;

ALTER TABLE purchase_sku          ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_sku          FORCE  ROW LEVEL SECURITY;
ALTER TABLE purchase_sku_learned  ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_sku_learned  FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS purchase_sku_tenant_isolation ON purchase_sku;
CREATE POLICY purchase_sku_tenant_isolation ON purchase_sku
  USING      ((brand_id)::text = current_setting('app.brand_id', true))
  WITH CHECK ((brand_id)::text = current_setting('app.brand_id', true));

DROP POLICY IF EXISTS purchase_sku_learned_tenant_isolation ON purchase_sku_learned;
CREATE POLICY purchase_sku_learned_tenant_isolation ON purchase_sku_learned
  USING      ((brand_id)::text = current_setting('app.brand_id', true))
  WITH CHECK ((brand_id)::text = current_setting('app.brand_id', true));
