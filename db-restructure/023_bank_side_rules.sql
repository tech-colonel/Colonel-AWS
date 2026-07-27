-- 023_bank_side_rules.sql
--
-- Per-brand, SIDE-DEPENDENT vendor → ledger rules for the Universal Bank Statement
-- classifier.
--
-- WHY: one vendor can need two different ledgers depending on which way the money moved —
-- the credit-side ledger when cash arrives (a Receipt) and the debit-side ledger when cash
-- goes out (a Payment). `bank_payee_directory` stores exactly ONE ledger per key, so it
-- structurally cannot express that. These rules previously lived in hand-edited JSON files
-- (new-backend/output/side_ledgers/<brand>.json) that only a developer could change and
-- that shipped by rsync. This table makes them data: editable, learnable from accountant
-- corrections, and per-brand.
--
-- SAFETY: purely additive. No existing table is altered. A brand with no rows here behaves
-- exactly as it did before — recoController falls back to the checked-in seed JSON, and a
-- brand with neither passes no --side-map at all.
--
-- Run as the postgres superuser (the app role cannot CREATE in schema public):
--   psql -U postgres -d colonel_agent_accountant -f db-restructure/023_bank_side_rules.sql

CREATE TABLE IF NOT EXISTS public.bank_side_rules (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id      UUID NOT NULL,
    tokens        TEXT[] NOT NULL,            -- uppercase substrings matched in narration
    credit_ledger TEXT NOT NULL,              -- money IN  → Receipt
    debit_ledger  TEXT NOT NULL,              -- money OUT → Payment
    fixed_type    TEXT,                       -- e.g. 'Contra', overrides Receipt/Payment
    tier          TEXT NOT NULL DEFAULT 'primary',   -- 'primary' | 'fallback'
    priority      INT  NOT NULL DEFAULT 100,         -- lower is checked first
    status        TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'suggested' | 'disabled'
    source        TEXT NOT NULL DEFAULT 'manual',    -- 'seed' | 'learned' | 'manual'
    evidence      JSONB,                      -- {credit_rows, debit_rows, key}
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bank_side_rules_brand_idx
    ON public.bank_side_rules (brand_id, status);

-- One rule per token set per brand, so re-running the seeder is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS bank_side_rules_brand_tokens_uidx
    ON public.bank_side_rules (brand_id, tokens);

ALTER TABLE public.bank_side_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.bank_side_rules FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'bank_side_rules'
      AND policyname = 'bank_side_rules_tenant_isolation'
  ) THEN
    CREATE POLICY bank_side_rules_tenant_isolation ON public.bank_side_rules
      USING (brand_id::text = current_setting('app.brand_id', true))
      WITH CHECK (brand_id::text = current_setting('app.brand_id', true));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bank_side_rules TO colonel_app;
