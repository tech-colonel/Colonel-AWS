-- 016: reco_jobs.period_end_month / period_end_year — lets a job represent a month
-- RANGE (e.g. "Mar 2025 – May 2025") instead of only a single month, for the
-- Receivable Cycle "Generate Receivables" form. Both stay NULL for a single-month
-- run and for every other agent (purely additive; period is metadata only, not a
-- data filter — see receivable_cycle.py, which is untouched by this change).
-- Idempotent. Applied directly to colonel_agent_accountant (unified DB); also
-- mirrored into new-backend/src/db/migrations/001_reco_tables.sql for the legacy
-- per-brand path.
ALTER TABLE public.reco_jobs ADD COLUMN IF NOT EXISTS period_end_month INTEGER;
ALTER TABLE public.reco_jobs ADD COLUMN IF NOT EXISTS period_end_year  INTEGER;

-- Recreate the idempotency index to include the new columns, so two range-runs
-- that share the same start month/year + file hash but differ in end period
-- don't collide on insert.
DROP INDEX IF EXISTS public.reco_jobs_idempotency_idx;
CREATE UNIQUE INDEX reco_jobs_idempotency_idx
    ON public.reco_jobs (brand_id, agent_type, month, year,
                          COALESCE(period_end_month, -1), COALESCE(period_end_year, -1), file_hash)
    WHERE file_hash IS NOT NULL;
