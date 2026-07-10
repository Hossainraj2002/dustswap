-- Admin wallet replacement verification (non-destructive: wrapped in ROLLBACK).
-- Run after admin_wallet_replacement.sql. It seeds throwaway accounts, exercises
-- wallet replacement, asserts outcomes, then rolls everything back.

BEGIN;

DO $$
DECLARE
  v_old_unused        VARCHAR := '0x' || encode(gen_random_bytes(20), 'hex');
  v_new_unused        VARCHAR := '0x' || encode(gen_random_bytes(20), 'hex');
  v_old_displaced     VARCHAR := '0x' || encode(gen_random_bytes(20), 'hex');
  v_new_displaced     VARCHAR := '0x' || encode(gen_random_bytes(20), 'hex');
  v_old_same_account  VARCHAR := '0x' || encode(gen_random_bytes(20), 'hex');
  v_new_same_account  VARCHAR := '0x' || encode(gen_random_bytes(20), 'hex');
  v_secondary_wallet  VARCHAR := '0x' || encode(gen_random_bytes(20), 'hex');
  v_missing_wallet    VARCHAR := '0x' || encode(gen_random_bytes(20), 'hex');
  v_code_suffix       TEXT := upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 12));
  v_user_a            INTEGER;
  v_user_b_primary    INTEGER;
  v_user_b_displaced  INTEGER;
  v_user_c            INTEGER;
  v_quest             UUID;
  v_replacement       RECORD;
  v_total_points      BIGINT;
BEGIN
  INSERT INTO quests (slug, title, category, platform, action_type, verification_type, status)
  VALUES ('admin-wallet-replacement-verify', 'Admin Wallet Replacement Verify', 'onchain', 'dustswap', 'swap_count', 'swap_volume', 'published')
  RETURNING id INTO v_quest;

  -- Replacement into an unused destination wallet.
  INSERT INTO users (address, referral_code, total_points, spin_tickets, current_streak, longest_streak)
  VALUES (v_old_unused, 'WRA' || v_code_suffix, 100, 2, 4, 5)
  RETURNING id INTO v_user_a;
  INSERT INTO user_wallets (user_id, wallet_address, wallet_type, is_primary)
  VALUES (v_user_a, v_old_unused, 'eoa', true);
  INSERT INTO wallet_spin_balances (wallet_address, user_id, spin_tickets)
  VALUES (v_old_unused, v_user_a, 7);
  INSERT INTO quest_progress (quest_id, user_id, wallet_address, cycle_key, status, progress, target_value)
  VALUES (v_quest, v_user_a, v_old_unused, 'global', 'completed', 1, 1);
  INSERT INTO sweeps (user_address, tx_hash, tokens_swapped, value_usd, chain_id)
  VALUES (v_old_unused, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 3, 12.5, 8453);

  SELECT * INTO v_replacement
  FROM admin_replace_primary_wallet(v_old_unused, v_new_unused, 'verify unused destination');

  IF v_replacement.primary_user_id <> v_user_a OR v_replacement.displaced_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'unused destination replacement returned wrong users';
  END IF;
  IF (SELECT address FROM users WHERE id = v_user_a) <> v_new_unused THEN
    RAISE EXCEPTION 'unused destination did not update users.address';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM user_wallets
    WHERE user_id = v_user_a AND wallet_address = v_new_unused AND is_primary = true
  ) THEN
    RAISE EXCEPTION 'unused destination did not move primary user_wallets row';
  END IF;
  IF EXISTS (SELECT 1 FROM user_wallets WHERE wallet_address = v_old_unused) THEN
    RAISE EXCEPTION 'old wallet row still exists after unused destination replacement';
  END IF;
  IF (SELECT spin_tickets FROM wallet_spin_balances WHERE wallet_address = v_new_unused) <> 7 THEN
    RAISE EXCEPTION 'spin balance did not move to unused destination';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM quest_progress
    WHERE user_id = v_user_a AND wallet_address = v_new_unused AND quest_id = v_quest
  ) THEN
    RAISE EXCEPTION 'quest progress did not move to unused destination';
  END IF;

  -- Replacement over a destination wallet that belongs to a different user.
  INSERT INTO users (address, referral_code, total_points, spin_tickets, current_streak, longest_streak)
  VALUES (v_old_displaced, 'WRB' || v_code_suffix, 200, 1, 1, 1)
  RETURNING id INTO v_user_b_primary;
  INSERT INTO users (address, referral_code, total_points, spin_tickets, current_streak, longest_streak)
  VALUES (v_new_displaced, 'WRC' || v_code_suffix, 999, 9, 9, 9)
  RETURNING id INTO v_user_b_displaced;
  INSERT INTO user_wallets (user_id, wallet_address, wallet_type, is_primary)
  VALUES
    (v_user_b_primary, v_old_displaced, 'eoa', true),
    (v_user_b_displaced, v_new_displaced, 'eoa', true);
  INSERT INTO wallet_spin_balances (wallet_address, user_id, spin_tickets)
  VALUES
    (v_old_displaced, v_user_b_primary, 2),
    (v_new_displaced, v_user_b_displaced, 99);
  INSERT INTO point_events (user_id, action, points, total_awarded)
  VALUES (v_user_b_displaced, 'verify_destination_data', 999, 999);
  INSERT INTO quest_progress (quest_id, user_id, wallet_address, cycle_key, status, progress, target_value)
  VALUES (v_quest, v_user_b_displaced, v_new_displaced, 'daily:verify', 'completed', 1, 1);

  SELECT * INTO v_replacement
  FROM admin_replace_primary_wallet(v_old_displaced, v_new_displaced, 'verify displaced destination');

  IF v_replacement.displaced_user_id <> v_user_b_displaced THEN
    RAISE EXCEPTION 'displaced destination did not report displaced user';
  END IF;
  SELECT total_points INTO v_total_points FROM users WHERE id = v_user_b_primary;
  IF v_total_points <> 200 THEN
    RAISE EXCEPTION 'destination points were merged into primary unexpectedly: %', v_total_points;
  END IF;
  IF (SELECT merged_into FROM users WHERE id = v_user_b_displaced) <> v_user_b_primary THEN
    RAISE EXCEPTION 'destination user was not tombstoned into primary';
  END IF;
  IF EXISTS (SELECT 1 FROM point_events WHERE user_id = v_user_b_displaced) THEN
    RAISE EXCEPTION 'destination point events were not removed';
  END IF;
  IF EXISTS (SELECT 1 FROM quest_progress WHERE user_id = v_user_b_displaced OR wallet_address = v_new_displaced AND user_id <> v_user_b_primary) THEN
    RAISE EXCEPTION 'destination quest progress was not removed';
  END IF;

  -- Destination wallet already linked to the same account.
  INSERT INTO users (address, referral_code, total_points, spin_tickets, current_streak, longest_streak)
  VALUES (v_old_same_account, 'WRD' || v_code_suffix, 300, 0, 2, 3)
  RETURNING id INTO v_user_c;
  INSERT INTO user_wallets (user_id, wallet_address, wallet_type, is_primary)
  VALUES
    (v_user_c, v_old_same_account, 'eoa', true),
    (v_user_c, v_new_same_account, 'base_account', false),
    (v_user_c, v_secondary_wallet, 'unknown', false);
  INSERT INTO wallet_spin_balances (wallet_address, user_id, spin_tickets)
  VALUES
    (v_old_same_account, v_user_c, 5),
    (v_new_same_account, v_user_c, 1);
  INSERT INTO spin_history (
    user_id,
    tx_hash,
    reward_key,
    reward_label,
    reward_type,
    reward_amount,
    reward_probability,
    wallet_address
  )
  VALUES
    (
      v_user_c,
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'points',
      'Points',
      'points',
      0,
      100,
      v_old_same_account
    ),
    (
      v_user_c,
      '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      'tickets',
      'Tickets',
      'tickets',
      1,
      100,
      v_new_same_account
    );

  SELECT * INTO v_replacement
  FROM admin_replace_primary_wallet(v_old_same_account, v_new_same_account, 'verify same account destination');

  IF v_replacement.displaced_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'same-account destination should not displace a user';
  END IF;
  IF (SELECT COUNT(*) FROM user_wallets WHERE user_id = v_user_c AND is_primary = true) <> 1 THEN
    RAISE EXCEPTION 'same-account replacement left wrong primary wallet count';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM user_wallets
    WHERE user_id = v_user_c AND wallet_address = v_new_same_account AND is_primary = true
  ) THEN
    RAISE EXCEPTION 'same-account destination was not promoted to primary';
  END IF;
  IF (SELECT spin_tickets FROM wallet_spin_balances WHERE wallet_address = v_new_same_account) <> 5 THEN
    RAISE EXCEPTION 'same-account destination did not receive old wallet spin balance';
  END IF;
  IF (SELECT COUNT(*) FROM spin_history WHERE user_id = v_user_c AND wallet_address = v_new_same_account) <> 1 THEN
    RAISE EXCEPTION 'same-account destination spin history was merged instead of replaced';
  END IF;

  -- Rejection cases.
  BEGIN
    PERFORM 1 FROM admin_replace_primary_wallet('not-a-wallet', v_missing_wallet, NULL);
    RAISE EXCEPTION 'invalid wallet was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%invalid_wallet_address%' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM 1 FROM admin_replace_primary_wallet(v_new_unused, v_new_unused, NULL);
    RAISE EXCEPTION 'same wallet replacement was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%same_wallet_replacement_not_allowed%' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM 1 FROM admin_replace_primary_wallet(v_missing_wallet, v_secondary_wallet, NULL);
    RAISE EXCEPTION 'missing old wallet was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%old_wallet_is_not_primary%' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM 1 FROM admin_replace_primary_wallet(v_secondary_wallet, v_missing_wallet, NULL);
    RAISE EXCEPTION 'non-primary old wallet was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%old_wallet_is_not_primary%' THEN
      RAISE;
    END IF;
  END;

  RAISE NOTICE 'admin_wallet_replacement verification PASSED';
END;
$$;

ROLLBACK;
