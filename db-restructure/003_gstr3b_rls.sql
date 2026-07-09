-- 003_gstr3b_rls.sql — add RLS to gstr3b_* (already have brand_id, lacked RLS)
DO $$ DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['gstr3b_runs','gstr3b_coa_master','gstr3b_vt_master'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t||'_brand_policy', t);
    EXECUTE format($f$CREATE POLICY %I ON %I USING (current_setting('app.bypass_rls', true) = 'true' OR brand_id::text = current_setting('app.brand_id', true))$f$, t||'_brand_policy', t);
  END LOOP;
END $$;
