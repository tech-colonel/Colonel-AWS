-- 022: receivable_cycle_imports.role — tags each imported row with which parser it
-- feeds ('tally' | 'delhivery' | 'ekart' | 'xpressbees' | 'srn') instead of relying on
-- a hardcoded literal source_file/sheet_name match. This is what lets the Receivable
-- Cycle agent's normal upload (recoController.js) populate receivable_cycle_imports
-- for ANY brand — new-backend/src/services/receivableLedgerBuilder.js reads rows by
-- (brand_id, role) instead of by the one historical Flo Mattress dataset's literal
-- filenames, which is what new-backend/scripts/buildReceivableLedger.js still does
-- (untouched — that one-off script keeps working exactly as before).
-- Idempotent. Applied directly to colonel_agent_accountant (unified DB); also mirrored
-- into new-backend/src/db/migrations/001_reco_tables.sql for the legacy per-brand path.
ALTER TABLE public.receivable_cycle_imports ADD COLUMN IF NOT EXISTS role VARCHAR(16);

CREATE INDEX IF NOT EXISTS receivable_cycle_imports_brand_role_idx
    ON public.receivable_cycle_imports (brand_id, role);
