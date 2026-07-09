--
-- PostgreSQL database dump
--

\restrict O43MHnJA0LS7gjZ2wNrEF88QBs6jwDYmk3n160roab8beVbjJIJATcDjrqAvx4V

-- Dumped from database version 16.13 (Homebrew)
-- Dumped by pg_dump version 16.13 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: bank_payee_directory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bank_payee_directory (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    key_type character varying(20) NOT NULL,
    key_value text NOT NULL,
    ledger character varying(255) NOT NULL,
    txn_type character varying(50),
    source character varying(20) DEFAULT 'seed'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.bank_payee_directory FORCE ROW LEVEL SECURITY;


--
-- Name: bank_reco_corrections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bank_reco_corrections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    narration_raw text NOT NULL,
    narration_key text NOT NULL,
    correct_ledger character varying(255) NOT NULL,
    correct_type character varying(50),
    source character varying(20) DEFAULT 'ui'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.bank_reco_corrections FORCE ROW LEVEL SECURITY;


--
-- Name: bank_reco_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bank_reco_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    brand_id uuid NOT NULL,
    txn_date date,
    description text,
    debit numeric(15,2),
    credit numeric(15,2),
    balance numeric(15,2),
    txn_type character varying(50),
    ledger_name character varying(255),
    confidence character varying(20),
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.bank_reco_results FORCE ROW LEVEL SECURITY;


--
-- Name: gstr3b_coa_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gstr3b_coa_master (
    id integer NOT NULL,
    brand_id uuid NOT NULL,
    ledger_name character varying(300) NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: gstr3b_coa_master_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.gstr3b_coa_master_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gstr3b_coa_master_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.gstr3b_coa_master_id_seq OWNED BY public.gstr3b_coa_master.id;


--
-- Name: gstr3b_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gstr3b_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    job_id character varying(100),
    period text,
    excel_path character varying(500),
    total_entries integer DEFAULT 0,
    total_debit numeric(18,2) DEFAULT 0,
    total_credit numeric(18,2) DEFAULT 0,
    monthly_data jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: gstr3b_vt_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gstr3b_vt_master (
    id integer NOT NULL,
    brand_id uuid NOT NULL,
    voucher_name character varying(200) NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: gstr3b_vt_master_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.gstr3b_vt_master_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gstr3b_vt_master_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.gstr3b_vt_master_id_seq OWNED BY public.gstr3b_vt_master.id;


--
-- Name: gstr_1_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gstr_1_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    brand_id uuid NOT NULL,
    invoice_number character varying(100),
    invoice_date date,
    customer_name character varying(255),
    taxable_value numeric(15,2),
    igst numeric(15,2),
    cgst numeric(15,2),
    sgst numeric(15,2),
    remark_1 character varying(100),
    remark_2 text,
    created_at timestamp with time zone DEFAULT now(),
    gstin character varying(20)
);

ALTER TABLE ONLY public.gstr_1_results FORCE ROW LEVEL SECURITY;


--
-- Name: gstr_2a_2b_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gstr_2a_2b_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    brand_id uuid NOT NULL,
    supplier_name character varying(255),
    supplier_gstin character varying(20),
    invoice_number character varying(100),
    invoice_date date,
    taxable_value numeric(15,2),
    igst numeric(15,2),
    cgst numeric(15,2),
    sgst numeric(15,2),
    remark_1 character varying(100),
    remark_2 text,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.gstr_2a_2b_results FORCE ROW LEVEL SECURITY;


--
-- Name: gstr_2b_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gstr_2b_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    brand_id uuid NOT NULL,
    supplier_name character varying(255),
    supplier_gstin character varying(20),
    invoice_number character varying(100),
    invoice_date date,
    taxable_value numeric(15,2),
    igst numeric(15,2),
    cgst numeric(15,2),
    sgst numeric(15,2),
    remark_1 character varying(100),
    remark_2 text,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.gstr_2b_results FORCE ROW LEVEL SECURITY;


--
-- Name: gstr_3b_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gstr_3b_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    brand_id uuid NOT NULL,
    itc_type character varying(100),
    claimed_value numeric(15,2),
    available_value numeric(15,2),
    difference numeric(15,2),
    remark character varying(255),
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.gstr_3b_results FORCE ROW LEVEL SECURITY;


--
-- Name: gstr_3b_tally_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gstr_3b_tally_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    brand_id uuid NOT NULL,
    row_type character varying(20),
    sno character varying(20),
    particulars text,
    debit numeric(15,2),
    credit numeric(15,2),
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.gstr_3b_tally_results FORCE ROW LEVEL SECURITY;


--
-- Name: ledger_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_master (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    ledger_name character varying(255) NOT NULL,
    ledger_name_key text NOT NULL,
    source character varying(20) DEFAULT 'upload'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.ledger_master FORCE ROW LEVEL SECURITY;


--
-- Name: reco_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reco_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    agent_type character varying(50) NOT NULL,
    month integer,
    year integer,
    file_hash character varying(64),
    status character varying(20) DEFAULT 'completed'::character varying NOT NULL,
    total_rows integer DEFAULT 0,
    matched_rows integer DEFAULT 0,
    unmatched_rows integer DEFAULT 0,
    output_file_id character varying(36),
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.reco_jobs FORCE ROW LEVEL SECURITY;


--
-- Name: gstr3b_coa_master id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gstr3b_coa_master ALTER COLUMN id SET DEFAULT nextval('public.gstr3b_coa_master_id_seq'::regclass);


--
-- Name: gstr3b_vt_master id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gstr3b_vt_master ALTER COLUMN id SET DEFAULT nextval('public.gstr3b_vt_master_id_seq'::regclass);


--
-- Name: bank_payee_directory bank_payee_directory_brand_key_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_payee_directory
    ADD CONSTRAINT bank_payee_directory_brand_key_uq UNIQUE (brand_id, key_type, key_value);


--
-- Name: bank_payee_directory bank_payee_directory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_payee_directory
    ADD CONSTRAINT bank_payee_directory_pkey PRIMARY KEY (id);


--
-- Name: bank_reco_corrections bank_reco_corrections_brand_narration_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_reco_corrections
    ADD CONSTRAINT bank_reco_corrections_brand_narration_uq UNIQUE (brand_id, narration_key);


--
-- Name: bank_reco_corrections bank_reco_corrections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_reco_corrections
    ADD CONSTRAINT bank_reco_corrections_pkey PRIMARY KEY (id);


--
-- Name: bank_reco_results bank_reco_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_reco_results
    ADD CONSTRAINT bank_reco_results_pkey PRIMARY KEY (id);


--
-- Name: gstr3b_coa_master gstr3b_coa_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gstr3b_coa_master
    ADD CONSTRAINT gstr3b_coa_master_pkey PRIMARY KEY (id);


--
-- Name: gstr3b_coa_master gstr3b_coa_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gstr3b_coa_master
    ADD CONSTRAINT gstr3b_coa_uq UNIQUE (brand_id, ledger_name);


--
-- Name: gstr3b_runs gstr3b_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gstr3b_runs
    ADD CONSTRAINT gstr3b_runs_pkey PRIMARY KEY (id);


--
-- Name: gstr3b_vt_master gstr3b_vt_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gstr3b_vt_master
    ADD CONSTRAINT gstr3b_vt_master_pkey PRIMARY KEY (id);


--
-- Name: gstr3b_vt_master gstr3b_vt_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gstr3b_vt_master
    ADD CONSTRAINT gstr3b_vt_uq UNIQUE (brand_id, voucher_name);


--
-- Name: gstr_1_results gstr_1_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gstr_1_results
    ADD CONSTRAINT gstr_1_results_pkey PRIMARY KEY (id);


--
-- Name: gstr_2a_2b_results gstr_2a_2b_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gstr_2a_2b_results
    ADD CONSTRAINT gstr_2a_2b_results_pkey PRIMARY KEY (id);


--
-- Name: gstr_2b_results gstr_2b_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gstr_2b_results
    ADD CONSTRAINT gstr_2b_results_pkey PRIMARY KEY (id);


--
-- Name: gstr_3b_results gstr_3b_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gstr_3b_results
    ADD CONSTRAINT gstr_3b_results_pkey PRIMARY KEY (id);


--
-- Name: gstr_3b_tally_results gstr_3b_tally_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gstr_3b_tally_results
    ADD CONSTRAINT gstr_3b_tally_results_pkey PRIMARY KEY (id);


--
-- Name: ledger_master ledger_master_brand_name_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_master
    ADD CONSTRAINT ledger_master_brand_name_uq UNIQUE (brand_id, ledger_name_key);


--
-- Name: ledger_master ledger_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_master
    ADD CONSTRAINT ledger_master_pkey PRIMARY KEY (id);


--
-- Name: reco_jobs reco_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reco_jobs
    ADD CONSTRAINT reco_jobs_pkey PRIMARY KEY (id);


--
-- Name: bank_payee_directory_brand_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bank_payee_directory_brand_idx ON public.bank_payee_directory USING btree (brand_id);


--
-- Name: bank_reco_corrections_brand_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bank_reco_corrections_brand_idx ON public.bank_reco_corrections USING btree (brand_id);


--
-- Name: bank_reco_results_brand_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bank_reco_results_brand_id_idx ON public.bank_reco_results USING btree (brand_id);


--
-- Name: bank_reco_results_job_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bank_reco_results_job_id_idx ON public.bank_reco_results USING btree (job_id);


--
-- Name: bank_reco_results_ledger_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bank_reco_results_ledger_idx ON public.bank_reco_results USING btree (ledger_name);


--
-- Name: bank_reco_results_txn_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bank_reco_results_txn_uq ON public.bank_reco_results USING btree (brand_id, description, txn_date, COALESCE(debit, (0)::numeric), COALESCE(credit, (0)::numeric), COALESCE(balance, (0)::numeric));


--
-- Name: gstr_1_results_brand_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gstr_1_results_brand_id_idx ON public.gstr_1_results USING btree (brand_id);


--
-- Name: gstr_1_results_job_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gstr_1_results_job_id_idx ON public.gstr_1_results USING btree (job_id);


--
-- Name: gstr_2a_2b_results_brand_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gstr_2a_2b_results_brand_id_idx ON public.gstr_2a_2b_results USING btree (brand_id);


--
-- Name: gstr_2a_2b_results_job_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gstr_2a_2b_results_job_id_idx ON public.gstr_2a_2b_results USING btree (job_id);


--
-- Name: gstr_2b_results_brand_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gstr_2b_results_brand_id_idx ON public.gstr_2b_results USING btree (brand_id);


--
-- Name: gstr_2b_results_job_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gstr_2b_results_job_id_idx ON public.gstr_2b_results USING btree (job_id);


--
-- Name: gstr_3b_results_brand_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gstr_3b_results_brand_id_idx ON public.gstr_3b_results USING btree (brand_id);


--
-- Name: gstr_3b_results_job_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gstr_3b_results_job_id_idx ON public.gstr_3b_results USING btree (job_id);


--
-- Name: gstr_3b_tally_results_brand_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gstr_3b_tally_results_brand_id_idx ON public.gstr_3b_tally_results USING btree (brand_id);


--
-- Name: gstr_3b_tally_results_job_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gstr_3b_tally_results_job_id_idx ON public.gstr_3b_tally_results USING btree (job_id);


--
-- Name: ledger_master_brand_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ledger_master_brand_idx ON public.ledger_master USING btree (brand_id);


--
-- Name: reco_jobs_brand_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reco_jobs_brand_type_idx ON public.reco_jobs USING btree (brand_id, agent_type);


--
-- Name: reco_jobs_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reco_jobs_created_at_idx ON public.reco_jobs USING btree (created_at DESC);


--
-- Name: reco_jobs_idempotency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX reco_jobs_idempotency_idx ON public.reco_jobs USING btree (brand_id, agent_type, month, year, file_hash) WHERE (file_hash IS NOT NULL);


--
-- Name: bank_reco_results bank_reco_results_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_reco_results
    ADD CONSTRAINT bank_reco_results_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.reco_jobs(id) ON DELETE CASCADE;


--
-- Name: gstr_1_results gstr_1_results_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gstr_1_results
    ADD CONSTRAINT gstr_1_results_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.reco_jobs(id) ON DELETE CASCADE;


--
-- Name: gstr_2a_2b_results gstr_2a_2b_results_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gstr_2a_2b_results
    ADD CONSTRAINT gstr_2a_2b_results_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.reco_jobs(id) ON DELETE CASCADE;


--
-- Name: gstr_2b_results gstr_2b_results_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gstr_2b_results
    ADD CONSTRAINT gstr_2b_results_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.reco_jobs(id) ON DELETE CASCADE;


--
-- Name: gstr_3b_results gstr_3b_results_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gstr_3b_results
    ADD CONSTRAINT gstr_3b_results_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.reco_jobs(id) ON DELETE CASCADE;


--
-- Name: gstr_3b_tally_results gstr_3b_tally_results_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gstr_3b_tally_results
    ADD CONSTRAINT gstr_3b_tally_results_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.reco_jobs(id) ON DELETE CASCADE;


--
-- Name: bank_payee_directory; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bank_payee_directory ENABLE ROW LEVEL SECURITY;

--
-- Name: bank_payee_directory bank_payee_directory_brand_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bank_payee_directory_brand_policy ON public.bank_payee_directory USING (((current_setting('app.bypass_rls'::text, true) = 'true'::text) OR ((brand_id)::text = current_setting('app.brand_id'::text, true))));


--
-- Name: bank_reco_results bank_reco_brand_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bank_reco_brand_policy ON public.bank_reco_results USING (((current_setting('app.bypass_rls'::text, true) = 'true'::text) OR ((brand_id)::text = current_setting('app.brand_id'::text, true))));


--
-- Name: bank_reco_corrections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bank_reco_corrections ENABLE ROW LEVEL SECURITY;

--
-- Name: bank_reco_corrections bank_reco_corrections_brand_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bank_reco_corrections_brand_policy ON public.bank_reco_corrections USING (((current_setting('app.bypass_rls'::text, true) = 'true'::text) OR ((brand_id)::text = current_setting('app.brand_id'::text, true))));


--
-- Name: bank_reco_results; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bank_reco_results ENABLE ROW LEVEL SECURITY;

--
-- Name: gstr_1_results gstr_1_brand_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY gstr_1_brand_policy ON public.gstr_1_results USING (((current_setting('app.bypass_rls'::text, true) = 'true'::text) OR ((brand_id)::text = current_setting('app.brand_id'::text, true))));


--
-- Name: gstr_1_results; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gstr_1_results ENABLE ROW LEVEL SECURITY;

--
-- Name: gstr_2a_2b_results gstr_2a_2b_brand_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY gstr_2a_2b_brand_policy ON public.gstr_2a_2b_results USING (((current_setting('app.bypass_rls'::text, true) = 'true'::text) OR ((brand_id)::text = current_setting('app.brand_id'::text, true))));


--
-- Name: gstr_2a_2b_results; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gstr_2a_2b_results ENABLE ROW LEVEL SECURITY;

--
-- Name: gstr_2b_results gstr_2b_brand_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY gstr_2b_brand_policy ON public.gstr_2b_results USING (((current_setting('app.bypass_rls'::text, true) = 'true'::text) OR ((brand_id)::text = current_setting('app.brand_id'::text, true))));


--
-- Name: gstr_2b_results; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gstr_2b_results ENABLE ROW LEVEL SECURITY;

--
-- Name: gstr_3b_results gstr_3b_brand_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY gstr_3b_brand_policy ON public.gstr_3b_results USING (((current_setting('app.bypass_rls'::text, true) = 'true'::text) OR ((brand_id)::text = current_setting('app.brand_id'::text, true))));


--
-- Name: gstr_3b_results; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gstr_3b_results ENABLE ROW LEVEL SECURITY;

--
-- Name: gstr_3b_tally_results gstr_3b_tally_brand_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY gstr_3b_tally_brand_policy ON public.gstr_3b_tally_results USING (((current_setting('app.bypass_rls'::text, true) = 'true'::text) OR ((brand_id)::text = current_setting('app.brand_id'::text, true))));


--
-- Name: gstr_3b_tally_results; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gstr_3b_tally_results ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_master; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ledger_master ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_master ledger_master_brand_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ledger_master_brand_policy ON public.ledger_master USING (((current_setting('app.bypass_rls'::text, true) = 'true'::text) OR ((brand_id)::text = current_setting('app.brand_id'::text, true))));


--
-- Name: reco_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reco_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: reco_jobs reco_jobs_brand_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reco_jobs_brand_policy ON public.reco_jobs USING (((current_setting('app.bypass_rls'::text, true) = 'true'::text) OR ((brand_id)::text = current_setting('app.brand_id'::text, true))));


--
-- PostgreSQL database dump complete
--

\unrestrict O43MHnJA0LS7gjZ2wNrEF88QBs6jwDYmk3n160roab8beVbjJIJATcDjrqAvx4V

