-- 025: Create the sales_pepperfry dynamic agent table for the new Sales-Pepperfry agent
-- (seed-sales-pepperfry.js). getDynamicModel.sync() is a no-op in unified mode (the app
-- connects as the non-superuser colonel_app role, which has no CREATE privilege), so this
-- table must be created here, as the superuser, before the agent's working files can be
-- saved. Schema mirrors what getDynamicModel would produce from the agent's `columns` (see
-- seed-sales-pepperfry.js), plus the same RLS treatment as every other sales_* table
-- post-005-hardening (no app.bypass_rls escape hatch — only the real superuser bypasses RLS).
CREATE TABLE IF NOT EXISTS sales_pepperfry (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id               UUID NOT NULL DEFAULT NULLIF(current_setting('app.brand_id', true), '')::uuid,
    month                  INTEGER,
    year                   INTEGER,
    file_type              VARCHAR(255),
    inventory_type         VARCHAR(255),
    filename               VARCHAR(255),
    created_at             TIMESTAMPTZ DEFAULT NOW(),
    created_by             UUID,

    order_id_sku           VARCHAR(255),
    state                  VARCHAR(255),
    gstin                  VARCHAR(255),
    document_type          VARCHAR(255),
    taxability             VARCHAR(255),
    supply_type            VARCHAR(255),
    gstin_of_recipient     VARCHAR(255),
    recipient_state        VARCHAR(255),
    name_of_recipient      VARCHAR(255),
    invoice_number         VARCHAR(255),
    invoice_date           TIMESTAMPTZ,
    invoice_value          NUMERIC,
    total_discount         NUMERIC,
    item_code               VARCHAR(255),
    category               VARCHAR(255),
    hsn_sac                VARCHAR(255),
    product_description    VARCHAR(255),
    invoiced_quantity      NUMERIC,
    sale_price             NUMERIC,
    merchant_discount      NUMERIC,

    -- SOP column mapping (section 7): Taxable Value, Tax Rate, IGST/CGST/SGST
    taxable_value          NUMERIC,
    tax_rate               NUMERIC,
    igst                   NUMERIC,
    cgst                   NUMERIC,
    sgst                   NUMERIC,

    ship_from_state        VARCHAR(255),
    ship_to_state          VARCHAR(255),
    tcs_amount             NUMERIC,
    status_of_delivery     VARCHAR(255),
    commission_amount      NUMERIC,
    commission_invoice_no  VARCHAR(255),
    return_date            TIMESTAMPTZ,

    sale_type              VARCHAR(255), -- B2B / B2C
    transaction_type       VARCHAR(255)  -- Sale / Return
);

CREATE INDEX IF NOT EXISTS sales_pepperfry_brand_idx ON sales_pepperfry (brand_id);
CREATE INDEX IF NOT EXISTS sales_pepperfry_filename_idx ON sales_pepperfry (filename);

ALTER TABLE sales_pepperfry ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_pepperfry FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_pepperfry_tenant_isolation ON sales_pepperfry;
CREATE POLICY sales_pepperfry_tenant_isolation ON sales_pepperfry
    USING (brand_id::text = current_setting('app.brand_id', true))
    WITH CHECK (brand_id::text = current_setting('app.brand_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON sales_pepperfry TO colonel_app;
