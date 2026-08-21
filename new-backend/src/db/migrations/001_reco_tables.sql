-- ============================================================
-- Colonel Hero Database Migration — 001
-- Creates all result tables for every agent type.
-- Designed to run on each brand-specific PostgreSQL database.
-- Idempotent: all statements use IF NOT EXISTS / OR REPLACE.
-- ============================================================

-- Enable uuid generation (safe to run even if already enabled)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ────────────────────────────────────────────────────────────
-- 1.  reco_jobs  — one row per reconciliation run
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reco_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id        UUID        NOT NULL,
    agent_type      VARCHAR(50) NOT NULL,
    month           INTEGER,
    year            INTEGER,
    file_hash       VARCHAR(64),          -- SHA-256 of input file(s) — idempotency key
    status          VARCHAR(20) NOT NULL DEFAULT 'completed',
    total_rows      INTEGER DEFAULT 0,
    matched_rows    INTEGER DEFAULT 0,
    unmatched_rows  INTEGER DEFAULT 0,
    output_file_id  VARCHAR(36),          -- job UUID for Excel download
    created_by      UUID,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Idempotency: skip if same brand + agent + period + file already processed
CREATE UNIQUE INDEX IF NOT EXISTS reco_jobs_idempotency_idx
    ON reco_jobs (brand_id, agent_type, month, year, file_hash)
    WHERE file_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS reco_jobs_brand_type_idx ON reco_jobs (brand_id, agent_type);
CREATE INDEX IF NOT EXISTS reco_jobs_created_at_idx ON reco_jobs (created_at DESC);

-- Universal run-log: sales/marketplace agent runs also record here (via middleware).
-- source_name = the uploaded file name ("from where"). Idempotent.
ALTER TABLE reco_jobs ADD COLUMN IF NOT EXISTS source_name TEXT;

-- period_end_month/year: lets a job represent a month RANGE (e.g. Receivable Cycle's
-- "Generate Receivables" form) instead of only a single month. NULL for every other
-- agent and for single-month runs — metadata only, not a data filter.
ALTER TABLE reco_jobs ADD COLUMN IF NOT EXISTS period_end_month INTEGER;
ALTER TABLE reco_jobs ADD COLUMN IF NOT EXISTS period_end_year  INTEGER;

DROP INDEX IF EXISTS reco_jobs_idempotency_idx;
CREATE UNIQUE INDEX reco_jobs_idempotency_idx
    ON reco_jobs (brand_id, agent_type, month, year,
                  COALESCE(period_end_month, -1), COALESCE(period_end_year, -1), file_hash)
    WHERE file_hash IS NOT NULL;

-- ────────────────────────────────────────────────────────────
-- 2.  bank_reco_results  — classified bank statement rows
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_reco_results (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id       UUID         NOT NULL REFERENCES reco_jobs(id) ON DELETE CASCADE,
    brand_id     UUID         NOT NULL,
    txn_date     DATE,
    description  TEXT,
    debit        NUMERIC(15,2),
    credit       NUMERIC(15,2),
    balance      NUMERIC(15,2),
    txn_type     VARCHAR(50),
    ledger_name  VARCHAR(255),
    confidence   VARCHAR(20),             -- 'High' | 'Medium' | 'Low'
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bank_reco_results_job_id_idx   ON bank_reco_results (job_id);
CREATE INDEX IF NOT EXISTS bank_reco_results_brand_id_idx ON bank_reco_results (brand_id);
CREATE INDEX IF NOT EXISTS bank_reco_results_ledger_idx   ON bank_reco_results (ledger_name);

-- Deduplication: same transaction = same narration + date + amount + running balance.
-- Balance is cumulative so it's unique per transaction even when narration/amount repeats
-- (e.g. multiple "SC NEFT OTHER THAN SB IMB" charges on the same day each have a unique balance).
-- Idempotent upgrade: drop old index (without balance column) if present before recreating.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'bank_reco_results'
      AND indexname = 'bank_reco_results_txn_uq'
      AND indexdef NOT LIKE '%balance%'
  ) THEN
    EXECUTE 'DROP INDEX bank_reco_results_txn_uq';
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS bank_reco_results_txn_uq
    ON bank_reco_results (brand_id, description, txn_date,
                          COALESCE(debit, 0), COALESCE(credit, 0), COALESCE(balance, 0));

-- ────────────────────────────────────────────────────────────
-- 3.  gstr_2b_results  — GSTR-2B vs Books reconciliation rows
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gstr_2b_results (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id           UUID         NOT NULL REFERENCES reco_jobs(id) ON DELETE CASCADE,
    brand_id         UUID         NOT NULL,
    supplier_name    VARCHAR(255),
    supplier_gstin   VARCHAR(20),
    invoice_number   VARCHAR(100),
    invoice_date     DATE,
    taxable_value    NUMERIC(15,2),
    igst             NUMERIC(15,2),
    cgst             NUMERIC(15,2),
    sgst             NUMERIC(15,2),
    remark_1         VARCHAR(100),
    remark_2         TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gstr_2b_results_job_id_idx   ON gstr_2b_results (job_id);
CREATE INDEX IF NOT EXISTS gstr_2b_results_brand_id_idx ON gstr_2b_results (brand_id);

-- ────────────────────────────────────────────────────────────
-- 4.  gstr_2a_2b_results  — 3-way GSTR-2A / 2B / Books
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gstr_2a_2b_results (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id           UUID         NOT NULL REFERENCES reco_jobs(id) ON DELETE CASCADE,
    brand_id         UUID         NOT NULL,
    supplier_name    VARCHAR(255),
    supplier_gstin   VARCHAR(20),
    invoice_number   VARCHAR(100),
    invoice_date     DATE,
    taxable_value    NUMERIC(15,2),
    igst             NUMERIC(15,2),
    cgst             NUMERIC(15,2),
    sgst             NUMERIC(15,2),
    remark_1         VARCHAR(100),
    remark_2         TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gstr_2a_2b_results_job_id_idx   ON gstr_2a_2b_results (job_id);
CREATE INDEX IF NOT EXISTS gstr_2a_2b_results_brand_id_idx ON gstr_2a_2b_results (brand_id);

-- ────────────────────────────────────────────────────────────
-- 5.  gstr_3b_results  — GSTR-3B vs GSTR-2B ITC comparison
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gstr_3b_results (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id           UUID         NOT NULL REFERENCES reco_jobs(id) ON DELETE CASCADE,
    brand_id         UUID         NOT NULL,
    itc_type         VARCHAR(100),
    claimed_value    NUMERIC(15,2),
    available_value  NUMERIC(15,2),
    difference       NUMERIC(15,2),
    remark           VARCHAR(255),
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gstr_3b_results_job_id_idx   ON gstr_3b_results (job_id);
CREATE INDEX IF NOT EXISTS gstr_3b_results_brand_id_idx ON gstr_3b_results (brand_id);

-- ────────────────────────────────────────────────────────────
-- 6.  gstr_1_results  — GSTR-1 vs Books / Sales register
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gstr_1_results (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id           UUID         NOT NULL REFERENCES reco_jobs(id) ON DELETE CASCADE,
    brand_id         UUID         NOT NULL,
    invoice_number   VARCHAR(100),
    invoice_date     DATE,
    customer_name    VARCHAR(255),
    taxable_value    NUMERIC(15,2),
    igst             NUMERIC(15,2),
    cgst             NUMERIC(15,2),
    sgst             NUMERIC(15,2),
    remark_1         VARCHAR(100),
    remark_2         TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gstr_1_results_job_id_idx   ON gstr_1_results (job_id);
CREATE INDEX IF NOT EXISTS gstr_1_results_brand_id_idx ON gstr_1_results (brand_id);

-- Customer GSTIN for GSTR-1 analysis (added later; idempotent).
ALTER TABLE gstr_1_results ADD COLUMN IF NOT EXISTS gstin VARCHAR(20);

-- ────────────────────────────────────────────────────────────
-- 7.  bank_reco_corrections  — per-brand accountant corrections
--     Each row teaches the classifier: this narration → this ledger.
--     Corrections are applied BEFORE fuzzy matching on every future run.
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_reco_corrections (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id         UUID         NOT NULL,
    narration_raw    TEXT         NOT NULL,   -- exact Description string from the run
    narration_key    TEXT         NOT NULL,   -- UPPER + trim + collapse spaces
    correct_ledger   VARCHAR(255) NOT NULL,
    correct_type     VARCHAR(50),             -- 'Payment' | 'Receipt' | 'Contra'
    source           VARCHAR(20)  NOT NULL DEFAULT 'ui',  -- 'ui' | 'excel' | 'output_upload'
    created_at       TIMESTAMPTZ  DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  DEFAULT NOW(),
    CONSTRAINT bank_reco_corrections_brand_narration_uq UNIQUE (brand_id, narration_key)
);

CREATE INDEX IF NOT EXISTS bank_reco_corrections_brand_idx
    ON bank_reco_corrections (brand_id);

-- ────────────────────────────────────────────────────────────
-- Row Level Security
-- The Node backend sets "app.brand_id" per transaction.
-- Policies ensure a brand's data is never visible to another.
-- ────────────────────────────────────────────────────────────
ALTER TABLE reco_jobs              ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_reco_results      ENABLE ROW LEVEL SECURITY;
ALTER TABLE gstr_2b_results        ENABLE ROW LEVEL SECURITY;
ALTER TABLE gstr_2a_2b_results     ENABLE ROW LEVEL SECURITY;
ALTER TABLE gstr_3b_results        ENABLE ROW LEVEL SECURITY;
ALTER TABLE gstr_1_results         ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_reco_corrections  ENABLE ROW LEVEL SECURITY;

-- Force RLS even for superuser connections (backend runs as postgres)
ALTER TABLE reco_jobs              FORCE ROW LEVEL SECURITY;
ALTER TABLE bank_reco_results      FORCE ROW LEVEL SECURITY;
ALTER TABLE gstr_2b_results        FORCE ROW LEVEL SECURITY;
ALTER TABLE gstr_2a_2b_results     FORCE ROW LEVEL SECURITY;
ALTER TABLE gstr_3b_results        FORCE ROW LEVEL SECURITY;
ALTER TABLE gstr_1_results         FORCE ROW LEVEL SECURITY;
ALTER TABLE bank_reco_corrections  FORCE ROW LEVEL SECURITY;

-- Drop existing policies before recreating (idempotent)
DO $$ BEGIN
  DROP POLICY IF EXISTS reco_jobs_brand_policy              ON reco_jobs;
  DROP POLICY IF EXISTS bank_reco_brand_policy              ON bank_reco_results;
  DROP POLICY IF EXISTS gstr_2b_brand_policy                ON gstr_2b_results;
  DROP POLICY IF EXISTS gstr_2a_2b_brand_policy             ON gstr_2a_2b_results;
  DROP POLICY IF EXISTS gstr_3b_brand_policy                ON gstr_3b_results;
  DROP POLICY IF EXISTS gstr_1_brand_policy                 ON gstr_1_results;
  DROP POLICY IF EXISTS bank_reco_corrections_brand_policy  ON bank_reco_corrections;

  -- Migration bypass policies
  DROP POLICY IF EXISTS reco_jobs_migration_policy           ON reco_jobs;
  DROP POLICY IF EXISTS bank_reco_migration_policy           ON bank_reco_results;
  DROP POLICY IF EXISTS gstr_2b_migration_policy             ON gstr_2b_results;
  DROP POLICY IF EXISTS gstr_2a_2b_migration_policy          ON gstr_2a_2b_results;
  DROP POLICY IF EXISTS gstr_3b_migration_policy             ON gstr_3b_results;
  DROP POLICY IF EXISTS gstr_1_migration_policy              ON gstr_1_results;
  DROP POLICY IF EXISTS bank_reco_corrections_migration_policy ON bank_reco_corrections;
  DROP POLICY IF EXISTS gstr_3b_tally_brand_policy             ON gstr_3b_tally_results;
END $$;

-- Brand isolation policies: row is visible/writable only when
-- app.brand_id session variable matches the row's brand_id.
-- app.bypass_rls = 'true' is set during migrations and admin ops.
CREATE POLICY reco_jobs_brand_policy ON reco_jobs
    USING (
        current_setting('app.bypass_rls', true) = 'true'
        OR brand_id::text = current_setting('app.brand_id', true)
    );

CREATE POLICY bank_reco_brand_policy ON bank_reco_results
    USING (
        current_setting('app.bypass_rls', true) = 'true'
        OR brand_id::text = current_setting('app.brand_id', true)
    );

CREATE POLICY gstr_2b_brand_policy ON gstr_2b_results
    USING (
        current_setting('app.bypass_rls', true) = 'true'
        OR brand_id::text = current_setting('app.brand_id', true)
    );

CREATE POLICY gstr_2a_2b_brand_policy ON gstr_2a_2b_results
    USING (
        current_setting('app.bypass_rls', true) = 'true'
        OR brand_id::text = current_setting('app.brand_id', true)
    );

CREATE POLICY gstr_3b_brand_policy ON gstr_3b_results
    USING (
        current_setting('app.bypass_rls', true) = 'true'
        OR brand_id::text = current_setting('app.brand_id', true)
    );

CREATE POLICY gstr_1_brand_policy ON gstr_1_results
    USING (
        current_setting('app.bypass_rls', true) = 'true'
        OR brand_id::text = current_setting('app.brand_id', true)
    );

CREATE POLICY bank_reco_corrections_brand_policy ON bank_reco_corrections
    USING (
        current_setting('app.bypass_rls', true) = 'true'
        OR brand_id::text = current_setting('app.brand_id', true)
    );

-- ────────────────────────────────────────────────────────────
-- 8.  gstr_3b_tally_results  — GSTR-3B Tally Entry journal rows
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gstr_3b_tally_results (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id       UUID NOT NULL REFERENCES reco_jobs(id) ON DELETE CASCADE,
    brand_id     UUID NOT NULL,
    row_type     VARCHAR(20),
    sno          VARCHAR(20),
    particulars  TEXT,
    debit        NUMERIC(15,2),
    credit       NUMERIC(15,2),
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gstr_3b_tally_results_job_id_idx   ON gstr_3b_tally_results (job_id);
CREATE INDEX IF NOT EXISTS gstr_3b_tally_results_brand_id_idx ON gstr_3b_tally_results (brand_id);

ALTER TABLE gstr_3b_tally_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE gstr_3b_tally_results FORCE ROW LEVEL SECURITY;

-- Idempotent: drop before create so re-running the migration never throws
-- "policy already exists" (which would roll back the whole transaction and
-- prevent later tables in this file from being created on existing brand DBs).
DROP POLICY IF EXISTS gstr_3b_tally_brand_policy ON gstr_3b_tally_results;
CREATE POLICY gstr_3b_tally_brand_policy ON gstr_3b_tally_results
    USING (
        current_setting('app.bypass_rls', true) = 'true'
        OR brand_id::text = current_setting('app.brand_id', true)
    );

-- ────────────────────────────────────────────────────────────
-- 9.  ledger_master  — per-brand Chart of Accounts (COA), DB-backed.
--     Replaces the non-portable disk cache (output/ledgers/*.xlsx). One row per
--     unique ledger name. Populated when an accountant uploads a COA in the UI;
--     every reco run fetches the FULL list from here. Shared Postgres → identical
--     across Colonel Full (3001) and this app (ngrok/3000).
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ledger_master (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id         UUID         NOT NULL,
    ledger_name      VARCHAR(255) NOT NULL,
    ledger_name_key  TEXT         NOT NULL,   -- UPPER + trim + collapse spaces (dedup key)
    source           VARCHAR(20)  NOT NULL DEFAULT 'upload',  -- 'upload' | 'correction'
    created_at       TIMESTAMPTZ  DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  DEFAULT NOW(),
    CONSTRAINT ledger_master_brand_name_uq UNIQUE (brand_id, ledger_name_key)
);

CREATE INDEX IF NOT EXISTS ledger_master_brand_idx ON ledger_master (brand_id);

ALTER TABLE ledger_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_master FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ledger_master_brand_policy ON ledger_master;
CREATE POLICY ledger_master_brand_policy ON ledger_master
    USING (
        current_setting('app.bypass_rls', true) = 'true'
        OR brand_id::text = current_setting('app.brand_id', true)
    );

-- ────────────────────────────────────────────────────────────
-- 10.  receivable_cycle_results — row-level storage for the Receivable Cycle
--      agent's Main Sheet + per-courier COD sub-sheets. Unlike every other
--      *_results table above, this agent's output has ~90 columns across 6
--      differently-shaped sheets, so rows are stored as a JSON blob per
--      source row (sheet_name + row_data) instead of a rigid flat schema —
--      the frontend derives table columns dynamically from row keys.
--      row_data is JSON, not JSONB: JSONB re-serializes object keys sorted by
--      (length, then lexicographic) and does NOT preserve original key order,
--      which silently scrambled the Excel's column order in the web "View"
--      (short keys like "2"/"3"/"4"/"IRN"/"Qty" jumped to the front).
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS receivable_cycle_results (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id       UUID NOT NULL REFERENCES reco_jobs(id) ON DELETE CASCADE,
    brand_id     UUID NOT NULL,
    sheet_name   VARCHAR(50) NOT NULL,
    row_index    INTEGER NOT NULL,
    row_data     JSON NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Idempotent upgrade path: fix an already-created table that still has the old JSONB column.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'receivable_cycle_results'
      AND column_name = 'row_data' AND data_type = 'jsonb'
  ) THEN
    ALTER TABLE receivable_cycle_results ALTER COLUMN row_data TYPE json USING row_data::json;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS receivable_cycle_results_job_id_idx ON receivable_cycle_results (job_id);
CREATE INDEX IF NOT EXISTS receivable_cycle_results_brand_sheet_idx ON receivable_cycle_results (brand_id, sheet_name);

ALTER TABLE receivable_cycle_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE receivable_cycle_results FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS receivable_cycle_results_brand_policy ON receivable_cycle_results;
CREATE POLICY receivable_cycle_results_brand_policy ON receivable_cycle_results
    USING (
        current_setting('app.bypass_rls', true) = 'true'
        OR brand_id::text = current_setting('app.brand_id', true)
    );

-- ────────────────────────────────────────────────────────────
-- 11.  receivable_cycle_imports — raw storage for historical Receivable Cycle
--      source files (e.g. a prior year's already-built Main Sheet/COD sheets
--      workbook, or a raw Combined SRN register) that predate the reco_jobs
--      upload pipeline and so have no job_id to hang off of. Same
--      row-per-sheet-row JSON-blob shape as receivable_cycle_results above,
--      for the same reason (many differently-named columns across sheets;
--      JSON, not JSONB, preserves original column order).
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS receivable_cycle_imports (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id     UUID NOT NULL DEFAULT NULLIF(current_setting('app.brand_id', true), '')::uuid,
    source_file  VARCHAR(255) NOT NULL,
    sheet_name   VARCHAR(64) NOT NULL,
    row_index    INTEGER NOT NULL,
    row_data     JSON NOT NULL,
    -- 022: which parser this row feeds ('tally' | 'delhivery' | 'ekart' | 'xpressbees' | 'srn') —
    -- lets receivableLedgerBuilder.js source rows by role instead of a hardcoded literal filename.
    role         VARCHAR(16),
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS receivable_cycle_imports_brand_source_idx ON receivable_cycle_imports (brand_id, source_file, sheet_name);
CREATE INDEX IF NOT EXISTS receivable_cycle_imports_brand_role_idx ON receivable_cycle_imports (brand_id, role);

ALTER TABLE receivable_cycle_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE receivable_cycle_imports FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS receivable_cycle_imports_brand_policy ON receivable_cycle_imports;
CREATE POLICY receivable_cycle_imports_brand_policy ON receivable_cycle_imports
    USING (
        current_setting('app.bypass_rls', true) = 'true'
        OR brand_id::text = current_setting('app.brand_id', true)
    );

-- ────────────────────────────────────────────────────────────
-- 12.  receivable_ledger — persistent, order-level, cross-year/cross-source
--      reconciliation state powering the Receivable Cycle global dashboard.
--      One row per sale order (keyed by AWB, or invoice number when no AWB),
--      kept across every file/run ever loaded for a brand, so a courier
--      settlement or SRN return arriving months later than the sale can
--      still be matched back to the right original order. settled_flag and
--      returned_flag are independent facts (not one enum) since an order can
--      be settled in month X and still returned in month Y afterwards.
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS receivable_ledger (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id          UUID NOT NULL DEFAULT NULLIF(current_setting('app.brand_id', true), '')::uuid,
    awb               VARCHAR(64) NOT NULL DEFAULT '',
    invoice_key       VARCHAR(64) NOT NULL DEFAULT '',
    invoice_number    VARCHAR(64),
    sale_order_number VARCHAR(64),
    order_date        DATE,
    order_month       INTEGER NOT NULL,
    order_year        INTEGER NOT NULL,
    payment_method    VARCHAR(16) NOT NULL,
    courier           VARCHAR(32) NOT NULL DEFAULT '',
    total_amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
    settled_flag      BOOLEAN NOT NULL DEFAULT FALSE,
    settled_amount    NUMERIC(14,2),
    settled_month     INTEGER,
    settled_year      INTEGER,
    settled_source    VARCHAR(32),
    returned_flag     BOOLEAN NOT NULL DEFAULT FALSE,
    returned_amount   NUMERIC(14,2),
    returned_month    INTEGER,
    returned_year     INTEGER,
    source_file       VARCHAR(255),
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS receivable_ledger_awb_uidx ON receivable_ledger (brand_id, awb) WHERE awb <> '';
CREATE UNIQUE INDEX IF NOT EXISTS receivable_ledger_invoice_uidx ON receivable_ledger (brand_id, invoice_key) WHERE awb = '' AND invoice_key <> '';
CREATE INDEX IF NOT EXISTS receivable_ledger_order_month_idx ON receivable_ledger (brand_id, order_year, order_month);
CREATE INDEX IF NOT EXISTS receivable_ledger_settled_month_idx ON receivable_ledger (brand_id, settled_year, settled_month);
CREATE INDEX IF NOT EXISTS receivable_ledger_returned_month_idx ON receivable_ledger (brand_id, returned_year, returned_month);

ALTER TABLE receivable_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE receivable_ledger FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS receivable_ledger_brand_policy ON receivable_ledger;
CREATE POLICY receivable_ledger_brand_policy ON receivable_ledger
    USING (
        current_setting('app.bypass_rls', true) = 'true'
        OR brand_id::text = current_setting('app.brand_id', true)
    );

-- receivable_ledger_unmatched — settlement/SRN rows whose AWB/invoice doesn't
-- match any known ledger order, logged instead of silently dropped.
CREATE TABLE IF NOT EXISTS receivable_ledger_unmatched (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL DEFAULT NULLIF(current_setting('app.brand_id', true), '')::uuid,
    match_key   VARCHAR(64) NOT NULL,
    source      VARCHAR(32) NOT NULL,
    amount      NUMERIC(14,2),
    source_file VARCHAR(255),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS receivable_ledger_unmatched_brand_idx ON receivable_ledger_unmatched (brand_id, source);

ALTER TABLE receivable_ledger_unmatched ENABLE ROW LEVEL SECURITY;
ALTER TABLE receivable_ledger_unmatched FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS receivable_ledger_unmatched_brand_policy ON receivable_ledger_unmatched;
CREATE POLICY receivable_ledger_unmatched_brand_policy ON receivable_ledger_unmatched
    USING (
        current_setting('app.bypass_rls', true) = 'true'
        OR brand_id::text = current_setting('app.brand_id', true)
    );

-- receivable_ledger.channel — which sales portal/channel an order came from
-- (Shopify, Amazon, Flipkart, etc.), bucketed from the Tally row's raw
-- "Channel Ledger" value. Powers the "Total sales" KPI's by-portal drill-down.
ALTER TABLE receivable_ledger ADD COLUMN IF NOT EXISTS channel VARCHAR(64) NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS receivable_ledger_channel_idx ON receivable_ledger (brand_id, channel);
