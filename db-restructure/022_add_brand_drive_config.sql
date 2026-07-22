-- 022: brand_drive_config — per-brand "central Drive folder" configuration.
--
-- Lets an admin save, per brand, the Google Drive folder link that holds that
-- brand's files. The folder lives in the firm's team@colonel.co.in Drive and is
-- read via the existing service account (see new-backend/src/services/driveService.js).
-- One row per brand (brand_id is the PK). Populated/updated by
-- new-backend/src/controllers/driveConfigController.js.
--
-- This is a UNIFIED multi-tenant DB with Row-Level Security. The app connects as
-- the NON-superuser role `colonel_app` and rows are scoped by brand_id matched
-- against the session GUC `app.brand_id` (set per brand-pool connection via the
-- afterConnect hook in config/database.js). This migration mirrors the EXACT RLS
-- shape used by the sibling per-brand tables (see db-restructure/005_harden_rls.sql
-- and 020_add_receivable_ledger.sql): FORCE ROW LEVEL SECURITY, a single
-- `<table>_tenant_isolation` policy with USING + WITH CHECK on
-- `brand_id::text = current_setting('app.brand_id', true)`, and the same grants
-- to colonel_app. brand_id also auto-stamps from app.brand_id via column DEFAULT
-- like the other tenant tables. Idempotent.
--
-- APPLY (as the postgres superuser — RLS-owning/DDL ops must NOT run as colonel_app):
--   psql -U postgres -h localhost -v ON_ERROR_STOP=1 -d colonel_agent_accountant -f db-restructure/022_add_brand_drive_config.sql

CREATE TABLE IF NOT EXISTS public.brand_drive_config (
    brand_id        UUID PRIMARY KEY
                        DEFAULT NULLIF(current_setting('app.brand_id', true), '')::uuid
                        REFERENCES public.brands(id) ON DELETE CASCADE,
    root_folder_url TEXT,
    root_folder_id  TEXT,
    label           TEXT,
    updated_by      UUID,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.brand_drive_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.brand_drive_config FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'brand_drive_config'
      AND policyname = 'brand_drive_config_tenant_isolation'
  ) THEN
    CREATE POLICY brand_drive_config_tenant_isolation ON public.brand_drive_config
      USING (brand_id::text = current_setting('app.brand_id', true))
      WITH CHECK (brand_id::text = current_setting('app.brand_id', true));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.brand_drive_config TO colonel_app;
