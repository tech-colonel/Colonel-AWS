-- 012_order_cycle_gateway_fees.sql
-- Gateway cost of collection, per order.
--
-- WHY generic rather than cashfree_fee: an order settles through exactly ONE
-- gateway, so one column pair is enough, and gateway_fee_source records which
-- gateway reported it. Adding fees for another gateway later needs no migration.
--
-- NOT every gateway reports a fee breakdown — Snapmint and BharatX ledgers carry
-- none, and Razorpay's file only sometimes does. These columns are populated ONLY
-- by gateways explicitly registered as fee-reporting (see GATEWAY_REPORTS_FEES in
-- orderCycleShopifyProcessor.js). For every other brand and gateway they stay
-- NULL, and the balance formula subtracts zero — byte-identical to today.

ALTER TABLE shopify_order_cycle
  ADD COLUMN IF NOT EXISTS gateway_fee        numeric,
  ADD COLUMN IF NOT EXISTS gateway_fee_gst    numeric,
  ADD COLUMN IF NOT EXISTS gateway_fee_source varchar(32);

COMMENT ON COLUMN shopify_order_cycle.gateway_fee IS
  'Gateway commission deducted before settlement. NULL when the gateway does not report fees.';
COMMENT ON COLUMN shopify_order_cycle.gateway_fee_gst IS
  'GST charged on the gateway fee — claimable input credit.';
COMMENT ON COLUMN shopify_order_cycle.gateway_fee_source IS
  'Which gateway reported the fee (e.g. Cashfree), for audit.';
