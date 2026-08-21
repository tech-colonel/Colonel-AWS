-- 024: extend receivable_ledger with delivery-lifecycle + exact-date columns, and a
-- view that exposes it in the exact shape the Advance Amount / Payables dashboards
-- already expect (previously sourced from shopify_order_cycle, which held fabricated
-- test data — see receivable_ledger_advance_columns work). Un-skips Shopify Prepaid
-- into the receivable ledger and lets it carry real Snapmint/BharatX/Razorpay gateway
-- settlement facts via the existing settled_flag/settled_amount/settled_source columns,
-- plus a real delivery_status/dispatch/return date so "collected but not yet
-- delivered" (Advance) can be told apart from "delivered" (earned) on this same table.
ALTER TABLE public.receivable_ledger ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(32);
ALTER TABLE public.receivable_ledger ADD COLUMN IF NOT EXISTS dispatch_or_cancellation_date TIMESTAMPTZ;
ALTER TABLE public.receivable_ledger ADD COLUMN IF NOT EXISTS return_date TIMESTAMPTZ;
ALTER TABLE public.receivable_ledger ADD COLUMN IF NOT EXISTS settled_date TIMESTAMPTZ;
ALTER TABLE public.receivable_ledger ADD COLUMN IF NOT EXISTS srn VARCHAR(255);

CREATE INDEX IF NOT EXISTS receivable_ledger_delivery_status_idx
    ON public.receivable_ledger (brand_id, delivery_status);

-- One row per Shopify Prepaid order, column-for-column compatible with what
-- dashboardController.js's Advance Amount + Payables queries already expect from
-- shopify_order_cycle (ADVANCE_TABLE) — so those queries only need their FROM target
-- repointed here, not rewritten. delhivery_delivery_date/xpressbees_delivery_date are
-- always NULL: Shopify Prepaid orders are never COD-remitted, kept only so
-- ADVANCE_BEST_DELIVERY_DATE's existing COALESCE needs no code change.
CREATE OR REPLACE VIEW public.advance_amount_ledger AS
SELECT
    brand_id,
    id,
    COALESCE(dispatch_or_cancellation_date, order_date::timestamptz) AS date,
    sale_order_number,
    invoice_number,
    awb AS awb_number,
    channel AS platform,
    courier AS shipping_partner,
    dispatch_or_cancellation_date,
    return_date,
    delivery_status,
    srn,
    total_amount,
    COALESCE(returned_amount, 0) AS return_amount,
    total_amount - COALESCE(returned_amount, 0) AS net_amount,
    CASE WHEN settled_source = 'snapmint' THEN settled_amount ELSE 0 END AS snapmint_settlement_value,
    CASE WHEN settled_source = 'snapmint' THEN settled_date ELSE NULL END AS snapmint_settlement_date,
    CASE WHEN settled_source = 'bharatx' THEN settled_amount ELSE 0 END AS bharatx_ledger_amount,
    CASE WHEN settled_source = 'bharatx' THEN settled_date ELSE NULL END AS bharatx_settlement_timestamp,
    CASE WHEN settled_source = 'razorpay' THEN settled_amount ELSE 0 END AS razorpay_settlement_amount,
    CASE WHEN settled_source = 'razorpay' THEN settled_date ELSE NULL END AS razorpay_settlement_date,
    NULL::timestamptz AS delhivery_delivery_date,
    NULL::timestamptz AS xpressbees_delivery_date
FROM public.receivable_ledger
WHERE payment_method = 'PREPAID' AND channel = 'Shopify';
