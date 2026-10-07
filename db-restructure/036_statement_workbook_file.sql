-- 036_statement_workbook_file.sql
-- The workbook a statement was written to, so the download outlives the records.
--
-- A statement is what the page renders: totals, the registration table, the
-- schedules. The WORKBOOK is more than that — its Order Ledger sheet carries
-- every order, and the exception schedules list orders one by one. That detail
-- is deliberately not kept in the statement payload; a year of it is a million
-- and a half lines and the whole point of the store is to be small.
--
-- Which means a produced workbook can only be rebuilt while the records are
-- still held. Clear the records and the report survives on screen but its
-- download dies with them — an accountant would reasonably expect a statement
-- they have already produced to stay downloadable.
--
-- So the file is remembered. Once a workbook has been written, the statement
-- points at it, and the download serves that file whether or not the records
-- it was cast from are still in the table.

ALTER TABLE receivables_statements
    ADD COLUMN IF NOT EXISTS workbook_file TEXT;

COMMENT ON COLUMN receivables_statements.workbook_file IS
  'Filename under outputs/ of the workbook (or, for YEAR, the zip) produced from '
  'this statement. Set the first time it is downloaded; kept so the download '
  'survives a reset of the underlying records.';
