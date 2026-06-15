-- Wallet merge / unlink verification (non-destructive: wrapped in ROLLBACK).
-- Run in the Supabase SQL editor AFTER applying wallet_merge.sql. It seeds two
-- throwaway accounts, exercises merge_accounts + unlink_wallet, asserts the
-- outcomes, then rolls everything back. Any failed assertion raises an exception.

BEGIN;

DO $$
DECLARE
  v_eoa   VARCHAR := '0x1111111111111111111111111111111111111111';
  v_base  VARCHAR := '0x2222222222222222222222222222222222222222';
  v_a     INTEGER;  -- primary (EOA)
  v_b     INTEGER;  -- secondary (Base)
  v_quest UUID;
  v_merge BIGINT;
  v_new   INTEGER;
  v_total BIGINT;
  v_bonus INTEGER;
  v_count INTEGER;
  v_tickets INTEGER;
BEGIN
  -- seed accounts
  INSERT INTO users (address, referral_code, total_points, spin_tickets, current_streak, longest_streak)
  VALUES (v_eoa, 'DUST-TST0A', 1000, 0, 5, 7) RETURNING id INTO v_a;
  INSERT INTO users (address, referral_code, total_points, spin_tickets, current_streak, longest_streak)
  VALUES (v_base, 'DUST-TST0B', 400, 0, 9, 9) RETURNING id INTO v_b;

  -- backfill-equivalent wallet rows + spin balances
  INSERT INTO user_wallets (user_id, wallet_address, wallet_type, is_primary) VALUES
    (v_a, v_eoa, 'eoa', true), (v_b, v_base, 'base_account', true);
  INSERT INTO wallet_spin_balances (wallet_address, user_id, spin_tickets) VALUES
    (v_eoa, v_a, 2), (v_base, v_b, 6);

  -- a temp onchain quest + B's per-wallet progress
  INSERT INTO quests (slug, title, category, platform, action_type, verification_type, status)
  VALUES ('merge-test-onchain', 'Merge Test', 'onchain', 'base', 'swap_count', 'automatic', 'published')
  RETURNING id INTO v_quest;
  INSERT INTO quest_progress (quest_id, user_id, wallet_address, cycle_key, status, progress, target_value, completed_at)
  VALUES (v_quest, v_b, v_base, 'global', 'completed', 3, 1, NOW());

  -- point ledger rows so the sum has provenance
  INSERT INTO point_events (user_id, action, points, total_awarded) VALUES (v_a, 'seed', 1000, 1000);
  INSERT INTO point_events (user_id, action, points, total_awarded) VALUES (v_b, 'seed', 400, 400);

  -- ── MERGE ──
  v_merge := merge_accounts(v_a, v_b, v_base, NULL, 15000);

  SELECT total_points INTO v_total FROM users WHERE id = v_a;
  IF v_total <> 1000 + 400 + 15000 THEN
    RAISE EXCEPTION 'merge PP wrong: got %, expected %', v_total, 1000 + 400 + 15000;
  END IF;

  IF (SELECT current_streak FROM users WHERE id = v_a) <> 9 THEN
    RAISE EXCEPTION 'merge streak not maxed';
  END IF;

  IF (SELECT merged_into FROM users WHERE id = v_b) <> v_a THEN
    RAISE EXCEPTION 'secondary not tombstoned into primary';
  END IF;

  IF (SELECT user_id FROM user_wallets WHERE wallet_address = v_base) <> v_a
     OR (SELECT is_primary FROM user_wallets WHERE wallet_address = v_base) <> false THEN
    RAISE EXCEPTION 'base wallet not re-pointed as non-primary under primary';
  END IF;

  SELECT spin_tickets INTO v_tickets FROM wallet_spin_balances WHERE wallet_address = v_base;
  IF v_tickets <> 6 THEN
    RAISE EXCEPTION 'base wallet spin balance not preserved: %', v_tickets;
  END IF;

  SELECT link_bonus_awarded, link_bonus_pp INTO v_bonus, v_count
    FROM account_merges WHERE id = v_merge;
  IF NOT (SELECT link_bonus_awarded FROM account_merges WHERE id = v_merge) THEN
    RAISE EXCEPTION 'link bonus not flagged';
  END IF;

  SELECT COUNT(*) INTO v_count FROM point_events WHERE user_id = v_a AND action = 'wallet_link_bonus';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one wallet_link_bonus event, got %', v_count;
  END IF;

  -- onchain progress should now hang off the primary but keep its wallet stamp
  IF (SELECT user_id FROM quest_progress WHERE wallet_address = v_base AND quest_id = v_quest) <> v_a THEN
    RAISE EXCEPTION 'onchain quest progress not re-pointed to primary';
  END IF;

  -- idempotency: a second merge is a no-op returning the same id
  IF merge_accounts(v_a, v_b, v_base, NULL, 15000) <> v_merge THEN
    RAISE EXCEPTION 'merge not idempotent';
  END IF;

  -- ── UNLINK ──
  v_new := unlink_wallet(v_a, v_base, 'DUST-TSTUN');

  IF (SELECT address FROM users WHERE id = v_new) <> v_base THEN
    RAISE EXCEPTION 'unlink did not create standalone account for wallet';
  END IF;
  IF (SELECT user_id FROM user_wallets WHERE wallet_address = v_base) <> v_new
     OR (SELECT is_primary FROM user_wallets WHERE wallet_address = v_base) <> true THEN
    RAISE EXCEPTION 'unlinked wallet not primary of its new account';
  END IF;
  IF (SELECT user_id FROM wallet_spin_balances WHERE wallet_address = v_base) <> v_new THEN
    RAISE EXCEPTION 'spin balance did not follow the unlinked wallet';
  END IF;
  IF (SELECT user_id FROM quest_progress WHERE wallet_address = v_base AND quest_id = v_quest) <> v_new THEN
    RAISE EXCEPTION 'onchain quest progress did not follow the unlinked wallet';
  END IF;
  -- shared PP stays with the primary
  IF (SELECT total_points FROM users WHERE id = v_a) <> 1000 + 400 + 15000 THEN
    RAISE EXCEPTION 'shared PP should remain on primary after unlink';
  END IF;

  RAISE NOTICE 'wallet_merge verification PASSED (merge id %, new account %)', v_merge, v_new;
END;
$$;

ROLLBACK;
