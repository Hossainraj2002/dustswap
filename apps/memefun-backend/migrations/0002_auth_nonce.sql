-- Sign-in nonces (SIWE). Kept in the database, not in memory, so any API replica can verify a
-- nonce another one issued. Each nonce is single-use: verification deletes it.
CREATE TABLE IF NOT EXISTS memefun_app.auth_nonce (
  nonce       text PRIMARY KEY,
  ip_hash     text NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_nonce_expiry_idx ON memefun_app.auth_nonce (expires_at);
