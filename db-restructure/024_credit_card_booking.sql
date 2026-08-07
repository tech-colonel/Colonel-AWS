-- 010_credit_card_booking.sql
--
-- Learning layer for the Credit Card Booking agent.
--
-- Deliberately SEPARATE from bank_payee_directory / bank_reco_corrections: the
-- bank classifier's keys are bank-narration identities (phone, VPA, payee name)
-- while a card statement has none of those — its identity ladder is built from
-- the merchant string. Sharing one table would mix two key vocabularies whose
-- ambiguity rules differ per brand, so the Universal Bank Statement agent's
-- learned layer is left completely untouched.
--
-- Structure mirrors bank_payee_directory exactly (brand_id default from the RLS
-- GUC, forced RLS with tenant isolation, unique on brand+key_type+key_value)
-- so it behaves identically under the hardened policies — no app.bypass_rls
-- escape hatch, which 005_harden_rls.sql removed.
--
-- Idempotent: safe to re-run.

BEGIN;

-- ── Auto-learned merchant → ledger directory ────────────────────────────────
-- key_type ladder, most specific first:
--   exact      full narration minus the Ref-No tail
--   merchant   the 3-token merchant identity key
--   merchant2  leading 2 tokens   (statements truncate to column width)
--   merchant1  leading 1 token    (accepted ONLY when unambiguous for the brand)
--   keyword    hand-added rule, matched anywhere in the narration
CREATE TABLE IF NOT EXISTS public.cc_merchant_directory (
    id          uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id    uuid DEFAULT NULLIF(current_setting('app.brand_id'::text, true), ''::text)::uuid NOT NULL,
    key_type    character varying(20) NOT NULL,
    key_value   text NOT NULL,
    ledger      character varying(255) NOT NULL,
    card_ledger character varying(255),          -- optional: scope a rule to one card
    source      character varying(20) DEFAULT 'seed'::character varying NOT NULL,
    created_at  timestamp with time zone DEFAULT now(),
    updated_at  timestamp with time zone DEFAULT now(),
    CONSTRAINT cc_merchant_directory_pkey PRIMARY KEY (id)
);

DO $$ BEGIN
    ALTER TABLE public.cc_merchant_directory
        ADD CONSTRAINT cc_merchant_directory_brand_key_uq
        UNIQUE (brand_id, key_type, key_value);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS cc_merchant_directory_brand_idx
    ON public.cc_merchant_directory (brand_id);

-- ── Reviewer corrections (the learning loop's input) ────────────────────────
-- A row the agent left in Suspense, or booked wrongly, that a human fixed in the
-- review grid. Kept as its own table so the raw narration survives even after the
-- derived directory keys are regenerated.
CREATE TABLE IF NOT EXISTS public.cc_booking_corrections (
    id             uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id       uuid DEFAULT NULLIF(current_setting('app.brand_id'::text, true), ''::text)::uuid NOT NULL,
    narration_raw  text NOT NULL,
    narration_key  text NOT NULL,
    correct_ledger character varying(255) NOT NULL,
    previous_ledger character varying(255),
    card_ledger    character varying(255),
    job_id         uuid,
    corrected_by   uuid,
    source         character varying(20) DEFAULT 'ui'::character varying NOT NULL,
    created_at     timestamp with time zone DEFAULT now(),
    updated_at     timestamp with time zone DEFAULT now(),
    CONSTRAINT cc_booking_corrections_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS cc_booking_corrections_brand_idx
    ON public.cc_booking_corrections (brand_id);
CREATE INDEX IF NOT EXISTS cc_booking_corrections_key_idx
    ON public.cc_booking_corrections (brand_id, narration_key);

-- ── RLS — identical to the hardened bank_payee_directory policy ─────────────
ALTER TABLE public.cc_merchant_directory  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cc_merchant_directory  FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.cc_booking_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cc_booking_corrections FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cc_merchant_directory_tenant_isolation  ON public.cc_merchant_directory;
DROP POLICY IF EXISTS cc_booking_corrections_tenant_isolation ON public.cc_booking_corrections;

CREATE POLICY cc_merchant_directory_tenant_isolation ON public.cc_merchant_directory
    USING      (((brand_id)::text = current_setting('app.brand_id'::text, true)))
    WITH CHECK (((brand_id)::text = current_setting('app.brand_id'::text, true)));

CREATE POLICY cc_booking_corrections_tenant_isolation ON public.cc_booking_corrections
    USING      (((brand_id)::text = current_setting('app.brand_id'::text, true)))
    WITH CHECK (((brand_id)::text = current_setting('app.brand_id'::text, true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.cc_merchant_directory  TO colonel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cc_booking_corrections TO colonel_app;

COMMIT;
