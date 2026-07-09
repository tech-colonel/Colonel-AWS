-- 005: HARDEN RLS. Remove the client-settable app.bypass_rls escape hatch from all
-- tenant policies (colonel_app could set it and defeat isolation). Real superuser
-- (postgres) still bypasses RLS natively for migrations/admin. Add explicit WITH CHECK.
DO $$
DECLARE r record; pol record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND rowsecurity LOOP
    FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=r.tablename LOOP
      EXECUTE format('DROP POLICY %I ON %I', pol.policyname, r.tablename);
    END LOOP;
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (brand_id::text = current_setting(''app.brand_id'', true)) WITH CHECK (brand_id::text = current_setting(''app.brand_id'', true))',
      r.tablename||'_tenant_isolation', r.tablename);
  END LOOP;
END $$;
