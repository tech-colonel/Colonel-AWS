/**
 * complianceMigrate.js — creates the Compliance Tracker tables in the MASTER DB.
 * Idempotent (CREATE TABLE / INDEX IF NOT EXISTS) → safe to run on every boot.
 *
 * A brand-scoped + user-scoped task tracker, kept as its OWN module (separate
 * from the master `tasks` table). Shape:
 *
 *   compliance_categories   per-brand, colored, extensible (GST / TDS / ...)
 *   compliance_tasks        one row per task, in one month's instance
 *   compliance_attachments  polymorphic — attaches to compliance_tasks AND tasks
 *
 * "Blank for un-seeded brands" falls out naturally: a brand+user with no rows
 * returns an empty tracker. Seeding is idempotent via the template unique index.
 */

const { masterSequelize } = require('../config/database');

const SQL = `
-- ── categories (per brand, colored, user-extensible) ─────────────────────────
CREATE TABLE IF NOT EXISTS compliance_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id    UUID NOT NULL,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#0748EE',
  is_system   BOOLEAN NOT NULL DEFAULT false,
  created_by  UUID,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_cat_brand_name
  ON compliance_categories (brand_id, lower(name));

-- ── tasks (brand + user scoped, one row per monthly-instance task) ───────────
CREATE TABLE IF NOT EXISTS compliance_tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id      UUID NOT NULL,
  user_id       UUID NOT NULL,
  year          INT,
  month         INT,
  period        TEXT,
  period_order  INT,
  seq           INT,
  title         TEXT NOT NULL,
  description   TEXT,
  category_id   UUID REFERENCES compliance_categories(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'todo',      -- todo | in_progress | review | done
  priority      TEXT NOT NULL DEFAULT 'medium',    -- low | medium | high | urgent
  progress      INT NOT NULL DEFAULT 0,            -- 0..100
  due_date      DATE,
  data_source   TEXT,
  frequency     TEXT,
  remarks       TEXT,
  agent_id      UUID,                               -- deep-link to a Colonel agent
  source        TEXT NOT NULL DEFAULT 'self',      -- template | self | admin
  assigned_by   UUID,
  linked_task_id UUID,                              -- optional bridge to master tasks
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_compliance_tasks_scope
  ON compliance_tasks (brand_id, user_id, year, month);
-- idempotent seeding: one template row per (brand,user,month,window,seq)
CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_template_row
  ON compliance_tasks (brand_id, user_id, year, month, period_order, seq)
  WHERE source = 'template';

-- ── attachments (polymorphic: compliance_task | task) ────────────────────────
CREATE TABLE IF NOT EXISTS compliance_attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   TEXT NOT NULL,                     -- 'compliance_task' | 'task'
  entity_id     UUID NOT NULL,
  source        TEXT NOT NULL,                     -- 'upload' | 'drive'
  file_name     TEXT NOT NULL,
  mime_type     TEXT,
  file_size     BIGINT,
  storage_path  TEXT,                              -- upload: relative path under output/
  drive_file_id TEXT,                              -- drive: file id
  drive_url     TEXT,                              -- drive: webViewLink
  uploaded_by   UUID,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_compliance_attach_entity
  ON compliance_attachments (entity_type, entity_id);

-- ── chat-with-admin (one thread per brand + accountant) ──────────────────────
CREATE TABLE IF NOT EXISTS compliance_chat_messages (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id       UUID NOT NULL,
  thread_user_id UUID NOT NULL,                    -- the accountant who owns the thread
  sender_id      UUID NOT NULL,
  sender_role    TEXT NOT NULL,                    -- 'accountant' | 'admin'
  message        TEXT NOT NULL,
  read_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_compliance_chat_thread
  ON compliance_chat_messages (brand_id, thread_user_id, created_at);
`;

const migrateCompliance = async () => {
  try {
    await masterSequelize.query(SQL);
    console.log('[MIGRATE] ✅ compliance tracker tables ready (master DB).');
  } catch (err) {
    console.error(`[MIGRATE] ❌ compliance tables — ${err.message}`);
  }
};

module.exports = { migrateCompliance };
