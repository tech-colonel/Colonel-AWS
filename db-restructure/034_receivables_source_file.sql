-- The name the workbook arrived under.
--
-- Without it every record carries only a generated name like
-- receivables_Off_Duty_1790592178556_db2a2e97.xlsx, so a Drive folder holding
-- 2024, 2025 and 2026 workbooks produces dozens of rows nobody can tell apart —
-- and there is no way to pick out the ones that should not have been read.
--
-- Additive and idempotent. Rows read before this migration keep NULL and fall
-- back to the generated name on screen.
ALTER TABLE receivables_summary ADD COLUMN IF NOT EXISTS source_file TEXT;
