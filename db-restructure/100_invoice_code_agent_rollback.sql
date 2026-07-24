-- ============================================================
-- 100_invoice_code_agent_rollback.sql
-- Reverses 100_invoice_code_agent.sql. Touches ONLY the new invoice_code
-- objects + the "Invoice code" agent — never the live Invoice Process flow.
--   psql -U postgres -d colonel_agent_accountant -f db-restructure/100_invoice_code_agent_rollback.sql
-- ============================================================

-- Remove the Koparo (and any) brand_agents rows for the Invoice code agent.
DELETE FROM brand_agents ba
USING agents a
WHERE ba.agent_id = a.id AND a.name = 'Invoice code';

-- Remove the agent.
DELETE FROM agents WHERE name = 'Invoice code';

-- Drop the table (and its policy/indexes with it).
DROP TABLE IF EXISTS invoice_code;

-- NOTE: the brand_agents.invoice_config column is intentionally LEFT in place
-- (harmless, additive). To also drop it, uncomment:
-- ALTER TABLE brand_agents DROP COLUMN IF EXISTS invoice_config;
