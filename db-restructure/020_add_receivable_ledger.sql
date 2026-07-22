-- 020: receivable_ledger — persistent, order-level, cross-year/cross-source
-- reconciliation state for the Receivable Cycle agent's global dashboard.
--
-- Why this exists: the Receivable Cycle agent's per-run Main Sheet/COD sheets
-- (receivable_cycle_results) only ever match a courier settlement or SRN
-- return against the SAME run's own Tally rows. Real remittances routinely
-- arrive months late (e.g. a Feb settlement file clearing a Dec order), so a
-- per-run-only match silently misses that receipt. This table is the fix:
-- one row per sale order (keyed by AWB, or invoice number when no AWB), kept
-- across every file/run ever loaded for a brand, so a settlement or SRN can
-- be matched against ANY prior order regardless of which month it was sold.
--
-- settled_flag/returned_flag are deliberately independent facts (NOT a single
-- pending/settled/returned enum) — an order can be settled in month X and
-- still be returned in month Y afterwards; collapsing that into one enum
-- either blocks the return from posting or silently erases the settlement
-- from its own month's "received" total. Both facts must coexist.
CREATE TABLE IF NOT EXISTS public.receivable_ledger (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id          UUID NOT NULL DEFAULT NULLIF(current_setting('app.brand_id', true), '')::uuid,
    awb               VARCHAR(64) NOT NULL DEFAULT '',
    invoice_key       VARCHAR(64) NOT NULL DEFAULT '',
    invoice_number    VARCHAR(64),
    sale_order_number VARCHAR(64),
    order_date        DATE,
    order_month       INTEGER NOT NULL,
    order_year        INTEGER NOT NULL,
    payment_method    VARCHAR(16) NOT NULL,           -- COD | PREPAID
    courier           VARCHAR(32) NOT NULL DEFAULT '', -- Delivery | Ekart | Xpressbees | DTDC | Self shipping | Other COD | '' (prepaid)
    total_amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
    settled_flag      BOOLEAN NOT NULL DEFAULT FALSE,
    settled_amount    NUMERIC(14,2),
    settled_month     INTEGER,
    settled_year      INTEGER,
    settled_source    VARCHAR(32),                     -- delhivery | ekart | xpressbees | prepaid
    returned_flag     BOOLEAN NOT NULL DEFAULT FALSE,
    returned_amount   NUMERIC(14,2),
    returned_month    INTEGER,
    returned_year     INTEGER,
    source_file       VARCHAR(255),
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Two partial unique indexes (not one generated match_key column) because a
-- meaningful chunk of rows (Self shipping, some DTDC) never have an AWB and
-- must fall back to invoice_key as their dedupe/match key instead.
CREATE UNIQUE INDEX IF NOT EXISTS receivable_ledger_awb_uidx
    ON public.receivable_ledger (brand_id, awb) WHERE awb <> '';
CREATE UNIQUE INDEX IF NOT EXISTS receivable_ledger_invoice_uidx
    ON public.receivable_ledger (brand_id, invoice_key) WHERE awb = '' AND invoice_key <> '';
CREATE INDEX IF NOT EXISTS receivable_ledger_order_month_idx
    ON public.receivable_ledger (brand_id, order_year, order_month);
CREATE INDEX IF NOT EXISTS receivable_ledger_settled_month_idx
    ON public.receivable_ledger (brand_id, settled_year, settled_month);
CREATE INDEX IF NOT EXISTS receivable_ledger_returned_month_idx
    ON public.receivable_ledger (brand_id, returned_year, returned_month);

ALTER TABLE public.receivable_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.receivable_ledger FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'receivable_ledger'
      AND policyname = 'receivable_ledger_tenant_isolation'
  ) THEN
    CREATE POLICY receivable_ledger_tenant_isolation ON public.receivable_ledger
      USING (brand_id::text = current_setting('app.brand_id', true))
      WITH CHECK (brand_id::text = current_setting('app.brand_id', true));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.receivable_ledger TO colonel_app;

-- Sink for settlement/SRN rows whose AWB/invoice doesn't match any known
-- ledger order (order predates the loaded history, or a data-entry mismatch)
-- — logged instead of silently dropped, and surfaced as a "data quality" tab.
CREATE TABLE IF NOT EXISTS public.receivable_ledger_unmatched (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL DEFAULT NULLIF(current_setting('app.brand_id', true), '')::uuid,
    match_key   VARCHAR(64) NOT NULL,
    source      VARCHAR(32) NOT NULL,   -- delhivery | ekart | xpressbees | srn
    amount      NUMERIC(14,2),
    source_file VARCHAR(255),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS receivable_ledger_unmatched_brand_idx
    ON public.receivable_ledger_unmatched (brand_id, source);

ALTER TABLE public.receivable_ledger_unmatched ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.receivable_ledger_unmatched FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'receivable_ledger_unmatched'
      AND policyname = 'receivable_ledger_unmatched_tenant_isolation'
  ) THEN
    CREATE POLICY receivable_ledger_unmatched_tenant_isolation ON public.receivable_ledger_unmatched
      USING (brand_id::text = current_setting('app.brand_id', true))
      WITH CHECK (brand_id::text = current_setting('app.brand_id', true));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.receivable_ledger_unmatched TO colonel_app;
