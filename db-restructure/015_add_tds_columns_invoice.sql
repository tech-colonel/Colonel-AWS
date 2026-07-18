-- 015_add_tds_columns_invoice.sql — add TDS fields to the Invoice Process table.
--
-- Three additive, nullable TEXT columns (consistent with the other amount/rate
-- columns in invoice_process, which are all stored as text). Populated per-invoice
-- from the n8n feed (tds_section / tds_rate / tds_amount); NULL when an invoice has
-- no TDS. Only the Invoice Process agent's table (`invoice_process`) is touched —
-- `invoice_agent` is a legacy/orphan table with no agent mapping.
--
--   psql -U postgres -d colonel_agent_accountant -f db-restructure/015_add_tds_columns_invoice.sql

DO $$
BEGIN
  IF to_regclass('public.invoice_process') IS NOT NULL THEN
    ALTER TABLE public.invoice_process ADD COLUMN IF NOT EXISTS tds_section text;
    ALTER TABLE public.invoice_process ADD COLUMN IF NOT EXISTS tds_rate    text;
    ALTER TABLE public.invoice_process ADD COLUMN IF NOT EXISTS tds_amount  text;
  END IF;
END $$;
