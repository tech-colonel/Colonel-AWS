/**
 * statutoryMigrate.js — creates the Statutory Compliance table in the MASTER DB.
 * Idempotent (CREATE TABLE / INDEX IF NOT EXISTS) → safe to run every boot.
 *
 * Per-brand, shared register of statutory filings (GST, TDS, PF/ESIC/PT, ITR,
 * ROC/MCA, audits). One row per filing occurrence (state × period for the
 * state-wise ones). Private feature — API is gated to a single owner email.
 */
const { masterSequelize } = require('../config/database');

const SQL = `
CREATE TABLE IF NOT EXISTS statutory_filings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id       UUID NOT NULL,
  compliance_type TEXT NOT NULL,
  title          TEXT NOT NULL,
  period_label   TEXT,
  period_type    TEXT,                       -- monthly | quarterly | annual | event
  year           INT,
  month          INT,
  quarter        INT,
  state          TEXT,
  status         TEXT NOT NULL DEFAULT 'not_due',  -- not_due | pending | filed | not_applicable
  due_date       DATE,
  filing_date    DATE,
  ack_no         TEXT,
  applicability  TEXT,
  note           TEXT,
  drive_url      TEXT,
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_statutory_scope
  ON statutory_filings (brand_id, compliance_type, year, month);
-- Idempotent seeding key: one row per (brand, type, state, period, title).
CREATE UNIQUE INDEX IF NOT EXISTS uq_statutory_row
  ON statutory_filings (brand_id, compliance_type, COALESCE(state,''), COALESCE(period_label,''), COALESCE(title,''));
`;

const migrateStatutory = async () => {
  try {
    await masterSequelize.query(SQL);
    console.log('[MIGRATE] ✅ statutory compliance table ready (master DB).');
  } catch (err) {
    console.error(`[MIGRATE] ❌ statutory table — ${err.message}`);
  }
};

module.exports = { migrateStatutory };
