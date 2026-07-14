-- 010-statutory-config.sql — per-brand DYNAMIC config for Statutory Compliance.
-- Lets each brand define its OWN categories (filter chips) and status columns
-- (Kanban), instead of the hardcoded 15 filing types + fixed Not-Due/Filed set.
-- Brands WITHOUT a row here fall back to the built-in defaults (e.g. Stroom keeps
-- its filing types + Not-Due/Pending/Filed/Not-Applicable — zero behaviour change).
-- Shape:
--   categories = [{ "key","name","color","group"?,"stateWise"? }, ...]
--   statuses   = [{ "key","label","color","terminal"? }, ...]  (terminal = "done")
-- Statutory is app-scoped (canAccessBrand in the controller), RLS is NOT enabled
-- on statutory_filings, so this table only needs table grants — no RLS policy.

CREATE TABLE IF NOT EXISTS statutory_config (
  brand_id   uuid PRIMARY KEY REFERENCES brands(id) ON DELETE CASCADE,
  categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  statuses   jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON statutory_config TO colonel_app;
