-- Defense-in-depth: safe partner reward math from sanitized swap volume.
--
-- Root fix lives in swapRecorder (sanitizeSwapUsdScaled) so swap_transactions
-- never stores an absurd amount_usd again, and swap_volume_write_guard.sql blocks
-- high unanchored rows at the database layer. This view-level guard is a second
-- line of defence for partner payouts: high unanchored legacy/future rows count
-- as $0, while real anchored volume is paid by the program rule:
--   reward = amount_usd * 0.2% protocol-fee basis * partner fee-share percent.
-- At the default 50% share, that is 0.1% of referred-user swap volume.
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
  swap_values.amount_usd,
  swaps.occurred_at,
  date_trunc('week', swaps.occurred_at AT TIME ZONE 'UTC')::DATE AS week_start_utc,
  swap_values.protocol_fee_usd,
  (
    swap_values.protocol_fee_usd
    * (fee_history.fee_share_percent / 100::NUMERIC)
  ) AS reward_usd
FROM partner_program_referred_users referred
JOIN partner_fee_share_history fee_history
  ON fee_history.partner_member_id = referred.partner_member_id
JOIN swap_transactions swaps
  ON swaps.user_id = referred.referee_user_id
CROSS JOIN LATERAL (
  SELECT
    CASE
      WHEN swaps.amount_usd IS NULL OR swaps.amount_usd < 0::NUMERIC THEN 0::NUMERIC
      WHEN swaps.amount_usd > 1000::NUMERIC
        AND NOT swap_volume_is_trusted_anchor(swaps.chain_id, swaps.src_token_address)
        AND NOT swap_volume_is_trusted_anchor(swaps.chain_id, swaps.dst_token_address)
        THEN 0::NUMERIC
      ELSE swaps.amount_usd
    END::NUMERIC(20,6) AS amount_usd
) safe_swap
CROSS JOIN LATERAL (
  SELECT
    safe_swap.amount_usd,
    safe_swap.amount_usd * 0.002::NUMERIC AS protocol_fee_usd
) swap_values
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
