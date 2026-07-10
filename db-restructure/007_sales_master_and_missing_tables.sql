-- 007_sales_master_and_missing_tables.sql
-- Fixes two unified-DB gaps exposed after the sales-agent pull:
--
--  (1) brand_agents (the ONE org-layer table in unified) was created from the
--      master schema with only id/brand_id/agent_id. The friend's sales agents
--      store per-(brand,agent) SKU/Ledger master in brand_agents.sku_master /
--      ledger_master (JSONB) via getBrandAgentModel — so EVERY sales agent's
--      GET /:portal/master 500'd with "column sku_master does not exist".
--
--  (2) New sales agents added AFTER the unified build (Sales-Nykaa, Sales-FirstCry,
--      Sales-Limeroad) never had their dynamic tables created — and getDynamicModel's
--      sync() is a no-op in unified mode, so opening the workspace no longer
--      auto-creates them → GET /working-files 500 "relation sales_nykaa does not exist".
--
-- Part (1) is static SQL (below). Part (2) is dynamic (column types derived from
-- agents.columns at runtime) and lives in the companion node script
-- 007_fix_missing_agent_tables.js, which creates each missing table with the SAME
-- brand_id default + tenant_isolation RLS + colonel_app grants pattern used by
-- 002/004/005. Both are idempotent and AWS-portable.
--
-- Run: psql -U postgres -d colonel_agent_accountant -f 007_sales_master_and_missing_tables.sql
--      node 007_fix_missing_agent_tables.js

BEGIN;

-- (1) brand_agents SKU/Ledger master columns (org-layer table, no RLS — reads are
--     already scoped by findOrCreate where {brand_id, agent_id}). colonel_app already
--     holds SELECT/INSERT/UPDATE/DELETE on brand_agents; new columns inherit that.
ALTER TABLE brand_agents ADD COLUMN IF NOT EXISTS sku_master    jsonb DEFAULT '[]'::jsonb;
ALTER TABLE brand_agents ADD COLUMN IF NOT EXISTS ledger_master jsonb DEFAULT '[]'::jsonb;

COMMIT;
