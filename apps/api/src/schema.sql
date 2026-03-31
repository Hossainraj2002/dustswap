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
  current_streak INTEGER DEFAULT 0,
  longest_streak INTEGER DEFAULT 0,
  last_check_in  TIMESTAMP,
  created_at     TIMESTAMP DEFAULT NOW(),
  updated_at     TIMESTAMP DEFAULT NOW()
);

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
CREATE INDEX IF NOT EXISTS idx_users_points   ON users(total_points DESC);
CREATE INDEX IF NOT EXISTS idx_users_refcode  ON users(referral_code);
CREATE INDEX IF NOT EXISTS idx_history_user   ON sweep_history(user_id);
CREATE INDEX IF NOT EXISTS idx_recovery_user  ON streak_recovery_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_daily_asset_prices_symbol_date ON daily_asset_prices(asset_symbol, price_date DESC);

-- Enable Row Level Security
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE point_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE check_ins      ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_asset_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE streak_recovery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sweep_history  ENABLE ROW LEVEL SECURITY;

-- Allow service-role access (backend uses service key)
DROP POLICY IF EXISTS "service_all_users"      ON users;
DROP POLICY IF EXISTS "service_all_events"     ON point_events;
DROP POLICY IF EXISTS "service_all_checkins"   ON check_ins;
DROP POLICY IF EXISTS "service_all_daily_prices" ON daily_asset_prices;
DROP POLICY IF EXISTS "service_all_recoveries" ON streak_recovery_events;
DROP POLICY IF EXISTS "service_all_referrals"  ON referrals;
DROP POLICY IF EXISTS "service_all_history"    ON sweep_history;
CREATE POLICY "service_all_users"         ON users          FOR ALL USING (true);
CREATE POLICY "service_all_events"        ON point_events   FOR ALL USING (true);
CREATE POLICY "service_all_checkins"      ON check_ins      FOR ALL USING (true);
CREATE POLICY "service_all_daily_prices"  ON daily_asset_prices FOR ALL USING (true);
CREATE POLICY "service_all_recoveries"    ON streak_recovery_events FOR ALL USING (true);
CREATE POLICY "service_all_referrals"     ON referrals      FOR ALL USING (true);
CREATE POLICY "service_all_history"       ON sweep_history  FOR ALL USING (true);

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
  UNIQUE(tx_hash, event_type, source)
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
CREATE INDEX IF NOT EXISTS idx_quest_progress_user    ON quest_progress(user_id, quest_id, cycle_key);
CREATE INDEX IF NOT EXISTS idx_quest_logs_user        ON quest_verification_logs(user_id, quest_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_user   ON activity_events(user_id, event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_whitelist_campaign ON quest_campaign_whitelist(campaign_key, created_at DESC);

ALTER TABLE quests                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_accounts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest_progress           ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest_verification_logs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest_campaign_whitelist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_all_quests"           ON quests;
DROP POLICY IF EXISTS "service_all_social_accounts"  ON social_accounts;
DROP POLICY IF EXISTS "service_all_quest_progress"   ON quest_progress;
DROP POLICY IF EXISTS "service_all_quest_logs"       ON quest_verification_logs;
DROP POLICY IF EXISTS "service_all_activity_events"  ON activity_events;
DROP POLICY IF EXISTS "service_all_campaign_whitelist" ON quest_campaign_whitelist;
CREATE POLICY "service_all_quests"          ON quests                  FOR ALL USING (true);
CREATE POLICY "service_all_social_accounts" ON social_accounts         FOR ALL USING (true);
CREATE POLICY "service_all_quest_progress"  ON quest_progress          FOR ALL USING (true);
CREATE POLICY "service_all_quest_logs"      ON quest_verification_logs FOR ALL USING (true);
CREATE POLICY "service_all_activity_events" ON activity_events         FOR ALL USING (true);
CREATE POLICY "service_all_campaign_whitelist" ON quest_campaign_whitelist FOR ALL USING (true);

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
    '{"requiredMentionsAny":["@dustswaponbase","@akbarx402"],"requiredHashtags":["#dustswaponbase"],"composeText":"Posting about @dustswaponbase #dustswaponbase"}'::jsonb
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
    '{"requiredMentionsAny":["@dustswaponbase","@akbarx402"],"requiredHashtags":["#dustswaponbase"],"composeText":"Posting about @dustswaponbase #dustswaponbase"}'::jsonb
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
