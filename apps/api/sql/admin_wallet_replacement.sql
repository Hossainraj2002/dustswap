-- =========================================================
-- Admin Wallet Replacement
-- =========================================================
-- Replaces a primary wallet with a new wallet for hacked-wallet support.
-- The operation is intentionally admin-only through the API's direct Postgres
-- connection. The audit table has RLS enabled and no public policies.

CREATE TABLE IF NOT EXISTS admin_wallet_replacements (
  id                 BIGSERIAL PRIMARY KEY,
  old_wallet         VARCHAR(42) NOT NULL,
  new_wallet         VARCHAR(42) NOT NULL,
  primary_user_id    INTEGER NOT NULL REFERENCES users(id),
  displaced_user_id  INTEGER REFERENCES users(id),
  old_wallet_before  JSONB NOT NULL,
  new_wallet_before  JSONB NOT NULL,
  after_state        JSONB NOT NULL DEFAULT '{}'::jsonb,
  logs               JSONB NOT NULL DEFAULT '[]'::jsonb,
  note               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_wallet_replacements_created
  ON admin_wallet_replacements(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_wallet_replacements_old_wallet
  ON admin_wallet_replacements(old_wallet);
CREATE INDEX IF NOT EXISTS idx_admin_wallet_replacements_new_wallet
  ON admin_wallet_replacements(new_wallet);
CREATE INDEX IF NOT EXISTS idx_admin_wallet_replacements_primary_user
  ON admin_wallet_replacements(primary_user_id);

ALTER TABLE admin_wallet_replacements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE admin_wallet_replacements FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admin_wallet_replacements_wallets_evm_check'
  ) THEN
    ALTER TABLE admin_wallet_replacements
      ADD CONSTRAINT admin_wallet_replacements_wallets_evm_check
      CHECK (
        old_wallet ~* '^0x[0-9a-f]{40}$'
        AND new_wallet ~* '^0x[0-9a-f]{40}$'
      )
      NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION admin_replace_primary_wallet(
  p_old_wallet VARCHAR,
  p_new_wallet VARCHAR,
  p_note TEXT DEFAULT NULL
) RETURNS TABLE (
  replacement_id BIGINT,
  old_wallet VARCHAR,
  new_wallet VARCHAR,
  primary_user_id INTEGER,
  displaced_user_id INTEGER,
  logs JSONB,
  backup_saved BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_wallet        VARCHAR := LOWER(TRIM(COALESCE(p_old_wallet, '')));
  v_new_wallet        VARCHAR := LOWER(TRIM(COALESCE(p_new_wallet, '')));
  v_primary_user_id   INTEGER;
  v_new_owner_id      INTEGER;
  v_displaced_user_id INTEGER;
  v_old_before        JSONB;
  v_new_before        JSONB;
  v_after_state       JSONB;
  v_logs              JSONB := '[]'::jsonb;
  v_count             INTEGER;
BEGIN
  IF v_old_wallet !~* '^0x[0-9a-f]{40}$' OR v_new_wallet !~* '^0x[0-9a-f]{40}$' THEN
    RAISE EXCEPTION 'invalid_wallet_address';
  END IF;

  IF v_old_wallet = v_new_wallet THEN
    RAISE EXCEPTION 'same_wallet_replacement_not_allowed';
  END IF;

  SELECT user_id
    INTO v_primary_user_id
  FROM user_wallets
  WHERE wallet_address = v_old_wallet
    AND is_primary = true
  FOR UPDATE;

  IF v_primary_user_id IS NULL THEN
    RAISE EXCEPTION 'old_wallet_is_not_primary';
  END IF;

  SELECT user_id
    INTO v_new_owner_id
  FROM user_wallets
  WHERE wallet_address = v_new_wallet
  FOR UPDATE;

  IF v_new_owner_id IS NULL THEN
    SELECT id
      INTO v_new_owner_id
    FROM users
    WHERE address = v_new_wallet
      AND merged_into IS NULL
    FOR UPDATE;
  END IF;

  IF v_new_owner_id IS NOT NULL AND v_new_owner_id <> v_primary_user_id THEN
    v_displaced_user_id := v_new_owner_id;
  END IF;

  PERFORM 1 FROM users WHERE id = v_primary_user_id FOR UPDATE;
  IF v_displaced_user_id IS NOT NULL THEN
    PERFORM 1 FROM users WHERE id = v_displaced_user_id FOR UPDATE;
  END IF;

  SELECT jsonb_build_object(
    'wallet', v_old_wallet,
    'user', (SELECT to_jsonb(u) FROM users u WHERE u.id = v_primary_user_id),
    'user_wallets', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM user_wallets WHERE user_id = v_primary_user_id OR wallet_address = v_old_wallet ORDER BY id) r), '[]'::jsonb),
    'wallet_spin_balances', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM wallet_spin_balances WHERE user_id = v_primary_user_id OR wallet_address = v_old_wallet ORDER BY id) r), '[]'::jsonb),
    'point_events', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM point_events WHERE user_id = v_primary_user_id ORDER BY id) r), '[]'::jsonb),
    'check_ins', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM check_ins WHERE user_id = v_primary_user_id ORDER BY id) r), '[]'::jsonb),
    'streak_recovery_events', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM streak_recovery_events WHERE user_id = v_primary_user_id ORDER BY id) r), '[]'::jsonb),
    'spin_history', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM spin_history WHERE user_id = v_primary_user_id OR wallet_address = v_old_wallet ORDER BY id) r), '[]'::jsonb),
    'sweep_history', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM sweep_history WHERE user_id = v_primary_user_id ORDER BY id) r), '[]'::jsonb),
    'sweeps', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM sweeps WHERE LOWER(user_address) = v_old_wallet ORDER BY id) r), '[]'::jsonb),
    'swap_transactions', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM swap_transactions WHERE user_id = v_primary_user_id OR address = v_old_wallet ORDER BY id) r), '[]'::jsonb),
    'user_volume_daily', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM user_volume_daily WHERE user_id = v_primary_user_id ORDER BY id) r), '[]'::jsonb),
    'user_volume_alltime', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM user_volume_alltime WHERE user_id = v_primary_user_id ORDER BY id) r), '[]'::jsonb),
    'activity_events', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM activity_events WHERE user_id = v_primary_user_id ORDER BY id) r), '[]'::jsonb),
    'oauth_states', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM oauth_states WHERE user_id = v_primary_user_id OR wallet_address = v_old_wallet ORDER BY id) r), '[]'::jsonb),
    'quest_verification_logs', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM quest_verification_logs WHERE user_id = v_primary_user_id ORDER BY id) r), '[]'::jsonb),
    'social_accounts', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM social_accounts WHERE user_id = v_primary_user_id ORDER BY id) r), '[]'::jsonb),
    'user_profiles', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM user_profiles WHERE user_id = v_primary_user_id) r), '[]'::jsonb),
    'user_onboarding_guides', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM user_onboarding_guides WHERE wallet_address = v_old_wallet ORDER BY id) r), '[]'::jsonb),
    'quest_progress', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM quest_progress WHERE user_id = v_primary_user_id OR wallet_address = v_old_wallet ORDER BY id) r), '[]'::jsonb),
    'quest_campaign_whitelist', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM quest_campaign_whitelist WHERE user_id = v_primary_user_id OR wallet_address = v_old_wallet ORDER BY id) r), '[]'::jsonb),
    'footprint_social_verifications', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM footprint_social_verifications WHERE user_id = v_primary_user_id OR wallet_address = v_old_wallet ORDER BY id) r), '[]'::jsonb),
    'partner_program_members', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM partner_program_members WHERE user_id = v_primary_user_id OR wallet_address = v_old_wallet ORDER BY id) r), '[]'::jsonb),
    'partner_fee_share_history', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT h.* FROM partner_fee_share_history h JOIN partner_program_members pm ON pm.id = h.partner_member_id WHERE pm.user_id = v_primary_user_id OR pm.wallet_address = v_old_wallet ORDER BY h.id) r), '[]'::jsonb),
    'partner_reward_distributions', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT d.* FROM partner_reward_distributions d JOIN partner_program_members pm ON pm.id = d.partner_member_id WHERE pm.user_id = v_primary_user_id OR pm.wallet_address = v_old_wallet ORDER BY d.id) r), '[]'::jsonb),
    'partner_content_submissions', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM partner_content_submissions WHERE partner_user_id = v_primary_user_id ORDER BY id) r), '[]'::jsonb),
    'referrals_as_referrer', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM referrals WHERE referrer_id = v_primary_user_id ORDER BY id) r), '[]'::jsonb),
    'referrals_as_referee', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM referrals WHERE referee_id = v_primary_user_id ORDER BY id) r), '[]'::jsonb),
    'referral_leaderboard_snapshot_entries', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM referral_leaderboard_snapshot_entries WHERE user_id = v_primary_user_id OR address = v_old_wallet ORDER BY rank) r), '[]'::jsonb),
    'wallet_token_balances', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM wallet_token_balances WHERE wallet_address = v_old_wallet ORDER BY chain_id, token_address, source_type) r), '[]'::jsonb),
    'wallet_discovery_jobs', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM wallet_discovery_jobs WHERE wallet_address = v_old_wallet ORDER BY id) r), '[]'::jsonb)
  ) INTO v_old_before;

  SELECT jsonb_build_object(
    'wallet', v_new_wallet,
    'user', (SELECT to_jsonb(u) FROM users u WHERE u.id = v_new_owner_id),
    'user_wallets', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM user_wallets WHERE user_id = v_new_owner_id OR wallet_address = v_new_wallet ORDER BY id) r), '[]'::jsonb),
    'wallet_spin_balances', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM wallet_spin_balances WHERE user_id = v_new_owner_id OR wallet_address = v_new_wallet ORDER BY id) r), '[]'::jsonb),
    'point_events', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM point_events WHERE user_id = v_new_owner_id ORDER BY id) r), '[]'::jsonb),
    'check_ins', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM check_ins WHERE user_id = v_new_owner_id ORDER BY id) r), '[]'::jsonb),
    'streak_recovery_events', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM streak_recovery_events WHERE user_id = v_new_owner_id ORDER BY id) r), '[]'::jsonb),
    'spin_history', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM spin_history WHERE user_id = v_new_owner_id OR wallet_address = v_new_wallet ORDER BY id) r), '[]'::jsonb),
    'sweep_history', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM sweep_history WHERE user_id = v_new_owner_id ORDER BY id) r), '[]'::jsonb),
    'sweeps', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM sweeps WHERE LOWER(user_address) = v_new_wallet ORDER BY id) r), '[]'::jsonb),
    'swap_transactions', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM swap_transactions WHERE user_id = v_new_owner_id OR address = v_new_wallet ORDER BY id) r), '[]'::jsonb),
    'user_volume_daily', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM user_volume_daily WHERE user_id = v_new_owner_id ORDER BY id) r), '[]'::jsonb),
    'user_volume_alltime', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM user_volume_alltime WHERE user_id = v_new_owner_id ORDER BY id) r), '[]'::jsonb),
    'activity_events', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM activity_events WHERE user_id = v_new_owner_id ORDER BY id) r), '[]'::jsonb),
    'oauth_states', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM oauth_states WHERE user_id = v_new_owner_id OR wallet_address = v_new_wallet ORDER BY id) r), '[]'::jsonb),
    'quest_verification_logs', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM quest_verification_logs WHERE user_id = v_new_owner_id ORDER BY id) r), '[]'::jsonb),
    'social_accounts', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM social_accounts WHERE user_id = v_new_owner_id ORDER BY id) r), '[]'::jsonb),
    'user_profiles', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM user_profiles WHERE user_id = v_new_owner_id) r), '[]'::jsonb),
    'user_onboarding_guides', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM user_onboarding_guides WHERE wallet_address = v_new_wallet ORDER BY id) r), '[]'::jsonb),
    'quest_progress', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM quest_progress WHERE user_id = v_new_owner_id OR wallet_address = v_new_wallet ORDER BY id) r), '[]'::jsonb),
    'quest_campaign_whitelist', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM quest_campaign_whitelist WHERE user_id = v_new_owner_id OR wallet_address = v_new_wallet ORDER BY id) r), '[]'::jsonb),
    'footprint_social_verifications', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM footprint_social_verifications WHERE user_id = v_new_owner_id OR wallet_address = v_new_wallet ORDER BY id) r), '[]'::jsonb),
    'partner_program_members', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM partner_program_members WHERE user_id = v_new_owner_id OR wallet_address = v_new_wallet ORDER BY id) r), '[]'::jsonb),
    'partner_fee_share_history', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT h.* FROM partner_fee_share_history h JOIN partner_program_members pm ON pm.id = h.partner_member_id WHERE pm.user_id = v_new_owner_id OR pm.wallet_address = v_new_wallet ORDER BY h.id) r), '[]'::jsonb),
    'partner_reward_distributions', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT d.* FROM partner_reward_distributions d JOIN partner_program_members pm ON pm.id = d.partner_member_id WHERE pm.user_id = v_new_owner_id OR pm.wallet_address = v_new_wallet ORDER BY d.id) r), '[]'::jsonb),
    'partner_content_submissions', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM partner_content_submissions WHERE partner_user_id = v_new_owner_id ORDER BY id) r), '[]'::jsonb),
    'referrals_as_referrer', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM referrals WHERE referrer_id = v_new_owner_id ORDER BY id) r), '[]'::jsonb),
    'referrals_as_referee', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM referrals WHERE referee_id = v_new_owner_id ORDER BY id) r), '[]'::jsonb),
    'referral_leaderboard_snapshot_entries', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM referral_leaderboard_snapshot_entries WHERE user_id = v_new_owner_id OR address = v_new_wallet ORDER BY rank) r), '[]'::jsonb),
    'wallet_token_balances', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM wallet_token_balances WHERE wallet_address = v_new_wallet ORDER BY chain_id, token_address, source_type) r), '[]'::jsonb),
    'wallet_discovery_jobs', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM wallet_discovery_jobs WHERE wallet_address = v_new_wallet ORDER BY id) r), '[]'::jsonb)
  ) INTO v_new_before;

  v_logs := v_logs || jsonb_build_array(
    jsonb_build_object('level', 'backup', 'message', 'Backed up old wallet state.', 'count', 1),
    jsonb_build_object('level', 'backup', 'message', 'Backed up new wallet state.', 'count', CASE WHEN v_new_owner_id IS NULL THEN 0 ELSE 1 END)
  );

  IF v_displaced_user_id IS NOT NULL THEN
    IF to_regclass('public.swap_transaction_legs') IS NOT NULL THEN
      DELETE FROM swap_transaction_legs l
      USING swap_transactions s
      WHERE s.user_id = v_displaced_user_id
        AND l.chain_id = s.chain_id
        AND l.tx_hash = s.tx_hash;
      GET DIAGNOSTICS v_count = ROW_COUNT;
      IF v_count > 0 THEN
        v_logs := v_logs || jsonb_build_array(jsonb_build_object('level', 'minus', 'message', 'Removed destination swap legs.', 'count', v_count));
      END IF;
    END IF;

    DELETE FROM point_events WHERE user_id = v_displaced_user_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count > 0 THEN v_logs := v_logs || jsonb_build_array(jsonb_build_object('level', 'minus', 'message', 'Removed destination point events.', 'count', v_count)); END IF;

    DELETE FROM check_ins WHERE user_id = v_displaced_user_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count > 0 THEN v_logs := v_logs || jsonb_build_array(jsonb_build_object('level', 'minus', 'message', 'Removed destination check-ins.', 'count', v_count)); END IF;

    DELETE FROM streak_recovery_events WHERE user_id = v_displaced_user_id;
    DELETE FROM sweep_history WHERE user_id = v_displaced_user_id;
    DELETE FROM spin_history WHERE user_id = v_displaced_user_id;
    DELETE FROM swap_transactions WHERE user_id = v_displaced_user_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count > 0 THEN v_logs := v_logs || jsonb_build_array(jsonb_build_object('level', 'minus', 'message', 'Removed destination swap transactions.', 'count', v_count)); END IF;

    DELETE FROM user_volume_daily WHERE user_id = v_displaced_user_id;
    DELETE FROM user_volume_alltime WHERE user_id = v_displaced_user_id;
    DELETE FROM activity_events WHERE user_id = v_displaced_user_id;
    DELETE FROM oauth_states WHERE user_id = v_displaced_user_id;
    DELETE FROM quest_verification_logs WHERE user_id = v_displaced_user_id;
    DELETE FROM social_accounts WHERE user_id = v_displaced_user_id;
    DELETE FROM user_profiles WHERE user_id = v_displaced_user_id;
    DELETE FROM quest_progress WHERE user_id = v_displaced_user_id;
    DELETE FROM quest_campaign_whitelist WHERE user_id = v_displaced_user_id;
    DELETE FROM footprint_social_verifications WHERE user_id = v_displaced_user_id;
    DELETE FROM partner_content_submissions WHERE partner_user_id = v_displaced_user_id;
    DELETE FROM wallet_link_requests WHERE source_user_id = v_displaced_user_id;
    UPDATE wallet_link_requests SET consumed_by_user_id = NULL WHERE consumed_by_user_id = v_displaced_user_id;

    UPDATE users SET referred_by = NULL, updated_at = NOW() WHERE referred_by = v_displaced_user_id;
    DELETE FROM referrals WHERE referrer_id = v_displaced_user_id OR referee_id = v_displaced_user_id;

    DELETE FROM partner_program_members
    WHERE user_id = v_displaced_user_id
       OR (wallet_address = v_new_wallet AND user_id <> v_primary_user_id);

    DELETE FROM referral_leaderboard_snapshot_entries
    WHERE user_id = v_displaced_user_id
       OR address = v_new_wallet;

    DELETE FROM wallet_spin_balances
    WHERE user_id = v_displaced_user_id
       OR wallet_address = v_new_wallet;
    DELETE FROM user_wallets
    WHERE user_id = v_displaced_user_id
       OR wallet_address = v_new_wallet;

    UPDATE users SET
      merged_into = v_primary_user_id,
      total_points = 0,
      spin_tickets = 0,
      current_streak = 0,
      longest_streak = 0,
      x_user_id = NULL,
      x_username = NULL,
      x_name = NULL,
      x_avatar = NULL,
      x_connected = false,
      x_connected_at = NULL,
      address = 'merged:' || id::text,
      updated_at = NOW()
    WHERE id = v_displaced_user_id;

    v_logs := v_logs || jsonb_build_array(jsonb_build_object('level', 'minus', 'message', 'Tombstoned destination user account.', 'count', 1));
  ELSE
    DELETE FROM user_wallets WHERE wallet_address = v_new_wallet AND user_id = v_primary_user_id;
    DELETE FROM wallet_spin_balances WHERE wallet_address = v_new_wallet;
  END IF;

  DELETE FROM quest_progress WHERE wallet_address = v_new_wallet;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN v_logs := v_logs || jsonb_build_array(jsonb_build_object('level', 'minus', 'message', 'Removed destination wallet quest progress.', 'count', v_count)); END IF;

  DELETE FROM user_onboarding_guides WHERE wallet_address = v_new_wallet;
  DELETE FROM quest_campaign_whitelist WHERE wallet_address = v_new_wallet;
  DELETE FROM footprint_social_verifications WHERE wallet_address = v_new_wallet;
  DELETE FROM oauth_states WHERE wallet_address = v_new_wallet;

  IF to_regclass('public.swap_transaction_legs') IS NOT NULL THEN
    DELETE FROM swap_transaction_legs l
    USING swap_transactions s
    WHERE s.address = v_new_wallet
      AND l.chain_id = s.chain_id
      AND l.tx_hash = s.tx_hash;
  END IF;

  DELETE FROM swap_transactions WHERE address = v_new_wallet;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN v_logs := v_logs || jsonb_build_array(jsonb_build_object('level', 'minus', 'message', 'Removed destination wallet swap transactions.', 'count', v_count)); END IF;

  DELETE FROM sweeps WHERE LOWER(user_address) = v_new_wallet;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN v_logs := v_logs || jsonb_build_array(jsonb_build_object('level', 'minus', 'message', 'Removed destination wallet sweeps.', 'count', v_count)); END IF;

  DELETE FROM spin_history WHERE wallet_address = v_new_wallet;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN v_logs := v_logs || jsonb_build_array(jsonb_build_object('level', 'minus', 'message', 'Removed destination wallet spin history.', 'count', v_count)); END IF;

  DELETE FROM wallet_token_balances WHERE wallet_address IN (v_old_wallet, v_new_wallet);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_logs := v_logs || jsonb_build_array(jsonb_build_object('level', 'minus', 'message', 'Cleared wallet token balance cache.', 'count', v_count));

  DELETE FROM wallet_discovery_jobs WHERE wallet_address IN (v_old_wallet, v_new_wallet);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_logs := v_logs || jsonb_build_array(jsonb_build_object('level', 'minus', 'message', 'Cleared wallet discovery job cache.', 'count', v_count));

  UPDATE users
  SET address = v_new_wallet, updated_at = NOW()
  WHERE id = v_primary_user_id;
  v_logs := v_logs || jsonb_build_array(jsonb_build_object('level', 'plus', 'message', 'Updated primary user wallet.', 'count', 1));

  UPDATE user_wallets SET is_primary = false WHERE user_id = v_primary_user_id;
  UPDATE user_wallets
  SET wallet_address = v_new_wallet, user_id = v_primary_user_id, is_primary = true, linked_at = NOW()
  WHERE wallet_address = v_old_wallet;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    INSERT INTO user_wallets (user_id, wallet_address, wallet_type, is_primary, linked_at)
    VALUES (v_primary_user_id, v_new_wallet, 'unknown', true, NOW());
  END IF;

  UPDATE wallet_spin_balances
  SET wallet_address = v_new_wallet, user_id = v_primary_user_id, updated_at = NOW()
  WHERE wallet_address = v_old_wallet;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    INSERT INTO wallet_spin_balances (wallet_address, user_id, spin_tickets)
    VALUES (v_new_wallet, v_primary_user_id, COALESCE((SELECT spin_tickets FROM users WHERE id = v_primary_user_id), 0))
    ON CONFLICT (wallet_address) DO UPDATE
      SET user_id = EXCLUDED.user_id, updated_at = NOW();
  END IF;

  UPDATE quest_progress
  SET wallet_address = v_new_wallet, user_id = v_primary_user_id, updated_at = NOW()
  WHERE wallet_address = v_old_wallet;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN v_logs := v_logs || jsonb_build_array(jsonb_build_object('level', 'plus', 'message', 'Moved per-wallet quest progress.', 'count', v_count)); END IF;

  UPDATE spin_history
  SET wallet_address = v_new_wallet, user_id = v_primary_user_id
  WHERE wallet_address = v_old_wallet;

  UPDATE sweeps
  SET user_address = v_new_wallet
  WHERE LOWER(user_address) = v_old_wallet;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN v_logs := v_logs || jsonb_build_array(jsonb_build_object('level', 'plus', 'message', 'Moved recorded sweeps.', 'count', v_count)); END IF;

  UPDATE swap_transactions
  SET address = v_new_wallet, user_id = v_primary_user_id, updated_at = NOW()
  WHERE address = v_old_wallet;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN v_logs := v_logs || jsonb_build_array(jsonb_build_object('level', 'plus', 'message', 'Moved swap transaction wallet stamps.', 'count', v_count)); END IF;

  UPDATE user_volume_daily
  SET address = v_new_wallet, updated_at = NOW()
  WHERE user_id = v_primary_user_id;
  UPDATE user_volume_alltime
  SET address = v_new_wallet, updated_at = NOW()
  WHERE user_id = v_primary_user_id;

  UPDATE user_onboarding_guides
  SET wallet_address = v_new_wallet, updated_at = NOW()
  WHERE wallet_address = v_old_wallet;

  UPDATE quest_campaign_whitelist
  SET wallet_address = v_new_wallet, user_id = v_primary_user_id, updated_at = NOW()
  WHERE wallet_address = v_old_wallet;

  UPDATE footprint_social_verifications
  SET wallet_address = v_new_wallet, user_id = v_primary_user_id, updated_at = NOW()
  WHERE wallet_address = v_old_wallet;

  UPDATE oauth_states
  SET wallet_address = v_new_wallet, user_id = v_primary_user_id
  WHERE wallet_address = v_old_wallet;

  UPDATE partner_program_members
  SET wallet_address = v_new_wallet, user_id = v_primary_user_id, updated_at = NOW()
  WHERE user_id = v_primary_user_id;

  UPDATE referral_leaderboard_snapshot_entries
  SET address = v_new_wallet
  WHERE user_id = v_primary_user_id OR address = v_old_wallet;

  SELECT jsonb_build_object(
    'user', (SELECT to_jsonb(u) FROM users u WHERE id = v_primary_user_id),
    'primary_wallet', (SELECT to_jsonb(w) FROM user_wallets w WHERE user_id = v_primary_user_id AND is_primary = true),
    'new_wallet_spin_balance', (SELECT to_jsonb(wsb) FROM wallet_spin_balances wsb WHERE wallet_address = v_new_wallet),
    'displaced_user', (SELECT to_jsonb(u) FROM users u WHERE id = v_displaced_user_id)
  ) INTO v_after_state;

  INSERT INTO admin_wallet_replacements (
    old_wallet,
    new_wallet,
    primary_user_id,
    displaced_user_id,
    old_wallet_before,
    new_wallet_before,
    after_state,
    logs,
    note
  )
  VALUES (
    v_old_wallet,
    v_new_wallet,
    v_primary_user_id,
    v_displaced_user_id,
    v_old_before,
    v_new_before,
    v_after_state,
    v_logs,
    NULLIF(TRIM(COALESCE(p_note, '')), '')
  )
  RETURNING id INTO replacement_id;

  RETURN QUERY SELECT
    replacement_id,
    v_old_wallet,
    v_new_wallet,
    v_primary_user_id,
    v_displaced_user_id,
    v_logs || jsonb_build_array(jsonb_build_object('level', 'backup', 'message', 'Saved replacement audit record.', 'count', 1)),
    true;
END;
$$;

REVOKE ALL ON FUNCTION admin_replace_primary_wallet(VARCHAR, VARCHAR, TEXT) FROM PUBLIC;
