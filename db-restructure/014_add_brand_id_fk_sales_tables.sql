-- 014_add_brand_id_fk_sales_tables.sql
--
-- None of the 12 sales_* tables enforce brand_id -> brands.id today (0
-- orphans currently, but nothing in the DB stops one). Every other brand_id
-- FK in the schema (brand_agents, brand_users, statutory_config) uses
-- ON DELETE CASCADE, so this matches that convention: deleting a brand
-- cascades to its sales rows instead of leaving them orphaned or blocking
-- the delete.
--
-- Run as the postgres superuser (colonel_app cannot run DDL):
--   psql -U postgres -d colonel_agent_accountant -f db-restructure/014_add_brand_id_fk_sales_tables.sql

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'sales_amazon','sales_blinkit','sales_cread','sales_firstcry','sales_flipkart',
    'sales_jiomart','sales_limeroad','sales_mirrow','sales_myntra','sales_nykaa',
    'sales_shopify','sales_zepto'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE',
        t, t || '_brand_id_fkey'
      );
    END IF;
  END LOOP;
END $$;
