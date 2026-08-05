-- ============================================================================
-- DustSweep "Sweep $500 → Earn $10" rewards campaign
-- Run against the API database (see apps/api/src/scripts/runMigration.ts).
-- Idempotent: safe to run more than once.
--
-- Design notes:
-- * All money is stored as integer micro-USD / micro-USDC (6 decimals) so the
--   tier math never touches floats.
-- * sweep_campaign_credits rows start as 'pending' and only count after the
--   verifier has re-derived the value from the on-chain DustSwept /
--   DustSweepExecuted event. Client-reported values are never stored here.
-- * Tier progress and claims key on users.id (the merged account), so linked
--   wallets share a single $500 track.
-- ============================================================================

-- 1. Campaign config ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS sweep_campaigns (
  id                       SERIAL PRIMARY KEY,
  slug                     TEXT NOT NULL UNIQUE,
  name                     TEXT NOT NULL,
  chain_id                 INTEGER NOT NULL DEFAULT 8453,
  starts_at                TIMESTAMPTZ NOT NULL,
  ends_at                  TIMESTAMPTZ NOT NULL,
  -- [{"tier":1,"thresholdUsdMicro":100000000,"rewardUsdcMicro":1000000}, ...]
  tier_config              JSONB NOT NULL,
  -- [{"rankFrom":1,"rankTo":1,"prizeUsdcMicro":500000000,"prizePp":5000000}, ...]
  leaderboard_prizes       JSONB NOT NULL,
  volume_cap_usd_micro     BIGINT NOT NULL DEFAULT 500000000,
  per_sweep_cap_usd_micro  BIGINT NOT NULL DEFAULT 1000000000,
  is_active                BOOLEAN NOT NULL DEFAULT TRUE,
  finalized_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Verified per-sweep credits ---------------------------------------------
CREATE TABLE IF NOT EXISTS sweep_campaign_credits (
  id                BIGSERIAL PRIMARY KEY,
  campaign_id       INTEGER NOT NULL REFERENCES sweep_campaigns(id),
  chain_id          INTEGER NOT NULL DEFAULT 8453,
  -- Hash the client submitted; may be an ERC-4337 userOp hash.
  tx_hash           TEXT NOT NULL,
  -- Canonical on-chain tx hash after userOp resolution.
  resolved_tx_hash  TEXT,
  wallet_address    TEXT NOT NULL,
  user_id           INTEGER REFERENCES users(id),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'verified', 'rejected')),
  reject_reason     TEXT,
  output_token      TEXT,
  gross_amount_out  NUMERIC,
  fee_amount        NUMERIC,
  value_usd_micro   BIGINT NOT NULL DEFAULT 0,
  fee_usd_micro     BIGINT NOT NULL DEFAULT 0,
  -- TRUE when the per-sweep sanity cap clamped the value (admin review).
  flagged           BOOLEAN NOT NULL DEFAULT FALSE,
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_retry_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  swept_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, chain_id, tx_hash)
);

-- The same execution must not credit twice via userOp hash + tx hash.
CREATE UNIQUE INDEX IF NOT EXISTS idx_scc_resolved_tx
  ON sweep_campaign_credits (campaign_id, chain_id, resolved_tx_hash)
  WHERE resolved_tx_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scc_pending
  ON sweep_campaign_credits (status, next_retry_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_scc_user_verified
  ON sweep_campaign_credits (campaign_id, user_id)
  WHERE status = 'verified';

-- 3. Tier + prize claims -----------------------------------------------------
CREATE TABLE IF NOT EXISTS sweep_campaign_claims (
  id                    BIGSERIAL PRIMARY KEY,
  campaign_id           INTEGER NOT NULL REFERENCES sweep_campaigns(id),
  user_id               INTEGER NOT NULL REFERENCES users(id),
  kind                  TEXT NOT NULL DEFAULT 'tier'
                        CHECK (kind IN ('tier', 'prize')),
  -- Tier number 1-5 for kind='tier'; final leaderboard rank for kind='prize'.
  tier                  INTEGER NOT NULL,
  amount_usdc_micro     BIGINT NOT NULL CHECK (amount_usdc_micro > 0),
  recipient_address     TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending_payout'
                        CHECK (status IN ('pending_approval', 'pending_payout', 'sending', 'paid', 'failed')),
  claim_signature_hash  TEXT UNIQUE,
  -- Stored BEFORE broadcast so a crash between send and DB write can never
  -- double-pay: on recovery the worker checks this hash's receipt first, and
  -- only requeues once the account nonce has provably moved past the attempt.
  payout_attempt_tx_hash TEXT,
  payout_attempt_nonce  INTEGER,
  payout_tx_hash        TEXT,
  payout_attempts       INTEGER NOT NULL DEFAULT 0,
  payout_error          TEXT,
  approved_at           TIMESTAMPTZ,
  paid_at               TIMESTAMPTZ,
  paid_notes            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, user_id, kind, tier)
);

CREATE INDEX IF NOT EXISTS idx_scclaims_status
  ON sweep_campaign_claims (campaign_id, status);

-- 4. Leaderboard RPCs --------------------------------------------------------
-- Ordering: volume DESC, earliest first-verified-sweep wins ties, then user_id
-- for full determinism. Both functions must sort identically.

CREATE OR REPLACE FUNCTION get_sweep_campaign_leaderboard_page(
  p_campaign_id INTEGER,
  p_limit INTEGER,
  p_offset INTEGER
)
RETURNS TABLE (
  rank BIGINT,
  user_id INTEGER,
  wallet_address TEXT,
  volume_usd_micro BIGINT,
  sweep_count BIGINT
)
LANGUAGE sql
STABLE
AS $$
  WITH totals AS (
    SELECT
      c.user_id,
      SUM(c.value_usd_micro)::BIGINT AS volume_usd_micro,
      COUNT(*)::BIGINT AS sweep_count,
      MIN(c.verified_at) AS first_verified_at
    FROM sweep_campaign_credits c
    JOIN sweep_campaigns camp ON camp.id = c.campaign_id
    WHERE c.campaign_id = p_campaign_id
      AND c.status = 'verified'
      AND c.user_id IS NOT NULL
      -- Defense in depth: the verifier already rejects out-of-window sweeps by
      -- block timestamp, but never let a stray row age into the totals.
      AND c.swept_at >= camp.starts_at
      AND c.swept_at <= camp.ends_at
    GROUP BY c.user_id
  ),
  ranked AS (
    SELECT
      t.user_id,
      t.volume_usd_micro,
      t.sweep_count,
      ROW_NUMBER() OVER (
        ORDER BY t.volume_usd_micro DESC, t.first_verified_at ASC, t.user_id ASC
      ) AS rank
    FROM totals t
  )
  SELECT
    r.rank,
    r.user_id,
    u.address AS wallet_address,
    r.volume_usd_micro,
    r.sweep_count
  FROM ranked r
  JOIN users u ON u.id = r.user_id
  ORDER BY r.rank
  LIMIT GREATEST(p_limit, 0)
  OFFSET GREATEST(p_offset, 0);
$$;

CREATE OR REPLACE FUNCTION get_sweep_campaign_leaderboard_viewer(
  p_campaign_id INTEGER,
  p_user_id INTEGER
)
RETURNS TABLE (
  rank BIGINT,
  volume_usd_micro BIGINT,
  sweep_count BIGINT
)
LANGUAGE sql
STABLE
AS $$
  WITH totals AS (
    SELECT
      c.user_id,
      SUM(c.value_usd_micro)::BIGINT AS volume_usd_micro,
      COUNT(*)::BIGINT AS sweep_count,
      MIN(c.verified_at) AS first_verified_at
    FROM sweep_campaign_credits c
    JOIN sweep_campaigns camp ON camp.id = c.campaign_id
    WHERE c.campaign_id = p_campaign_id
      AND c.status = 'verified'
      AND c.user_id IS NOT NULL
      -- Defense in depth: the verifier already rejects out-of-window sweeps by
      -- block timestamp, but never let a stray row age into the totals.
      AND c.swept_at >= camp.starts_at
      AND c.swept_at <= camp.ends_at
    GROUP BY c.user_id
  ),
  ranked AS (
    SELECT
      t.user_id,
      t.volume_usd_micro,
      t.sweep_count,
      ROW_NUMBER() OVER (
        ORDER BY t.volume_usd_micro DESC, t.first_verified_at ASC, t.user_id ASC
      ) AS rank
    FROM totals t
  )
  SELECT r.rank, r.volume_usd_micro, r.sweep_count
  FROM ranked r
  WHERE r.user_id = p_user_id;
$$;

-- 5. Seed the v1 campaign ----------------------------------------------------
-- Dates are placeholders: UPDATE starts_at / ends_at before the real launch.
INSERT INTO sweep_campaigns (
  slug,
  name,
  chain_id,
  starts_at,
  ends_at,
  tier_config,
  leaderboard_prizes,
  volume_cap_usd_micro,
  per_sweep_cap_usd_micro,
  is_active
)
VALUES (
  'sweep500-aug2026',
  'Sweep $500, earn $10 USDC',
  8453,
  '2026-08-10T00:00:00Z',
  '2026-08-24T00:00:00Z',
  '[
    {"tier":1,"thresholdUsdMicro":100000000,"rewardUsdcMicro":1000000},
    {"tier":2,"thresholdUsdMicro":200000000,"rewardUsdcMicro":1000000},
    {"tier":3,"thresholdUsdMicro":300000000,"rewardUsdcMicro":1000000},
    {"tier":4,"thresholdUsdMicro":400000000,"rewardUsdcMicro":1000000},
    {"tier":5,"thresholdUsdMicro":500000000,"rewardUsdcMicro":6000000}
  ]'::jsonb,
  '[
    {"rankFrom":1,"rankTo":1,"prizeUsdcMicro":500000000,"prizePp":5000000},
    {"rankFrom":2,"rankTo":2,"prizeUsdcMicro":100000000,"prizePp":3000000},
    {"rankFrom":3,"rankTo":3,"prizeUsdcMicro":50000000,"prizePp":2000000},
    {"rankFrom":4,"rankTo":4,"prizeUsdcMicro":50000000,"prizePp":1000000},
    {"rankFrom":5,"rankTo":5,"prizeUsdcMicro":50000000,"prizePp":1000000},
    {"rankFrom":6,"rankTo":50,"prizeUsdcMicro":5000000,"prizePp":500000}
  ]'::jsonb,
  500000000,
  1000000000,
  TRUE
)
ON CONFLICT (slug) DO NOTHING;

-- ============================================================================
-- LAUNCH: set the real start date. The campaign runs for exactly 2 weeks, so
-- ends_at is derived rather than typed by hand. Replace the timestamp below
-- with the moment the campaign should open (UTC), then run this one statement.
--
--   UPDATE sweep_campaigns
--   SET starts_at = TIMESTAMPTZ '2026-08-10 00:00:00+00',
--       ends_at   = TIMESTAMPTZ '2026-08-10 00:00:00+00' + INTERVAL '14 days'
--   WHERE slug = 'sweep500-aug2026';
--
-- Nothing accrues before starts_at: eligibility is decided by the block
-- timestamp of each sweep, so moving this date can never retroactively credit
-- older sweeps.
--
-- AFTER THE CAMPAIGN ENDS, pay the leaderboard in one batch:
--   1. POST /api/dustsweep/campaign/admin/finalize   (snapshots top 50, awards PP,
--                                                     creates USDC prize claims)
--   2. GET  /api/dustsweep/campaign/admin/claims?status=pending_approval
--   3. POST /api/dustsweep/campaign/admin/claims/approve  { "claimIds": [...] }
-- All three require the x-admin-token header.
-- ============================================================================
