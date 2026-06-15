-- Wallet linking: quest_progress unique-constraint SWAP (phase 2).
--
-- This is split out from wallet_merge.sql because it is the ONLY part that is
-- NOT backward-compatible with old code: dropping the full unique breaks any
-- code that does `ON CONFLICT (user_id, quest_id, cycle_key)`.
--
-- Safe rollout order:
--   1. Apply wallet_merge.sql (additive: tables, columns, functions, backfill).
--   2. Deploy the new application code (linking can stay flag-OFF).
--   3. Apply THIS file (no old code is left that uses the bare ON CONFLICT).
--   4. Flip the feature flags on to enable wallet linking.
--
-- Idempotent. Verify the live constraint name first if it differs from the
-- Postgres default below (\d quest_progress).

ALTER TABLE quest_progress
  DROP CONSTRAINT IF EXISTS quest_progress_user_id_quest_id_cycle_key_key;

-- Social / account-level progress: one row per (user, quest, cycle).
CREATE UNIQUE INDEX IF NOT EXISTS idx_quest_progress_account
  ON quest_progress(user_id, quest_id, cycle_key)
  WHERE wallet_address IS NULL;

-- Onchain / per-wallet progress: one row per (wallet, quest, cycle).
CREATE UNIQUE INDEX IF NOT EXISTS idx_quest_progress_wallet
  ON quest_progress(wallet_address, quest_id, cycle_key)
  WHERE wallet_address IS NOT NULL;
