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
