-- 026: brands.invoice_input_folder_id / brands.vendor_folder_id
--
-- Commit 55b5016 ("invoice-process: ... Drive upload, three-box UI") added these
-- two nullable columns to the Sequelize Brand model
-- (new-backend/src/models/master/index.js) but shipped no migration, so any DB
-- that predates it (e.g. the db-seed snapshot / local dev) is missing them and
-- every `SELECT ... FROM brands` throws `42703 column ... does not exist`.
--
--   invoice_input_folder_id — the brand's n8n INPUT Drive folder id; the in-UI
--                             Drive-upload box drops invoice files here.
--   vendor_folder_id        — the brand's vendor-wise PROCESSED folder id; n8n
--                             files each processed invoice into a per-vendor
--                             subfolder under it, and box 3 iframes it.
--
-- Both are plain nullable VARCHAR, no RLS (brands is not a tenant-scoped table).
-- Idempotent.
--
-- APPLY (as the postgres superuser):
--   psql -U postgres -h localhost -v ON_ERROR_STOP=1 -d colonel_agent_accountant -f db-restructure/026_add_brands_invoice_folders.sql

ALTER TABLE public.brands ADD COLUMN IF NOT EXISTS invoice_input_folder_id VARCHAR(255);
ALTER TABLE public.brands ADD COLUMN IF NOT EXISTS vendor_folder_id        VARCHAR(255);
