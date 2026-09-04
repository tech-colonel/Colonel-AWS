-- 027: brand_agents.hsn_master
--
-- The sales-myntra "without inventory" run builds a GSTR-HSN sheet whose HSN
-- column is resolved from an article-type → HSN reference master. That master is
-- stored the same JSONB-on-brand_agents way as sku_master / ledger_master
-- (007_sales_master_and_missing_tables.sql), via getBrandAgentModel
-- (new-backend/src/models/brand/index.js). Without this column every
-- GET/POST .../myntra/master call 500s with "column hsn_master does not exist"
-- on any DB predating this change (db-seed snapshot / local dev).
--
-- brand_agents is the org-layer table — no RLS (reads are already scoped by
-- findOrCreate where {brand_id, agent_id}); colonel_app already holds
-- SELECT/INSERT/UPDATE/DELETE on it and new columns inherit that grant.
-- Idempotent.
--
-- APPLY (as the postgres superuser):
--   psql -U postgres -h localhost -v ON_ERROR_STOP=1 -d colonel_agent_accountant -f db-restructure/027_add_brand_agents_hsn_master.sql

ALTER TABLE public.brand_agents ADD COLUMN IF NOT EXISTS hsn_master jsonb DEFAULT '[]'::jsonb;
