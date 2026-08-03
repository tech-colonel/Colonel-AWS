-- 024_add_brands_kyroen_baynine.sql
-- Adds two new brands (Kyroen, Baynine) with fixed UUIDs and assigns every agent
-- to each, matching how existing brands are set up. Idempotent — safe to re-run.
-- Fixed UUIDs match the rows created on local (colonel_agent_accountant) and on
-- AWS prod on 2026-08-03, so all environments stay in sync.

INSERT INTO brands (id, name, db_name, "createdAt", "updatedAt") VALUES
  ('49f8b69c-0d71-4c4c-b413-9268ac560a34', 'Kyroen',  'colonel_kyroen',  now(), now()),
  ('85b67672-f7ca-447f-9ca3-5548e1805322', 'Baynine', 'colonel_baynine', now(), now())
ON CONFLICT (id) DO NOTHING;

-- Assign every agent to each new brand; skip any pair that already exists.
INSERT INTO brand_agents (id, brand_id, agent_id, "createdAt", "updatedAt", sku_master, ledger_master)
SELECT gen_random_uuid(), b.id, a.id, now(), now(), '[]'::jsonb, '[]'::jsonb
FROM brands b CROSS JOIN agents a
WHERE b.name IN ('Kyroen', 'Baynine')
  AND NOT EXISTS (
    SELECT 1 FROM brand_agents ba WHERE ba.brand_id = b.id AND ba.agent_id = a.id
  );
