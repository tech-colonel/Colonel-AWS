-- PO Extractor: master data + extra output columns.
--
-- 1) New per-line fields on po_extractor. QTY + Material Code are extracted by
--    Gemini; Taxable/IGST/CGST/SGST are derived (Unit cost × QTY, split by
--    whether the Supplier and Buyer GSTIN state codes match). Vendor Name as per
--    Tally and FG are NOT stored — they are looked up live from the two master
--    tables below (same as the XLOOKUP formulas in the Google Sheet), so fixing a
--    master row fixes every PO that uses it. Old rows keep NULLs (new runs only).
-- 2) Two brand-scoped master tables, edited from the PO Extractor UI and mirrored
--    to the brand's PO Sheet as the Vendor_Master / SKU_Master tabs the sheet's
--    XLOOKUPs read.
--
-- Additive + idempotent; RLS-scoped by brand, same hardened pattern as 031.
BEGIN;
ALTER TABLE public.po_extractor ADD COLUMN IF NOT EXISTS material_code varchar(120);
ALTER TABLE public.po_extractor ADD COLUMN IF NOT EXISTS qty           numeric(16,4);
ALTER TABLE public.po_extractor ADD COLUMN IF NOT EXISTS taxable_value numeric(16,2);
ALTER TABLE public.po_extractor ADD COLUMN IF NOT EXISTS igst          numeric(16,2);
ALTER TABLE public.po_extractor ADD COLUMN IF NOT EXISTS cgst          numeric(16,2);
ALTER TABLE public.po_extractor ADD COLUMN IF NOT EXISTS sgst          numeric(16,2);

-- Vendor master: Buyer GSTIN -> Vendor (party) name as per Tally.
CREATE TABLE IF NOT EXISTS public.po_vendor_master (
    id                uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id          uuid DEFAULT NULLIF(current_setting('app.brand_id'::text, true), ''::text)::uuid NOT NULL,
    buyer_gstin       varchar(20)  NOT NULL,
    vendor_name_tally varchar(255) NOT NULL,
    created_at        timestamp with time zone DEFAULT now(),
    updated_at        timestamp with time zone DEFAULT now(),
    CONSTRAINT po_vendor_master_pkey PRIMARY KEY (id),
    CONSTRAINT po_vendor_master_uniq UNIQUE (brand_id, buyer_gstin)
);

-- SKU master: Material / SKU code printed on the buyer's PO -> FG (Tally item name).
CREATE TABLE IF NOT EXISTS public.po_sku_master (
    id            uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id      uuid DEFAULT NULLIF(current_setting('app.brand_id'::text, true), ''::text)::uuid NOT NULL,
    material_code varchar(120) NOT NULL,
    fg_name       varchar(255) NOT NULL,
    created_at    timestamp with time zone DEFAULT now(),
    updated_at    timestamp with time zone DEFAULT now(),
    CONSTRAINT po_sku_master_pkey PRIMARY KEY (id),
    CONSTRAINT po_sku_master_uniq UNIQUE (brand_id, material_code)
);

ALTER TABLE public.po_vendor_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.po_vendor_master FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS po_vendor_master_tenant_isolation ON public.po_vendor_master;
CREATE POLICY po_vendor_master_tenant_isolation ON public.po_vendor_master
    USING      (((brand_id)::text = current_setting('app.brand_id'::text, true)))
    WITH CHECK (((brand_id)::text = current_setting('app.brand_id'::text, true)));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.po_vendor_master TO colonel_app;

ALTER TABLE public.po_sku_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.po_sku_master FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS po_sku_master_tenant_isolation ON public.po_sku_master;
CREATE POLICY po_sku_master_tenant_isolation ON public.po_sku_master
    USING      (((brand_id)::text = current_setting('app.brand_id'::text, true)))
    WITH CHECK (((brand_id)::text = current_setting('app.brand_id'::text, true)));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.po_sku_master TO colonel_app;
COMMIT;
