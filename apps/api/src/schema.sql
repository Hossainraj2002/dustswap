-- DustSweep Database Schema
-- Run this in Supabase SQL Editor (supabase.com → SQL Editor → New query)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Users
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  address        VARCHAR(42) UNIQUE NOT NULL,
  referral_code  VARCHAR(20) UNIQUE NOT NULL,
  referred_by    INTEGER REFERENCES users(id),
  total_points   BIGINT  DEFAULT 0,
  spin_tickets   INTEGER DEFAULT 0,
  current_streak INTEGER DEFAULT 0,
  longest_streak INTEGER DEFAULT 0,
  last_check_in  TIMESTAMP,
  created_at     TIMESTAMP DEFAULT NOW(),
  updated_at     TIMESTAMP DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS spin_tickets INTEGER NOT NULL DEFAULT 0;

-- Point events ledger
CREATE TABLE IF NOT EXISTS point_events (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id),
  action        VARCHAR(50)    NOT NULL,
  points        INTEGER        NOT NULL,
  multiplier    DECIMAL(4,2)   DEFAULT 1.0,
  total_awarded INTEGER        NOT NULL,
  tx_hash       VARCHAR(66),
  metadata      JSONB,
  season        INTEGER        DEFAULT 1,
  created_at    TIMESTAMP DEFAULT NOW()
);

-- Daily check-ins
CREATE TABLE IF NOT EXISTS check_ins (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER  REFERENCES users(id),
  check_in_date  DATE     NOT NULL,
  points_earned  INTEGER  NOT NULL,
  streak_day     INTEGER  NOT NULL,
  payment_tx_hash VARCHAR(66),
  payment_asset   VARCHAR(10),
  payment_amount  TEXT,
  payment_amount_usd DECIMAL(20,6),
  price_snapshot_date DATE,
  created_at     TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, check_in_date)
);

ALTER TABLE check_ins ADD COLUMN IF NOT EXISTS payment_tx_hash VARCHAR(66);
ALTER TABLE check_ins ADD COLUMN IF NOT EXISTS payment_asset VARCHAR(10);
ALTER TABLE check_ins ADD COLUMN IF NOT EXISTS payment_amount TEXT;
ALTER TABLE check_ins ADD COLUMN IF NOT EXISTS payment_amount_usd DECIMAL(20,6);
ALTER TABLE check_ins ADD COLUMN IF NOT EXISTS price_snapshot_date DATE;

-- Daily price snapshots for ETH fallback fee calculations
CREATE TABLE IF NOT EXISTS daily_asset_prices (
  id            SERIAL PRIMARY KEY,
  asset_symbol  VARCHAR(20) NOT NULL,
  price_date    DATE NOT NULL,
  price_usd     DECIMAL(20,8) NOT NULL,
  source        VARCHAR(40) NOT NULL DEFAULT 'coingecko',
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW(),
  UNIQUE(asset_symbol, price_date)
);

-- Paid streak recovery history
CREATE TABLE IF NOT EXISTS streak_recovery_events (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER REFERENCES users(id),
  tx_hash          VARCHAR(66) UNIQUE NOT NULL,
  asset_symbol     VARCHAR(10) NOT NULL,
  asset_address    VARCHAR(42),
  amount           TEXT NOT NULL,
  amount_usd       DECIMAL(20,6) NOT NULL DEFAULT 1,
  previous_streak  INTEGER NOT NULL,
  restored_streak  INTEGER NOT NULL,
  status           VARCHAR(20) NOT NULL DEFAULT 'confirmed',
  created_at       TIMESTAMP DEFAULT NOW()
);

-- Spin reward history
CREATE TABLE IF NOT EXISTS spin_history (
  id                 SERIAL PRIMARY KEY,
  user_id            INTEGER REFERENCES users(id),
  tx_hash            VARCHAR(66) UNIQUE NOT NULL,
  reward_key         VARCHAR(32) NOT NULL,
  reward_label       VARCHAR(32) NOT NULL,
  reward_type        VARCHAR(10) NOT NULL,
  reward_amount      DECIMAL(20,6) NOT NULL,
  reward_points      INTEGER NOT NULL DEFAULT 0,
  reward_probability DECIMAL(5,2) NOT NULL DEFAULT 0,
  ticket_cost        INTEGER NOT NULL DEFAULT 1,
  execution_type     VARCHAR(20),
  status             VARCHAR(20) NOT NULL DEFAULT 'confirmed',
  created_at         TIMESTAMP DEFAULT NOW()
);

-- Referrals
CREATE TABLE IF NOT EXISTS referrals (
  id                   SERIAL PRIMARY KEY,
  referrer_id          INTEGER REFERENCES users(id),
  referee_id           INTEGER REFERENCES users(id),
  referrer_earned      BIGINT  DEFAULT 0,
  referee_first_sweep  BOOLEAN DEFAULT false,
  created_at           TIMESTAMP DEFAULT NOW(),
  UNIQUE(referee_id)
);

-- Sweep / bridge / burn transaction history
CREATE TABLE IF NOT EXISTS sweep_history (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER REFERENCES users(id),
  tx_hash          VARCHAR(66)   NOT NULL,
  chain_id         INTEGER       NOT NULL,
  input_tokens     JSONB         NOT NULL,
  output_token     VARCHAR(42)   NOT NULL,
  output_amount    TEXT          NOT NULL,
  output_value_usd DECIMAL(20,6),
  fee_amount       TEXT,
  token_count      INTEGER       NOT NULL,
  type             VARCHAR(20)   NOT NULL, -- 'sweep' | 'bridge' | 'burn' | 'swap'
  status           VARCHAR(20)   DEFAULT 'pending',
  points_earned    INTEGER       DEFAULT 0,
  created_at       TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_events_user    ON point_events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_action  ON point_events(action);
CREATE INDEX IF NOT EXISTS idx_events_user_action_created
  ON point_events(user_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_points   ON users(total_points DESC);
CREATE INDEX IF NOT EXISTS idx_users_refcode  ON users(referral_code);
CREATE INDEX IF NOT EXISTS idx_history_user   ON sweep_history(user_id);
CREATE INDEX IF NOT EXISTS idx_history_user_type_created
  ON sweep_history(user_id, type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_tx_hash
  ON sweep_history(tx_hash);
CREATE INDEX IF NOT EXISTS idx_history_chain_tx_hash_type
  ON sweep_history(chain_id, tx_hash, type);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer
  ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_recovery_user  ON streak_recovery_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_spin_history_user_created
  ON spin_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_daily_asset_prices_symbol_date ON daily_asset_prices(asset_symbol, price_date DESC);

-- Enable Row Level Security
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE point_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE check_ins      ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_asset_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE streak_recovery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE spin_history   ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sweep_history  ENABLE ROW LEVEL SECURITY;

-- Allow service-role access (backend uses service key)
DROP POLICY IF EXISTS "service_all_users"      ON users;
DROP POLICY IF EXISTS "service_all_events"     ON point_events;
DROP POLICY IF EXISTS "service_all_checkins"   ON check_ins;
DROP POLICY IF EXISTS "service_all_daily_prices" ON daily_asset_prices;
DROP POLICY IF EXISTS "service_all_recoveries" ON streak_recovery_events;
DROP POLICY IF EXISTS "service_all_spin_history" ON spin_history;
DROP POLICY IF EXISTS "service_all_referrals"  ON referrals;
DROP POLICY IF EXISTS "service_all_history"    ON sweep_history;
CREATE POLICY "service_all_users"         ON users          FOR ALL USING (true);
CREATE POLICY "service_all_events"        ON point_events   FOR ALL USING (true);
CREATE POLICY "service_all_checkins"      ON check_ins      FOR ALL USING (true);
CREATE POLICY "service_all_daily_prices"  ON daily_asset_prices FOR ALL USING (true);
CREATE POLICY "service_all_recoveries"    ON streak_recovery_events FOR ALL USING (true);
CREATE POLICY "service_all_spin_history"  ON spin_history   FOR ALL USING (true);
CREATE POLICY "service_all_referrals"     ON referrals      FOR ALL USING (true);
CREATE POLICY "service_all_history"       ON sweep_history  FOR ALL USING (true);

CREATE OR REPLACE FUNCTION adjust_spin_tickets(
  p_user_id INTEGER,
  p_delta INTEGER
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_next_tickets INTEGER;
BEGIN
  UPDATE users
  SET
    spin_tickets = spin_tickets + p_delta,
    updated_at = NOW()
  WHERE
    id = p_user_id
    AND spin_tickets + p_delta >= 0
  RETURNING spin_tickets INTO v_next_tickets;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'insufficient_spin_tickets';
  END IF;

  RETURN v_next_tickets;
END;
$$;

-- =========================================================
-- Quest System
-- =========================================================

CREATE TABLE IF NOT EXISTS quests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              TEXT UNIQUE NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT,
  campaign_key      TEXT NOT NULL DEFAULT 'general',
  category          TEXT NOT NULL,
  platform          TEXT NOT NULL,
  action_type       TEXT NOT NULL,
  verification_type TEXT NOT NULL,
  progress_window   TEXT NOT NULL DEFAULT 'once',
  reward_kind       TEXT NOT NULL DEFAULT 'particle_points',
  reward_points     INTEGER NOT NULL DEFAULT 0,
  target_value      DECIMAL(20,6) NOT NULL DEFAULT 1,
  cta_label         TEXT,
  cta_url           TEXT,
  status            TEXT NOT NULL DEFAULT 'draft',
  is_active         BOOLEAN NOT NULL DEFAULT true,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  starts_at         TIMESTAMPTZ,
  ends_at           TIMESTAMPTZ,
  rules             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE quests
  ADD COLUMN IF NOT EXISTS campaign_key TEXT NOT NULL DEFAULT 'general';

UPDATE quests
SET campaign_key = 'general'
WHERE campaign_key IS NULL;

CREATE TABLE IF NOT EXISTS social_accounts (
  id                BIGSERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform          TEXT NOT NULL,
  platform_user_id  TEXT NOT NULL,
  username          TEXT,
  display_name      TEXT,
  profile_image_url TEXT,
  access_token      TEXT,
  refresh_token     TEXT,
  scope             TEXT,
  token_expires_at  TIMESTAMPTZ,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, platform),
  UNIQUE(platform, platform_user_id)
);

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username TEXT UNIQUE,
  display_name TEXT,
  discord_username TEXT,
  pfp_url TEXT,
  pfp_storage_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_profiles_username_format CHECK (
    username IS NULL OR username ~ '^[a-z0-9._]{3,24}$'
  ),
  CONSTRAINT user_profiles_display_name_length CHECK (
    display_name IS NULL OR char_length(display_name) BETWEEN 2 AND 32
  ),
  CONSTRAINT user_profiles_discord_length CHECK (
    discord_username IS NULL OR char_length(discord_username) BETWEEN 2 AND 40
  )
);

CREATE TABLE IF NOT EXISTS quest_progress (
  id                    BIGSERIAL PRIMARY KEY,
  quest_id              UUID NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cycle_key             TEXT NOT NULL DEFAULT 'global',
  status                TEXT NOT NULL DEFAULT 'not_started',
  progress              DECIMAL(20,6) NOT NULL DEFAULT 0,
  target_value          DECIMAL(20,6) NOT NULL DEFAULT 0,
  verification_attempts INTEGER NOT NULL DEFAULT 0,
  fake_failures_served  INTEGER NOT NULL DEFAULT 0,
  opened_at             TIMESTAMPTZ,
  next_verification_at  TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  rewarded_at           TIMESTAMPTZ,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, quest_id, cycle_key)
);

CREATE TABLE IF NOT EXISTS quest_verification_logs (
  id               BIGSERIAL PRIMARY KEY,
  quest_id         UUID NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cycle_key        TEXT NOT NULL DEFAULT 'global',
  status           TEXT NOT NULL,
  request_payload  JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS activity_events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  source      TEXT NOT NULL,
  chain_id    INTEGER,
  tx_hash     VARCHAR(66),
  amount_usd  DECIMAL(20,6) NOT NULL DEFAULT 0,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(chain_id, tx_hash, event_type, source)
);

CREATE TABLE IF NOT EXISTS quest_campaign_whitelist (
  id             BIGSERIAL PRIMARY KEY,
  campaign_key   TEXT NOT NULL,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_address VARCHAR(42) NOT NULL,
  status         TEXT NOT NULL DEFAULT 'whitelisted',
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(campaign_key, user_id),
  UNIQUE(campaign_key, wallet_address)
);

CREATE INDEX IF NOT EXISTS idx_quests_status          ON quests(status, is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_quests_campaign        ON quests(campaign_key, status, is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_social_accounts_user   ON social_accounts(user_id, platform);
CREATE INDEX IF NOT EXISTS idx_user_profiles_username ON user_profiles(username);
CREATE INDEX IF NOT EXISTS idx_quest_progress_user    ON quest_progress(user_id, quest_id, cycle_key);
CREATE INDEX IF NOT EXISTS idx_quest_logs_user        ON quest_verification_logs(user_id, quest_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_user   ON activity_events(user_id, event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_user_source_occurred
  ON activity_events(user_id, event_type, source, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_whitelist_campaign ON quest_campaign_whitelist(campaign_key, created_at DESC);

ALTER TABLE quests                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_accounts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest_progress           ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest_verification_logs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest_campaign_whitelist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_all_quests"           ON quests;
DROP POLICY IF EXISTS "service_all_social_accounts"  ON social_accounts;
DROP POLICY IF EXISTS "service_all_user_profiles"    ON user_profiles;
DROP POLICY IF EXISTS "service_all_quest_progress"   ON quest_progress;
DROP POLICY IF EXISTS "service_all_quest_logs"       ON quest_verification_logs;
DROP POLICY IF EXISTS "service_all_activity_events"  ON activity_events;
DROP POLICY IF EXISTS "service_all_campaign_whitelist" ON quest_campaign_whitelist;
CREATE POLICY "service_all_quests"          ON quests                  FOR ALL USING (true);
CREATE POLICY "service_all_social_accounts" ON social_accounts         FOR ALL USING (true);
CREATE POLICY "service_all_user_profiles"   ON user_profiles           FOR ALL USING (true);
CREATE POLICY "service_all_quest_progress"  ON quest_progress          FOR ALL USING (true);
CREATE POLICY "service_all_quest_logs"      ON quest_verification_logs FOR ALL USING (true);
CREATE POLICY "service_all_activity_events" ON activity_events         FOR ALL USING (true);
CREATE POLICY "service_all_campaign_whitelist" ON quest_campaign_whitelist FOR ALL USING (true);

CREATE OR REPLACE FUNCTION get_user_sweep_stats(p_user_id INTEGER)
RETURNS TABLE (
  dust_swept BIGINT,
  swap_volume NUMERIC,
  tokens_burned BIGINT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COALESCE(SUM(CASE WHEN type = 'sweep' THEN token_count ELSE 0 END), 0)::BIGINT AS dust_swept,
    COALESCE(
      SUM(CASE WHEN type = 'swap' THEN COALESCE(output_value_usd, 0) ELSE 0 END),
      0
    )::NUMERIC(20,6) AS swap_volume,
    COALESCE(SUM(CASE WHEN type = 'burn' THEN token_count ELSE 0 END), 0)::BIGINT AS tokens_burned
  FROM sweep_history
  WHERE user_id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION get_user_referral_stats(p_user_id INTEGER)
RETURNS TABLE (
  friends_joined BIGINT,
  points_earned BIGINT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    (
      SELECT COUNT(*)::BIGINT
      FROM referrals
      WHERE referrer_id = p_user_id
    ) AS friends_joined,
    (
      SELECT COALESCE(SUM(total_awarded), 0)::BIGINT
      FROM point_events
      WHERE user_id = p_user_id
        AND action IN ('referral_commission', 'referral_new_user')
    ) AS points_earned;
$$;

CREATE OR REPLACE FUNCTION is_leaderboard_eligible_user(
  p_user_id INTEGER,
  p_total_points BIGINT DEFAULT 0
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT
    COALESCE(p_total_points, 0) > 0
    OR EXISTS (
      SELECT 1
      FROM point_events pe
      WHERE pe.user_id = p_user_id
    )
    OR EXISTS (
      SELECT 1
      FROM check_ins ci
      WHERE ci.user_id = p_user_id
    )
    OR EXISTS (
      SELECT 1
      FROM sweep_history sh
      WHERE sh.user_id = p_user_id
    )
    OR EXISTS (
      SELECT 1
      FROM spin_history spin
      WHERE spin.user_id = p_user_id
    )
    OR EXISTS (
      SELECT 1
      FROM streak_recovery_events recovery
      WHERE recovery.user_id = p_user_id
    );
$$;

CREATE OR REPLACE FUNCTION get_points_overview()
RETURNS TABLE (
  total_user_count BIGINT,
  total_particle_points BIGINT
)
LANGUAGE sql
STABLE
AS $$
  WITH eligible_users AS (
    SELECT
      u.id,
      u.total_points
    FROM users u
    WHERE is_leaderboard_eligible_user(u.id, u.total_points)
  )
  SELECT
    COUNT(*)::BIGINT AS total_user_count,
    COALESCE(SUM(total_points), 0)::BIGINT AS total_particle_points
  FROM eligible_users;
$$;

CREATE OR REPLACE FUNCTION get_particle_point_leaderboard_page(
  p_offset INTEGER,
  p_limit INTEGER
)
RETURNS TABLE (
  rank BIGINT,
  user_id INTEGER,
  address VARCHAR(42),
  total_points BIGINT,
  current_streak INTEGER,
  last_check_in TIMESTAMP
)
LANGUAGE sql
STABLE
AS $$
  WITH eligible_users AS (
    SELECT
      u.id,
      u.address,
      u.total_points,
      u.current_streak,
      u.last_check_in
    FROM users u
    WHERE is_leaderboard_eligible_user(u.id, u.total_points)
  ),
  ranked AS (
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY
          eligible_users.total_points DESC,
          eligible_users.id ASC
      )::BIGINT AS rank,
      eligible_users.id AS user_id,
      eligible_users.address,
      eligible_users.total_points::BIGINT AS total_points,
      eligible_users.current_streak,
      eligible_users.last_check_in
    FROM eligible_users
  )
  SELECT
    ranked.rank,
    ranked.user_id,
    ranked.address,
    ranked.total_points,
    ranked.current_streak,
    ranked.last_check_in
  FROM ranked
  ORDER BY ranked.rank
  OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 100);
$$;

CREATE OR REPLACE FUNCTION get_particle_point_leaderboard_viewer(p_user_id INTEGER)
RETURNS TABLE (
  rank BIGINT,
  user_id INTEGER,
  address VARCHAR(42),
  total_points BIGINT,
  current_streak INTEGER,
  last_check_in TIMESTAMP
)
LANGUAGE sql
STABLE
AS $$
  WITH eligible_users AS (
    SELECT
      u.id,
      u.address,
      u.total_points,
      u.current_streak,
      u.last_check_in
    FROM users u
    WHERE is_leaderboard_eligible_user(u.id, u.total_points)
  ),
  ranked AS (
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY
          eligible_users.total_points DESC,
          eligible_users.id ASC
      )::BIGINT AS rank,
      eligible_users.id AS user_id,
      eligible_users.address,
      eligible_users.total_points::BIGINT AS total_points,
      eligible_users.current_streak,
      eligible_users.last_check_in
    FROM eligible_users
  )
  SELECT
    ranked.rank,
    ranked.user_id,
    ranked.address,
    ranked.total_points,
    ranked.current_streak,
    ranked.last_check_in
  FROM ranked
  WHERE ranked.user_id = p_user_id
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION get_referral_leaderboard_page(
  p_offset INTEGER,
  p_limit INTEGER
)
RETURNS TABLE (
  rank BIGINT,
  user_id INTEGER,
  address VARCHAR(42),
  total_points BIGINT,
  referral_points BIGINT,
  referred_users BIGINT
)
LANGUAGE sql
STABLE
AS $$
  WITH referral_counts AS (
    SELECT referrer_id AS user_id, COUNT(*)::BIGINT AS referred_users
    FROM referrals
    WHERE referrer_id IS NOT NULL
    GROUP BY referrer_id
  ),
  referral_points AS (
    SELECT user_id, COALESCE(SUM(total_awarded), 0)::BIGINT AS referral_points
    FROM point_events
    WHERE action IN ('referral_commission', 'referral_new_user')
    GROUP BY user_id
  ),
  eligible_users AS (
    SELECT
      u.id,
      u.address,
      u.total_points,
      referral_counts.referred_users
    FROM users u
    JOIN referral_counts ON referral_counts.user_id = u.id
    WHERE referral_counts.referred_users > 0
  ),
  ranked AS (
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY
          COALESCE(referral_points.referral_points, 0) DESC,
          eligible_users.referred_users DESC,
          eligible_users.total_points DESC,
          eligible_users.id ASC
      )::BIGINT AS rank,
      eligible_users.id AS user_id,
      eligible_users.address,
      eligible_users.total_points::BIGINT AS total_points,
      COALESCE(referral_points.referral_points, 0)::BIGINT AS referral_points,
      eligible_users.referred_users::BIGINT AS referred_users
    FROM eligible_users
    LEFT JOIN referral_points ON referral_points.user_id = eligible_users.id
  )
  SELECT
    ranked.rank,
    ranked.user_id,
    ranked.address,
    ranked.total_points,
    ranked.referral_points,
    ranked.referred_users
  FROM ranked
  ORDER BY ranked.rank
  OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
$$;

CREATE OR REPLACE FUNCTION get_referral_leaderboard_count()
RETURNS TABLE (
  total_entries BIGINT
)
LANGUAGE sql
STABLE
AS $$
  WITH referral_counts AS (
    SELECT referrer_id AS user_id, COUNT(*)::BIGINT AS referred_users
    FROM referrals
    WHERE referrer_id IS NOT NULL
    GROUP BY referrer_id
  )
  SELECT COUNT(*)::BIGINT AS total_entries
  FROM users u
  JOIN referral_counts ON referral_counts.user_id = u.id
  WHERE referral_counts.referred_users > 0;
$$;

CREATE OR REPLACE FUNCTION get_referral_leaderboard_viewer(p_user_id INTEGER)
RETURNS TABLE (
  rank BIGINT,
  user_id INTEGER,
  address VARCHAR(42),
  total_points BIGINT,
  referral_points BIGINT,
  referred_users BIGINT
)
LANGUAGE sql
STABLE
AS $$
  WITH referral_counts AS (
    SELECT referrer_id AS user_id, COUNT(*)::BIGINT AS referred_users
    FROM referrals
    WHERE referrer_id IS NOT NULL
    GROUP BY referrer_id
  ),
  referral_points AS (
    SELECT user_id, COALESCE(SUM(total_awarded), 0)::BIGINT AS referral_points
    FROM point_events
    WHERE action IN ('referral_commission', 'referral_new_user')
    GROUP BY user_id
  ),
  eligible_users AS (
    SELECT
      u.id,
      u.address,
      u.total_points,
      referral_counts.referred_users
    FROM users u
    JOIN referral_counts ON referral_counts.user_id = u.id
    WHERE referral_counts.referred_users > 0
  ),
  ranked AS (
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY
          COALESCE(referral_points.referral_points, 0) DESC,
          eligible_users.referred_users DESC,
          eligible_users.total_points DESC,
          eligible_users.id ASC
      )::BIGINT AS rank,
      eligible_users.id AS user_id,
      eligible_users.address,
      eligible_users.total_points::BIGINT AS total_points,
      COALESCE(referral_points.referral_points, 0)::BIGINT AS referral_points,
      eligible_users.referred_users::BIGINT AS referred_users
    FROM eligible_users
    LEFT JOIN referral_points ON referral_points.user_id = eligible_users.id
  )
  SELECT
    ranked.rank,
    ranked.user_id,
    ranked.address,
    ranked.total_points,
    ranked.referral_points,
    ranked.referred_users
  FROM ranked
  WHERE ranked.user_id = p_user_id
  LIMIT 1;
$$;

CREATE TABLE IF NOT EXISTS referral_leaderboard_snapshot_entries (
  rank BIGINT PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  address VARCHAR(42) NOT NULL,
  total_points BIGINT NOT NULL DEFAULT 0,
  referral_points BIGINT NOT NULL DEFAULT 0,
  referred_users BIGINT NOT NULL DEFAULT 0,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_leaderboard_snapshot_entries_user_id
  ON referral_leaderboard_snapshot_entries(user_id);

CREATE TABLE IF NOT EXISTS referral_leaderboard_snapshot_meta (
  singleton SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_entries BIGINT NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION refresh_referral_leaderboard_snapshot()
RETURNS TABLE (
  refreshed_at TIMESTAMPTZ,
  total_entries BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_refreshed_at TIMESTAMPTZ := timezone('utc', now());
  v_total_entries BIGINT := 0;
BEGIN
  CREATE TEMP TABLE tmp_referral_leaderboard_snapshot ON COMMIT DROP AS
  WITH referral_counts AS (
    SELECT referrer_id AS user_id, COUNT(*)::BIGINT AS referred_users
    FROM referrals
    WHERE referrer_id IS NOT NULL
    GROUP BY referrer_id
  ),
  referral_points AS (
    SELECT user_id, COALESCE(SUM(total_awarded), 0)::BIGINT AS referral_points
    FROM point_events
    WHERE action IN ('referral_commission', 'referral_new_user')
    GROUP BY user_id
  ),
  eligible_users AS (
    SELECT
      u.id,
      u.address,
      u.total_points,
      referral_counts.referred_users
    FROM users u
    JOIN referral_counts ON referral_counts.user_id = u.id
    WHERE referral_counts.referred_users > 0
  ),
  ranked AS (
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY
          COALESCE(referral_points.referral_points, 0) DESC,
          eligible_users.referred_users DESC,
          eligible_users.total_points DESC,
          eligible_users.id ASC
      )::BIGINT AS rank,
      eligible_users.id AS user_id,
      eligible_users.address,
      eligible_users.total_points::BIGINT AS total_points,
      COALESCE(referral_points.referral_points, 0)::BIGINT AS referral_points,
      eligible_users.referred_users::BIGINT AS referred_users
    FROM eligible_users
    LEFT JOIN referral_points ON referral_points.user_id = eligible_users.id
  )
  SELECT
    ranked.rank,
    ranked.user_id,
    ranked.address,
    ranked.total_points,
    ranked.referral_points,
    ranked.referred_users,
    v_refreshed_at AS refreshed_at
  FROM ranked;

  SELECT COUNT(*)::BIGINT INTO v_total_entries
  FROM tmp_referral_leaderboard_snapshot;

  TRUNCATE TABLE referral_leaderboard_snapshot_entries;

  INSERT INTO referral_leaderboard_snapshot_entries (
    rank,
    user_id,
    address,
    total_points,
    referral_points,
    referred_users,
    refreshed_at
  )
  SELECT
    rank,
    user_id,
    address,
    total_points,
    referral_points,
    referred_users,
    refreshed_at
  FROM tmp_referral_leaderboard_snapshot
  ORDER BY rank;

  INSERT INTO referral_leaderboard_snapshot_meta (
    singleton,
    refreshed_at,
    total_entries
  )
  VALUES (1, v_refreshed_at, v_total_entries)
  ON CONFLICT (singleton) DO UPDATE
  SET
    refreshed_at = EXCLUDED.refreshed_at,
    total_entries = EXCLUDED.total_entries;

  RETURN QUERY
  SELECT v_refreshed_at, v_total_entries;
END;
$$;

CREATE OR REPLACE FUNCTION get_volume_leaderboard_page(
  p_offset INTEGER,
  p_limit INTEGER
)
RETURNS TABLE (
  rank BIGINT,
  user_id INTEGER,
  address VARCHAR(42),
  total_points BIGINT,
  swap_volume NUMERIC
)
LANGUAGE sql
STABLE
AS $$
  WITH volume_totals AS (
    SELECT
      user_id,
      COALESCE(SUM(output_value_usd), 0)::NUMERIC(20,6) AS swap_volume
    FROM sweep_history
    WHERE type = 'swap'
      AND user_id IS NOT NULL
    GROUP BY user_id
  ),
  eligible_users AS (
    SELECT
      u.id,
      u.address,
      u.total_points
    FROM users u
    WHERE is_leaderboard_eligible_user(u.id, u.total_points)
  ),
  ranked AS (
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY
          COALESCE(volume_totals.swap_volume, 0) DESC,
          eligible_users.total_points DESC,
          eligible_users.id ASC
      )::BIGINT AS rank,
      eligible_users.id AS user_id,
      eligible_users.address,
      eligible_users.total_points::BIGINT AS total_points,
      COALESCE(volume_totals.swap_volume, 0)::NUMERIC(20,6) AS swap_volume
    FROM eligible_users
    LEFT JOIN volume_totals ON volume_totals.user_id = eligible_users.id
  )
  SELECT
    ranked.rank,
    ranked.user_id,
    ranked.address,
    ranked.total_points,
    ranked.swap_volume
  FROM ranked
  ORDER BY ranked.rank
  OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
$$;

CREATE OR REPLACE FUNCTION get_volume_leaderboard_viewer(p_user_id INTEGER)
RETURNS TABLE (
  rank BIGINT,
  user_id INTEGER,
  address VARCHAR(42),
  total_points BIGINT,
  swap_volume NUMERIC
)
LANGUAGE sql
STABLE
AS $$
  WITH volume_totals AS (
    SELECT
      user_id,
      COALESCE(SUM(output_value_usd), 0)::NUMERIC(20,6) AS swap_volume
    FROM sweep_history
    WHERE type = 'swap'
      AND user_id IS NOT NULL
    GROUP BY user_id
  ),
  eligible_users AS (
    SELECT
      u.id,
      u.address,
      u.total_points
    FROM users u
    WHERE is_leaderboard_eligible_user(u.id, u.total_points)
  ),
  ranked AS (
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY
          COALESCE(volume_totals.swap_volume, 0) DESC,
          eligible_users.total_points DESC,
          eligible_users.id ASC
      )::BIGINT AS rank,
      eligible_users.id AS user_id,
      eligible_users.address,
      eligible_users.total_points::BIGINT AS total_points,
      COALESCE(volume_totals.swap_volume, 0)::NUMERIC(20,6) AS swap_volume
    FROM eligible_users
    LEFT JOIN volume_totals ON volume_totals.user_id = eligible_users.id
  )
  SELECT
    ranked.rank,
    ranked.user_id,
    ranked.address,
    ranked.total_points,
    ranked.swap_volume
  FROM ranked
  WHERE ranked.user_id = p_user_id
  LIMIT 1;
$$;

INSERT INTO quests (
  slug,
  title,
  description,
  campaign_key,
  category,
  platform,
  action_type,
  verification_type,
  progress_window,
  reward_points,
  target_value,
  cta_label,
  cta_url,
  status,
  is_active,
  sort_order,
  rules
) VALUES
  (
    'swap-daily-10',
    'Swap $10 Today',
    'Swap at least $10 volume on DustSwap today.',
    'general',
    'onchain',
    'dustswap',
    'swap_volume',
    'swap_volume',
    'daily',
    100,
    10,
    'Open Swap',
    '/swap',
    'published',
    true,
    10,
    '{"source":"dustswap_swap"}'::jsonb
  ),
  (
    'swap-daily-100',
    'Swap $100 Today',
    'Push your daily volume past $100 on DustSwap.',
    'general',
    'onchain',
    'dustswap',
    'swap_volume',
    'swap_volume',
    'daily',
    300,
    100,
    'Open Swap',
    '/swap',
    'published',
    true,
    20,
    '{"source":"dustswap_swap"}'::jsonb
  ),
  (
    'swap-weekly-5000',
    'Weekly $5,000 Volume',
    'Accumulate $5,000 of swap volume this week.',
    'general',
    'onchain',
    'dustswap',
    'swap_volume',
    'swap_volume',
    'weekly',
    1500,
    5000,
    'Open Swap',
    '/swap',
    'published',
    true,
    30,
    '{"source":"dustswap_swap"}'::jsonb
  ),
  (
    'x-post-proof',
    'Post About DustSwap',
    'Add your X username, publish your post, and send the link for verification.',
    'general',
    'social',
    'x',
    'post',
    'x_post_link',
    'once',
    250,
    1,
    'Open Composer',
    'https://x.com/intent/tweet?text=Posting%20about%20%40dustswaponbase%20%23dustswaponbase',
    'published',
    true,
    40,
    '{"requiredAnyOf":["@dustswaponbase","#dustswaponbase","@akbarx402"],"composeText":"Posting about @dustswaponbase #dustswaponbase"}'::jsonb
  ),
  (
    'x-follow-soft',
    'Follow DustSwap on X',
    'Open the X profile, come back after 20 seconds, then verify.',
    'general',
    'social',
    'x',
    'follow',
    'delay_gate_retry',
    'once',
    60,
    1,
    'Open X Profile',
    'https://x.com/dustswap',
    'published',
    true,
    50,
    '{"delaySeconds":20,"fakeFailureCount":1,"externalUrl":"https://x.com/dustswap"}'::jsonb
  ),
  (
    'x-repost-soft',
    'Repost the Launch Post',
    'Open the post, repost it, then verify after 20 seconds.',
    'general',
    'social',
    'x',
    'repost',
    'delay_gate',
    'once',
    80,
    1,
    'Open X Post',
    'https://x.com/dustswap',
    'published',
    true,
    60,
    '{"delaySeconds":20,"externalUrl":"https://x.com/dustswap"}'::jsonb
  ),
  (
    'base-visit-soft',
    'Visit DustSwap on Base App',
    'Open the Base App page, come back after 20 seconds, then verify.',
    'general',
    'social',
    'base',
    'visit',
    'delay_gate',
    'once',
    40,
    1,
    'Open Base App',
    'https://base.app/',
    'published',
    true,
    70,
    '{"delaySeconds":20,"externalUrl":"https://base.app/"}'::jsonb
  ),
  (
    'cofounder-swap-100',
    'Swap $100 on DustSwap',
    'Complete at least $100 of swap volume on DustSwap to unlock your coFounder pass progress.',
    'cofounder_pass',
    'onchain',
    'dustswap',
    'swap_volume',
    'swap_volume',
    'once',
    200,
    100,
    'Open Swap',
    '/swap',
    'published',
    true,
    5,
    '{"source":"dustswap_swap"}'::jsonb
  ),
  (
    'cofounder-follow-founder',
    'Follow Akbar on X',
    'Open the founder profile, follow @akbarx402, come back after 20 seconds, then verify.',
    'cofounder_pass',
    'social',
    'x',
    'follow',
    'delay_gate_retry',
    'once',
    60,
    1,
    'Open Founder X',
    'https://x.com/akbarx402',
    'published',
    true,
    10,
    '{"delaySeconds":20,"fakeFailureCount":1,"externalUrl":"https://x.com/akbarx402"}'::jsonb
  ),
  (
    'cofounder-follow-dustswap',
    'Follow DustSwap on X',
    'Open the DustSwap profile, follow @dustswaponbase, come back after 20 seconds, then verify.',
    'cofounder_pass',
    'social',
    'x',
    'follow',
    'delay_gate_retry',
    'once',
    60,
    1,
    'Open DustSwap X',
    'https://x.com/dustswaponbase',
    'published',
    true,
    20,
    '{"delaySeconds":20,"fakeFailureCount":1,"externalUrl":"https://x.com/dustswaponbase"}'::jsonb
  ),
  (
    'cofounder-like-repost-launch',
    'Like + repost the launch announcement',
    'Open the launch announcement, like it, repost it, then verify after 20 seconds.',
    'cofounder_pass',
    'social',
    'x',
    'like',
    'delay_gate',
    'once',
    90,
    1,
    'Open Launch Post',
    'https://x.com/dustswaponbase',
    'published',
    true,
    30,
    '{"delaySeconds":20,"externalUrl":"https://x.com/dustswaponbase"}'::jsonb
  ),
  (
    'cofounder-reply-launch',
    'Reply on the launch announcement',
    'Open the launch announcement, reply to it, then verify after 20 seconds.',
    'cofounder_pass',
    'social',
    'x',
    'reply',
    'delay_gate',
    'once',
    90,
    1,
    'Open Launch Post',
    'https://x.com/dustswaponbase',
    'published',
    true,
    40,
    '{"delaySeconds":20,"externalUrl":"https://x.com/dustswaponbase"}'::jsonb
  ),
  (
    'cofounder-post-about-dustswap',
    'Post about DustSwap',
    'Post about DustSwap on X, mention DustSwap or Akbar, add #dustswaponbase, then paste the post link to verify.',
    'cofounder_pass',
    'social',
    'x',
    'post',
    'x_post_link',
    'once',
    150,
    1,
    'Open Composer',
    'https://x.com/intent/tweet?text=Posting%20about%20%40dustswaponbase%20%23dustswaponbase',
    'published',
    true,
    50,
    '{"requiredAnyOf":["@dustswaponbase","#dustswaponbase","@akbarx402"],"composeText":"Posting about @dustswaponbase #dustswaponbase"}'::jsonb
  )
ON CONFLICT (slug) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  campaign_key = EXCLUDED.campaign_key,
  category = EXCLUDED.category,
  platform = EXCLUDED.platform,
  action_type = EXCLUDED.action_type,
  verification_type = EXCLUDED.verification_type,
  progress_window = EXCLUDED.progress_window,
  reward_points = EXCLUDED.reward_points,
  target_value = EXCLUDED.target_value,
  cta_label = EXCLUDED.cta_label,
  cta_url = EXCLUDED.cta_url,
  status = EXCLUDED.status,
  is_active = EXCLUDED.is_active,
  sort_order = EXCLUDED.sort_order,
  rules = EXCLUDED.rules,
  updated_at = NOW();

-- =========================================================
-- Partner Program
-- =========================================================

CREATE TABLE IF NOT EXISTS partner_program_members (
  id                        BIGSERIAL PRIMARY KEY,
  user_id                   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_address            VARCHAR(42) NOT NULL UNIQUE,
  status                    TEXT NOT NULL DEFAULT 'whitelisted',
  whitelisted_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  joined_at                 TIMESTAMPTZ,
  current_fee_share_percent NUMERIC(5,2) NOT NULL DEFAULT 50,
  is_admin                  BOOLEAN NOT NULL DEFAULT false,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id),
  CONSTRAINT partner_program_members_status_check
    CHECK (status IN ('whitelisted', 'joined')),
  CONSTRAINT partner_program_members_fee_share_check
    CHECK (current_fee_share_percent >= 0 AND current_fee_share_percent <= 100)
);

CREATE TABLE IF NOT EXISTS partner_fee_share_history (
  id                BIGSERIAL PRIMARY KEY,
  partner_member_id BIGINT NOT NULL REFERENCES partner_program_members(id) ON DELETE CASCADE,
  fee_share_percent NUMERIC(5,2) NOT NULL,
  effective_at      TIMESTAMPTZ NOT NULL,
  ended_at          TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT partner_fee_share_history_fee_share_check
    CHECK (fee_share_percent >= 0 AND fee_share_percent <= 100),
  CONSTRAINT partner_fee_share_history_range_check
    CHECK (ended_at IS NULL OR ended_at > effective_at)
);

CREATE TABLE IF NOT EXISTS partner_reward_distributions (
  id                    BIGSERIAL PRIMARY KEY,
  partner_member_id     BIGINT NOT NULL REFERENCES partner_program_members(id) ON DELETE CASCADE,
  week_start_utc        DATE NOT NULL,
  week_end_utc          DATE NOT NULL,
  qualifying_volume_usd NUMERIC(20,6) NOT NULL DEFAULT 0,
  protocol_fee_usd      NUMERIC(20,6) NOT NULL DEFAULT 0,
  reward_usd            NUMERIC(20,6) NOT NULL DEFAULT 0,
  min_fee_share_percent NUMERIC(5,2),
  max_fee_share_percent NUMERIC(5,2),
  referred_users_total  BIGINT NOT NULL DEFAULT 0,
  traded_users_total    BIGINT NOT NULL DEFAULT 0,
  payout_usdc_amount    NUMERIC(20,6),
  payout_tx_hash        VARCHAR(66),
  paid_at               TIMESTAMPTZ,
  paid_notes            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(partner_member_id, week_start_utc),
  CONSTRAINT partner_reward_distributions_week_range_check
    CHECK (week_end_utc > week_start_utc)
);

CREATE INDEX IF NOT EXISTS idx_partner_program_members_status
  ON partner_program_members(status, joined_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_program_members_wallet
  ON partner_program_members(wallet_address);
CREATE INDEX IF NOT EXISTS idx_partner_fee_share_history_member_effective
  ON partner_fee_share_history(partner_member_id, effective_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_fee_share_history_open_interval
  ON partner_fee_share_history(partner_member_id)
  WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_partner_reward_distributions_member_week
  ON partner_reward_distributions(partner_member_id, week_start_utc DESC);
CREATE INDEX IF NOT EXISTS idx_partner_reward_distributions_paid_at
  ON partner_reward_distributions(paid_at DESC);

ALTER TABLE partner_program_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_fee_share_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_reward_distributions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_all_partner_program_members" ON partner_program_members;
DROP POLICY IF EXISTS "service_all_partner_fee_share_history" ON partner_fee_share_history;
DROP POLICY IF EXISTS "service_all_partner_reward_distributions" ON partner_reward_distributions;

CREATE POLICY "service_all_partner_program_members"
  ON partner_program_members FOR ALL USING (true);
CREATE POLICY "service_all_partner_fee_share_history"
  ON partner_fee_share_history FOR ALL USING (true);
CREATE POLICY "service_all_partner_reward_distributions"
  ON partner_reward_distributions FOR ALL USING (true);

CREATE OR REPLACE FUNCTION partner_program_current_week_start_utc(
  p_reference TIMESTAMPTZ DEFAULT NOW()
)
RETURNS DATE
LANGUAGE sql
STABLE
AS $$
  SELECT date_trunc('week', p_reference AT TIME ZONE 'UTC')::DATE;
$$;

CREATE OR REPLACE VIEW partner_program_referred_users AS
SELECT
  pm.id AS partner_member_id,
  pm.user_id AS partner_user_id,
  pm.wallet_address AS partner_wallet_address,
  pm.status AS partner_status,
  pm.whitelisted_at,
  pm.joined_at,
  pm.current_fee_share_percent,
  r.referee_id AS referee_user_id,
  referee.address AS referee_address,
  r.created_at AS referral_activated_at
FROM partner_program_members pm
JOIN referrals r
  ON r.referrer_id = pm.user_id
JOIN users referee
  ON referee.id = r.referee_id;

CREATE OR REPLACE VIEW partner_program_qualifying_swaps AS
SELECT
  referred.partner_member_id,
  referred.partner_user_id,
  referred.partner_wallet_address,
  referred.partner_status,
  referred.whitelisted_at,
  referred.joined_at,
  referred.referee_user_id,
  referred.referee_address,
  referred.referral_activated_at,
  fee_history.id AS fee_share_history_id,
  fee_history.fee_share_percent,
  GREATEST(
    referred.whitelisted_at,
    referred.referral_activated_at,
    fee_history.effective_at
  ) AS qualifying_from,
  swaps.id AS swap_transaction_id,
  swaps.tx_hash,
  swaps.chain_id,
  swaps.amount_usd,
  swaps.occurred_at,
  date_trunc('week', swaps.occurred_at AT TIME ZONE 'UTC')::DATE AS week_start_utc,
  (swaps.amount_usd * 0.002::NUMERIC) AS protocol_fee_usd,
  (
    swaps.amount_usd
    * 0.002::NUMERIC
    * (fee_history.fee_share_percent / 100::NUMERIC)
  ) AS reward_usd
FROM partner_program_referred_users referred
JOIN partner_fee_share_history fee_history
  ON fee_history.partner_member_id = referred.partner_member_id
JOIN swap_transactions swaps
  ON swaps.user_id = referred.referee_user_id
WHERE
  swaps.occurred_at >= GREATEST(
    referred.whitelisted_at,
    referred.referral_activated_at,
    fee_history.effective_at
  )
  AND (
    fee_history.ended_at IS NULL
    OR swaps.occurred_at < fee_history.ended_at
  );

CREATE OR REPLACE VIEW partner_program_member_referral_counts AS
SELECT
  pm.id AS partner_member_id,
  pm.user_id AS partner_user_id,
  pm.wallet_address AS partner_wallet_address,
  COUNT(referred.referee_user_id)::BIGINT AS referred_users_total
FROM partner_program_members pm
LEFT JOIN partner_program_referred_users referred
  ON referred.partner_member_id = pm.id
GROUP BY
  pm.id,
  pm.user_id,
  pm.wallet_address;

CREATE OR REPLACE VIEW partner_program_member_alltime_metrics AS
SELECT
  qualifying.partner_member_id,
  qualifying.partner_user_id,
  qualifying.partner_wallet_address,
  COUNT(DISTINCT qualifying.referee_user_id)::BIGINT AS traded_users_total,
  COUNT(DISTINCT qualifying.swap_transaction_id)::BIGINT AS swap_count_total,
  COALESCE(SUM(qualifying.amount_usd), 0)::NUMERIC(20,6) AS qualifying_volume_all_time_usd,
  COALESCE(SUM(qualifying.protocol_fee_usd), 0)::NUMERIC(20,6) AS protocol_fee_all_time_usd,
  COALESCE(SUM(qualifying.reward_usd), 0)::NUMERIC(20,6) AS reward_all_time_usd,
  MIN(qualifying.occurred_at) AS first_qualifying_trade_at,
  MAX(qualifying.occurred_at) AS last_qualifying_trade_at
FROM partner_program_qualifying_swaps qualifying
GROUP BY
  qualifying.partner_member_id,
  qualifying.partner_user_id,
  qualifying.partner_wallet_address;

CREATE OR REPLACE VIEW partner_program_member_weekly_metrics AS
SELECT
  qualifying.partner_member_id,
  qualifying.partner_user_id,
  qualifying.partner_wallet_address,
  qualifying.week_start_utc,
  COUNT(DISTINCT qualifying.referee_user_id)::BIGINT AS traded_users_total,
  COUNT(DISTINCT qualifying.swap_transaction_id)::BIGINT AS swap_count_total,
  COALESCE(SUM(qualifying.amount_usd), 0)::NUMERIC(20,6) AS qualifying_volume_usd,
  COALESCE(SUM(qualifying.protocol_fee_usd), 0)::NUMERIC(20,6) AS protocol_fee_usd,
  COALESCE(SUM(qualifying.reward_usd), 0)::NUMERIC(20,6) AS reward_usd,
  MIN(qualifying.fee_share_percent)::NUMERIC(5,2) AS min_fee_share_percent,
  MAX(qualifying.fee_share_percent)::NUMERIC(5,2) AS max_fee_share_percent,
  MIN(qualifying.occurred_at) AS first_trade_at,
  MAX(qualifying.occurred_at) AS last_trade_at
FROM partner_program_qualifying_swaps qualifying
GROUP BY
  qualifying.partner_member_id,
  qualifying.partner_user_id,
  qualifying.partner_wallet_address,
  qualifying.week_start_utc;

CREATE OR REPLACE VIEW partner_program_referred_user_alltime_metrics AS
SELECT
  qualifying.partner_member_id,
  qualifying.partner_user_id,
  qualifying.referee_user_id,
  qualifying.referee_address,
  MIN(qualifying.referral_activated_at) AS referral_activated_at,
  COUNT(DISTINCT qualifying.swap_transaction_id)::BIGINT AS swap_count_total,
  COALESCE(SUM(qualifying.amount_usd), 0)::NUMERIC(20,6) AS qualifying_volume_all_time_usd,
  COALESCE(SUM(qualifying.reward_usd), 0)::NUMERIC(20,6) AS reward_all_time_usd,
  MIN(qualifying.occurred_at) AS first_qualifying_trade_at,
  MAX(qualifying.occurred_at) AS last_qualifying_trade_at
FROM partner_program_qualifying_swaps qualifying
GROUP BY
  qualifying.partner_member_id,
  qualifying.partner_user_id,
  qualifying.referee_user_id,
  qualifying.referee_address;

CREATE OR REPLACE VIEW partner_program_referred_user_weekly_metrics AS
SELECT
  qualifying.partner_member_id,
  qualifying.partner_user_id,
  qualifying.referee_user_id,
  qualifying.referee_address,
  qualifying.week_start_utc,
  COUNT(DISTINCT qualifying.swap_transaction_id)::BIGINT AS swap_count_total,
  COALESCE(SUM(qualifying.amount_usd), 0)::NUMERIC(20,6) AS qualifying_volume_usd,
  COALESCE(SUM(qualifying.reward_usd), 0)::NUMERIC(20,6) AS reward_usd,
  MIN(qualifying.fee_share_percent)::NUMERIC(5,2) AS min_fee_share_percent,
  MAX(qualifying.fee_share_percent)::NUMERIC(5,2) AS max_fee_share_percent,
  MIN(qualifying.occurred_at) AS first_trade_at,
  MAX(qualifying.occurred_at) AS last_trade_at
FROM partner_program_qualifying_swaps qualifying
GROUP BY
  qualifying.partner_member_id,
  qualifying.partner_user_id,
  qualifying.referee_user_id,
  qualifying.referee_address,
  qualifying.week_start_utc;
