-- 015_return_prime_events.sql
--
-- Landing table for Return Prime webhook deliveries.
--
-- WHY RAW, NOT PARSED
-- Webhooks are not replayable. If we parse on receipt and the parser is wrong,
-- the original is gone and the event cannot be reconstructed — so the payload is
-- stored verbatim and interpreted on read. This is also what lets the future
-- nightly job re-derive returns from history without re-asking Return Prime.
--
-- WHY A DEDUPE KEY
-- Webhook senders retry on timeout, and a retry after we already committed looks
-- identical to a new event. Without idempotency a slow response would silently
-- double-count a refund. `dedupe_key` is a unique index, so a replay is a no-op
-- rather than a second return row.
--
-- Number 015: 014 is taken by amazon_connections, and there are already two 011s
-- in this directory — the numbering collides because nothing tracks applied
-- migrations. Everything here is IF NOT EXISTS so re-running is safe.

CREATE TABLE IF NOT EXISTS return_prime_events (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    brand_id        uuid NOT NULL,
    topic           text NOT NULL,              -- request_refunded, request_created, …
    shop_domain     text,
    -- Return Prime's own id for the return request, when the payload carries one.
    request_id      text,
    order_number    text,                       -- joined to sale_order_number later
    amount          numeric,
    currency        text,
    -- Verbatim body. Never edited; every derived field above is a convenience copy.
    payload         jsonb NOT NULL,
    dedupe_key      text NOT NULL,
    received_at     timestamptz NOT NULL DEFAULT now(),
    processed_at    timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rp_events_dedupe  ON return_prime_events (dedupe_key);
CREATE INDEX IF NOT EXISTS idx_rp_events_brand_topic    ON return_prime_events (brand_id, topic);
CREATE INDEX IF NOT EXISTS idx_rp_events_order          ON return_prime_events (brand_id, order_number);
CREATE INDEX IF NOT EXISTS idx_rp_events_received       ON return_prime_events (received_at DESC);

-- Ownership + grants. A table created by a migration run as a different role is
-- invisible to colonel_app otherwise — the trap that cost time on 010.
ALTER TABLE return_prime_events OWNER TO postgres;
GRANT SELECT, INSERT, UPDATE ON return_prime_events TO colonel_app;

-- RLS, scoped by brand like every other brand-owned table.
ALTER TABLE return_prime_events ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'return_prime_events' AND policyname = 'rp_events_brand_isolation') THEN
        -- USING gates SELECT/UPDATE/DELETE; WITH CHECK is required for INSERT.
        -- A policy with only USING silently rejects every insert.
        CREATE POLICY rp_events_brand_isolation ON return_prime_events
            USING (brand_id::text = current_setting('app.brand_id', true))
            WITH CHECK (brand_id::text = current_setting('app.brand_id', true));
    END IF;
END $$;
