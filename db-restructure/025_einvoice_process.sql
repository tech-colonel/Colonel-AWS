-- E-Invoice Extraction history: one row per extracted e-invoice (header + line
-- items as jsonb + stored PDF path). RLS-scoped by brand, same hardened pattern
-- as bank_payee_directory / cc_merchant_directory. Idempotent.
BEGIN;
CREATE TABLE IF NOT EXISTS public.einvoice_process (
    id              uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id        uuid DEFAULT NULLIF(current_setting('app.brand_id'::text, true), ''::text)::uuid NOT NULL,
    agent_id        uuid,
    job_id          uuid,
    filename        text,
    invoice_no      character varying(120),
    ack_no          character varying(60),
    irn             character varying(80),
    invoice_date    character varying(30),
    pos             character varying(60),
    supplier_name   text,
    supplier_gstin  character varying(20),
    recipient_name  text,
    recipient_gstin character varying(20),
    status          character varying(30),
    line_items      jsonb DEFAULT '[]'::jsonb,
    pdf_path        text,
    created_at      timestamp with time zone DEFAULT now(),
    updated_at      timestamp with time zone DEFAULT now(),
    CONSTRAINT einvoice_process_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS einvoice_process_brand_idx   ON public.einvoice_process (brand_id);
CREATE INDEX IF NOT EXISTS einvoice_process_created_idx ON public.einvoice_process (brand_id, created_at DESC);

ALTER TABLE public.einvoice_process ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.einvoice_process FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS einvoice_process_tenant_isolation ON public.einvoice_process;
CREATE POLICY einvoice_process_tenant_isolation ON public.einvoice_process
    USING      (((brand_id)::text = current_setting('app.brand_id'::text, true)))
    WITH CHECK (((brand_id)::text = current_setting('app.brand_id'::text, true)));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.einvoice_process TO colonel_app;
COMMIT;
