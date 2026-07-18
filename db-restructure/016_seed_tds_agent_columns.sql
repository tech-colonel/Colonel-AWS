-- 016_seed_tds_agent_columns.sql — register the TDS fields on the Invoice Process agent.
--
-- Companion to 015 (which adds the physical columns). The dynamic Sequelize model is
-- built from `agents.columns`, so TDS must be declared there too or the n8n feed's
-- bulkCreate silently drops it. Idempotent: only appends when not already present.
--
--   psql -U postgres -d colonel_agent_accountant -f db-restructure/016_seed_tds_agent_columns.sql

UPDATE agents
SET columns = columns::jsonb || '[
  {"name":"tds_section","type":"STRING"},
  {"name":"tds_rate","type":"FLOAT"},
  {"name":"tds_amount","type":"FLOAT"}
]'::jsonb
WHERE name = 'Invoice Process'
  AND columns::text NOT LIKE '%tds_%';
