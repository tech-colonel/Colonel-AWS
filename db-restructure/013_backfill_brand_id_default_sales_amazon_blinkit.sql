-- 013_backfill_brand_id_default_sales_amazon_blinkit.sql
--
-- Every table in the "Marketplace / Sales (dynamic)" group defaults brand_id
-- to the RLS session var so the app doesn't have to pass it explicitly on
-- every insert — except sales_amazon and sales_blinkit, which were created
-- without it. Brings them in line with the rest of the group.
--
-- Run as the postgres superuser (colonel_app cannot run DDL):
--   psql -U postgres -d colonel_agent_accountant -f db-restructure/013_backfill_brand_id_default_sales_amazon_blinkit.sql

ALTER TABLE sales_amazon ALTER COLUMN brand_id SET DEFAULT (NULLIF(current_setting('app.brand_id', true), ''))::uuid;
ALTER TABLE sales_blinkit ALTER COLUMN brand_id SET DEFAULT (NULLIF(current_setting('app.brand_id', true), ''))::uuid;
