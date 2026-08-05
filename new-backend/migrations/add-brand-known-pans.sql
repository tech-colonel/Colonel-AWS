-- ─────────────────────────────────────────────────────────────────────────────
-- Brand PAN checkpoint  (Invoice Process — wrong-brand guard)
-- ─────────────────────────────────────────────────────────────────────────────
-- On a purchase invoice the BUYER is the brand, so buyer_gstin's PAN identifies the
-- brand. We keep a learned {PAN: count} map per brand on brands.known_pans and use it
-- in the n8n feed handler (new-backend/src/controllers/agents/invoice-process/
-- n8n-invoice-feed-db.js) to reject invoices whose buyer PAN is positively owned by a
-- DIFFERENT brand (e.g. Baynine files dropped into Stroom's folder), flag stranger
-- PANs as "Needs Review", and self-learn each brand's own PANs over time.
--
-- brands.known_pans is MASTER data (not RLS-scoped), so ownership can be resolved
-- across brands — unlike invoice_process, which is row-level-secured per brand.
--
-- Additive + idempotent. Safe to run on any DB.

ALTER TABLE brands ADD COLUMN IF NOT EXISTS known_pans jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Seed the map from existing invoice history (dominant PAN per brand is derived at
-- read time: a brand "owns" a PAN once it holds >= 80% of that PAN's occurrences and
-- >= 3 absolute). Re-runnable — recomputes purely from current invoice_process rows.
UPDATE brands b SET known_pans = COALESCE(sub.pans, '{}'::jsonb)
FROM (
  SELECT brand_id, jsonb_object_agg(pan, cnt) AS pans FROM (
    SELECT brand_id,
           upper(substring(regexp_replace(buyer_gstin, '[^0-9A-Za-z]', '', 'g') from 3 for 10)) AS pan,
           count(*) AS cnt
    FROM invoice_process
    WHERE buyer_gstin IS NOT NULL
      AND length(regexp_replace(buyer_gstin, '[^0-9A-Za-z]', '', 'g')) >= 15
    GROUP BY brand_id, 2
  ) t GROUP BY brand_id
) sub
WHERE b.id = sub.brand_id;
