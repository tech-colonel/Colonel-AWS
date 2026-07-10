-- 006: Invoice agents 3 -> 1. Keep "Invoice Process" (new AI review); retire
-- "Invoice Agent" (legacy n8n) and "Invoice-Processing" (extract). By NAME so it
-- is portable across DBs (local + AWS). Data tables (invoice_process, invoice_agent)
-- are PRESERVED — not dropped. Idempotent.
BEGIN;
DELETE FROM brand_agents WHERE agent_id IN (SELECT id FROM agents WHERE name IN ('Invoice Agent','Invoice-Processing'));
DELETE FROM agents        WHERE name IN ('Invoice Agent','Invoice-Processing');
-- ensure the survivor is assigned to every brand
INSERT INTO brand_agents (id, brand_id, agent_id, "createdAt", "updatedAt")
SELECT gen_random_uuid(), b.id, a.id, now(), now()
FROM brands b CROSS JOIN (SELECT id FROM agents WHERE name='Invoice Process' LIMIT 1) a
WHERE NOT EXISTS (SELECT 1 FROM brand_agents ba WHERE ba.brand_id=b.id AND ba.agent_id=a.id);
COMMIT;
