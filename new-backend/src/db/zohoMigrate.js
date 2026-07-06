/**
 * zohoMigrate.js — creates the Zoho Books mirror tables in the MASTER DB.
 * Idempotent (CREATE TABLE IF NOT EXISTS) → safe to run on every boot.
 *
 * Segregation & drill-down:
 *   zoho_organizations (BRANDS)
 *     → zoho_accounts   (chart of accounts / ledgers)   [organization_id]
 *     → zoho_contacts   (customers + vendors)            [organization_id]
 *     → zoho_items                                        [organization_id]
 *     → zoho_vouchers   (ALL transactions, typed)         [organization_id, contact_id]
 *   Every row keeps the full Zoho payload in `raw` (JSONB) so nothing is lost.
 */

const { masterSequelize } = require('../config/database');

const SQL = `
CREATE TABLE IF NOT EXISTS zoho_organizations (
  organization_id  TEXT PRIMARY KEY,
  name             TEXT,
  currency_code    TEXT,
  raw              JSONB,
  synced_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS zoho_accounts (
  account_id       TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL,
  account_name     TEXT,
  account_type     TEXT,
  is_active        BOOLEAN,
  raw              JSONB,
  synced_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_zoho_accounts_org ON zoho_accounts (organization_id);

CREATE TABLE IF NOT EXISTS zoho_contacts (
  contact_id       TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL,
  contact_name     TEXT,
  company_name     TEXT,
  contact_type     TEXT,            -- 'customer' | 'vendor'
  email            TEXT,
  phone            TEXT,
  outstanding      NUMERIC,
  raw              JSONB,
  synced_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_zoho_contacts_org  ON zoho_contacts (organization_id);
CREATE INDEX IF NOT EXISTS idx_zoho_contacts_type ON zoho_contacts (organization_id, contact_type);

CREATE TABLE IF NOT EXISTS zoho_items (
  item_id          TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL,
  name             TEXT,
  rate             NUMERIC,
  status           TEXT,
  raw              JSONB,
  synced_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_zoho_items_org ON zoho_items (organization_id);

CREATE TABLE IF NOT EXISTS zoho_vouchers (
  id               BIGSERIAL PRIMARY KEY,
  organization_id  TEXT NOT NULL,
  voucher_type     TEXT NOT NULL,   -- invoice, bill, expense, purchase_order, sales_order,
                                    -- estimate, credit_note, vendor_credit,
                                    -- customer_payment, vendor_payment, journal
  zoho_id          TEXT NOT NULL,
  number           TEXT,
  voucher_date     DATE,
  contact_id       TEXT,
  contact_name     TEXT,
  status           TEXT,
  total            NUMERIC,
  raw              JSONB,
  synced_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE (voucher_type, zoho_id)
);
CREATE INDEX IF NOT EXISTS idx_zoho_vouchers_org      ON zoho_vouchers (organization_id);
CREATE INDEX IF NOT EXISTS idx_zoho_vouchers_contact  ON zoho_vouchers (organization_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_zoho_vouchers_type     ON zoho_vouchers (organization_id, voucher_type);

CREATE TABLE IF NOT EXISTS zoho_bank_accounts (
  account_id       TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL,
  account_name     TEXT,
  account_type     TEXT,            -- bank | cash | credit_card | ...
  bank_name        TEXT,
  account_number   TEXT,
  balance          NUMERIC,
  currency_code    TEXT,
  is_active        BOOLEAN,
  raw              JSONB,
  synced_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_zoho_bank_accounts_org ON zoho_bank_accounts (organization_id);

CREATE TABLE IF NOT EXISTS zoho_bank_transactions (
  transaction_id   TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL,
  account_id       TEXT NOT NULL,
  txn_date         DATE,
  amount           NUMERIC,
  debit_or_credit  TEXT,            -- debit | credit
  transaction_type TEXT,            -- vendor_payment | expense | deposit | ...
  status           TEXT,            -- matched | categorized | uncategorized | ...
  payee            TEXT,
  reference_number TEXT,
  description      TEXT,
  running_balance  NUMERIC,
  raw              JSONB,
  synced_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_zoho_bank_txn_org  ON zoho_bank_transactions (organization_id);
CREATE INDEX IF NOT EXISTS idx_zoho_bank_txn_acct ON zoho_bank_transactions (account_id, txn_date);

CREATE TABLE IF NOT EXISTS zoho_sync_log (
  id               BIGSERIAL PRIMARY KEY,
  organization_id  TEXT,
  started_at       TIMESTAMPTZ DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  status           TEXT,            -- running | ok | error
  counts           JSONB,
  error            TEXT
);
`;

async function migrateZoho() {
  try {
    await masterSequelize.query(SQL);
    console.log('[ZOHO MIGRATE] ✅ Zoho Books mirror tables ready (master DB)');
  } catch (e) {
    console.error('[ZOHO MIGRATE] ❌', e.message);
  }
}

module.exports = { migrateZoho };
