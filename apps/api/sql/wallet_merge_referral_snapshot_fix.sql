-- Fix: merge_accounts referenced a non-existent table
-- "referral_leaderboard_snapshot" (real table is
-- referral_leaderboard_snapshot_entries, and it is optional), which aborted the
-- entire wallet-link merge with: relation "referral_leaderboard_snapshot" does not exist.
-- Run this in the Supabase / Railway SQL editor to replace the function in prod.
-- Idempotent (CREATE OR REPLACE); safe to run multiple times.

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

  -- referral leaderboard snapshot UNIQUE(user_id) — regenerated by the scheduler;
  -- drop the secondary's stale row. The real table is
  -- `referral_leaderboard_snapshot_entries` (the old name `referral_leaderboard_snapshot`
  -- does not exist and aborted the whole merge). It's an optional snapshot table
  -- that may be absent in some environments, so guard on its existence.
  IF to_regclass('public.referral_leaderboard_snapshot_entries') IS NOT NULL THEN
    DELETE FROM referral_leaderboard_snapshot_entries WHERE user_id = p_secondary_user_id;
  END IF;

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
