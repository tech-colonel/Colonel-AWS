-- 033_receivables_summary.sql
-- Table for the Receivables Summary agent.
--
-- Created here rather than left to Sequelize's runtime sync(): brand connections
-- run as colonel_app, which has no CREATE on schema public, so a new agent table
-- can only come from a migration. The column list mirrors COLUMNS in
-- receivablesSummaryController.js — change both together.
--
-- One flat table holding four kinds of row, told apart by source_kind:
--   DELIVERED / REFUND / RTO  from each GST registration's sales workbook
--   PAYMENT                   from the payment reconciliation
-- The per-order join happens in the reader, not here, because an order can
-- appear in two registrations when its lines shipped from two warehouses.

CREATE TABLE IF NOT EXISTS receivables_summary (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL,
    month       INTEGER,
    year        INTEGER,
    file_type   VARCHAR(255),
    inventory_type VARCHAR(255),
    filename    VARCHAR(255),
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    created_by  UUID,

    source_kind VARCHAR(255),
    source_tab  VARCHAR(255),
    entity      VARCHAR(255),
    order_id    VARCHAR(255),
    order_date  VARCHAR(255),
    period      VARCHAR(255),
    sales_month VARCHAR(255),

    shipping_state VARCHAR(255),
    pickup_state   VARCHAR(255),
    sku            VARCHAR(255),
    product_name   VARCHAR(255),
    qty            NUMERIC,

    order_total    NUMERIC,
    tax_rate       NUMERIC,
    taxable_value  NUMERIC,
    tax_amount     NUMERIC,
    cgst           NUMERIC,
    sgst           NUMERIC,
    igst           NUMERIC,

    order_status   VARCHAR(255),
    gst_status     VARCHAR(255),
    delivered_date VARCHAR(255),
    rto_date       VARCHAR(255),
    rto_month      VARCHAR(255),
    refunded_at    VARCHAR(255),
    refunded_amount NUMERIC,
    refund_status  VARCHAR(255),
    refund_mode    VARCHAR(255),

    financial_status    VARCHAR(255),
    payment_method      VARCHAR(255),
    shipping_aggregator VARCHAR(255),

    collector         VARCHAR(255),
    cashfree          NUMERIC,
    billdesk          NUMERIC,
    billdesk_exchange NUMERIC,
    razorpay_exchange NUMERIC,
    shiprocket        NUMERIC,
    collectors_total  NUMERIC,

    remitted_amount NUMERIC,
    difference      NUMERIC,
    remarks         VARCHAR(255),
    utr_id          VARCHAR(255),
    payment_date    VARCHAR(255),
    deposit_date    VARCHAR(255),
    cancelled_at    VARCHAR(255),
    discount_amount NUMERIC
);

CREATE INDEX IF NOT EXISTS receivables_summary_brand_idx    ON receivables_summary (brand_id);
CREATE INDEX IF NOT EXISTS receivables_summary_filename_idx ON receivables_summary (filename);
-- The ledger joins on order_id across four source kinds; without this the join
-- is a sequential scan over every row of every uploaded month.
CREATE INDEX IF NOT EXISTS receivables_summary_order_idx    ON receivables_summary (brand_id, order_id);

ALTER TABLE receivables_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE receivables_summary FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS receivables_summary_brand_policy ON receivables_summary;
-- No client-settable bypass. 005_harden_rls.sql removed the app.bypass_rls
-- escape hatch from every policy in this database; all 58 policies on the live
-- box use the form below and none carries a bypass clause. Writing one here
-- would have made this table the single exception — a session that can set a
-- GUC could read every brand's orders. The real postgres superuser still
-- bypasses RLS natively, which is what migrations and admin work use.
CREATE POLICY receivables_summary_brand_policy ON receivables_summary
    USING (brand_id::text = current_setting('app.brand_id', true));

-- 004 sets DEFAULT PRIVILEGES for colonel_app, but only for tables created by
-- the role that ran it. Granting explicitly so this does not depend on who
-- applies the migration.
GRANT SELECT, INSERT, UPDATE, DELETE ON receivables_summary TO colonel_app;
