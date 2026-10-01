-- 038_amazon_threeway.sql
-- Amazon Receivables: the stored result of an order → MTR → settlement run.
--
-- WHY STORE IT. The run reads three sources — a few thousand order lines, the
-- MTR, and a settlement month — folds them to orders and walks the chain. That
-- is not work to repeat every time somebody opens the page, and it is the same
-- lesson the Receivables Summary agent already learned: compute once, write the
-- result, and let opening it be a read.
--
-- `payload` is the finished reconciliation as the page renders it — the month table,
-- the three legs, and the unsettled list. Not the source rows; those stay in
-- their files. So clearing or re-fetching sources never destroys a run that has
-- already been produced and possibly shown to a client.
--
-- `window_months` is the set of months the run covered, e.g. {2026-06,2026-07,
-- 2026-08}. A run is identified by brand plus that window: re-running the same
-- window replaces it rather than growing a pile nobody prunes.
--
-- `source_fingerprint` records what it was built from — the row counts of the
-- three legs. Equal means the run still describes the files in hand; different
-- means a source moved and the page should offer a rebuild rather than quietly
-- serve a figure that no longer matches its inputs.

CREATE TABLE IF NOT EXISTS amazon_threeway_runs (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id           UUID NOT NULL,

    window_months      TEXT[] NOT NULL,          -- {'2026-06','2026-07','2026-08'}
    payload            JSONB NOT NULL,           -- the finished reconciliation

    order_rows         INTEGER,                  -- what each leg contributed
    mtr_rows           INTEGER,
    settlement_rows    INTEGER,
    source_fingerprint TEXT,

    built_ms           INTEGER,
    built_by           UUID,
    built_at           TIMESTAMPTZ DEFAULT NOW(),
    created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- One current run per brand per window.
CREATE UNIQUE INDEX IF NOT EXISTS amazon_threeway_one_per_window
    ON amazon_threeway_runs (brand_id, window_months);

CREATE INDEX IF NOT EXISTS amazon_threeway_brand_idx
    ON amazon_threeway_runs (brand_id);

ALTER TABLE amazon_threeway_runs OWNER TO postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON amazon_threeway_runs TO colonel_app;

ALTER TABLE amazon_threeway_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE amazon_threeway_runs FORCE ROW LEVEL SECURITY;

-- No client-settable bypass: 005_harden_rls.sql removed that escape hatch from
-- every policy here and this one is written the same way. WITH CHECK is required
-- for INSERT to be permitted at all — a USING-only policy silently rejects every
-- insert.
DROP POLICY IF EXISTS amazon_threeway_brand_policy ON amazon_threeway_runs;
CREATE POLICY amazon_threeway_brand_policy ON amazon_threeway_runs
    USING      (brand_id::text = current_setting('app.brand_id', true))
    WITH CHECK (brand_id::text = current_setting('app.brand_id', true));
