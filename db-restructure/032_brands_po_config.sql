-- PO Extractor per-brand config, editable from the UI (mirrors brands.invoice_input_folder_id,
-- which Invoice Process already has as a real column rather than an env var). Nullable —
-- falls back to the <Brand>_po_folder_id / <Brand>_po_sheet env vars until set here.
BEGIN;
ALTER TABLE public.brands ADD COLUMN IF NOT EXISTS po_input_folder_id text;
ALTER TABLE public.brands ADD COLUMN IF NOT EXISTS po_sheet_url        text;
COMMIT;
