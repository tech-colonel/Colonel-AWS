-- 015: receivable_cycle_results — row-level storage for the Receivable Cycle agent's
-- Main Sheet + per-courier COD sub-sheets, so past runs can be viewed as a table (not
-- just re-downloaded as an .xlsx). Unlike every other *_results table, this agent's
-- output has ~90 columns across 6 differently-shaped sheets, so rows are stored as a
-- JSONB blob per source row (sheet_name + row_data) instead of a rigid flat schema —
-- the frontend already derives table columns dynamically from row keys.
-- Idempotent. Applied directly to colonel_agent_accountant (unified DB); also mirrored
-- into new-backend/src/db/migrations/001_reco_tables.sql for the legacy per-brand path.
--
-- row_data is JSON, not JSONB, deliberately: JSONB re-serializes object keys sorted
-- by (length, then lexicographic) and does NOT preserve original key order, while
-- JSON stores the exact input text. Since the frontend derives table columns from
-- the row's own key order (no fixed schema — see GenericDashboard), JSONB here would
-- silently scramble the Excel's column order in the web "View" (e.g. short keys like
-- "2"/"3"/"4"/"IRN"/"Qty" would jump to the front) — confirmed and fixed after a real
-- report of exactly that.
CREATE TABLE IF NOT EXISTS public.receivable_cycle_results (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id      UUID NOT NULL REFERENCES public.reco_jobs(id) ON DELETE CASCADE,
    brand_id    UUID NOT NULL,
    sheet_name  VARCHAR(50) NOT NULL,
    row_index   INTEGER NOT NULL,
    row_data    JSON NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Idempotent upgrade path: an earlier version of this migration created row_data as
-- JSONB; fix it in place on re-run against an already-created table.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'receivable_cycle_results'
      AND column_name = 'row_data' AND data_type = 'jsonb'
  ) THEN
    ALTER TABLE public.receivable_cycle_results ALTER COLUMN row_data TYPE json USING row_data::json;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS receivable_cycle_results_job_id_idx
    ON public.receivable_cycle_results (job_id);
CREATE INDEX IF NOT EXISTS receivable_cycle_results_brand_sheet_idx
    ON public.receivable_cycle_results (brand_id, sheet_name);

ALTER TABLE public.receivable_cycle_results ALTER COLUMN brand_id
    SET DEFAULT NULLIF(current_setting('app.brand_id', true), '')::uuid;

ALTER TABLE public.receivable_cycle_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.receivable_cycle_results FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'receivable_cycle_results'
      AND policyname = 'receivable_cycle_results_tenant_isolation'
  ) THEN
    CREATE POLICY receivable_cycle_results_tenant_isolation ON public.receivable_cycle_results
      USING (brand_id::text = current_setting('app.brand_id', true))
      WITH CHECK (brand_id::text = current_setting('app.brand_id', true));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.receivable_cycle_results TO colonel_app;
