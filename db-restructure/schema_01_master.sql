--
-- PostgreSQL database dump
--

\restrict iu4IZEe9qE1ZKu9ctFR4phOD3P52c6CHtuEYEvKGaddNUEegz8xKcAPesakePmJ

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

--
-- Name: dblink; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA public;


--
-- Name: EXTENSION dblink; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION dblink IS 'connect to other PostgreSQL databases from within a database';


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: enum_integrations_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.enum_integrations_status AS ENUM (
    'connected',
    'disconnected'
);


--
-- Name: enum_mcp_servers_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.enum_mcp_servers_status AS ENUM (
    'registered',
    'disconnected'
);


--
-- Name: enum_task_messages_sender_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.enum_task_messages_sender_role AS ENUM (
    'admin',
    'accountant',
    'developer'
);


--
-- Name: enum_tasks_priority; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.enum_tasks_priority AS ENUM (
    'low',
    'medium',
    'high',
    'urgent'
);


--
-- Name: enum_tasks_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.enum_tasks_status AS ENUM (
    'pending',
    'in_progress',
    'done',
    'overdue'
);


--
-- Name: enum_users_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.enum_users_role AS ENUM (
    'admin',
    'accountant',
    'brand_executive',
    'developer'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_workflows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_workflows (
    id uuid NOT NULL,
    agent_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    sample_columns jsonb DEFAULT '[]'::jsonb,
    columns jsonb DEFAULT '[]'::jsonb,
    sheets jsonb DEFAULT '[]'::jsonb,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agents (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    columns jsonb DEFAULT '[]'::jsonb,
    "createdAt" timestamp with time zone DEFAULT now(),
    "updatedAt" timestamp with time zone DEFAULT now()
);


--
-- Name: brand_agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brand_agents (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    brand_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now(),
    "updatedAt" timestamp with time zone DEFAULT now()
);


--
-- Name: brand_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brand_users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    brand_id uuid NOT NULL,
    user_id uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now(),
    "updatedAt" timestamp with time zone DEFAULT now()
);


--
-- Name: brands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brands (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    image_url character varying(500),
    db_name character varying(255) NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now(),
    "updatedAt" timestamp with time zone DEFAULT now(),
    drive_folder_id character varying(255)
);


--
-- Name: compliance_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.compliance_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    source text NOT NULL,
    file_name text NOT NULL,
    mime_type text,
    file_size bigint,
    storage_path text,
    drive_file_id text,
    drive_url text,
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: compliance_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.compliance_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    name text NOT NULL,
    color text DEFAULT '#0748EE'::text NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: compliance_chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.compliance_chat_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    thread_user_id uuid NOT NULL,
    sender_id uuid NOT NULL,
    sender_role text NOT NULL,
    message text NOT NULL,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: compliance_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.compliance_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    user_id uuid NOT NULL,
    year integer,
    month integer,
    period text,
    period_order integer,
    seq integer,
    title text NOT NULL,
    description text,
    category_id uuid,
    status text DEFAULT 'todo'::text NOT NULL,
    priority text DEFAULT 'medium'::text NOT NULL,
    progress integer DEFAULT 0 NOT NULL,
    due_date date,
    data_source text,
    frequency text,
    remarks text,
    agent_id uuid,
    source text DEFAULT 'self'::text NOT NULL,
    assigned_by uuid,
    linked_task_id uuid,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    title character varying(255) DEFAULT 'New chat'::character varying NOT NULL,
    model character varying(255) DEFAULT 'claude-sonnet-4-6'::character varying NOT NULL,
    messages jsonb DEFAULT '[]'::jsonb NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integrations (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    type character varying(255) NOT NULL,
    status public.enum_integrations_status DEFAULT 'disconnected'::public.enum_integrations_status NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    connected_by uuid,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: mcp_servers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_servers (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    url character varying(255) NOT NULL,
    status public.enum_mcp_servers_status DEFAULT 'registered'::public.enum_mcp_servers_status NOT NULL,
    created_by uuid,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: meeting_pins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_pins (
    user_id text NOT NULL,
    transcript_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plans (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    created_by uuid NOT NULL,
    shared_with jsonb DEFAULT '[]'::jsonb NOT NULL,
    graph jsonb DEFAULT '{"edges": [], "nodes": []}'::jsonb NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: statutory_filings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.statutory_filings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    compliance_type text NOT NULL,
    title text NOT NULL,
    period_label text,
    period_type text,
    year integer,
    month integer,
    quarter integer,
    state text,
    status text DEFAULT 'not_due'::text NOT NULL,
    due_date date,
    filing_date date,
    ack_no text,
    applicability text,
    note text,
    drive_url text,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: task_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_messages (
    id uuid NOT NULL,
    task_id uuid NOT NULL,
    sender_id uuid NOT NULL,
    message text NOT NULL,
    sender_role public.enum_task_messages_sender_role NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id uuid NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    status public.enum_tasks_status DEFAULT 'pending'::public.enum_tasks_status,
    priority public.enum_tasks_priority DEFAULT 'medium'::public.enum_tasks_priority,
    due_date date,
    assigned_to uuid NOT NULL,
    assigned_by uuid NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    category character varying(32) DEFAULT 'task'::character varying NOT NULL,
    source_meta jsonb,
    plan_id uuid
);


--
-- Name: user_google_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_google_accounts (
    user_id uuid NOT NULL,
    access_token text,
    refresh_token text,
    token_expiry bigint,
    email text,
    name text,
    picture text,
    status character varying(16) DEFAULT 'connected'::character varying,
    "createdAt" timestamp with time zone DEFAULT now(),
    "updatedAt" timestamp with time zone DEFAULT now()
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    password character varying(255) NOT NULL,
    role character varying(50) DEFAULT 'accountant'::character varying,
    "createdAt" timestamp with time zone DEFAULT now(),
    "updatedAt" timestamp with time zone DEFAULT now()
);


--
-- Name: zoho_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zoho_accounts (
    account_id text NOT NULL,
    organization_id text NOT NULL,
    account_name text,
    account_type text,
    is_active boolean,
    raw jsonb,
    synced_at timestamp with time zone DEFAULT now()
);


--
-- Name: zoho_bank_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zoho_bank_accounts (
    account_id text NOT NULL,
    organization_id text NOT NULL,
    account_name text,
    account_type text,
    bank_name text,
    account_number text,
    balance numeric,
    currency_code text,
    is_active boolean,
    raw jsonb,
    synced_at timestamp with time zone DEFAULT now()
);


--
-- Name: zoho_bank_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zoho_bank_transactions (
    transaction_id text NOT NULL,
    organization_id text NOT NULL,
    account_id text NOT NULL,
    txn_date date,
    amount numeric,
    debit_or_credit text,
    transaction_type text,
    status text,
    payee text,
    reference_number text,
    description text,
    running_balance numeric,
    raw jsonb,
    synced_at timestamp with time zone DEFAULT now()
);


--
-- Name: zoho_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zoho_contacts (
    contact_id text NOT NULL,
    organization_id text NOT NULL,
    contact_name text,
    company_name text,
    contact_type text,
    email text,
    phone text,
    outstanding numeric,
    raw jsonb,
    synced_at timestamp with time zone DEFAULT now()
);


--
-- Name: zoho_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zoho_items (
    item_id text NOT NULL,
    organization_id text NOT NULL,
    name text,
    rate numeric,
    status text,
    raw jsonb,
    synced_at timestamp with time zone DEFAULT now()
);


--
-- Name: zoho_organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zoho_organizations (
    organization_id text NOT NULL,
    name text,
    currency_code text,
    raw jsonb,
    synced_at timestamp with time zone DEFAULT now()
);


--
-- Name: zoho_sync_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zoho_sync_log (
    id bigint NOT NULL,
    organization_id text,
    started_at timestamp with time zone DEFAULT now(),
    finished_at timestamp with time zone,
    status text,
    counts jsonb,
    error text
);


--
-- Name: zoho_sync_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.zoho_sync_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: zoho_sync_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.zoho_sync_log_id_seq OWNED BY public.zoho_sync_log.id;


--
-- Name: zoho_vouchers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zoho_vouchers (
    id bigint NOT NULL,
    organization_id text NOT NULL,
    voucher_type text NOT NULL,
    zoho_id text NOT NULL,
    number text,
    voucher_date date,
    contact_id text,
    contact_name text,
    status text,
    total numeric,
    raw jsonb,
    synced_at timestamp with time zone DEFAULT now()
);


--
-- Name: zoho_vouchers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.zoho_vouchers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: zoho_vouchers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.zoho_vouchers_id_seq OWNED BY public.zoho_vouchers.id;


--
-- Name: zoho_sync_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zoho_sync_log ALTER COLUMN id SET DEFAULT nextval('public.zoho_sync_log_id_seq'::regclass);


--
-- Name: zoho_vouchers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zoho_vouchers ALTER COLUMN id SET DEFAULT nextval('public.zoho_vouchers_id_seq'::regclass);


--
-- Name: agent_workflows agent_workflows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_workflows
    ADD CONSTRAINT agent_workflows_pkey PRIMARY KEY (id);


--
-- Name: agents agents_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_name_key UNIQUE (name);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);


--
-- Name: brand_agents brand_agents_brand_id_agent_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_agents
    ADD CONSTRAINT brand_agents_brand_id_agent_id_key UNIQUE (brand_id, agent_id);


--
-- Name: brand_agents brand_agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_agents
    ADD CONSTRAINT brand_agents_pkey PRIMARY KEY (id);


--
-- Name: brand_users brand_users_brand_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_users
    ADD CONSTRAINT brand_users_brand_id_user_id_key UNIQUE (brand_id, user_id);


--
-- Name: brand_users brand_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_users
    ADD CONSTRAINT brand_users_pkey PRIMARY KEY (id);


--
-- Name: brands brands_db_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brands
    ADD CONSTRAINT brands_db_name_key UNIQUE (db_name);


--
-- Name: brands brands_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brands
    ADD CONSTRAINT brands_name_key UNIQUE (name);


--
-- Name: brands brands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brands
    ADD CONSTRAINT brands_pkey PRIMARY KEY (id);


--
-- Name: compliance_attachments compliance_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.compliance_attachments
    ADD CONSTRAINT compliance_attachments_pkey PRIMARY KEY (id);


--
-- Name: compliance_categories compliance_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.compliance_categories
    ADD CONSTRAINT compliance_categories_pkey PRIMARY KEY (id);


--
-- Name: compliance_chat_messages compliance_chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.compliance_chat_messages
    ADD CONSTRAINT compliance_chat_messages_pkey PRIMARY KEY (id);


--
-- Name: compliance_tasks compliance_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.compliance_tasks
    ADD CONSTRAINT compliance_tasks_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: integrations integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integrations
    ADD CONSTRAINT integrations_pkey PRIMARY KEY (id);


--
-- Name: integrations integrations_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integrations
    ADD CONSTRAINT integrations_type_key UNIQUE (type);


--
-- Name: mcp_servers mcp_servers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_servers
    ADD CONSTRAINT mcp_servers_pkey PRIMARY KEY (id);


--
-- Name: meeting_pins meeting_pins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_pins
    ADD CONSTRAINT meeting_pins_pkey PRIMARY KEY (user_id, transcript_id);


--
-- Name: plans plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);


--
-- Name: statutory_filings statutory_filings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statutory_filings
    ADD CONSTRAINT statutory_filings_pkey PRIMARY KEY (id);


--
-- Name: task_messages task_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_messages
    ADD CONSTRAINT task_messages_pkey PRIMARY KEY (id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: user_google_accounts user_google_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_google_accounts
    ADD CONSTRAINT user_google_accounts_pkey PRIMARY KEY (user_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: zoho_accounts zoho_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zoho_accounts
    ADD CONSTRAINT zoho_accounts_pkey PRIMARY KEY (account_id);


--
-- Name: zoho_bank_accounts zoho_bank_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zoho_bank_accounts
    ADD CONSTRAINT zoho_bank_accounts_pkey PRIMARY KEY (account_id);


--
-- Name: zoho_bank_transactions zoho_bank_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zoho_bank_transactions
    ADD CONSTRAINT zoho_bank_transactions_pkey PRIMARY KEY (transaction_id);


--
-- Name: zoho_contacts zoho_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zoho_contacts
    ADD CONSTRAINT zoho_contacts_pkey PRIMARY KEY (contact_id);


--
-- Name: zoho_items zoho_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zoho_items
    ADD CONSTRAINT zoho_items_pkey PRIMARY KEY (item_id);


--
-- Name: zoho_organizations zoho_organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zoho_organizations
    ADD CONSTRAINT zoho_organizations_pkey PRIMARY KEY (organization_id);


--
-- Name: zoho_sync_log zoho_sync_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zoho_sync_log
    ADD CONSTRAINT zoho_sync_log_pkey PRIMARY KEY (id);


--
-- Name: zoho_vouchers zoho_vouchers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zoho_vouchers
    ADD CONSTRAINT zoho_vouchers_pkey PRIMARY KEY (id);


--
-- Name: zoho_vouchers zoho_vouchers_voucher_type_zoho_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zoho_vouchers
    ADD CONSTRAINT zoho_vouchers_voucher_type_zoho_id_key UNIQUE (voucher_type, zoho_id);


--
-- Name: conversations_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversations_user_id ON public.conversations USING btree (user_id);


--
-- Name: idx_compliance_attach_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_compliance_attach_entity ON public.compliance_attachments USING btree (entity_type, entity_id);


--
-- Name: idx_compliance_chat_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_compliance_chat_thread ON public.compliance_chat_messages USING btree (brand_id, thread_user_id, created_at);


--
-- Name: idx_compliance_tasks_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_compliance_tasks_scope ON public.compliance_tasks USING btree (brand_id, user_id, year, month);


--
-- Name: idx_statutory_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_statutory_scope ON public.statutory_filings USING btree (brand_id, compliance_type, year, month);


--
-- Name: idx_zoho_accounts_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zoho_accounts_org ON public.zoho_accounts USING btree (organization_id);


--
-- Name: idx_zoho_bank_accounts_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zoho_bank_accounts_org ON public.zoho_bank_accounts USING btree (organization_id);


--
-- Name: idx_zoho_bank_txn_acct; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zoho_bank_txn_acct ON public.zoho_bank_transactions USING btree (account_id, txn_date);


--
-- Name: idx_zoho_bank_txn_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zoho_bank_txn_org ON public.zoho_bank_transactions USING btree (organization_id);


--
-- Name: idx_zoho_contacts_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zoho_contacts_org ON public.zoho_contacts USING btree (organization_id);


--
-- Name: idx_zoho_contacts_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zoho_contacts_type ON public.zoho_contacts USING btree (organization_id, contact_type);


--
-- Name: idx_zoho_items_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zoho_items_org ON public.zoho_items USING btree (organization_id);


--
-- Name: idx_zoho_vouchers_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zoho_vouchers_contact ON public.zoho_vouchers USING btree (organization_id, contact_id);


--
-- Name: idx_zoho_vouchers_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zoho_vouchers_org ON public.zoho_vouchers USING btree (organization_id);


--
-- Name: idx_zoho_vouchers_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zoho_vouchers_type ON public.zoho_vouchers USING btree (organization_id, voucher_type);


--
-- Name: uq_compliance_cat_brand_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_compliance_cat_brand_name ON public.compliance_categories USING btree (brand_id, lower(name));


--
-- Name: uq_compliance_template_row; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_compliance_template_row ON public.compliance_tasks USING btree (brand_id, user_id, year, month, period_order, seq) WHERE (source = 'template'::text);


--
-- Name: uq_statutory_row; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_statutory_row ON public.statutory_filings USING btree (brand_id, compliance_type, COALESCE(state, ''::text), COALESCE(period_label, ''::text), COALESCE(title, ''::text));


--
-- Name: agent_workflows agent_workflows_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_workflows
    ADD CONSTRAINT agent_workflows_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: brand_agents brand_agents_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_agents
    ADD CONSTRAINT brand_agents_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: brand_agents brand_agents_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_agents
    ADD CONSTRAINT brand_agents_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;


--
-- Name: brand_users brand_users_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_users
    ADD CONSTRAINT brand_users_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;


--
-- Name: brand_users brand_users_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_users
    ADD CONSTRAINT brand_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: compliance_tasks compliance_tasks_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.compliance_tasks
    ADD CONSTRAINT compliance_tasks_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.compliance_categories(id) ON DELETE SET NULL;


--
-- Name: task_messages task_messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_messages
    ADD CONSTRAINT task_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.users(id) ON UPDATE CASCADE;


--
-- Name: task_messages task_messages_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_messages
    ADD CONSTRAINT task_messages_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: tasks tasks_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.users(id) ON UPDATE CASCADE;


--
-- Name: tasks tasks_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON UPDATE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict iu4IZEe9qE1ZKu9ctFR4phOD3P52c6CHtuEYEvKGaddNUEegz8xKcAPesakePmJ

