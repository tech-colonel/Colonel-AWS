-- 040  Amazon Receivables: move the per-order detail out of the run payload
--
-- The run used to carry every order four times over - once for each leg - and
-- for eighteen months that is 45.5 MB of a 46 MB payload. Everything the screen
-- actually draws (perMonth, totals, buckets, legs) comes to about 90 kB. Asking
-- for the full history built a payload Node could not hold and the process died
-- rebuilding it.
--
-- The detail lives here instead and is fetched one drill at a time, the same way
-- receivables_summary works.

CREATE TABLE IF NOT EXISTS amazon_receivables_rows (
  id          bigserial PRIMARY KEY,
  run_id      uuid        NOT NULL REFERENCES amazon_threeway_runs(id) ON DELETE CASCADE,
  brand_id    uuid        NOT NULL,
  leg         text        NOT NULL,     -- ledger | money | invoicing | chain
  month       text,                     -- YYYY-MM, the sale/cohort month
  order_id    text,
  bucket      text,                     -- the leg's own classification, for drills
  data        jsonb       NOT NULL,     -- the row exactly as the processor built it
  created_at  timestamptz DEFAULT now()
);

-- a drill asks for one leg, inside the selected months, sometimes one bucket
CREATE INDEX IF NOT EXISTS amazon_rows_run_leg_month_idx
  ON amazon_receivables_rows (run_id, leg, month);
CREATE INDEX IF NOT EXISTS amazon_rows_run_leg_bucket_idx
  ON amazon_receivables_rows (run_id, leg, bucket);
CREATE INDEX IF NOT EXISTS amazon_rows_order_idx
  ON amazon_receivables_rows (run_id, order_id);
CREATE INDEX IF NOT EXISTS amazon_rows_brand_idx
  ON amazon_receivables_rows (brand_id);

COMMENT ON TABLE amazon_receivables_rows IS
  'Per-order detail behind an Amazon Receivables run. One row per order per leg. '
  'Kept out of the run payload so the full history can be opened at once; fetched '
  'on demand when a drill-down is clicked.';

-- Ownership and grants, matching amazon_threeway_runs exactly. Without these the
-- app role gets "permission denied for table amazon_receivables_rows", the rows
-- are silently not stored, and every drill-down comes back empty while the
-- summaries still look perfectly healthy.
ALTER TABLE amazon_receivables_rows OWNER TO postgres;
ALTER SEQUENCE amazon_receivables_rows_id_seq OWNER TO postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON amazon_receivables_rows TO colonel_app;
GRANT USAGE, SELECT ON SEQUENCE amazon_receivables_rows_id_seq TO colonel_app;
