-- 019: receivable_cycle_imports — raw storage for historical Receivable Cycle source
-- files (e.g. a prior year's already-built Main Sheet/COD sheets workbook, or a raw
-- Combined SRN register) that predate the reco_jobs upload pipeline and so have no
-- job_id to hang off of. Same row-per-sheet-row JSON-blob shape as
-- receivable_cycle_results (017_add_receivable_cycle_results.sql) for the same reason:
-- these source files carry ~70-90 differently-named columns across several sheets,
-- and JSON (not JSONB) preserves the original column order for a faithful re-view.
-- Idempotent. Applied directly to colonel_agent_accountant (unified DB); also mirrored
-- into new-backend/src/db/migrations/001_reco_tables.sql for the legacy per-brand path.
CREATE TABLE IF NOT EXISTS public.receivable_cycle_imports (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL DEFAULT NULLIF(current_setting('app.brand_id', true), '')::uuid,
    source_file VARCHAR(255) NOT NULL,
    sheet_name  VARCHAR(64) NOT NULL,
    row_index   INTEGER NOT NULL,
    row_data    JSON NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS receivable_cycle_imports_brand_source_idx
    ON public.receivable_cycle_imports (brand_id, source_file, sheet_name);

ALTER TABLE public.receivable_cycle_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.receivable_cycle_imports FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'receivable_cycle_imports'
      AND policyname = 'receivable_cycle_imports_tenant_isolation'
  ) THEN
    CREATE POLICY receivable_cycle_imports_tenant_isolation ON public.receivable_cycle_imports
      USING (brand_id::text = current_setting('app.brand_id', true))
      WITH CHECK (brand_id::text = current_setting('app.brand_id', true));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.receivable_cycle_imports TO colonel_app;
