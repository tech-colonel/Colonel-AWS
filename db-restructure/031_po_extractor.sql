-- PO Extractor history: one row per PURCHASE-ORDER line item, extracted by the
-- n8n "PO Extract" workflow (Gemini) and fed back via POST /api/n8n/po/feed.
-- Column set mirrors "PO Data for Automation.xlsx" (8 business columns) + run
-- bookkeeping. RLS-scoped by brand, same hardened pattern as einvoice_process.
-- Idempotent.
BEGIN;
CREATE TABLE IF NOT EXISTS public.po_extractor (
    id                  uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id            uuid DEFAULT NULLIF(current_setting('app.brand_id'::text, true), ''::text)::uuid NOT NULL,
    agent_id            uuid,
    run_id              text,
    source_file         text,
    po_pdf_link         text,
    po_number           character varying(160),
    po_date             character varying(30),
    supplier_gstin      character varying(20),
    buyer_gstin         character varying(20),
    billing_address     text,
    product_description text,
    unit_cost           numeric(16,4),
    gst_rate            numeric(6,2),
    status              character varying(30),
    created_at          timestamp with time zone DEFAULT now(),
    updated_at          timestamp with time zone DEFAULT now(),
    CONSTRAINT po_extractor_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS po_extractor_brand_idx   ON public.po_extractor (brand_id);
CREATE INDEX IF NOT EXISTS po_extractor_created_idx ON public.po_extractor (brand_id, created_at DESC);
CREATE INDEX IF NOT EXISTS po_extractor_po_idx      ON public.po_extractor (brand_id, po_number);

ALTER TABLE public.po_extractor ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.po_extractor FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS po_extractor_tenant_isolation ON public.po_extractor;
CREATE POLICY po_extractor_tenant_isolation ON public.po_extractor
    USING      (((brand_id)::text = current_setting('app.brand_id'::text, true)))
    WITH CHECK (((brand_id)::text = current_setting('app.brand_id'::text, true)));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.po_extractor TO colonel_app;
COMMIT;
