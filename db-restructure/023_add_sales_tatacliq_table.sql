-- 023: Create the sales_tatacliq dynamic agent table for the new Sales-TataCliq
-- agent (seed-sales-tatacliq.js). getDynamicModel.sync() is a no-op in unified
-- mode, so this table must be created here, as the superuser, before the agent's
-- working files can be saved. Schema mirrors what getDynamicModel would produce
-- from the agent's `columns` (see seed-sales-tatacliq.js), plus the same RLS
-- treatment as every other sales_* table post-005-hardening (no app.bypass_rls
-- escape hatch — only the real superuser bypasses RLS).
CREATE TABLE IF NOT EXISTS sales_tatacliq (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id             UUID NOT NULL DEFAULT NULLIF(current_setting('app.brand_id', true), '')::uuid,
    month                INTEGER,
    year                 INTEGER,
    file_type            VARCHAR(255),
    inventory_type       VARCHAR(255),
    filename             VARCHAR(255),
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    created_by           UUID,

    seller_code          VARCHAR(255),
    seller_name          VARCHAR(255),
    order_reference_no   VARCHAR(255),
    order_id             VARCHAR(255),
    transaction_id       VARCHAR(255),
    hsn_code             VARCHAR(255),
    fulfillment_type     VARCHAR(255),
    order_type           VARCHAR(255),
    order_tag            VARCHAR(255),
    slave_id             VARCHAR(255),
    slave_gstin          VARCHAR(255),
    slave_state          VARCHAR(255),
    destination_code     VARCHAR(255),
    place_of_supply      VARCHAR(255),
    seller_invoice       VARCHAR(255),
    order_date           TIMESTAMPTZ,
    transaction_date     TIMESTAMPTZ,

    product_value        NUMERIC,
    product_cgst         NUMERIC,
    product_sgst         NUMERIC,
    product_igst         NUMERIC,
    gross_product_value  NUMERIC,
    tcs_cgst             NUMERIC,
    tcs_sgst             NUMERIC,
    tcs_igst             NUMERIC,
    total_tcs            NUMERIC,

    clearing_document    VARCHAR(255),
    document_date        TIMESTAMPTZ,
    tul_gstin            VARCHAR(255),
    gstin_status         VARCHAR(255),

    gst_rate             NUMERIC,
    state                VARCHAR(255),
    sku                  VARCHAR(255),
    voucher_type         VARCHAR(255),
    is_cn                VARCHAR(255),
    invoice_number       VARCHAR(255),
    debtor               VARCHAR(255),
    sales_ledger         VARCHAR(255),
    stock_name           VARCHAR(255),
    qty                  INTEGER,
    output_igst          NUMERIC,
    output_cgst          NUMERIC,
    output_sgst          NUMERIC,
    cost                 NUMERIC,
    cost_qty             NUMERIC
);

CREATE INDEX IF NOT EXISTS sales_tatacliq_brand_idx ON sales_tatacliq (brand_id);
CREATE INDEX IF NOT EXISTS sales_tatacliq_filename_idx ON sales_tatacliq (filename);

ALTER TABLE sales_tatacliq ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_tatacliq FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_tatacliq_tenant_isolation ON sales_tatacliq;
CREATE POLICY sales_tatacliq_tenant_isolation ON sales_tatacliq
    USING (brand_id::text = current_setting('app.brand_id', true))
    WITH CHECK (brand_id::text = current_setting('app.brand_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON sales_tatacliq TO colonel_app;
