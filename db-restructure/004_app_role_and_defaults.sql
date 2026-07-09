-- 004: non-superuser app role (so RLS actually enforces) + brand_id auto-stamp defaults.
-- Applied to colonel_agent_accountant ONLY. Idempotent.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='colonel_app') THEN
    CREATE ROLE colonel_app LOGIN PASSWORD 'colonel_app_local' NOSUPERUSER;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO colonel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO colonel_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO colonel_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO colonel_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO colonel_app;

-- brand_id auto-stamps from the session's app.brand_id (fail-closed: NULL if unset -> NOT NULL violation)
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND rowsecurity=true LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN brand_id SET DEFAULT NULLIF(current_setting(''app.brand_id'', true), '''')::uuid', r.tablename);
  END LOOP;
END $$;
