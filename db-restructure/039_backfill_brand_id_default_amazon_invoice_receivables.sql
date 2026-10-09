-- 039_backfill_brand_id_default_amazon_invoice_receivables.sql
--
-- Same gap 013 closed for sales_amazon / sales_blinkit, on the three agent tables
-- it missed: amazon, invoice_process, receivables_summary have brand_id NOT NULL
-- but no DEFAULT. Every other agent table auto-stamps brand_id from the request's
-- brand context (app.brand_id), so an INSERT that omits brand_id works there but
-- trips the RLS WITH CHECK here ("new row violates row-level security policy").
-- The app's Sequelize models pass the value explicitly, which is why this went
-- unnoticed; raw-SQL writers and scripts/smoke-agents.js do hit it.
--
-- Metadata-only change: no table rewrite, existing rows untouched. Verified on
-- production 2026-10-09 before applying: 0 rows with NULL brand_id and 0 rows
-- whose brand_id is missing from brands, in all three tables — no data backfill
-- needed. Idempotent; tables that do not exist are skipped.
--
-- Run as the postgres superuser (colonel_app cannot run DDL):
--   psql -U postgres -d colonel_agent_accountant -f db-restructure/039_backfill_brand_id_default_amazon_invoice_receivables.sql

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['amazon', 'invoice_process', 'receivables_summary'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE '039: % does not exist, skipped', t;
    ELSIF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'brand_id' AND column_default IS NOT NULL
    ) THEN
      RAISE NOTICE '039: % already has a brand_id default, unchanged', t;
    ELSE
      EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN brand_id SET DEFAULT NULLIF(current_setting(''app.brand_id'', true), '''')::uuid',
        t
      );
      RAISE NOTICE '039: % brand_id default set', t;
    END IF;
  END LOOP;
END $$;
