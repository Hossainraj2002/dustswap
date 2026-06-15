-- =========================================================
-- Wallet Linking / Account Merge
-- =========================================================
-- Lets a user link two wallets (usually an EOA + a Base Account) so they share
-- ONE DustSwap account. Account-level rewards (PP, streak, socials, profile,
-- leaderboard, referrals) are shared; wallet-level rewards (spin tickets,
-- onchain quest progress) stay per-wallet.
--
-- This file is additive and idempotent. It is mirrored at the end of
-- apps/api/src/schema.sql (the canonical applied schema). Run standalone in the
-- Supabase SQL editor for manual migrations.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------
-- Tables
-- ---------------------------------------------------------

-- Source of truth for wallet -> account. Every account has exactly one primary
-- wallet whose address equals users.address (kept denormalized for display).
CREATE TABLE IF NOT EXISTS user_wallets (
  id             BIGSERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_address VARCHAR(42) NOT NULL,            -- stored lowercase
  wallet_type    TEXT NOT NULL DEFAULT 'unknown', -- 'eoa' | 'base_account' | 'unknown'
  is_primary     BOOLEAN NOT NULL DEFAULT false,
  linked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(wallet_address)
);
CREATE INDEX IF NOT EXISTS idx_user_wallets_user ON user_wallets(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_wallets_one_primary
  ON user_wallets(user_id) WHERE is_primary;

-- One-time, 30-minute link tokens. Only token_hash is stored; the raw token is
-- only ever returned in the create response and carried in the link URL.
CREATE TABLE IF NOT EXISTS wallet_link_requests (
  id                  BIGSERIAL PRIMARY KEY,
  token_hash          TEXT NOT NULL UNIQUE,
  source_user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_wallet       VARCHAR(42) NOT NULL,
  target_wallet       VARCHAR(42),
  status              TEXT NOT NULL DEFAULT 'pending', -- pending|consumed|expired|cancelled
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL,
  consumed_at         TIMESTAMPTZ,
  consumed_by_user_id INTEGER REFERENCES users(id),
  merge_id            BIGINT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_wallet_link_requests_source ON wallet_link_requests(source_user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_link_requests_expires ON wallet_link_requests(expires_at);

-- Per-wallet spin ticket balances. Keyed by wallet so a balance survives merge
-- and unlink. user_id points at the wallet's current owning account.
CREATE TABLE IF NOT EXISTS wallet_spin_balances (
  id             BIGSERIAL PRIMARY KEY,
  wallet_address VARCHAR(42) NOT NULL UNIQUE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spin_tickets   INTEGER NOT NULL DEFAULT 0 CHECK (spin_tickets >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wallet_spin_balances_user ON wallet_spin_balances(user_id);

-- Audit trail for merges (also enforces the lifetime once-per-wallet link bonus).
CREATE TABLE IF NOT EXISTS account_merges (
  id                 BIGSERIAL PRIMARY KEY,
  primary_user_id    INTEGER NOT NULL REFERENCES users(id),
  secondary_user_id  INTEGER,
  secondary_wallet   VARCHAR(42) NOT NULL,
  link_request_id    BIGINT REFERENCES wallet_link_requests(id),
  status             TEXT NOT NULL DEFAULT 'completed', -- completed|reversed
  link_bonus_awarded BOOLEAN NOT NULL DEFAULT false,
  link_bonus_pp      INTEGER NOT NULL DEFAULT 0,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reversed_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_account_merges_primary ON account_merges(primary_user_id);
CREATE INDEX IF NOT EXISTS idx_account_merges_secondary_wallet ON account_merges(secondary_wallet);

-- Audit trail for unlinks.
CREATE TABLE IF NOT EXISTS wallet_unlinks (
  id               BIGSERIAL PRIMARY KEY,
  from_user_id     INTEGER NOT NULL REFERENCES users(id),
  detached_wallet  VARCHAR(42) NOT NULL,
  new_user_id      INTEGER REFERENCES users(id),
  related_merge_id BIGINT REFERENCES account_merges(id),
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------
-- Column / constraint changes on existing tables
-- ---------------------------------------------------------

-- Soft-tombstone for merged-away accounts (leaderboards filter merged_into IS NULL).
ALTER TABLE users ADD COLUMN IF NOT EXISTS merged_into INTEGER REFERENCES users(id);

-- Per-wallet onchain quest progress. NULL wallet_address = account-level (social)
-- progress; non-NULL = per-wallet (onchain) progress. (Additive: safe with old code.)
ALTER TABLE quest_progress ADD COLUMN IF NOT EXISTS wallet_address VARCHAR(42);

-- NOTE: the quest_progress unique-constraint SWAP (drop the old full unique,
-- add the two partial unique indexes) lives in wallet_merge_constraints.sql.
-- It is intentionally NOT here because dropping the old unique breaks code that
-- does ON CONFLICT (user_id, quest_id, cycle_key). Apply wallet_merge_constraints.sql
-- only once the new application code is deployed (and before enabling linking).

-- Stamp which wallet performed a spin.
ALTER TABLE spin_history ADD COLUMN IF NOT EXISTS wallet_address VARCHAR(42);

-- ---------------------------------------------------------
-- Backfill (idempotent): one wallet + spin balance row per existing user.
-- ---------------------------------------------------------
INSERT INTO user_wallets (user_id, wallet_address, wallet_type, is_primary, linked_at)
SELECT id, address, 'unknown', true, COALESCE(created_at, NOW())
FROM users
WHERE merged_into IS NULL
ON CONFLICT (wallet_address) DO NOTHING;

INSERT INTO wallet_spin_balances (wallet_address, user_id, spin_tickets)
SELECT address, id, COALESCE(spin_tickets, 0)
FROM users
WHERE merged_into IS NULL
ON CONFLICT (wallet_address) DO NOTHING;

-- Stamp existing ONCHAIN quest progress with the owner's wallet so per-wallet
-- reads keep finding it (pre-link, user_id maps 1:1 to a wallet). Social quest
-- progress stays account-level (wallet_address NULL).
UPDATE quest_progress qp
SET wallet_address = u.address
FROM quests q, users u
WHERE qp.quest_id = q.id
  AND q.category = 'onchain'
  AND qp.user_id = u.id
  AND qp.wallet_address IS NULL;

-- ---------------------------------------------------------
-- Functions
-- ---------------------------------------------------------

-- Resolve a wallet (lowercased) to its owning users row via user_wallets.
CREATE OR REPLACE FUNCTION resolve_user_by_wallet(p_wallet TEXT)
RETURNS SETOF users
LANGUAGE sql
STABLE
AS $$
  SELECT u.*
  FROM user_wallets w
  JOIN users u ON u.id = w.user_id
  WHERE w.wallet_address = LOWER(p_wallet)
  LIMIT 1;
$$;

-- Per-wallet spin ticket adjustment (mirrors adjust_spin_tickets). Upserts the
-- balance row, enforces a non-negative balance, returns the new balance.
CREATE OR REPLACE FUNCTION adjust_wallet_spin_tickets(
  p_wallet VARCHAR,
  p_user_id INTEGER,
  p_delta INTEGER
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_next_tickets INTEGER;
BEGIN
  INSERT INTO wallet_spin_balances (wallet_address, user_id, spin_tickets)
  VALUES (LOWER(p_wallet), p_user_id, 0)
  ON CONFLICT (wallet_address) DO NOTHING;

  UPDATE wallet_spin_balances
  SET
    spin_tickets = spin_tickets + p_delta,
    user_id = p_user_id,
    updated_at = NOW()
  WHERE
    wallet_address = LOWER(p_wallet)
    AND spin_tickets + p_delta >= 0
  RETURNING spin_tickets INTO v_next_tickets;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'insufficient_spin_tickets';
  END IF;

  RETURN v_next_tickets;
END;
$$;

-- Per-wallet onchain quest progress upsert (targets the partial unique index).
CREATE OR REPLACE FUNCTION upsert_wallet_quest_progress(
  p_quest_id UUID,
  p_user_id INTEGER,
  p_wallet VARCHAR,
  p_cycle_key TEXT,
  p_status TEXT,
  p_progress DECIMAL,
  p_target_value DECIMAL,
  p_completed_at TIMESTAMPTZ,
  p_metadata JSONB
) RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_id BIGINT;
BEGIN
  INSERT INTO quest_progress (
    quest_id, user_id, wallet_address, cycle_key, status,
    progress, target_value, completed_at, metadata, updated_at
  )
  VALUES (
    p_quest_id, p_user_id, LOWER(p_wallet), p_cycle_key, p_status,
    p_progress, p_target_value, p_completed_at, COALESCE(p_metadata, '{}'::jsonb), NOW()
  )
  ON CONFLICT (wallet_address, quest_id, cycle_key) WHERE wallet_address IS NOT NULL
  DO UPDATE SET
    user_id = EXCLUDED.user_id,
    status = EXCLUDED.status,
    progress = EXCLUDED.progress,
    target_value = EXCLUDED.target_value,
    completed_at = COALESCE(quest_progress.completed_at, EXCLUDED.completed_at),
    metadata = EXCLUDED.metadata,
    updated_at = NOW()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Atomically merge a secondary account into a primary account. Idempotent: a
-- second call for an already-merged secondary wallet is a no-op that returns the
-- existing account_merges id. Awards a one-time link bonus (p_bonus_pp) the first
-- time a given secondary wallet is ever linked.
CREATE OR REPLACE FUNCTION merge_accounts(
  p_primary_user_id INTEGER,
  p_secondary_user_id INTEGER,
  p_secondary_wallet VARCHAR,
  p_link_request_id BIGINT,
  p_bonus_pp INTEGER
) RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_wallet           VARCHAR := LOWER(p_secondary_wallet);
  v_merge_id         BIGINT;
  v_existing_merge   BIGINT;
  v_bonus_already    BOOLEAN;
  v_award_bonus      BOOLEAN := false;
  v_sec_points       BIGINT;
  v_sec_streak       INTEGER;
  v_sec_longest      INTEGER;
  v_sec_last_checkin TIMESTAMP;
  v_sec_referral     VARCHAR;
  v_sec_referred_by  INTEGER;
  v_payload          JSONB := '{}'::jsonb;
BEGIN
  IF p_primary_user_id = p_secondary_user_id THEN
    RAISE EXCEPTION 'cannot_merge_same_account';
  END IF;

  -- Idempotency: already merged this wallet?
  SELECT id INTO v_existing_merge
  FROM account_merges
  WHERE secondary_wallet = v_wallet AND status = 'completed'
  ORDER BY id DESC
  LIMIT 1;
  IF v_existing_merge IS NOT NULL THEN
    RETURN v_existing_merge;
  END IF;

  -- Lock both accounts in a deterministic order to avoid deadlocks.
  PERFORM 1 FROM users WHERE id IN (p_primary_user_id, p_secondary_user_id)
  ORDER BY id FOR UPDATE;

  -- Snapshot secondary scalars (for the audit payload + the merge math).
  SELECT total_points, current_streak, longest_streak, last_check_in, referral_code, referred_by
  INTO v_sec_points, v_sec_streak, v_sec_longest, v_sec_last_checkin, v_sec_referral, v_sec_referred_by
  FROM users WHERE id = p_secondary_user_id;

  -- --- users scalars: sum PP, take best streaks, keep primary identity ---
  UPDATE users p SET
    total_points   = COALESCE(p.total_points, 0) + COALESCE(v_sec_points, 0),
    current_streak = GREATEST(COALESCE(p.current_streak, 0), COALESCE(v_sec_streak, 0)),
    longest_streak = GREATEST(COALESCE(p.longest_streak, 0), COALESCE(v_sec_longest, 0)),
    last_check_in  = GREATEST(p.last_check_in, v_sec_last_checkin),
    updated_at     = NOW()
  WHERE p.id = p_primary_user_id;

  -- --- plain re-points (no per-user unique conflict) ---
  UPDATE point_events            SET user_id = p_primary_user_id WHERE user_id = p_secondary_user_id;
  UPDATE streak_recovery_events  SET user_id = p_primary_user_id WHERE user_id = p_secondary_user_id;
  UPDATE sweep_history           SET user_id = p_primary_user_id WHERE user_id = p_secondary_user_id;
  UPDATE swap_transactions       SET user_id = p_primary_user_id WHERE user_id = p_secondary_user_id;
  UPDATE activity_events         SET user_id = p_primary_user_id WHERE user_id = p_secondary_user_id;
  UPDATE oauth_states            SET user_id = p_primary_user_id WHERE user_id = p_secondary_user_id;
  UPDATE quest_verification_logs SET user_id = p_primary_user_id WHERE user_id = p_secondary_user_id;
  UPDATE partner_content_submissions SET partner_user_id = p_primary_user_id WHERE partner_user_id = p_secondary_user_id;

  -- spin_history: re-point + stamp the secondary wallet on un-stamped rows.
  UPDATE spin_history SET
    user_id = p_primary_user_id,
    wallet_address = COALESCE(wallet_address, v_wallet)
  WHERE user_id = p_secondary_user_id;

  -- --- conflict tables: move non-conflicting rows, drop the rest (primary wins) ---

  -- check_ins UNIQUE(user_id, check_in_date)
  UPDATE check_ins s SET user_id = p_primary_user_id
  WHERE s.user_id = p_secondary_user_id
    AND NOT EXISTS (SELECT 1 FROM check_ins p WHERE p.user_id = p_primary_user_id AND p.check_in_date = s.check_in_date);
  DELETE FROM check_ins WHERE user_id = p_secondary_user_id;

  -- referrals.referrer_id (re-point) then referee_id (UNIQUE(referee_id), primary wins)
  UPDATE referrals SET referrer_id = p_primary_user_id WHERE referrer_id = p_secondary_user_id;
  UPDATE referrals s SET referee_id = p_primary_user_id
  WHERE s.referee_id = p_secondary_user_id
    AND NOT EXISTS (SELECT 1 FROM referrals p WHERE p.referee_id = p_primary_user_id);
  DELETE FROM referrals WHERE referee_id = p_secondary_user_id;
  -- guard against self-referral created by the re-point
  DELETE FROM referrals WHERE referrer_id = referee_id;

  -- social_accounts UNIQUE(user_id, platform) + UNIQUE(platform, platform_user_id)
  UPDATE social_accounts s SET user_id = p_primary_user_id
  WHERE s.user_id = p_secondary_user_id
    AND NOT EXISTS (SELECT 1 FROM social_accounts p WHERE p.user_id = p_primary_user_id AND p.platform = s.platform)
    AND NOT EXISTS (SELECT 1 FROM social_accounts p2 WHERE p2.platform = s.platform AND p2.platform_user_id = s.platform_user_id AND p2.user_id <> s.user_id);
  DELETE FROM social_accounts WHERE user_id = p_secondary_user_id;

  -- user_profiles (PK user_id, username globally unique) — primary wins.
  UPDATE user_profiles s SET user_id = p_primary_user_id
  WHERE s.user_id = p_secondary_user_id
    AND NOT EXISTS (SELECT 1 FROM user_profiles p WHERE p.user_id = p_primary_user_id)
    AND (s.username IS NULL OR NOT EXISTS (SELECT 1 FROM user_profiles p2 WHERE p2.username = s.username AND p2.user_id <> s.user_id));
  DELETE FROM user_profiles WHERE user_id = p_secondary_user_id;

  -- quest_progress: social rows (account-level) dedupe; onchain rows (per-wallet) re-point.
  UPDATE quest_progress s SET user_id = p_primary_user_id
  WHERE s.user_id = p_secondary_user_id AND s.wallet_address IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM quest_progress p
      WHERE p.user_id = p_primary_user_id AND p.wallet_address IS NULL
        AND p.quest_id = s.quest_id AND p.cycle_key = s.cycle_key
    );
  DELETE FROM quest_progress WHERE user_id = p_secondary_user_id AND wallet_address IS NULL;
  UPDATE quest_progress SET user_id = p_primary_user_id
  WHERE user_id = p_secondary_user_id AND wallet_address IS NOT NULL;

  -- quest_campaign_whitelist UNIQUE(campaign_key, user_id) + UNIQUE(campaign_key, wallet_address)
  UPDATE quest_campaign_whitelist s SET user_id = p_primary_user_id
  WHERE s.user_id = p_secondary_user_id
    AND NOT EXISTS (SELECT 1 FROM quest_campaign_whitelist p WHERE p.campaign_key = s.campaign_key AND p.user_id = p_primary_user_id);
  DELETE FROM quest_campaign_whitelist WHERE user_id = p_secondary_user_id;

  -- footprint_social_verifications UNIQUE(user_id, task_key, platform)
  UPDATE footprint_social_verifications s SET user_id = p_primary_user_id
  WHERE s.user_id = p_secondary_user_id
    AND NOT EXISTS (
      SELECT 1 FROM footprint_social_verifications p
      WHERE p.user_id = p_primary_user_id AND p.task_key = s.task_key AND p.platform = s.platform
    );
  DELETE FROM footprint_social_verifications WHERE user_id = p_secondary_user_id;

  -- user_volume_daily UNIQUE(user_id, day_key) — move non-conflicting; sum overlaps into primary.
  UPDATE user_volume_daily p SET
    total_usd = p.total_usd + s.total_usd,
    swap_count = p.swap_count + s.swap_count,
    updated_at = NOW()
  FROM user_volume_daily s
  WHERE p.user_id = p_primary_user_id AND s.user_id = p_secondary_user_id AND p.day_key = s.day_key;
  UPDATE user_volume_daily s SET user_id = p_primary_user_id
  WHERE s.user_id = p_secondary_user_id
    AND NOT EXISTS (SELECT 1 FROM user_volume_daily p WHERE p.user_id = p_primary_user_id AND p.day_key = s.day_key);
  DELETE FROM user_volume_daily WHERE user_id = p_secondary_user_id;

  -- user_volume_alltime UNIQUE(user_id) — sum into primary then drop secondary.
  UPDATE user_volume_alltime p SET
    total_usd = p.total_usd + s.total_usd,
    swap_count = p.swap_count + s.swap_count,
    first_swap_at = LEAST(p.first_swap_at, s.first_swap_at),
    last_swap_at = GREATEST(p.last_swap_at, s.last_swap_at),
    updated_at = NOW()
  FROM user_volume_alltime s
  WHERE p.user_id = p_primary_user_id AND s.user_id = p_secondary_user_id;
  UPDATE user_volume_alltime s SET user_id = p_primary_user_id
  WHERE s.user_id = p_secondary_user_id
    AND NOT EXISTS (SELECT 1 FROM user_volume_alltime p WHERE p.user_id = p_primary_user_id);
  DELETE FROM user_volume_alltime WHERE user_id = p_secondary_user_id;

  -- partner_program_members UNIQUE(user_id) + wallet_address UNIQUE — primary wins.
  UPDATE partner_program_members s SET user_id = p_primary_user_id
  WHERE s.user_id = p_secondary_user_id
    AND NOT EXISTS (SELECT 1 FROM partner_program_members p WHERE p.user_id = p_primary_user_id);
  DELETE FROM partner_program_members WHERE user_id = p_secondary_user_id;

  -- referral_leaderboard_snapshot UNIQUE(user_id) — regenerated by scheduler; drop secondary.
  DELETE FROM referral_leaderboard_snapshot WHERE user_id = p_secondary_user_id;

  -- --- spin balances + wallet ownership ---
  UPDATE wallet_spin_balances SET user_id = p_primary_user_id WHERE user_id = p_secondary_user_id;
  -- fold the secondary account's legacy users.spin_tickets into its wallet balance
  INSERT INTO wallet_spin_balances (wallet_address, user_id, spin_tickets)
  SELECT v_wallet, p_primary_user_id, COALESCE((SELECT spin_tickets FROM users WHERE id = p_secondary_user_id), 0)
  ON CONFLICT (wallet_address) DO UPDATE SET user_id = EXCLUDED.user_id;

  -- the secondary wallet becomes a non-primary wallet under the primary account
  UPDATE user_wallets SET user_id = p_primary_user_id, is_primary = false, linked_at = NOW()
  WHERE wallet_address = v_wallet;
  INSERT INTO user_wallets (user_id, wallet_address, wallet_type, is_primary, linked_at)
  VALUES (p_primary_user_id, v_wallet, 'base_account', false, NOW())
  ON CONFLICT (wallet_address) DO UPDATE SET user_id = EXCLUDED.user_id, is_primary = false;

  -- --- link bonus (lifetime once per secondary wallet) ---
  SELECT EXISTS (
    SELECT 1 FROM account_merges WHERE secondary_wallet = v_wallet AND link_bonus_awarded
  ) INTO v_bonus_already;
  IF NOT v_bonus_already AND COALESCE(p_bonus_pp, 0) > 0 THEN
    v_award_bonus := true;
    INSERT INTO point_events (user_id, action, points, multiplier, total_awarded, metadata)
    VALUES (
      p_primary_user_id, 'wallet_link_bonus', p_bonus_pp, 1.0, p_bonus_pp,
      jsonb_build_object('secondary_wallet', v_wallet, 'secondary_user_id', p_secondary_user_id)
    );
    UPDATE users SET total_points = COALESCE(total_points, 0) + p_bonus_pp, updated_at = NOW()
    WHERE id = p_primary_user_id;
  END IF;

  -- --- tombstone the secondary account (frees its address slot) ---
  -- The address column is VARCHAR(42); use a short unique tombstone that fits.
  UPDATE users SET
    merged_into = p_primary_user_id,
    total_points = 0,
    spin_tickets = 0,
    address = 'merged:' || id::text,
    updated_at = NOW()
  WHERE id = p_secondary_user_id;

  -- --- audit + token consumption ---
  v_payload := jsonb_build_object(
    'secondary_total_points', v_sec_points,
    'secondary_current_streak', v_sec_streak,
    'secondary_longest_streak', v_sec_longest,
    'secondary_last_check_in', v_sec_last_checkin,
    'secondary_referral_code', v_sec_referral,
    'secondary_referred_by', v_sec_referred_by
  );

  INSERT INTO account_merges (
    primary_user_id, secondary_user_id, secondary_wallet, link_request_id,
    status, link_bonus_awarded, link_bonus_pp, payload
  )
  VALUES (
    p_primary_user_id, p_secondary_user_id, v_wallet, p_link_request_id,
    'completed', v_award_bonus, CASE WHEN v_award_bonus THEN p_bonus_pp ELSE 0 END, v_payload
  )
  RETURNING id INTO v_merge_id;

  IF p_link_request_id IS NOT NULL THEN
    UPDATE wallet_link_requests SET
      status = 'consumed',
      consumed_at = NOW(),
      consumed_by_user_id = p_secondary_user_id,
      target_wallet = v_wallet,
      merge_id = v_merge_id
    WHERE id = p_link_request_id;
  END IF;

  RETURN v_merge_id;
END;
$$;

-- Detach a non-primary wallet into a fresh standalone account. Wallet-level data
-- (spin balance, onchain quest progress, its swap rows) travels with it; shared
-- account-level data stays on the original account.
CREATE OR REPLACE FUNCTION unlink_wallet(
  p_user_id INTEGER,
  p_wallet VARCHAR,
  p_new_referral_code VARCHAR
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_wallet      VARCHAR := LOWER(p_wallet);
  v_new_user_id INTEGER;
  v_is_primary  BOOLEAN;
  v_owner       INTEGER;
  v_merge_id    BIGINT;
BEGIN
  SELECT user_id, is_primary INTO v_owner, v_is_primary
  FROM user_wallets WHERE wallet_address = v_wallet;

  IF v_owner IS NULL OR v_owner <> p_user_id THEN
    RAISE EXCEPTION 'wallet_not_linked_to_account';
  END IF;
  IF v_is_primary THEN
    RAISE EXCEPTION 'cannot_unlink_primary_wallet';
  END IF;

  PERFORM 1 FROM users WHERE id = p_user_id FOR UPDATE;

  INSERT INTO users (address, referral_code, total_points, spin_tickets, current_streak, longest_streak)
  VALUES (v_wallet, p_new_referral_code, 0, 0, 0, 0)
  RETURNING id INTO v_new_user_id;

  -- wallet-level data follows the wallet
  UPDATE wallet_spin_balances SET user_id = v_new_user_id WHERE wallet_address = v_wallet;
  UPDATE quest_progress SET user_id = v_new_user_id WHERE wallet_address = v_wallet;
  UPDATE swap_transactions SET user_id = v_new_user_id WHERE address = v_wallet;
  UPDATE spin_history SET user_id = v_new_user_id WHERE wallet_address = v_wallet;

  -- the wallet becomes primary of its own new account
  UPDATE user_wallets SET user_id = v_new_user_id, is_primary = true, linked_at = NOW()
  WHERE wallet_address = v_wallet;

  SELECT id INTO v_merge_id FROM account_merges
  WHERE secondary_wallet = v_wallet AND status = 'completed'
  ORDER BY id DESC LIMIT 1;

  INSERT INTO wallet_unlinks (from_user_id, detached_wallet, new_user_id, related_merge_id, payload)
  VALUES (p_user_id, v_wallet, v_new_user_id, v_merge_id, '{}'::jsonb);

  RETURN v_new_user_id;
END;
$$;
