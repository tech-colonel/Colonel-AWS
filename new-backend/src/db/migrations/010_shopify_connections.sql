-- 010_shopify_connections.sql
-- Per-brand Shopify Admin API credentials, obtained via our OWN OAuth handshake
-- (not Composio — Composio redacts access_token, and ~11 of our 30 scopes have
-- no Composio tool at all: returns, companies, shopify_payments_*, store credit,
-- markets, publications, inventory transfers/shipments, order edits).
--
-- Additive: nothing else reads or writes this table.
-- Tokens are AES-256-GCM encrypted at rest (see services/shopifyTokenStore.js);
-- the ciphertext is useless without SHOPIFY_TOKEN_KEY, which lives only in .env.

CREATE TABLE IF NOT EXISTS shopify_connections (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id       uuid NOT NULL,
  shop_domain    varchar(255) NOT NULL,              -- dchica.myshopify.com
  access_token   text NOT NULL,                      -- AES-256-GCM: iv:tag:ciphertext
  scopes         text,                               -- comma-separated, as granted
  api_version    varchar(16)  DEFAULT '2026-07',
  installed_by   uuid,
  installed_at   timestamptz DEFAULT now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz,                        -- set on app/uninstalled
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
);

-- One live connection per brand; a re-install updates in place.
CREATE UNIQUE INDEX IF NOT EXISTS shopify_connections_brand_uniq
  ON shopify_connections (brand_id) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS shopify_connections_shop_idx
  ON shopify_connections (shop_domain);

-- Ownership + grants must match the sibling brand tables, or the app user cannot
-- touch this table at all. Run the migration as a superuser; if it was applied by
-- a normal role these two statements still need to run as postgres.
ALTER TABLE shopify_connections OWNER TO postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON shopify_connections TO colonel_app;

-- RLS, consistent with every other brand-scoped table in this DB.
ALTER TABLE shopify_connections ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'shopify_connections' AND policyname = 'shopify_connections_brand_isolation'
  ) THEN
    -- USING gates SELECT/UPDATE/DELETE; WITH CHECK is required for INSERT to be
    -- allowed at all (a USING-only policy silently rejects every insert).
    CREATE POLICY shopify_connections_brand_isolation ON shopify_connections
      USING      (brand_id = NULLIF(current_setting('app.brand_id', true), '')::uuid)
      WITH CHECK (brand_id = NULLIF(current_setting('app.brand_id', true), '')::uuid);
  END IF;
END $$;
