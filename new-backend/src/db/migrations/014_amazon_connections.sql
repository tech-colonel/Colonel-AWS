-- 014_amazon_connections.sql
-- Per-brand Amazon Selling Partner API (SP-API) credentials.
--
-- Mirrors 010_shopify_connections.sql deliberately: same shape, same RLS, same
-- encryption discipline, so the two marketplace integrations are read and
-- operated the same way.
--
-- What differs from Shopify: Amazon hands us a long-lived REFRESH token, not an
-- access token. Every call first exchanges it at Login-with-Amazon for a 1-hour
-- access token (see services/amazonAuth.js). So the secret stored here is the
-- durable one — losing AMAZON_TOKEN_KEY means every brand must re-authorize.
--
-- Additive: nothing else reads or writes this table.

CREATE TABLE IF NOT EXISTS amazon_connections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id            uuid NOT NULL,
  selling_partner_id  varchar(64),                 -- merchant token, e.g. A1B2C3D4E5
  refresh_token       text NOT NULL,               -- AES-256-GCM: iv:tag:ciphertext
  marketplace_id      varchar(32)  DEFAULT 'A21TJRUUN4KGV',   -- amazon.in
  region              varchar(8)   DEFAULT 'eu',              -- eu | na | fe
  roles               text,                        -- comma-separated, as granted
  auth_method         varchar(16)  DEFAULT 'self', -- 'self' (self-authorized) | 'oauth'
  installed_by        uuid,
  installed_at        timestamptz DEFAULT now(),
  last_used_at        timestamptz,
  revoked_at          timestamptz,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

-- One live connection per brand; re-authorizing updates in place.
CREATE UNIQUE INDEX IF NOT EXISTS amazon_connections_brand_uniq
  ON amazon_connections (brand_id) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS amazon_connections_spid_idx
  ON amazon_connections (selling_partner_id);

-- Ownership + grants must match the sibling brand tables, or the app user cannot
-- touch this table at all. Run as superuser; if applied by a normal role these
-- two statements still need to run as postgres.
ALTER TABLE amazon_connections OWNER TO postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON amazon_connections TO colonel_app;

ALTER TABLE amazon_connections ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'amazon_connections' AND policyname = 'amazon_connections_brand_isolation'
  ) THEN
    -- USING gates SELECT/UPDATE/DELETE; WITH CHECK is required for INSERT to be
    -- allowed at all (a USING-only policy silently rejects every insert).
    CREATE POLICY amazon_connections_brand_isolation ON amazon_connections
      USING      (brand_id = NULLIF(current_setting('app.brand_id', true), '')::uuid)
      WITH CHECK (brand_id = NULLIF(current_setting('app.brand_id', true), '')::uuid);
  END IF;
END $$;
