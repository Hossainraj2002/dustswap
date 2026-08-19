-- ============================================================================
-- Leaderboard prizes become USER-CLAIMED (pull) instead of admin-pushed.
--
-- Safety model, identical in spirit to the tier claims:
--   * finalize() is the ONLY thing that creates a prize row, and it reads the
--     leaderboard RPC. A wallet outside the top 50 has no row, so there is
--     nothing for it to claim. The claim endpoint releases a pre-computed
--     entitlement; it never grants one.
--   * The amount is fixed by campaign config at finalize time. Nothing the
--     claimer sends can influence it.
--   * prize_claims_open_at is the admin gate. Until it is set AND reached,
--     no prize can be released, even by a genuine winner.
-- ============================================================================

ALTER TABLE sweep_campaigns
  ADD COLUMN IF NOT EXISTS prize_claims_open_at TIMESTAMPTZ;

-- 'awaiting_claim' = finalize created it, the winner has not claimed it yet.
ALTER TABLE sweep_campaign_claims
  DROP CONSTRAINT IF EXISTS sweep_campaign_claims_status_check;

ALTER TABLE sweep_campaign_claims
  ADD CONSTRAINT sweep_campaign_claims_status_check
  CHECK (status IN ('awaiting_claim','pending_approval','pending_payout','sending','paid','failed'));

CREATE INDEX IF NOT EXISTS idx_scclaims_prize_awaiting
  ON sweep_campaign_claims (campaign_id, user_id)
  WHERE kind = 'prize' AND status = 'awaiting_claim';
