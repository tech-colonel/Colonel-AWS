-- Invoice Process: accountant-taught Vendor / Category fixes + a correction audit trail.
--
-- WHY: n8n resolves the vendor from a Google Sheet (via its AI Agent) and the
-- category from a hardcoded CATEGORY_MASTER array in its Code node. When either
-- misses, the value arrives as the literal string "N/A" and today can only be
-- fixed by editing that sheet or that code. These tables let an accountant fix
-- an N/A from the app; the fix is remembered and applied on every later run.
--
-- SCOPE — deliberately NOT a copy of the masters. n8n stays the primary
-- resolver and is never written to. We only ever act on values n8n returned as
-- N/A, so re-storing the rules n8n already has would fill nothing (n8n produced
-- that N/A by running them and failing) while creating a second source of truth
-- that silently goes stale. These tables hold ONLY what a human taught us. The
-- UI shows the vendor sheet itself in an iframe; this is the layer on top.
--
-- TWO TABLES, because an N/A has two distinct causes:
--
--   Case A — the vendor's GSTIN is not in the sheet. The lookup returns
--     vendor_name_tally = "N/A", and the category fallback then derives no
--     vendor key from "N/A", so the category is N/A too. BOTH fields go N/A
--     together. -> invoice_vendor_master, keyed on GSTIN, supplies both.
--
--   Case B — a known marketplace bills an unrecognised fee type. The sheet
--     holds "Refer from Category Master" for these vendors, but the product
--     line matches no rule. Vendor is fine; only the category is N/A.
--     -> invoice_category_master, keyed on the vendor NAME, never the GSTIN.
--
-- Why case B must not key on GSTIN: a marketplace bills from a different GSTIN
-- per state under one constant name, and serves many expense heads. Keying on
-- GSTIN would need a row per (GSTIN x category) -- Amazon's ~15 heads times its
-- state GSTINs -- all duplicating each other, with every new fee type re-added
-- once per state. Keying on the name collapses that to one row per fee type,
-- covering every state automatically. That is the entire reason the category
-- master exists as a separate thing from the vendor master.
--
-- Same hardened RLS pattern as 025_einvoice_process.sql. Purely additive:
-- no existing table is touched. Idempotent -- safe to re-run.
BEGIN;

-- ── Case A: vendors an accountant taught us ──────────────────────────────────
-- Mirrors the columns the sheet would have supplied, so one hit fills both the
-- Tally vendor name and the category (nature of expense).
CREATE TABLE IF NOT EXISTS public.invoice_vendor_master (
    id                uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id          uuid DEFAULT NULLIF(current_setting('app.brand_id'::text, true), ''::text)::uuid NOT NULL,
    gstin             character varying(20),          -- nullable: some invoices carry no GSTIN
    vendor_name_raw   text,                           -- the vendor string as it appeared on the invoice
    vendor_name_norm  text,                           -- normalized, for the no-GSTIN fallback lookup
    vendor_name_tally text NOT NULL,                  -- what we book against (Tally ledger name)
    nature_of_expense text,                           -- becomes the row's category
    is_active         boolean DEFAULT true NOT NULL,
    source            character varying(20) DEFAULT 'correction' NOT NULL,  -- correction | manual | api
    created_by        uuid,
    created_at        timestamp with time zone DEFAULT now(),
    updated_at        timestamp with time zone DEFAULT now(),
    CONSTRAINT invoice_vendor_master_pkey PRIMARY KEY (id)
);

-- gstin is nullable, so a plain UNIQUE(brand_id, gstin) would be useless:
-- Postgres treats NULLs as distinct, allowing unlimited duplicate name-only
-- rows. COALESCE(gstin,'') is worse -- it collapses every name-only row into
-- one. Two partial uniques are the only correct shape.
-- NOTE for callers: an ON CONFLICT targeting either index MUST repeat its
-- WHERE predicate, and one statement cannot target both -- so the upsert
-- helper branches on whether gstin is null.
CREATE UNIQUE INDEX IF NOT EXISTS invoice_vendor_master_gstin_uq
    ON public.invoice_vendor_master (brand_id, gstin)            WHERE gstin IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS invoice_vendor_master_name_uq
    ON public.invoice_vendor_master (brand_id, vendor_name_norm) WHERE gstin IS NULL;
CREATE INDEX IF NOT EXISTS invoice_vendor_master_brand_idx
    ON public.invoice_vendor_master (brand_id);

ALTER TABLE public.invoice_vendor_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_vendor_master FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoice_vendor_master_tenant_isolation ON public.invoice_vendor_master;
CREATE POLICY invoice_vendor_master_tenant_isolation ON public.invoice_vendor_master
    USING      (((brand_id)::text = current_setting('app.brand_id'::text, true)))
    WITH CHECK (((brand_id)::text = current_setting('app.brand_id'::text, true)));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoice_vendor_master TO colonel_app;

-- ── Case B: fee types an accountant taught us ────────────────────────────────
-- One row per rule: "for this vendor, a product line containing this pattern
-- books to this ledger". Plain substring match on the normalized product name,
-- lowest priority first -- no scoring. We are not reproducing n8n's fuzzy
-- matcher, only recording exact answers a human gave us.
--
-- vendor_key is the marketplace name (amazon, flipkart, myntra, meesho,
-- fashnear, nykaa, reliance) when the vendor matches one, else the normalized
-- vendor name. Name, not GSTIN -- see the header note.
CREATE TABLE IF NOT EXISTS public.invoice_category_master (
    id           uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id     uuid DEFAULT NULLIF(current_setting('app.brand_id'::text, true), ''::text)::uuid NOT NULL,
    vendor_key   character varying(80) NOT NULL,
    vendor_label text,                             -- human-readable vendor, for the UI
    pattern_raw  text,                             -- the product line the accountant fixed, verbatim
    pattern_norm text NOT NULL,                    -- normalized; what we actually match on
    ledger       text NOT NULL,                    -- Tally ledger to book to
    priority     integer DEFAULT 500 NOT NULL,     -- ascending; ties broken by created_at
    is_active    boolean DEFAULT true NOT NULL,
    source       character varying(20) DEFAULT 'correction' NOT NULL,
    created_by   uuid,
    created_at   timestamp with time zone DEFAULT now(),
    updated_at   timestamp with time zone DEFAULT now(),
    CONSTRAINT invoice_category_master_pkey PRIMARY KEY (id),
    -- "".includes(x) is true for every input, and a 1-3 char pattern would
    -- swallow the whole catalogue. Both are almost certainly a mis-entry.
    CONSTRAINT invoice_category_master_pattern_len_chk
        CHECK (char_length(pattern_norm) >= 4)
);

CREATE UNIQUE INDEX IF NOT EXISTS invoice_category_master_rule_uq
    ON public.invoice_category_master (brand_id, vendor_key, pattern_norm);
CREATE INDEX IF NOT EXISTS invoice_category_master_lookup_idx
    ON public.invoice_category_master (brand_id, vendor_key, priority);

ALTER TABLE public.invoice_category_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_category_master FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoice_category_master_tenant_isolation ON public.invoice_category_master;
CREATE POLICY invoice_category_master_tenant_isolation ON public.invoice_category_master
    USING      (((brand_id)::text = current_setting('app.brand_id'::text, true)))
    WITH CHECK (((brand_id)::text = current_setting('app.brand_id'::text, true)));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoice_category_master TO colonel_app;

-- ── Audit trail ──────────────────────────────────────────────────────────────
-- Every manual fix: what the invoice looked like, what changed, which master
-- row it created, and exactly which invoice rows the backfill touched.
-- backfilled_row_ids is the undo set (previous values are N/A by construction).
-- Shape follows cc_booking_corrections (024).
CREATE TABLE IF NOT EXISTS public.invoice_master_corrections (
    id                  uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id            uuid DEFAULT NULLIF(current_setting('app.brand_id'::text, true), ''::text)::uuid NOT NULL,
    invoice_row_id      uuid,           -- the invoice_process row the fix started from
    run_id              character varying(60),
    invoice_number      text,
    seller_gstin        character varying(20),
    vendor_name_raw     text,
    product_name_raw    text,
    previous_vendor     text,
    corrected_vendor    text,
    previous_category   text,
    corrected_category  text,
    vendor_master_id    uuid,
    category_master_id  uuid,
    backfilled_count    integer DEFAULT 0 NOT NULL,
    backfilled_row_ids  uuid[],
    source              character varying(20) DEFAULT 'popup' NOT NULL,  -- popup | metadata_edit | api
    corrected_by        uuid,
    created_at          timestamp with time zone DEFAULT now(),
    CONSTRAINT invoice_master_corrections_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS invoice_master_corrections_brand_idx
    ON public.invoice_master_corrections (brand_id, created_at DESC);
CREATE INDEX IF NOT EXISTS invoice_master_corrections_row_idx
    ON public.invoice_master_corrections (invoice_row_id);

ALTER TABLE public.invoice_master_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_master_corrections FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoice_master_corrections_tenant_isolation ON public.invoice_master_corrections;
CREATE POLICY invoice_master_corrections_tenant_isolation ON public.invoice_master_corrections
    USING      (((brand_id)::text = current_setting('app.brand_id'::text, true)))
    WITH CHECK (((brand_id)::text = current_setting('app.brand_id'::text, true)));
-- Deliberately narrower than the other two: an audit trail is append-only.
--
-- The REVOKE is the part that does the work. 004_app_role_and_defaults.sql sets
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO colonel_app;
-- so this table is CREATEd with all four already granted. A narrower GRANT here
-- adds nothing and would silently leave the audit trail rewritable.
--
-- Scope of the REVOKE: one table object in this database. It does not touch
-- ALTER DEFAULT PRIVILEGES, so later tables still get the usual four; verified
-- against all 82 granted tables, only this row changed.
GRANT  SELECT, INSERT ON public.invoice_master_corrections TO colonel_app;
REVOKE UPDATE, DELETE ON public.invoice_master_corrections FROM colonel_app;

COMMIT;
