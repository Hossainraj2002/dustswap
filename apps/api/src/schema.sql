-- DustSweep Database Schema
-- Run this in Supabase SQL Editor (supabase.com → SQL Editor → New query)

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
  created_at     TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, check_in_date)
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

-- Enable Row Level Security
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE point_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE check_ins      ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sweep_history  ENABLE ROW LEVEL SECURITY;

-- Allow service-role access (backend uses service key)
CREATE POLICY "service_all_users"         ON users          FOR ALL USING (true);
CREATE POLICY "service_all_events"        ON point_events   FOR ALL USING (true);
CREATE POLICY "service_all_checkins"      ON check_ins      FOR ALL USING (true);
CREATE POLICY "service_all_referrals"     ON referrals      FOR ALL USING (true);
CREATE POLICY "service_all_history"       ON sweep_history  FOR ALL USING (true);
