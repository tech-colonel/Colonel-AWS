-- 024: Create the sales_varee dynamic agent table for the new Sales-Varee agent
-- (seed-sales-varee.js). getDynamicModel.sync() is a no-op in unified mode, so this
-- table must be created here, as the superuser, before the agent's working files can
-- be saved. Schema mirrors what getDynamicModel would produce from the agent's
-- `columns` (see seed-sales-varee.js), plus the same RLS treatment as every other
-- sales_* table post-005-hardening (no app.bypass_rls escape hatch — only the real
-- superuser bypasses RLS).
CREATE TABLE IF NOT EXISTS sales_varee (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id             UUID NOT NULL DEFAULT NULLIF(current_setting('app.brand_id', true), '')::uuid,
    month                INTEGER,
    year                 INTEGER,
    file_type            VARCHAR(255),
    inventory_type       VARCHAR(255),
    filename             VARCHAR(255),
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    created_by           UUID,

    payment_cycle        VARCHAR(255),
    order_date           TIMESTAMPTZ,
    order_number         VARCHAR(255),
    customer_name        VARCHAR(255),
    customer_state       VARCHAR(255),
    invoice_number       VARCHAR(255),
    order_status         VARCHAR(255),
    sku                  VARCHAR(255),

    taxable_goods        NUMERIC,
    gst_on_goods         NUMERIC,
    gst_rate             NUMERIC,
    taxable_cod          NUMERIC,
    gst_on_cod           NUMERIC,
    total_invoice_value  NUMERIC,

    final_rate           NUMERIC,
    final_taxable        NUMERIC,
    igst                 NUMERIC,
    cgst                 NUMERIC,
    sgst                 NUMERIC,
    quantity             INTEGER,

    tds                  NUMERIC,
    tcs                  NUMERIC,
    customer_gst_no      VARCHAR(255),
    fulfilled_by         VARCHAR(255),
    seller_state         VARCHAR(255),
    invoice_date         TIMESTAMPTZ,
    hsn_code             VARCHAR(255),

    sale_type            VARCHAR(255),
    transaction_type     VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS sales_varee_brand_idx ON sales_varee (brand_id);
CREATE INDEX IF NOT EXISTS sales_varee_filename_idx ON sales_varee (filename);

ALTER TABLE sales_varee ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_varee FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_varee_tenant_isolation ON sales_varee;
CREATE POLICY sales_varee_tenant_isolation ON sales_varee
    USING (brand_id::text = current_setting('app.brand_id', true))
    WITH CHECK (brand_id::text = current_setting('app.brand_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON sales_varee TO colonel_app;
