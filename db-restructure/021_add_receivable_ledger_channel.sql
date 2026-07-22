-- 021: receivable_ledger.channel — which sales portal/channel an order came from
-- (Shopify, Amazon, Flipkart, etc.), bucketed from the Tally row's raw "Channel
-- Ledger" value the same way `courier` is bucketed from "Shipping Provider".
-- Powers the "Total sales" KPI card's by-portal drill-down on the Receivable
-- Cycle global dashboard.
ALTER TABLE public.receivable_ledger ADD COLUMN IF NOT EXISTS channel VARCHAR(64) NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS receivable_ledger_channel_idx
    ON public.receivable_ledger (brand_id, channel);
