-- 011_add_working_file_creator.sql — track who generated each working file.
--
-- The dynamic per-agent tables (marketplace/sales working files) already carry
-- created_at but nothing records WHICH user generated the row. Adds an
-- additive `created_by` column (nullable — legacy rows stay unattributed) to
-- every table in the "Marketplace / Sales (dynamic)" group, matching the list
-- in new-backend/src/controllers/databaseController.js.
--
-- Run as the postgres superuser (colonel_app cannot run DDL):
--   psql -U postgres -d colonel_agent_accountant -f db-restructure/011_add_working_file_creator.sql

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'invoice_process','invoice_agent','flipkart','amazon','nykaa','myntra',
    'meesho','sales_amazon','ajio','sales_cread','total_sales_analyzer',
    'shopify_order_cycle','settlement_amazon','sales_shopify','sales_mirrow',
    'sales_zepto','sales_myntra','sales_jiomart','sales_flipkart','sales_blinkit',
    'gstr_2b_books'
  ];
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
