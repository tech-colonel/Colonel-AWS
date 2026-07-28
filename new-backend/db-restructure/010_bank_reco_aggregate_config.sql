-- 010_bank_reco_aggregate_config.sql
-- Per-brand learned aggregate-reconciliation rules for the Bank Reco tool.
-- One row per brand: dense aggregate parties (e.g. "flo sleep solutions") + custom salary
-- keywords learned from prior runs, so a later single-month file recalls them. Brand isolation
-- is by brand_id + Row-Level Security, matching bank_reco_corrections (owned by postgres, DML
-- granted to colonel_app; the app user cannot CREATE, so this must run as a superuser/migration).
-- Idempotent — safe to re-run. Apply on every environment (local + AWS) as the DB owner.

CREATE TABLE IF NOT EXISTS bank_reco_aggregate_config (
  brand_id        uuid PRIMARY KEY,
  parties         jsonb NOT NULL DEFAULT '[]'::jsonb,
  salary_keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Tenant isolation: a connection only ever sees/writes its own brand's row (app.brand_id is set
-- per connection by the unified-DB afterConnect hook). Mirrors bank_reco_corrections' policy.
ALTER TABLE bank_reco_aggregate_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_reco_aggregate_config FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bank_reco_aggregate_config_tenant_isolation ON bank_reco_aggregate_config;
CREATE POLICY bank_reco_aggregate_config_tenant_isolation ON bank_reco_aggregate_config
  FOR ALL TO public
  USING      ((brand_id)::text = current_setting('app.brand_id', true))
  WITH CHECK ((brand_id)::text = current_setting('app.brand_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON bank_reco_aggregate_config TO colonel_app;
