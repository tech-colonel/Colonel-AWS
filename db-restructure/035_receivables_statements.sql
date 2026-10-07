-- 035_receivables_statements.sql
-- Built statements, kept as artifacts.
--
-- Why this table exists. Opening the agent used to REBUILD the whole year from
-- the raw rows — 1.3 million of them, twelve statements, twenty to sixty
-- seconds and about a gigabyte of heap on the shared backend, every single
-- time the cache missed. And the cache missed often: it lived in a file under
-- outputs/ and its key included the mtimes of the processor files, so every
-- deploy threw it away. A page nobody had changed anything on would sit and
-- grind, and while it ground it was competing with every other agent for the
-- same node process.
--
-- The Order Cycle agent already solved this: it computes once, writes the
-- result to the brand database, and afterwards opening a saved output is a
-- read. This is the same shape for receivables.
--
-- What is stored is the FINISHED statement — the year overview, or one month —
-- as the JSON the page renders. Not the raw rows; those stay in
-- receivables_summary. So a reset that clears the records does not destroy the
-- statements built from them, which is what an accountant would expect of
-- something they have already produced and may have filed.
--
-- `source_fingerprint` is how staleness is known without recomputing: it is the
-- row count and newest row of the records the statement was built from. Equal
-- means the statement still describes what is held; different means the records
-- moved and the page should offer a rebuild rather than quietly serve an old
-- figure or quietly spend a minute making a new one.

CREATE TABLE IF NOT EXISTS receivables_statements (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id           UUID NOT NULL,

    -- 'YEAR' for the whole-year overview, 'MONTH' for one month's statement
    scope              VARCHAR(8)  NOT NULL,
    period             VARCHAR(7),              -- YYYY-MM; NULL when scope='YEAR'

    payload            JSONB NOT NULL,          -- the finished statement, as rendered

    source_rows        INTEGER,                 -- rows it was built from
    source_fingerprint TEXT,                    -- count|max(created_at) of those rows
    built_ms           INTEGER,                 -- how long it took, for the record
    built_by           UUID,
    built_at           TIMESTAMPTZ DEFAULT NOW(),
    created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- One current statement per brand per scope per period. Rebuilding replaces in
-- place rather than growing a pile nobody prunes.
CREATE UNIQUE INDEX IF NOT EXISTS receivables_statements_one_per_scope
    ON receivables_statements (brand_id, scope, COALESCE(period, ''));

CREATE INDEX IF NOT EXISTS receivables_statements_brand_idx
    ON receivables_statements (brand_id);

ALTER TABLE receivables_statements OWNER TO postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON receivables_statements TO colonel_app;

ALTER TABLE receivables_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE receivables_statements FORCE ROW LEVEL SECURITY;

-- No client-settable bypass: 005_harden_rls.sql removed that escape hatch from
-- every policy in this database and this one is written the same way. WITH CHECK
-- is required for INSERT to be permitted at all — a USING-only policy silently
-- rejects every insert.
DROP POLICY IF EXISTS receivables_statements_brand_policy ON receivables_statements;
CREATE POLICY receivables_statements_brand_policy ON receivables_statements
    USING      (brand_id::text = current_setting('app.brand_id', true))
    WITH CHECK (brand_id::text = current_setting('app.brand_id', true));
