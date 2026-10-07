-- 011_shopify_order_cycle_cashfree.sql
-- Cashfree settlement columns on shopify_order_cycle.
--
-- Additive and nullable: every existing brand (FLO on Ekart/Delhivery/Xpressbees
-- + Snapmint/BharatX/Razorpay) is unaffected — these stay NULL for them, exactly
-- as the Razorpay columns stay NULL for a brand that doesn't use Razorpay.
-- D'Chicha settles through Cashfree, which had no column of its own.

ALTER TABLE shopify_order_cycle
  ADD COLUMN IF NOT EXISTS cashfree_settlement_date   timestamptz,
  ADD COLUMN IF NOT EXISTS cashfree_settlement_amount numeric;
