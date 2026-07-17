-- 012_add_created_by_missing_sales_tables.sql — close the gap left by 011.
--
-- 011_add_working_file_creator.sql added `created_by` to the "Marketplace /
-- Sales (dynamic)" group, but the group's table list (in both that migration
-- and new-backend/src/controllers/databaseController.js) never included
-- sales_firstcry, sales_limeroad, sales_nykaa. Same fix, same pattern,
-- restricted to the three tables that were missed.
--
-- Run as the postgres superuser (colonel_app cannot run DDL):
--   psql -U postgres -d colonel_agent_accountant -f db-restructure/012_add_created_by_missing_sales_tables.sql

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['sales_firstcry','sales_limeroad','sales_nykaa'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL',
        t
      );
    END IF;
  END LOOP;
END $$;
