/**
 * tallyMigrate.js — creates the Tally mirror tables in the MASTER DB.
 * Idempotent (CREATE TABLE IF NOT EXISTS) → safe to run on every boot.
 *
 * Data arrives from the Colonel Tally Connector (tally-connector/), a small app
 * on the client's Tally PC that reads Tally over its XML port (fixed at 9002)
 * and pushes here. Admin-only for now, so — like the Zoho mirror — these are
 * master tables with no RLS; brand_id on tally_companies is an optional link
 * for when the data is surfaced brand-side.
 *
 *   tally_connectors  (one per installed connector; token stored as sha256 only)
 *   tally_companies   (one per Tally company; holds the sync watermark)
 *     → tally_ledgers   [company_id, guid]   full replace every sync
 *     → tally_vouchers  [company_id, guid]   incremental by Tally AlterID
 *     → tally_sync_runs                       one row per sync, for the admin log
 */

const { masterSequelize } = require('../config/database');
const { autoLinkCompanies } = require('../services/tallyBrandMatch');

const SQL = `
CREATE TABLE IF NOT EXISTS tally_connectors (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL,
  token_hash         TEXT NOT NULL UNIQUE,
  token_prefix       TEXT,
  machine_name       TEXT,
  connector_version  TEXT,
  tally_host         TEXT,
  tally_port         INT,
  last_status        TEXT,            -- ok | tally_unreachable | error
  last_error         TEXT,
  last_seen_at       TIMESTAMPTZ,
  last_ip            TEXT,
  created_at         TIMESTAMPTZ DEFAULT now(),
  revoked_at         TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS tally_companies (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_key            TEXT NOT NULL UNIQUE,   -- Tally company GUID, or 'name:<name>' if absent
  connector_id           UUID,
  brand_id               UUID,
  name                   TEXT NOT NULL,
  books_from             DATE,
  raw                    JSONB,
  last_voucher_alter_id  BIGINT NOT NULL DEFAULT 0,
  last_alt_vch_id        BIGINT,
  last_alt_mst_id        BIGINT,
  last_sync_at           TIMESTAMPTZ,
  last_sync_status       TEXT,
  last_error             TEXT,
  last_reconcile_at      TIMESTAMPTZ,
  created_at             TIMESTAMPTZ DEFAULT now(),
  updated_at             TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tally_ledgers (
  id               BIGSERIAL PRIMARY KEY,
  company_id       UUID NOT NULL,
  guid             TEXT NOT NULL,
  name             TEXT,
  parent           TEXT,
  opening_balance  NUMERIC(18,2),
  closing_balance  NUMERIC(18,2),
  gstin            TEXT,
  alter_id         BIGINT,
  sync_run_id      BIGINT,
  synced_at        TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT tally_ledgers_uq UNIQUE (company_id, guid)
);
CREATE INDEX IF NOT EXISTS idx_tally_ledgers_company_name ON tally_ledgers (company_id, name);

CREATE TABLE IF NOT EXISTS tally_vouchers (
  id               BIGSERIAL PRIMARY KEY,
  company_id       UUID NOT NULL,
  guid             TEXT NOT NULL,
  voucher_date     DATE,
  voucher_type     TEXT,
  voucher_number   TEXT,
  party_name       TEXT,
  amount           NUMERIC(18,2),
  narration        TEXT,
  is_cancelled     BOOLEAN DEFAULT false,
  is_optional      BOOLEAN DEFAULT false,
  alter_id         BIGINT,
  ledger_entries   JSONB,
  synced_at        TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT tally_vouchers_uq UNIQUE (company_id, guid)
);
CREATE INDEX IF NOT EXISTS idx_tally_vouchers_company_date ON tally_vouchers (company_id, voucher_date DESC);

CREATE TABLE IF NOT EXISTS tally_sync_runs (
  id            BIGSERIAL PRIMARY KEY,
  company_id    UUID,
  connector_id  UUID,
  started_at    TIMESTAMPTZ DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  status        TEXT,               -- running | ok | error
  counts        JSONB,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_tally_sync_runs_company ON tally_sync_runs (company_id, started_at DESC);

-- ── v2: everything else Tally knows about the company ──────────────────────
-- profile/details are JSONB: Tally's shape varies by version and feature set.
ALTER TABLE tally_companies ADD COLUMN IF NOT EXISTS profile       JSONB;
ALTER TABLE tally_companies ADD COLUMN IF NOT EXISTS data_version  INT NOT NULL DEFAULT 1;
ALTER TABLE tally_companies ADD COLUMN IF NOT EXISTS bills_run_id  BIGINT;
ALTER TABLE tally_ledgers   ADD COLUMN IF NOT EXISTS details       JSONB;
ALTER TABLE tally_vouchers  ADD COLUMN IF NOT EXISTS details       JSONB;
CREATE INDEX IF NOT EXISTS idx_tally_vouchers_lines ON tally_vouchers USING GIN (ledger_entries jsonb_path_ops);

-- Groups, voucher types, stock items/groups, godowns, units, currencies, cost centres.
CREATE TABLE IF NOT EXISTS tally_masters (
  id           BIGSERIAL PRIMARY KEY,
  company_id   UUID NOT NULL,
  kind         TEXT NOT NULL,
  guid         TEXT NOT NULL,
  name         TEXT,
  parent       TEXT,
  data         JSONB,
  sync_run_id  BIGINT,
  synced_at    TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT tally_masters_uq UNIQUE (company_id, kind, guid)
);
CREATE INDEX IF NOT EXISTS idx_tally_masters_kind ON tally_masters (company_id, kind, name);

-- Outstanding bills. Replaced in full each sync; the set in force is the one
-- from tally_companies.bills_run_id, so a half-finished sync is never shown.
CREATE TABLE IF NOT EXISTS tally_bills (
  id             BIGSERIAL PRIMARY KEY,
  company_id     UUID NOT NULL,
  party          TEXT NOT NULL,
  name           TEXT,
  bill_date      DATE,
  credit_period  TEXT,
  closing        NUMERIC(18,2),          -- negative = receivable (Dr), positive = payable (Cr)
  is_advance     BOOLEAN DEFAULT false,
  sync_run_id    BIGINT
);
CREATE INDEX IF NOT EXISTS idx_tally_bills_company ON tally_bills (company_id, sync_run_id, party);

-- ── v3: brand_id on every data table ────────────────────────────────────────
-- A company belongs to a brand (tally_companies.brand_id, set by name match or by
-- an admin). Every row below carries that brand_id too, so a brand's data can be
-- read directly by brand_id. Triggers keep it correct: new rows copy it from their
-- company, and linking/unlinking a company re-stamps its rows.
ALTER TABLE tally_companies ADD COLUMN IF NOT EXISTS auto_link_off BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tally_ledgers   ADD COLUMN IF NOT EXISTS brand_id UUID;
ALTER TABLE tally_vouchers  ADD COLUMN IF NOT EXISTS brand_id UUID;
ALTER TABLE tally_masters   ADD COLUMN IF NOT EXISTS brand_id UUID;
ALTER TABLE tally_bills     ADD COLUMN IF NOT EXISTS brand_id UUID;
ALTER TABLE tally_sync_runs ADD COLUMN IF NOT EXISTS brand_id UUID;
CREATE INDEX IF NOT EXISTS idx_tally_companies_brand ON tally_companies (brand_id);
CREATE INDEX IF NOT EXISTS idx_tally_ledgers_brand   ON tally_ledgers  (brand_id, name);
CREATE INDEX IF NOT EXISTS idx_tally_vouchers_brand  ON tally_vouchers (brand_id, voucher_date DESC);
CREATE INDEX IF NOT EXISTS idx_tally_masters_brand   ON tally_masters  (brand_id, kind, name);
CREATE INDEX IF NOT EXISTS idx_tally_bills_brand     ON tally_bills    (brand_id, party);
CREATE INDEX IF NOT EXISTS idx_tally_sync_runs_brand ON tally_sync_runs (brand_id, started_at DESC);

CREATE OR REPLACE FUNCTION tally_stamp_brand() RETURNS trigger AS $fn$
BEGIN
  NEW.brand_id := (SELECT brand_id FROM tally_companies WHERE id = NEW.company_id);
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION tally_cascade_brand() RETURNS trigger AS $fn$
BEGIN
  IF NEW.brand_id IS DISTINCT FROM OLD.brand_id THEN
    UPDATE tally_ledgers   SET brand_id = NEW.brand_id WHERE company_id = NEW.id;
    UPDATE tally_vouchers  SET brand_id = NEW.brand_id WHERE company_id = NEW.id;
    UPDATE tally_masters   SET brand_id = NEW.brand_id WHERE company_id = NEW.id;
    UPDATE tally_bills     SET brand_id = NEW.brand_id WHERE company_id = NEW.id;
    UPDATE tally_sync_runs SET brand_id = NEW.brand_id WHERE company_id = NEW.id;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

DO $do$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['tally_ledgers','tally_vouchers','tally_masters','tally_bills','tally_sync_runs'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_brand ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_brand BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION tally_stamp_brand()', t, t);
  END LOOP;
END $do$;
DROP TRIGGER IF EXISTS trg_tally_companies_brand ON tally_companies;
CREATE TRIGGER trg_tally_companies_brand AFTER UPDATE OF brand_id ON tally_companies
  FOR EACH ROW EXECUTE FUNCTION tally_cascade_brand();

-- one-time backfill of rows that pre-date v3
UPDATE tally_ledgers   x SET brand_id = c.brand_id FROM tally_companies c WHERE c.id = x.company_id AND x.brand_id IS NULL AND c.brand_id IS NOT NULL;
UPDATE tally_vouchers  x SET brand_id = c.brand_id FROM tally_companies c WHERE c.id = x.company_id AND x.brand_id IS NULL AND c.brand_id IS NOT NULL;
UPDATE tally_masters   x SET brand_id = c.brand_id FROM tally_companies c WHERE c.id = x.company_id AND x.brand_id IS NULL AND c.brand_id IS NOT NULL;
UPDATE tally_bills     x SET brand_id = c.brand_id FROM tally_companies c WHERE c.id = x.company_id AND x.brand_id IS NULL AND c.brand_id IS NOT NULL;
UPDATE tally_sync_runs x SET brand_id = c.brand_id FROM tally_companies c WHERE c.id = x.company_id AND x.brand_id IS NULL AND c.brand_id IS NOT NULL;
`;

async function migrateTally() {
  try {
    await masterSequelize.query(SQL);
    console.log('[TALLY MIGRATE] ✅ Tally mirror tables ready (master DB)');
    // Companies already synced: link any whose name equals a brand's name.
    const { linked, unmatched } = await autoLinkCompanies();
    if (linked.length || unmatched.length) console.log(`[TALLY MIGRATE] brand match: linked ${linked.length}, unmatched ${unmatched.length}`);
  } catch (e) {
    console.error('[TALLY MIGRATE] ❌', e.message);
  }
}

module.exports = { migrateTally };
