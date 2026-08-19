-- ============================================================================
-- Single authoritative "everything is over" moment for a campaign.
--
-- claims_close_at replaces the hardcoded 14-day grace constant. After it
-- passes the campaign reads as `closed`, the status endpoint stops returning
-- it, and every piece of campaign UI (progress bar, tier tracker, leaderboard)
-- disappears on its own. One timestamp drives the whole teardown, so there is
-- no way for one surface to linger after another.
-- ============================================================================

ALTER TABLE sweep_campaigns
  ADD COLUMN IF NOT EXISTS claims_close_at TIMESTAMPTZ;
