-- Address-based token price cache for swap volume recording
-- Run this after swap_volume_schema.sql and swap_volume_rpc.sql.

CREATE TABLE IF NOT EXISTS token_price_cache_daily (
  id            BIGSERIAL PRIMARY KEY,
  chain_id      INTEGER NOT NULL,
  token_address VARCHAR(42) NOT NULL,
  price_date    DATE NOT NULL,
  price_usd     DECIMAL(20,8) NOT NULL,
  source        VARCHAR(40) NOT NULL DEFAULT 'coingecko',
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(chain_id, token_address, price_date)
);

CREATE INDEX IF NOT EXISTS idx_token_price_cache_daily_lookup
  ON token_price_cache_daily(chain_id, token_address, price_date DESC);

ALTER TABLE token_price_cache_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_all_token_price_cache_daily" ON token_price_cache_daily;

CREATE POLICY "service_all_token_price_cache_daily"
  ON token_price_cache_daily FOR ALL USING (true);
