-- ============================================================================
-- Base App notifications: audience state machine
-- Run against the API database:  pnpm migrate base_notifications_audience_v2
-- Idempotent: safe to run more than once.
--
-- Why this exists
-- ---------------
-- The first cut treated Base's /app/users response as the only source of
-- audience. That is authoritative but it cannot grow on its own: a user who
-- installs DustSwap in Base App tomorrow is invisible until the next sync, and
-- there is no record of anyone we tried and failed to reach.
--
-- On-chain detection was considered and rejected on evidence. 3,000 wallets
-- were probed with eth_getCode across six cohorts (newest, oldest, random,
-- recent sweepers, recent check-ins, and the spin_history execution_type =
-- 'smart_wallet' cohort). Every single one was a plain EOA: zero contract
-- accounts, zero EIP-7702 delegations. A Coinbase Smart Wallet that has never
-- sent a transaction is counterfactual and returns empty code, and check-ins
-- are free, so eth_getCode cannot see exactly the users we care about.
--
-- The reliable detector is Base's own send response. Its failure reasons are
-- a free, per-wallet oracle delivered 1,000 addresses at a time:
--
--   sent: true                       -> confirmed Base App user, notifications on
--   "user has notifications disabled"-> IS a Base App user, notifications off
--   "user has not saved this app"    -> not pinned (or not a Base App user)
--
-- The middle case is the valuable one: it proves Base App membership without
-- the user ever receiving anything. So the audience learns from traffic it was
-- going to send anyway.
-- ============================================================================

-- 1. Audience state ----------------------------------------------------------
ALTER TABLE notification_audience
  ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'unknown';

COMMENT ON COLUMN notification_audience.state IS
  'confirmed | notifications_off | not_pinned | unknown';

ALTER TABLE notification_audience
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'unknown';

COMMENT ON COLUMN notification_audience.source IS
  'base_api | send_probe | status_probe | unknown';

ALTER TABLE notification_audience
  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE notification_audience
  ADD COLUMN IF NOT EXISTS last_probe_at TIMESTAMPTZ;

ALTER TABLE notification_audience
  ADD COLUMN IF NOT EXISTS last_delivered_at TIMESTAMPTZ;

ALTER TABLE notification_audience
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;

-- Existing rows came from the Base API opted-in list, so they are confirmed.
UPDATE notification_audience
SET state  = 'confirmed',
    source = 'base_api'
WHERE notifications_enabled = TRUE
  AND state = 'unknown';

-- Dispatch ordering: confirmed first, then never-probed, then stale probes.
CREATE INDEX IF NOT EXISTS idx_notification_audience_state
  ON notification_audience(state, last_probe_at NULLS FIRST);

CREATE INDEX IF NOT EXISTS idx_notification_audience_user
  ON notification_audience(user_id);

-- 2. Per-campaign cooldown ---------------------------------------------------
-- The global 24h cap stops five campaigns stacking on one person, but it does
-- nothing to stop ONE campaign repeating daily. daily_check_in targets users
-- with no streak and no check-in today, which is a large and permanently
-- matching population, so without a per-campaign cooldown a dormant user is
-- pinged every single day until they mute the app. Opt-outs are permanent.
CREATE INDEX IF NOT EXISTS idx_notification_sends_user_campaign_recent
  ON notification_sends(user_id, campaign, created_at DESC)
  WHERE status = 'sent';

-- 3. Ledger hygiene ----------------------------------------------------------
-- Discovery mode writes a row per attempted wallet, most of which fail because
-- the user is not a Base App user. Successful sends are kept indefinitely;
-- failures are prunable, and their durable summary lives on the audience row.
CREATE INDEX IF NOT EXISTS idx_notification_sends_prune
  ON notification_sends(created_at)
  WHERE status <> 'sent';

CREATE OR REPLACE FUNCTION prune_notification_sends(p_keep_days INTEGER DEFAULT 14)
RETURNS INTEGER AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM notification_sends
  WHERE status <> 'sent'
    AND created_at < NOW() - (p_keep_days * INTERVAL '1 day');
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$ LANGUAGE plpgsql;
