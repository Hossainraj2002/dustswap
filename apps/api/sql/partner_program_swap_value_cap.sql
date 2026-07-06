-- Defense-in-depth: bound the per-swap USD used for partner reward math.
--
-- Root fix lives in swapRecorder (sanitizeSwapUsdScaled) so swap_transactions
-- never stores an absurd amount_usd again. This view-level LEAST() cap is a
-- second line of defence: even if a mispriced row ever slips through, a single
-- swap can contribute at most MAX_SWAP_VALUE_USD (250k) to a partner's
-- qualifying volume / protocol fee / reward. DustSwap is a dust tool — real
-- swaps are a few dollars — so this can never clip a legitimate swap.
--
-- Re-run this after partner_program.sql. CREATE OR REPLACE keeps dependent views
-- (referral_counts, alltime/weekly metrics, referred_user metrics) intact.

CREATE OR REPLACE VIEW partner_program_qualifying_swaps AS
SELECT
  referred.partner_member_id,
  referred.partner_user_id,
  referred.partner_wallet_address,
  referred.partner_status,
  referred.whitelisted_at,
  referred.joined_at,
  referred.referee_user_id,
  referred.referee_address,
  referred.referral_activated_at,
  fee_history.id AS fee_share_history_id,
  fee_history.fee_share_percent,
  GREATEST(
    referred.whitelisted_at,
    referred.referral_activated_at,
    fee_history.effective_at
  ) AS qualifying_from,
  swaps.id AS swap_transaction_id,
  swaps.tx_hash,
  swaps.chain_id,
  LEAST(swaps.amount_usd, 250000::NUMERIC) AS amount_usd,
  swaps.occurred_at,
  date_trunc('week', swaps.occurred_at AT TIME ZONE 'UTC')::DATE AS week_start_utc,
  (LEAST(swaps.amount_usd, 250000::NUMERIC) * 0.002::NUMERIC) AS protocol_fee_usd,
  (
    LEAST(swaps.amount_usd, 250000::NUMERIC)
    * 0.002::NUMERIC
    * (fee_history.fee_share_percent / 100::NUMERIC)
  ) AS reward_usd
FROM partner_program_referred_users referred
JOIN partner_fee_share_history fee_history
  ON fee_history.partner_member_id = referred.partner_member_id
JOIN swap_transactions swaps
  ON swaps.user_id = referred.referee_user_id
WHERE
  swaps.occurred_at >= GREATEST(
    referred.whitelisted_at,
    referred.referral_activated_at,
    fee_history.effective_at
  )
  AND (
    fee_history.ended_at IS NULL
    OR swaps.occurred_at < fee_history.ended_at
  );
