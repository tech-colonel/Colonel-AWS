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
`;

async function migrateTally() {
  try {
    await masterSequelize.query(SQL);
    console.log('[TALLY MIGRATE] ✅ Tally mirror tables ready (master DB)');
  } catch (e) {
    console.error('[TALLY MIGRATE] ❌', e.message);
  }
}

module.exports = { migrateTally };
