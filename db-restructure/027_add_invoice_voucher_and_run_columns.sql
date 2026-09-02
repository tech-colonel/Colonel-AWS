-- 027_add_invoice_voucher_and_run_columns.sql
-- Store the Invoice Process fields n8n ALREADY sends but we currently drop, plus the
-- per-run sheet tracking fields.
--
-- WHY: `n8n-invoice-feed-db.js` already reads `vendor_name_tally` and `voucher_type`
-- off every payload, but neither exists as a physical column NOR in `agents.columns`,
-- so the dynamic Sequelize model silently discards them on bulkCreate. Since the
-- 2026-09-02 n8n change, `voucher_type` is also what classifies a document
-- ("Purchase <State>" / "Credit Note <State>" / "Debit Note <State>"), so without it
-- the X2Beta export cannot tell an invoice from a credit/debit note, and
-- `vendor_name_tally` is the X2Beta Party Ledger.
--
-- Applies to EVERY brand at once: `invoice_process` is a single shared table in the
-- unified DB, scoped by `brand_id` + RLS (3,072 rows across 12 brands at time of
-- writing). Nothing is brand-specific here.
--
-- Additive and idempotent — nullable columns only, no backfill, no agent-logic change.
-- Existing rows keep NULL; new n8n runs populate going forward.
--
--   psql -U postgres -d colonel_agent_accountant -f db-restructure/027_add_invoice_voucher_and_run_columns.sql

-- 1. physical columns -------------------------------------------------------
-- text for the two n8n fields, consistent with every other n8n-fed column on this
-- table (rate/amounts are all text here).
DO $$
BEGIN
  IF to_regclass('public.invoice_process') IS NOT NULL THEN
    -- already sent by n8n, currently discarded
    ALTER TABLE public.invoice_process ADD COLUMN IF NOT EXISTS vendor_name_tally text;
    ALTER TABLE public.invoice_process ADD COLUMN IF NOT EXISTS voucher_type      text;
    -- per-run sheet tracking (populated by the backend, not by n8n)
    ALTER TABLE public.invoice_process ADD COLUMN IF NOT EXISTS run_id            text;
    ALTER TABLE public.invoice_process ADD COLUMN IF NOT EXISTS sheet_id          text;
    ALTER TABLE public.invoice_process ADD COLUMN IF NOT EXISTS sheet_url         text;
    ALTER TABLE public.invoice_process ADD COLUMN IF NOT EXISTS sheet_row         integer;

    CREATE INDEX IF NOT EXISTS invoice_process_run_idx
      ON public.invoice_process (run_id);
  END IF;
END $$;

-- 2. register them on the agent --------------------------------------------
-- Companion to step 1: the dynamic model is built from `agents.columns`, so a field
-- missing here is dropped even when the physical column exists (exactly what
-- happened to TDS — see 015/016). Guarded on voucher_type so re-runs are no-ops.
UPDATE agents
SET columns = columns::jsonb || '[
  {"name":"vendor_name_tally","type":"STRING"},
  {"name":"voucher_type","type":"STRING"},
  {"name":"run_id","type":"STRING"},
  {"name":"sheet_id","type":"STRING"},
  {"name":"sheet_url","type":"STRING"},
  {"name":"sheet_row","type":"INTEGER"}
]'::jsonb
WHERE name = 'Invoice Process'
  AND columns::text NOT LIKE '%voucher_type%';
