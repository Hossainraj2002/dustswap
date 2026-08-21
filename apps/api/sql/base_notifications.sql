-- ============================================================================
-- Base App notifications (Base Dashboard REST API)
-- Run against the API database (see apps/api/src/scripts/runMigration.ts).
-- Idempotent: safe to run more than once.
--
-- Design notes:
-- * Base delivers to WALLET ADDRESSES, not FIDs. The Farcaster token/webhook
--   flow stopped reaching Base App users on 2026-04-09, so nothing here keys
--   on a notification token.
-- * Base returns EIP-55 checksummed addresses; every address column here is
--   stored lowercase to match user_wallets.wallet_address.
-- * users.address can be 'merged:<id>' after an account merge, so audience
--   rows resolve to a user through user_wallets, never through users.address.
-- * notification_sends is the frequency cap and the analytics table. Sends are
--   capped per users.id (the merged account) so a linked EOA + Base Account
--   pair cannot be notified twice for the same campaign.
-- ============================================================================

-- 1. Audience cache ----------------------------------------------------------
-- Mirror of GET /v1/notifications/app/users so campaign runs do not repaginate
-- the whole opted-in list every time.
CREATE TABLE IF NOT EXISTS notification_audience (
  wallet_address        VARCHAR(42) PRIMARY KEY,   -- stored lowercase
  app_pinned            BOOLEAN NOT NULL DEFAULT TRUE,
  notifications_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_audience_enabled
  ON notification_audience(notifications_enabled)
  WHERE notifications_enabled;

CREATE INDEX IF NOT EXISTS idx_notification_audience_synced
  ON notification_audience(last_synced_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notification_audience_evm_check'
  ) THEN
    ALTER TABLE notification_audience
      ADD CONSTRAINT notification_audience_evm_check
      CHECK (wallet_address ~ '^0x[0-9a-f]{40}$');
  END IF;
END $$;

-- 2. Send ledger -------------------------------------------------------------
-- Every dispatch attempt lands here, including dry runs and cap skips. This is
-- what enforces "at most one notification per account per 24h" and what the
-- admin dashboard reads.
CREATE TABLE IF NOT EXISTS notification_sends (
  id             BIGSERIAL PRIMARY KEY,
  campaign       TEXT NOT NULL,
  run_id         BIGINT,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  wallet_address VARCHAR(42) NOT NULL,            -- stored lowercase
  title          TEXT NOT NULL,
  message        TEXT NOT NULL,
  target_path    TEXT,
  -- 'sent' | 'failed' | 'dry_run'
  status         TEXT NOT NULL,
  failure_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Frequency-cap lookup: "was this account notified in the last 24h?"
CREATE INDEX IF NOT EXISTS idx_notification_sends_user_recent
  ON notification_sends(user_id, created_at DESC)
  WHERE status = 'sent';

-- Per-campaign cooldown lookup and admin rollups.
CREATE INDEX IF NOT EXISTS idx_notification_sends_campaign_recent
  ON notification_sends(campaign, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_sends_wallet_recent
  ON notification_sends(wallet_address, created_at DESC);

-- 3. Run log -----------------------------------------------------------------
-- One row per campaign execution, so a failed or half-finished run is visible
-- without scanning the send ledger.
CREATE TABLE IF NOT EXISTS notification_runs (
  id             BIGSERIAL PRIMARY KEY,
  campaign       TEXT NOT NULL,
  source         TEXT NOT NULL,                   -- 'scheduler' | 'manual' | 'script'
  dry_run        BOOLEAN NOT NULL DEFAULT FALSE,
  audience_size  INTEGER NOT NULL DEFAULT 0,      -- opted-in wallets considered
  targeted       INTEGER NOT NULL DEFAULT 0,      -- rows the segment matched
  -- Dropped by NOTIFICATIONS_MAX_PER_RUN. Accounts dropped by the 24h cooldown
  -- never reach the runner: that filter lives in the segment query itself.
  capped         INTEGER NOT NULL DEFAULT 0,
  sent_count     INTEGER NOT NULL DEFAULT 0,
  failed_count   INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notification_runs_campaign
  ON notification_runs(campaign, started_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notification_sends_run_fk'
  ) THEN
    ALTER TABLE notification_sends
      ADD CONSTRAINT notification_sends_run_fk
      FOREIGN KEY (run_id) REFERENCES notification_runs(id) ON DELETE SET NULL;
  END IF;
END $$;
