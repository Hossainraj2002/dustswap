-- Partner program tables, views, and helper functions.
-- Run this after schema.sql and swap_volume_schema.sql.

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

CREATE TABLE IF NOT EXISTS partner_content_submissions (
  id                BIGSERIAL PRIMARY KEY,
  partner_member_id BIGINT NOT NULL REFERENCES partner_program_members(id) ON DELETE CASCADE,
  partner_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_url       TEXT NOT NULL,
  normalized_url    TEXT NOT NULL,
  platform          TEXT NOT NULL DEFAULT 'other',
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT partner_content_submissions_platform_check
    CHECK (platform IN ('x', 'telegram', 'other'))
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
CREATE INDEX IF NOT EXISTS idx_partner_content_submissions_member_submitted
  ON partner_content_submissions(partner_member_id, submitted_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_content_submissions_member_url
  ON partner_content_submissions(partner_member_id, normalized_url);

ALTER TABLE partner_program_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_fee_share_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_reward_distributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_content_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_all_partner_program_members" ON partner_program_members;
DROP POLICY IF EXISTS "service_all_partner_fee_share_history" ON partner_fee_share_history;
DROP POLICY IF EXISTS "service_all_partner_reward_distributions" ON partner_reward_distributions;
DROP POLICY IF EXISTS "service_all_partner_content_submissions" ON partner_content_submissions;

CREATE POLICY "service_all_partner_program_members"
  ON partner_program_members FOR ALL USING (true);
CREATE POLICY "service_all_partner_fee_share_history"
  ON partner_fee_share_history FOR ALL USING (true);
CREATE POLICY "service_all_partner_reward_distributions"
  ON partner_reward_distributions FOR ALL USING (true);
CREATE POLICY "service_all_partner_content_submissions"
  ON partner_content_submissions FOR ALL USING (true);

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
  swap_values.amount_usd,
  swaps.occurred_at,
  date_trunc('week', swaps.occurred_at AT TIME ZONE 'UTC')::DATE AS week_start_utc,
  swap_values.protocol_fee_usd,
  (
    swap_values.protocol_fee_usd
    * (fee_history.fee_share_percent / 100::NUMERIC)
  ) AS reward_usd
FROM partner_program_referred_users referred
JOIN partner_fee_share_history fee_history
  ON fee_history.partner_member_id = referred.partner_member_id
JOIN swap_transactions swaps
  ON swaps.user_id = referred.referee_user_id
CROSS JOIN LATERAL (
  SELECT
    CASE
      WHEN swaps.amount_usd IS NULL OR swaps.amount_usd < 0::NUMERIC THEN 0::NUMERIC
      WHEN swaps.amount_usd > 1000::NUMERIC
        AND NOT swap_volume_is_trusted_anchor(swaps.chain_id, swaps.src_token_address)
        AND NOT swap_volume_is_trusted_anchor(swaps.chain_id, swaps.dst_token_address)
        THEN 0::NUMERIC
      ELSE swaps.amount_usd
    END::NUMERIC(20,6) AS amount_usd
) safe_swap
CROSS JOIN LATERAL (
  SELECT
    safe_swap.amount_usd,
    safe_swap.amount_usd * 0.002::NUMERIC AS protocol_fee_usd
) swap_values
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
