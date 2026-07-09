-- ============================================================
-- 002_dynamic_agent_tables.sql  — dynamic sales/marketplace/invoice tables
-- Recreated faithfully in the UNIFIED DB (colonel_agent_accountant) with brand_id + RLS.
-- Auto-generated (Phase 1): columns unioned across all brand DBs.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- invoice_process  (in 11 brand DBs, ~25 rows total, 30 data cols)
CREATE TABLE IF NOT EXISTS invoice_process (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL,
    processed_on TIMESTAMPTZ,
    company TEXT,
    invoice_number TEXT,
    invoice_date TEXT,
    due_date TEXT,
    seller_gstin TEXT,
    buyer_gstin TEXT,
    category TEXT,
    product_name TEXT,
    hsn_code TEXT,
    quantity INTEGER,
    unit TEXT,
    rate TEXT,
    cgst_rate TEXT,
    sgst_rate TEXT,
    igst_rate TEXT,
    cgst_amount TEXT,
    sgst_amount TEXT,
    igst_amount TEXT,
    gst_amount TEXT,
    taxable_value TEXT,
    invoice_link TEXT,
    status TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    month INTEGER,
    year INTEGER,
    file_type TEXT,
    inventory_type TEXT,
    filename TEXT
);
CREATE INDEX IF NOT EXISTS invoice_process_brand_idx ON invoice_process (brand_id);
ALTER TABLE invoice_process ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_process FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoice_process_brand_policy ON invoice_process;
CREATE POLICY invoice_process_brand_policy ON invoice_process
    USING (current_setting('app.bypass_rls', true) = 'true'
           OR brand_id::text = current_setting('app.brand_id', true));

-- invoice_agent  (in 11 brand DBs, ~27 rows total, 30 data cols)
CREATE TABLE IF NOT EXISTS invoice_agent (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id       UUID NOT NULL,
    processed_on   TIMESTAMPTZ,
    company        TEXT,
    invoice_number TEXT,
    invoice_date   TEXT,
    due_date       TEXT,
    seller_gstin   TEXT,
    buyer_gstin    TEXT,
    category       TEXT,
    product_name   TEXT,
    hsn_code       TEXT,
    quantity       INTEGER,
    unit           TEXT,
    rate           TEXT,
    cgst_rate      TEXT,
    sgst_rate      TEXT,
    igst_rate      TEXT,
    cgst_amount    TEXT,
    sgst_amount    TEXT,
    igst_amount    TEXT,
    gst_amount     TEXT,
    taxable_value  TEXT,
    invoice_link   TEXT,
    status         TEXT,
    created_at     TIMESTAMPTZ,
    updated_at     TIMESTAMPTZ,
    month          INTEGER,
    year           INTEGER,
    file_type      TEXT,
    inventory_type TEXT,
    filename       TEXT
);
CREATE INDEX IF NOT EXISTS invoice_agent_brand_idx ON invoice_agent (brand_id);
ALTER TABLE invoice_agent ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_agent FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoice_agent_brand_policy ON invoice_agent;
CREATE POLICY invoice_agent_brand_policy ON invoice_agent
    USING (current_setting('app.bypass_rls', true) = 'true'
           OR brand_id::text = current_setting('app.brand_id', true));

-- flipkart  (in 10 brand DBs, ~0 rows total, 65 data cols)
CREATE TABLE IF NOT EXISTS flipkart (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL,
    month INTEGER,
    year INTEGER,
    inventory_type VARCHAR(255),
    filename VARCHAR(255),
    created_at TIMESTAMPTZ,
    date TIMESTAMPTZ,
    seller_gstin VARCHAR(255),
    seller_state VARCHAR(255),
    order_id VARCHAR(255),
    order_item_id VARCHAR(255),
    order_type VARCHAR(255),
    event_type VARCHAR(255),
    event_sub_type VARCHAR(255),
    order_date TIMESTAMPTZ,
    order_approval_date TIMESTAMPTZ,
    sku VARCHAR(255),
    fg VARCHAR(255),
    fsn VARCHAR(255),
    item_description VARCHAR(255),
    hsn_code VARCHAR(255),
    quantity INTEGER,
    fulfilment_type VARCHAR(255),
    warehouse_id VARCHAR(255),
    ship_from_state VARCHAR(255),
    price_before_discount NUMERIC,
    total_discount NUMERIC,
    price_after_discount NUMERIC,
    shipping_charges NUMERIC,
    final_taxable_sales_value NUMERIC,
    final_shipping_taxable_value NUMERIC,
    final_invoice_amount NUMERIC,
    gst_rate NUMERIC,
    cgst_rate NUMERIC,
    sgst_rate NUMERIC,
    igst_rate NUMERIC,
    cgst_amount NUMERIC,
    sgst_amount NUMERIC,
    igst_amount NUMERIC,
    final_cgst_tax NUMERIC,
    final_sgst_tax NUMERIC,
    final_igst_tax NUMERIC,
    shipping_cgst_tax NUMERIC,
    shipping_sgst_tax NUMERIC,
    shipping_igst_tax NUMERIC,
    tcs_igst_amount NUMERIC,
    tcs_cgst_amount NUMERIC,
    tcs_sgst_amount NUMERIC,
    total_tcs NUMERIC,
    tds_rate NUMERIC,
    tds_amount NUMERIC,
    buyer_invoice_id VARCHAR(255),
    buyer_invoice_date TIMESTAMPTZ,
    buyer_invoice_amount NUMERIC,
    final_invoice_number VARCHAR(255),
    billing_state VARCHAR(255),
    billing_pincode VARCHAR(255),
    shipping_state VARCHAR(255),
    shipping_pincode VARCHAR(255),
    business_name VARCHAR(255),
    business_gstin VARCHAR(255),
    is_shopsy_order BOOLEAN,
    tally_ledger VARCHAR(255),
    imei VARCHAR(255),
    file_type VARCHAR(255),
    updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS flipkart_brand_idx ON flipkart (brand_id);
ALTER TABLE flipkart ENABLE ROW LEVEL SECURITY;
ALTER TABLE flipkart FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flipkart_brand_policy ON flipkart;
CREATE POLICY flipkart_brand_policy ON flipkart
    USING (current_setting('app.bypass_rls', true) = 'true'
           OR brand_id::text = current_setting('app.brand_id', true));

-- amazon  (in 10 brand DBs, ~0 rows total, 110 data cols)
CREATE TABLE IF NOT EXISTS amazon (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL,
    month INTEGER,
    year INTEGER,
    inventory_type VARCHAR(255),
    file_type VARCHAR(255),
    filename VARCHAR(255),
    created_at TIMESTAMPTZ,
    date TIMESTAMPTZ,
    seller_gstin VARCHAR(255),
    invoice_number VARCHAR(255),
    invoice_date TIMESTAMPTZ,
    transaction_type VARCHAR(255),
    order_id VARCHAR(255),
    shipment_id VARCHAR(255),
    shipment_date TIMESTAMPTZ,
    order_date TIMESTAMPTZ,
    shipment_item_id VARCHAR(255),
    quantity INTEGER,
    item_description VARCHAR(255),
    asin VARCHAR(255),
    hsn_sac VARCHAR(255),
    sku VARCHAR(255),
    fg VARCHAR(255),
    product_tax_code VARCHAR(255),
    bill_from_city VARCHAR(255),
    bill_from_state VARCHAR(255),
    bill_from_country VARCHAR(255),
    bill_from_postal_code VARCHAR(255),
    ship_from_city VARCHAR(255),
    ship_from_state VARCHAR(255),
    ship_from_country VARCHAR(255),
    ship_from_postal_code VARCHAR(255),
    ship_to_city VARCHAR(255),
    ship_to_state VARCHAR(255),
    ship_to_state_tally_ledger VARCHAR(255),
    final_invoice_number VARCHAR(255),
    ship_to_country VARCHAR(255),
    ship_to_postal_code VARCHAR(255),
    invoice_amount NUMERIC,
    tax_exclusive_gross NUMERIC,
    total_tax_amount NUMERIC,
    cgst_rate NUMERIC,
    sgst_rate NUMERIC,
    utgst_rate NUMERIC,
    igst_rate NUMERIC,
    compensatory_cess_rate NUMERIC,
    principal_amount NUMERIC,
    principal_amount_basis NUMERIC,
    cgst_tax NUMERIC,
    sgst_tax NUMERIC,
    utgst_tax NUMERIC,
    igst_tax NUMERIC,
    compensatory_cess_tax NUMERIC,
    final_tax_rate NUMERIC,
    final_taxable_sales_value NUMERIC,
    final_taxable_shipping_value NUMERIC,
    final_cgst_tax NUMERIC,
    final_sgst_tax NUMERIC,
    final_igst_tax NUMERIC,
    final_shipping_cgst_tax NUMERIC,
    final_shipping_sgst_tax NUMERIC,
    final_shipping_igst_tax NUMERIC,
    final_amount_receivable NUMERIC,
    shipping_amount NUMERIC,
    shipping_amount_basis NUMERIC,
    shipping_cgst_tax NUMERIC,
    shipping_sgst_tax NUMERIC,
    shipping_utgst_tax NUMERIC,
    shipping_igst_tax NUMERIC,
    shipping_cess_tax NUMERIC,
    gift_wrap_amount NUMERIC,
    gift_wrap_amount_basis NUMERIC,
    gift_wrap_cgst_tax NUMERIC,
    gift_wrap_sgst_tax NUMERIC,
    gift_wrap_utgst_tax NUMERIC,
    gift_wrap_igst_tax NUMERIC,
    gift_wrap_compensatory_cess_tax NUMERIC,
    item_promo_discount NUMERIC,
    item_promo_discount_basis NUMERIC,
    item_promo_tax NUMERIC,
    shipping_promo_discount NUMERIC,
    shipping_promo_discount_basis NUMERIC,
    shipping_promo_tax NUMERIC,
    gift_wrap_promo_discount NUMERIC,
    gift_wrap_promo_discount_basis NUMERIC,
    gift_wrap_promo_tax NUMERIC,
    tcs_cgst_rate NUMERIC,
    tcs_cgst_amount NUMERIC,
    tcs_sgst_rate NUMERIC,
    tcs_sgst_amount NUMERIC,
    tcs_utgst_rate NUMERIC,
    tcs_utgst_amount NUMERIC,
    tcs_igst_rate NUMERIC,
    tcs_igst_amount NUMERIC,
    warehouse_id VARCHAR(255),
    fulfillment_channel VARCHAR(255),
    payment_method_code VARCHAR(255),
    bill_to_city VARCHAR(255),
    bill_to_state VARCHAR(255),
    bill_to_country VARCHAR(255),
    bill_to_postal_code VARCHAR(255),
    customer_bill_to_gstin VARCHAR(255),
    customer_ship_to_gstin VARCHAR(255),
    buyer_name VARCHAR(255),
    credit_note_number VARCHAR(255),
    credit_note_date TIMESTAMPTZ,
    irn_number VARCHAR(255),
    irn_filing_status VARCHAR(255),
    irn_date TIMESTAMPTZ,
    irn_error_code VARCHAR(255),
    updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS amazon_brand_idx ON amazon (brand_id);
ALTER TABLE amazon ENABLE ROW LEVEL SECURITY;
ALTER TABLE amazon FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS amazon_brand_policy ON amazon;
CREATE POLICY amazon_brand_policy ON amazon
    USING (current_setting('app.bypass_rls', true) = 'true'
           OR brand_id::text = current_setting('app.brand_id', true));

-- nykaa  (in 7 brand DBs, ~0 rows total, 6 data cols)
CREATE TABLE IF NOT EXISTS nykaa (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL,
    month INTEGER,
    year INTEGER,
    filename VARCHAR(255),
    file_type VARCHAR(255),
    inventory_type VARCHAR(255),
    created_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS nykaa_brand_idx ON nykaa (brand_id);
ALTER TABLE nykaa ENABLE ROW LEVEL SECURITY;
ALTER TABLE nykaa FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nykaa_brand_policy ON nykaa;
CREATE POLICY nykaa_brand_policy ON nykaa
    USING (current_setting('app.bypass_rls', true) = 'true'
           OR brand_id::text = current_setting('app.brand_id', true));

-- myntra  (in 6 brand DBs, ~0 rows total, 18 data cols)
CREATE TABLE IF NOT EXISTS myntra (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL,
    year INTEGER,
    filename VARCHAR(255),
    created_at TIMESTAMPTZ,
    month INTEGER,
    date TIMESTAMPTZ,
    seller_gstin VARCHAR(255),
    invoice_number VARCHAR(255),
    debtor_ledger VARCHAR(255),
    sku VARCHAR(255),
    quantity INTEGER,
    shipping VARCHAR(255),
    gst_rate NUMERIC,
    base_value NUMERIC,
    file_type VARCHAR(255),
    igst_amount NUMERIC,
    cgst_amount NUMERIC,
    sgst_amount NUMERIC,
    invoice_amount NUMERIC
);
CREATE INDEX IF NOT EXISTS myntra_brand_idx ON myntra (brand_id);
ALTER TABLE myntra ENABLE ROW LEVEL SECURITY;
ALTER TABLE myntra FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS myntra_brand_policy ON myntra;
CREATE POLICY myntra_brand_policy ON myntra
    USING (current_setting('app.bypass_rls', true) = 'true'
           OR brand_id::text = current_setting('app.brand_id', true));

-- meesho  (in 6 brand DBs, ~0 rows total, 6 data cols)
CREATE TABLE IF NOT EXISTS meesho (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL,
    month INTEGER,
    year INTEGER,
    filename VARCHAR(255),
    created_at TIMESTAMPTZ,
    file_type VARCHAR(255),
    inventory_type VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS meesho_brand_idx ON meesho (brand_id);
ALTER TABLE meesho ENABLE ROW LEVEL SECURITY;
ALTER TABLE meesho FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meesho_brand_policy ON meesho;
CREATE POLICY meesho_brand_policy ON meesho
    USING (current_setting('app.bypass_rls', true) = 'true'
           OR brand_id::text = current_setting('app.brand_id', true));

-- sales_amazon  (in 4 brand DBs, ~96 rows total, 109 data cols)
CREATE TABLE IF NOT EXISTS sales_amazon (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL,
    month INTEGER,
    year INTEGER,
    file_type VARCHAR(255),
    inventory_type VARCHAR(255),
    filename VARCHAR(255),
    created_at TIMESTAMPTZ,
    date TIMESTAMPTZ,
    seller_gstin VARCHAR(255),
    invoice_number VARCHAR(255),
    invoice_date TIMESTAMPTZ,
    transaction_type VARCHAR(255),
    order_id VARCHAR(255),
    shipment_id VARCHAR(255),
    shipment_date TIMESTAMPTZ,
    order_date TIMESTAMPTZ,
    shipment_item_id VARCHAR(255),
    quantity INTEGER,
    item_description VARCHAR(255),
    asin VARCHAR(255),
    hsn_sac VARCHAR(255),
    sku VARCHAR(255),
    fg VARCHAR(255),
    product_tax_code VARCHAR(255),
    bill_from_city VARCHAR(255),
    bill_from_state VARCHAR(255),
    bill_from_country VARCHAR(255),
    bill_from_postal_code VARCHAR(255),
    ship_from_city VARCHAR(255),
    ship_from_state VARCHAR(255),
    ship_from_country VARCHAR(255),
    ship_from_postal_code VARCHAR(255),
    ship_to_city VARCHAR(255),
    ship_to_state VARCHAR(255),
    ship_to_state_tally_ledger VARCHAR(255),
    final_invoice_number VARCHAR(255),
    ship_to_country VARCHAR(255),
    ship_to_postal_code VARCHAR(255),
    invoice_amount NUMERIC,
    tax_exclusive_gross NUMERIC,
    total_tax_amount NUMERIC,
    cgst_rate NUMERIC,
    sgst_rate NUMERIC,
    utgst_rate NUMERIC,
    igst_rate NUMERIC,
    compensatory_cess_rate NUMERIC,
    principal_amount NUMERIC,
    principal_amount_basis NUMERIC,
    cgst_tax NUMERIC,
    sgst_tax NUMERIC,
    utgst_tax NUMERIC,
    igst_tax NUMERIC,
    compensatory_cess_tax NUMERIC,
    final_tax_rate NUMERIC,
    final_taxable_sales_value NUMERIC,
    final_taxable_shipping_value NUMERIC,
    final_cgst_tax NUMERIC,
    final_sgst_tax NUMERIC,
    final_igst_tax NUMERIC,
    final_shipping_cgst_tax NUMERIC,
    final_shipping_sgst_tax NUMERIC,
    final_shipping_igst_tax NUMERIC,
    final_amount_receivable NUMERIC,
    shipping_amount NUMERIC,
    shipping_amount_basis NUMERIC,
    shipping_cgst_tax NUMERIC,
    shipping_sgst_tax NUMERIC,
    shipping_utgst_tax NUMERIC,
    shipping_igst_tax NUMERIC,
    shipping_cess_tax NUMERIC,
    gift_wrap_amount NUMERIC,
    gift_wrap_amount_basis NUMERIC,
    gift_wrap_cgst_tax NUMERIC,
    gift_wrap_sgst_tax NUMERIC,
    gift_wrap_utgst_tax NUMERIC,
    gift_wrap_igst_tax NUMERIC,
    gift_wrap_compensatory_cess_tax NUMERIC,
    item_promo_discount NUMERIC,
    item_promo_discount_basis NUMERIC,
    item_promo_tax NUMERIC,
    shipping_promo_discount NUMERIC,
    shipping_promo_discount_basis NUMERIC,
    shipping_promo_tax NUMERIC,
    gift_wrap_promo_discount NUMERIC,
    gift_wrap_promo_discount_basis NUMERIC,
    gift_wrap_promo_tax NUMERIC,
    tcs_cgst_rate NUMERIC,
    tcs_cgst_amount NUMERIC,
    tcs_sgst_rate NUMERIC,
    tcs_sgst_amount NUMERIC,
    tcs_utgst_rate NUMERIC,
    tcs_utgst_amount NUMERIC,
    tcs_igst_rate NUMERIC,
    tcs_igst_amount NUMERIC,
    warehouse_id VARCHAR(255),
    fulfillment_channel VARCHAR(255),
    payment_method_code VARCHAR(255),
    bill_to_city VARCHAR(255),
    bill_to_state VARCHAR(255),
    bill_to_country VARCHAR(255),
    bill_to_postal_code VARCHAR(255),
    customer_bill_to_gstin VARCHAR(255),
    customer_ship_to_gstin VARCHAR(255),
    buyer_name VARCHAR(255),
    credit_note_number VARCHAR(255),
    credit_note_date TIMESTAMPTZ,
    irn_number VARCHAR(255),
    irn_filing_status VARCHAR(255),
    irn_date TIMESTAMPTZ,
    irn_error_code VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS sales_amazon_brand_idx ON sales_amazon (brand_id);
ALTER TABLE sales_amazon ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_amazon FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_amazon_brand_policy ON sales_amazon;
CREATE POLICY sales_amazon_brand_policy ON sales_amazon
    USING (current_setting('app.bypass_rls', true) = 'true'
           OR brand_id::text = current_setting('app.brand_id', true));

-- ajio  (in 4 brand DBs, ~0 rows total, 6 data cols)
CREATE TABLE IF NOT EXISTS ajio (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL,
    month INTEGER,
    year INTEGER,
    filename VARCHAR(255),
    created_at TIMESTAMPTZ,
    file_type VARCHAR(255),
    inventory_type VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS ajio_brand_idx ON ajio (brand_id);
ALTER TABLE ajio ENABLE ROW LEVEL SECURITY;
ALTER TABLE ajio FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ajio_brand_policy ON ajio;
CREATE POLICY ajio_brand_policy ON ajio
    USING (current_setting('app.bypass_rls', true) = 'true'
           OR brand_id::text = current_setting('app.brand_id', true));

-- sales_cread  (in 3 brand DBs, ~0 rows total, 30 data cols)
CREATE TABLE IF NOT EXISTS sales_cread (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL,
    month INTEGER,
    year INTEGER,
    file_type VARCHAR(255),
    inventory_type VARCHAR(255),
    filename VARCHAR(255),
    created_at TIMESTAMPTZ,
    order_date TIMESTAMPTZ,
    reference_code VARCHAR(255),
    ee_invoice_no VARCHAR(255),
    order_status VARCHAR(255),
    shipping_status VARCHAR(255),
    awb_no VARCHAR(255),
    suborder_quantity INTEGER,
    item_quantity INTEGER,
    sku VARCHAR(255),
    final_sku VARCHAR(255),
    mis_sku VARCHAR(255),
    shipping_zip_code VARCHAR(255),
    shipping_state VARCHAR(255),
    party_name VARCHAR(255),
    invoice_no VARCHAR(255),
    order_invoice_amount NUMERIC,
    tax NUMERIC,
    item_price_ex_tax NUMERIC,
    taxable_amount NUMERIC,
    cgst NUMERIC,
    sgst NUMERIC,
    igst NUMERIC,
    cred_status VARCHAR(255),
    final_status VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS sales_cread_brand_idx ON sales_cread (brand_id);
ALTER TABLE sales_cread ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_cread FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_cread_brand_policy ON sales_cread;
CREATE POLICY sales_cread_brand_policy ON sales_cread
    USING (current_setting('app.bypass_rls', true) = 'true'
           OR brand_id::text = current_setting('app.brand_id', true));

-- total_sales_analyzer  (in 2 brand DBs, ~0 rows total, 21 data cols)
CREATE TABLE IF NOT EXISTS total_sales_analyzer (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL,
    month INTEGER,
    year INTEGER,
    file_type VARCHAR(255),
    inventory_type VARCHAR(255),
    filename VARCHAR(255),
    created_at TIMESTAMPTZ,
    account VARCHAR(255),
    date TIMESTAMPTZ,
    particulars VARCHAR(255),
    "SKU" VARCHAR(255),
    buyer_supplier VARCHAR(255),
    buyer_supplier_address TEXT,
    city VARCHAR(255),
    state VARCHAR(255),
    depo_name VARCHAR(255),
    voucher_type VARCHAR(255),
    voucher_no VARCHAR(255),
    quantity VARCHAR(255),
    value NUMERIC,
    gross_total NUMERIC,
    sales_value NUMERIC
);
CREATE INDEX IF NOT EXISTS total_sales_analyzer_brand_idx ON total_sales_analyzer (brand_id);
ALTER TABLE total_sales_analyzer ENABLE ROW LEVEL SECURITY;
ALTER TABLE total_sales_analyzer FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS total_sales_analyzer_brand_policy ON total_sales_analyzer;
CREATE POLICY total_sales_analyzer_brand_policy ON total_sales_analyzer
    USING (current_setting('app.bypass_rls', true) = 'true'
           OR brand_id::text = current_setting('app.brand_id', true));

-- shopify_order_cycle  (in 2 brand DBs, ~0 rows total, 6 data cols)
CREATE TABLE IF NOT EXISTS shopify_order_cycle (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL,
    month INTEGER,
    year INTEGER,
    file_type VARCHAR(255),
    inventory_type VARCHAR(255),
    filename VARCHAR(255),
    created_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS shopify_order_cycle_brand_idx ON shopify_order_cycle (brand_id);
ALTER TABLE shopify_order_cycle ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_order_cycle FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shopify_order_cycle_brand_policy ON shopify_order_cycle;
CREATE POLICY shopify_order_cycle_brand_policy ON shopify_order_cycle
    USING (current_setting('app.bypass_rls', true) = 'true'
           OR brand_id::text = current_setting('app.brand_id', true));

-- settlement_amazon  (in 2 brand DBs, ~0 rows total, 33 data cols)
CREATE TABLE IF NOT EXISTS settlement_amazon (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL,
    month INTEGER,
    year INTEGER,
    file_type VARCHAR(255),
    inventory_type VARCHAR(255),
    filename VARCHAR(255),
    created_at TIMESTAMPTZ,
    date_time TIMESTAMPTZ,
    settlement_id VARCHAR(255),
    type VARCHAR(255),
    order_id VARCHAR(255),
    sku VARCHAR(255),
    description VARCHAR(255),
    quantity INTEGER,
    marketplace VARCHAR(255),
    account_type VARCHAR(255),
    fulfillment VARCHAR(255),
    order_city VARCHAR(255),
    order_state VARCHAR(255),
    order_postal VARCHAR(255),
    product_sales NUMERIC,
    shipping_credits NUMERIC,
    gift_wrap_credits NUMERIC,
    promotional_rebates NUMERIC,
    gst_before_tcs NUMERIC,
    tcs_cgst NUMERIC,
    tcs_sgst NUMERIC,
    tcs_igst NUMERIC,
    tds_194o NUMERIC,
    selling_fees NUMERIC,
    fba_fees NUMERIC,
    other_transaction_fees NUMERIC,
    other NUMERIC,
    total NUMERIC
);
CREATE INDEX IF NOT EXISTS settlement_amazon_brand_idx ON settlement_amazon (brand_id);
ALTER TABLE settlement_amazon ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_amazon FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS settlement_amazon_brand_policy ON settlement_amazon;
CREATE POLICY settlement_amazon_brand_policy ON settlement_amazon
    USING (current_setting('app.bypass_rls', true) = 'true'
           OR brand_id::text = current_setting('app.brand_id', true));

-- sales_shopify  (in 2 brand DBs, ~0 rows total, 42 data cols)
CREATE TABLE IF NOT EXISTS sales_shopify (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL,
    month INTEGER,
    year INTEGER,
    file_type VARCHAR(255),
    inventory_type VARCHAR(255),
    filename VARCHAR(255),
    created_at TIMESTAMPTZ,
    date TIMESTAMPTZ,
    day TIMESTAMPTZ,
    sales VARCHAR(255),
    product_variant_sku VARCHAR(255),
    fg VARCHAR(255),
    product_variant_id VARCHAR(255),
    product_variant_title VARCHAR(255),
    shipping_region VARCHAR(255),
    billing_region VARCHAR(255),
    tally_ledger VARCHAR(255),
    sales_ledger VARCHAR(255),
    invoice_number VARCHAR(255),
    customer_name VARCHAR(255),
    order_fulfillment_status VARCHAR(255),
    product_id VARCHAR(255),
    product_title VARCHAR(255),
    order_id VARCHAR(255),
    billing_city VARCHAR(255),
    shipping_city VARCHAR(255),
    gross_sales NUMERIC,
    discounts NUMERIC,
    returns NUMERIC,
    net_sales NUMERIC,
    shipping_charges NUMERIC,
    return_fees NUMERIC,
    taxes NUMERIC,
    total_sales NUMERIC,
    quantity_returned INTEGER,
    quantity_ordered INTEGER,
    quantity_ordered_per_order INTEGER,
    final_qty INTEGER,
    gst_rate NUMERIC,
    taxable_value NUMERIC,
    igst NUMERIC,
    cgst NUMERIC,
    sgst NUMERIC
);
CREATE INDEX IF NOT EXISTS sales_shopify_brand_idx ON sales_shopify (brand_id);
ALTER TABLE sales_shopify ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_shopify FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_shopify_brand_policy ON sales_shopify;
CREATE POLICY sales_shopify_brand_policy ON sales_shopify
    USING (current_setting('app.bypass_rls', true) = 'true'
           OR brand_id::text = current_setting('app.brand_id', true));

-- sales_mirrow  (in 2 brand DBs, ~0 rows total, 24 data cols)
CREATE TABLE IF NOT EXISTS sales_mirrow (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL,
    month INTEGER,
    year INTEGER,
    file_type VARCHAR(255),
    inventory_type VARCHAR(255),
    filename VARCHAR(255),
    created_at TIMESTAMPTZ,
    date TIMESTAMPTZ,
    order_id VARCHAR(255),
    sku VARCHAR(255),
    product_name VARCHAR(255),
    quantity INTEGER,
    mrp NUMERIC,
    selling_price NUMERIC,
    taxable_value NUMERIC,
    gst_rate NUMERIC,
    cgst NUMERIC,
    sgst NUMERIC,
    igst NUMERIC,
    total_amount NUMERIC,
    state VARCHAR(255),
    city VARCHAR(255),
    tally_ledger VARCHAR(255),
    invoice_number VARCHAR(255),
    fg VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS sales_mirrow_brand_idx ON sales_mirrow (brand_id);
ALTER TABLE sales_mirrow ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_mirrow FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_mirrow_brand_policy ON sales_mirrow;
CREATE POLICY sales_mirrow_brand_policy ON sales_mirrow
    USING (current_setting('app.bypass_rls', true) = 'true'
           OR brand_id::text = current_setting('app.brand_id', true));

-- sales_zepto  (in 1 brand DBs, ~0 rows total, 33 data cols)
CREATE TABLE IF NOT EXISTS sales_zepto (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL,
    month INTEGER,
    year INTEGER,
    file_type VARCHAR(255),
    inventory_type VARCHAR(255),
    filename VARCHAR(255),
    created_at TIMESTAMPTZ,
    date TIMESTAMPTZ,
    sku_number VARCHAR(255),
    sku_name VARCHAR(255),
    ean VARCHAR(255),
    sku_category VARCHAR(255),
    sku_sub_category VARCHAR(255),
    brand_name VARCHAR(255),
    manufacturer_name VARCHAR(255),
    manufacturer_id VARCHAR(255),
    city VARCHAR(255),
    sales_qty_units INTEGER,
    mrp NUMERIC,
    selling_price NUMERIC,
    gross_merchandise_value NUMERIC,
    gross_selling_value NUMERIC,
    pack_size INTEGER,
    unit_of_measure VARCHAR(255),
    orders INTEGER,
    fg VARCHAR(255),
    state VARCHAR(255),
    tally_ledger VARCHAR(255),
    invoice_number VARCHAR(255),
    tax NUMERIC,
    taxable_value NUMERIC,
    igst NUMERIC,
    cgst NUMERIC,
    sgst NUMERIC
);
CREATE INDEX IF NOT EXISTS sales_zepto_brand_idx ON sales_zepto (brand_id);
ALTER TABLE sales_zepto ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_zepto FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_zepto_brand_policy ON sales_zepto;
CREATE POLICY sales_zepto_brand_policy ON sales_zepto
    USING (current_setting('app.bypass_rls', true) = 'true'
           OR brand_id::text = current_setting('app.brand_id', true));

-- sales_myntra  (in 1 brand DBs, ~0 rows total, 19 data cols)
CREATE TABLE IF NOT EXISTS sales_myntra (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL,
    month INTEGER,
    year INTEGER,
    file_type VARCHAR(255),
    inventory_type VARCHAR(255),
    filename VARCHAR(255),
    created_at TIMESTAMPTZ,
    date TIMESTAMPTZ,
    seller_gstin VARCHAR(255),
    invoice_number VARCHAR(255),
    debtor_ledger VARCHAR(255),
    sku VARCHAR(255),
    quantity INTEGER,
    shipping VARCHAR(255),
    gst_rate NUMERIC,
    base_value NUMERIC,
    igst_amount NUMERIC,
    cgst_amount NUMERIC,
    sgst_amount NUMERIC,
    invoice_amount NUMERIC
);
CREATE INDEX IF NOT EXISTS sales_myntra_brand_idx ON sales_myntra (brand_id);
ALTER TABLE sales_myntra ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_myntra FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_myntra_brand_policy ON sales_myntra;
CREATE POLICY sales_myntra_brand_policy ON sales_myntra
    USING (current_setting('app.bypass_rls', true) = 'true'
           OR brand_id::text = current_setting('app.brand_id', true));

-- sales_jiomart  (in 1 brand DBs, ~0 rows total, 59 data cols)
CREATE TABLE IF NOT EXISTS sales_jiomart (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL,
    month INTEGER,
    year INTEGER,
    file_type VARCHAR(255),
    inventory_type VARCHAR(255),
    filename VARCHAR(255),
    created_at TIMESTAMPTZ,
    seller_gstin VARCHAR(255),
    order_id VARCHAR(255),
    order_item_id VARCHAR(255),
    order_type VARCHAR(255),
    order_date TIMESTAMPTZ,
    order_approval_date TIMESTAMPTZ,
    type VARCHAR(255),
    shipment_number VARCHAR(255),
    original_shipment_number VARCHAR(255),
    fulfillment_type VARCHAR(255),
    fulfiller_name VARCHAR(255),
    product_name VARCHAR(255),
    product_id VARCHAR(255),
    sku VARCHAR(255),
    fg VARCHAR(255),
    hsn_code VARCHAR(255),
    order_status VARCHAR(255),
    event_type VARCHAR(255),
    event_sub_type VARCHAR(255),
    quantity INTEGER,
    buyer_invoice_id VARCHAR(255),
    original_invoice_id VARCHAR(255),
    buyer_invoice_date TIMESTAMPTZ,
    tcs_date TIMESTAMPTZ,
    buyer_invoice_amount NUMERIC,
    shipped_from_state VARCHAR(255),
    billed_from_state VARCHAR(255),
    billing_pincode VARCHAR(255),
    billing_state VARCHAR(255),
    delivery_pincode VARCHAR(255),
    delivery_state VARCHAR(255),
    seller_coupon_code VARCHAR(255),
    offer_price NUMERIC,
    seller_coupon_amount NUMERIC,
    final_invoice_amount NUMERIC,
    tax_type VARCHAR(255),
    taxable_value NUMERIC,
    igst_rate NUMERIC,
    igst_amount NUMERIC,
    cgst_rate NUMERIC,
    cgst_amount NUMERIC,
    sgst_rate NUMERIC,
    sgst_amount NUMERIC,
    tcs_igst_rate NUMERIC,
    tcs_igst_amount NUMERIC,
    tcs_cgst_rate NUMERIC,
    tcs_cgst_amount NUMERIC,
    tcs_sgst_rate NUMERIC,
    tcs_sgst_amount NUMERIC,
    total_tcs_deducted NUMERIC,
    tds_rate NUMERIC,
    tds_amount NUMERIC,
    final_gst_rate NUMERIC
);
CREATE INDEX IF NOT EXISTS sales_jiomart_brand_idx ON sales_jiomart (brand_id);
ALTER TABLE sales_jiomart ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_jiomart FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_jiomart_brand_policy ON sales_jiomart;
CREATE POLICY sales_jiomart_brand_policy ON sales_jiomart
    USING (current_setting('app.bypass_rls', true) = 'true'
           OR brand_id::text = current_setting('app.brand_id', true));

-- sales_flipkart  (in 1 brand DBs, ~0 rows total, 64 data cols)
CREATE TABLE IF NOT EXISTS sales_flipkart (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL,
    month INTEGER,
    year INTEGER,
    file_type VARCHAR(255),
    inventory_type VARCHAR(255),
    filename VARCHAR(255),
    date TIMESTAMPTZ,
    seller_gstin VARCHAR(255),
    seller_state VARCHAR(255),
    order_id VARCHAR(255),
    order_item_id VARCHAR(255),
    order_type VARCHAR(255),
    event_type VARCHAR(255),
    event_sub_type VARCHAR(255),
    order_date TIMESTAMPTZ,
    order_approval_date TIMESTAMPTZ,
    sku VARCHAR(255),
    fg VARCHAR(255),
    fsn VARCHAR(255),
    item_description VARCHAR(255),
    hsn_code VARCHAR(255),
    quantity INTEGER,
    fulfilment_type VARCHAR(255),
    warehouse_id VARCHAR(255),
    ship_from_state VARCHAR(255),
    price_before_discount NUMERIC,
    total_discount NUMERIC,
    price_after_discount NUMERIC,
    shipping_charges NUMERIC,
    final_taxable_sales_value NUMERIC,
    final_shipping_taxable_value NUMERIC,
    final_invoice_amount NUMERIC,
    gst_rate NUMERIC,
    cgst_rate NUMERIC,
    sgst_rate NUMERIC,
    igst_rate NUMERIC,
    cgst_amount NUMERIC,
    sgst_amount NUMERIC,
    igst_amount NUMERIC,
    final_cgst_tax NUMERIC,
    final_sgst_tax NUMERIC,
    final_igst_tax NUMERIC,
    shipping_cgst_tax NUMERIC,
    shipping_sgst_tax NUMERIC,
    shipping_igst_tax NUMERIC,
    tcs_igst_amount NUMERIC,
    tcs_cgst_amount NUMERIC,
    tcs_sgst_amount NUMERIC,
    total_tcs NUMERIC,
    tds_rate NUMERIC,
    tds_amount NUMERIC,
    buyer_invoice_id VARCHAR(255),
    buyer_invoice_date TIMESTAMPTZ,
    buyer_invoice_amount NUMERIC,
    final_invoice_number VARCHAR(255),
    billing_state VARCHAR(255),
    billing_pincode VARCHAR(255),
    shipping_state VARCHAR(255),
    shipping_pincode VARCHAR(255),
    business_name VARCHAR(255),
    business_gstin VARCHAR(255),
    is_shopsy_order BOOLEAN,
    tally_ledger VARCHAR(255),
    imei VARCHAR(255),
    created_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sales_flipkart_brand_idx ON sales_flipkart (brand_id);
ALTER TABLE sales_flipkart ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_flipkart FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_flipkart_brand_policy ON sales_flipkart;
CREATE POLICY sales_flipkart_brand_policy ON sales_flipkart
    USING (current_setting('app.bypass_rls', true) = 'true'
           OR brand_id::text = current_setting('app.brand_id', true));

-- sales_blinkit  (in 1 brand DBs, ~0 rows total, 37 data cols)
CREATE TABLE IF NOT EXISTS sales_blinkit (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL,
    month INTEGER,
    year INTEGER,
    file_type VARCHAR(255),
    inventory_type VARCHAR(255),
    filename VARCHAR(255),
    created_at TIMESTAMPTZ,
    order_id VARCHAR(255),
    order_date TIMESTAMPTZ,
    item_id VARCHAR(255),
    product_name VARCHAR(255),
    brand_name VARCHAR(255),
    upc VARCHAR(255),
    variant_description VARCHAR(255),
    category_mapping VARCHAR(255),
    business_category VARCHAR(255),
    supply_city VARCHAR(255),
    supply_state VARCHAR(255),
    supply_state_gst VARCHAR(255),
    customer_city VARCHAR(255),
    customer_state VARCHAR(255),
    order_status VARCHAR(255),
    hsn_code VARCHAR(255),
    igst_percent NUMERIC,
    cgst_percent NUMERIC,
    sgst_percent NUMERIC,
    cess_percent NUMERIC,
    quantity INTEGER,
    mrp NUMERIC,
    selling_price NUMERIC,
    igst_value NUMERIC,
    cgst_value NUMERIC,
    sgst_value NUMERIC,
    cess_value NUMERIC,
    total_tax NUMERIC,
    total_gross_bill_amount NUMERIC,
    gst_rate NUMERIC,
    taxable_value NUMERIC
);
CREATE INDEX IF NOT EXISTS sales_blinkit_brand_idx ON sales_blinkit (brand_id);
ALTER TABLE sales_blinkit ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_blinkit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_blinkit_brand_policy ON sales_blinkit;
CREATE POLICY sales_blinkit_brand_policy ON sales_blinkit
    USING (current_setting('app.bypass_rls', true) = 'true'
           OR brand_id::text = current_setting('app.brand_id', true));

-- gstr_2b_books  (in 1 brand DBs, ~0 rows total, 7 data cols)
CREATE TABLE IF NOT EXISTS gstr_2b_books (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id    UUID NOT NULL,
    month INTEGER,
    year INTEGER,
    file_type VARCHAR(255),
    inventory_type VARCHAR(255),
    filename VARCHAR(255),
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS gstr_2b_books_brand_idx ON gstr_2b_books (brand_id);
ALTER TABLE gstr_2b_books ENABLE ROW LEVEL SECURITY;
ALTER TABLE gstr_2b_books FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gstr_2b_books_brand_policy ON gstr_2b_books;
CREATE POLICY gstr_2b_books_brand_policy ON gstr_2b_books
    USING (current_setting('app.bypass_rls', true) = 'true'
           OR brand_id::text = current_setting('app.brand_id', true));
