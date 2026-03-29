-- Swap volume capture tables
-- Run this file before swap_volume_rpc.sql in the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS swap_transactions (
  id                        BIGSERIAL PRIMARY KEY,
  user_id                   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address                   VARCHAR(42) NOT NULL,
  tx_hash                   VARCHAR(66) NOT NULL UNIQUE,
  chain_id                  INTEGER NOT NULL,
  router_address            VARCHAR(42),
  sender_address            VARCHAR(42),
  src_token_address         VARCHAR(42),
  src_token_symbol          VARCHAR(32),
  src_token_decimals        INTEGER,
  dst_token_address         VARCHAR(42),
  dst_token_symbol          VARCHAR(32),
  dst_token_decimals        INTEGER,
  dst_receiver              VARCHAR(42),
  referrer                  VARCHAR(42),
  amount_raw                TEXT NOT NULL DEFAULT '0',
  spent_amount_raw          TEXT NOT NULL DEFAULT '0',
  return_amount_raw         TEXT NOT NULL DEFAULT '0',
  min_return_amount_raw     TEXT NOT NULL DEFAULT '0',
  guaranteed_amount_raw     TEXT NOT NULL DEFAULT '0',
  amount_usd                DECIMAL(20,6) NOT NULL DEFAULT 0,
  day_key                   DATE NOT NULL,
  week_key                  TEXT NOT NULL,
  block_number              BIGINT,
  block_hash                VARCHAR(66),
  transaction_index         INTEGER,
  log_index                 INTEGER,
  occurred_at               TIMESTAMPTZ NOT NULL,
  metadata                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_volume_daily (
  id                        BIGSERIAL PRIMARY KEY,
  user_id                   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address                   VARCHAR(42) NOT NULL,
  day_key                   DATE NOT NULL,
  week_key                  TEXT NOT NULL,
  total_usd                 DECIMAL(20,6) NOT NULL DEFAULT 0,
  swap_count                INTEGER NOT NULL DEFAULT 0,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, day_key)
);

CREATE TABLE IF NOT EXISTS user_volume_alltime (
  id                        BIGSERIAL PRIMARY KEY,
  user_id                   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address                   VARCHAR(42) NOT NULL,
  total_usd                 DECIMAL(20,6) NOT NULL DEFAULT 0,
  swap_count                INTEGER NOT NULL DEFAULT 0,
  first_swap_at             TIMESTAMPTZ,
  last_swap_at              TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_swap_transactions_user_occurred
  ON swap_transactions(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_swap_transactions_address_occurred
  ON swap_transactions(address, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_swap_transactions_day_key
  ON swap_transactions(day_key, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_volume_daily_week_key
  ON user_volume_daily(week_key, total_usd DESC);
CREATE INDEX IF NOT EXISTS idx_user_volume_alltime_total
  ON user_volume_alltime(total_usd DESC);

ALTER TABLE swap_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_volume_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_volume_alltime ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_all_swap_transactions" ON swap_transactions;
DROP POLICY IF EXISTS "service_all_user_volume_daily" ON user_volume_daily;
DROP POLICY IF EXISTS "service_all_user_volume_alltime" ON user_volume_alltime;

CREATE POLICY "service_all_swap_transactions"
  ON swap_transactions FOR ALL USING (true);
CREATE POLICY "service_all_user_volume_daily"
  ON user_volume_daily FOR ALL USING (true);
CREATE POLICY "service_all_user_volume_alltime"
  ON user_volume_alltime FOR ALL USING (true);
