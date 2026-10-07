-- 013_order_cycle_courier_remittance.sql
-- COD remittance from the shipping PLATFORM, per order.
--
-- Why generic courier_* and not velocity_*: the existing delhivery_/ekart_/
-- xpressbees_ columns name the CARRIER, but the carrier is not who pays. D'Chicha
-- ships Delhivery parcels booked through Velocity — Delhivery hands the cash to
-- Velocity, Velocity remits to the brand. Putting Velocity's money in
-- delhivery_cod_amount would be the same mistake as parking Cashfree settlements
-- in the razorpay_ columns. courier_source records who actually remitted.
--
-- Additive and nullable: every brand still on uploaded courier files is untouched.

ALTER TABLE shopify_order_cycle
  ADD COLUMN IF NOT EXISTS courier_cod_amount      numeric,
  ADD COLUMN IF NOT EXISTS courier_delivery_date   timestamptz,
  ADD COLUMN IF NOT EXISTS courier_remittance_date timestamptz,
  ADD COLUMN IF NOT EXISTS courier_utr             varchar(64),
  ADD COLUMN IF NOT EXISTS courier_source          varchar(32);

COMMENT ON COLUMN shopify_order_cycle.courier_cod_amount IS
  'COD collected at delivery. Counts toward settlement received ONLY when courier_utr is set.';
COMMENT ON COLUMN shopify_order_cycle.courier_remittance_date IS
  'Actual settlement date when courier_utr is set; otherwise the platform''s FORECAST date — not money received.';
COMMENT ON COLUMN shopify_order_cycle.courier_utr IS
  'Bank UTR once remitted. NULL means the COD is still owed to the brand.';
COMMENT ON COLUMN shopify_order_cycle.courier_source IS
  'Which platform remitted (e.g. Velocity) — the carrier is not the remitter.';
