// Protocol fee rates, measured on Base mainnet rather than read from widget config.
//
// Why these are hardcoded here instead of derived from a column: neither the swap fee nor the
// sweep fee is stored on the row. `swap_transactions` has no fee column (the ALTER TABLE lines in
// sql/swap_volume_schema.sql were never applied) and `sweeps.fee_usd` is null on every row. The
// only fee figures in the database are `sweep_campaign_credits.fee_usd_micro`, which covers the
// campaign window only, and `streak_recovery_events.amount_usd`.
//
// Do NOT use `swap_transactions.metadata.protocolFeeUsd` as the swap fee. That field is
// OpenOcean's `tx_profit_valuation`, their own margin on the trade, and it runs roughly nine
// times smaller than the referrer fee the user actually paid.
//
// Verification (2026-09-21, 504 sampled Base transactions, zero exceptions):
//   - The referrer fee is taken from the swap INPUT token, on 100% of swaps.
//   - ERC-20 inputs leave a Transfer log to the referrer. Native ETH inputs pay via an INTERNAL
//     transfer with no log, so a log-only scan finds the fee on only ~55% of swaps and wrongly
//     looks like partial coverage.
//   - A day-by-day sweep placed the rate change on 2026-06-22, sharp, with no overlap either side.
//   - Re-verified 2026-09-01..09-21: 126/126 at 22.50 bps, so the rate has not moved since.

/** OpenOcean referrer address that receives the swap fee on Base. */
export const SWAP_REFERRER_ADDRESS = "0x0fd79f3ceaE7ddA5cFC15b35188E67EFAc542573";

/** DustSweep router fee collector on Base. */
export const SWEEP_FEE_COLLECTOR_ADDRESS = "0xE09495e955794708D4bC28045C46891cAf643733";

/** UTC instant the swap referrer fee moved from 20.00 bps to 22.50 bps. */
export const SWAP_FEE_RATE_CHANGE_AT = "2026-06-22T00:00:00.000Z";

/** Swap referrer fee as a fraction of input value, before the change. */
export const SWAP_FEE_RATE_BEFORE = 0.002;

/** Swap referrer fee as a fraction of input value, from the change onward. */
export const SWAP_FEE_RATE_AFTER = 0.00225;

/** DustSweep router fee as a fraction of GROSS output. Verified at exactly 200 bps. */
export const SWEEP_FEE_RATE = 0.02;

/** Streak Save price in USD, priced on the day the payment was mined. */
export const STREAK_SAVE_FEE_USD = 1;

/**
 * SQL expression for a swap row's fee in USD, using the day-of `amount_usd` already stored on
 * the row. `alias` is the table alias for `swap_transactions`.
 */
export function swapFeeSql(alias = "t") {
  return `(${alias}.amount_usd * CASE WHEN ${alias}.occurred_at < TIMESTAMPTZ '${SWAP_FEE_RATE_CHANGE_AT}'
            THEN ${SWAP_FEE_RATE_BEFORE} ELSE ${SWAP_FEE_RATE_AFTER} END)`;
}

/**
 * SQL expression for a sweep row's fee in USD. Prefers the chain-verified campaign credit where
 * one exists, otherwise applies the verified 200 bps to the recorded gross output.
 * `s` is the `sweeps` alias, `cr` the `sweep_campaign_credits` alias.
 */
export function sweepFeeSql(s = "s", cr = "cr") {
  return `(CASE WHEN ${cr}.fee_usd_micro IS NOT NULL
                THEN ${cr}.fee_usd_micro / 1e6::numeric
                ELSE COALESCE(${s}.value_usd, 0) * ${SWEEP_FEE_RATE} END)`;
}

/** SQL expression for a sweep row's gross output in USD, verified figure preferred. */
export function sweepGrossSql(s = "s", cr = "cr") {
  return `(CASE WHEN ${cr}.fee_usd_micro IS NOT NULL
                THEN (${cr}.value_usd_micro + ${cr}.fee_usd_micro) / 1e6::numeric
                ELSE COALESCE(${s}.value_usd, 0) END)`;
}
