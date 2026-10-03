/**
 * Protocol constants shared by the UI, the preview simulator, and (later) the
 * indexer. Values marked "default" are the launch-settings defaults the owner
 * can change for NEW launches; values marked "hard cap" mirror the bounds that
 * will be compiled into the contracts and can never be exceeded.
 */

export const BPS = 10_000;

/** Every coin: native B20 ASSET, 18 decimals, fixed 1,000,000,000 supply. */
export const COIN_DECIMALS = 18;
export const COIN_SUPPLY_HUMAN = 1_000_000_000;
export const COIN_SUPPLY = 1_000_000_000n * 10n ** 18n;

/** Uniswap v4 pool shape used for every launch. */
export const TICK_SPACING = 200;

/** A wallet that provably cannot move coins. Buybacks send bought coins here. */
export const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD" as const;

/** Native ETH is currency0 = address(0) in Uniswap v4. */
export const NATIVE_ETH = "0x0000000000000000000000000000000000000000" as const;

export const BASE_CHAIN_ID = 8453;
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** Default launch settings (owner-adjustable for new launches). */
export const DEFAULT_LAUNCH_SETTINGS = {
  creationFeeEth: 0,
  feeMinBps: 100,
  feeMaxBps: 500,
  defaultFeeBps: 100,
  platformShareBps: 2_000,
  referralShareBps: 2_500,
  creatorKeepMaxBps: 5_000,
  snipeStartBps: 5_000,
  snipeDurationSec: 15,
  openingFdvUsd: 5_000,
  launchesPaused: false,
} as const;

/** Hard caps (contract constants; settings can never exceed these). */
export const HARD_CAPS = {
  feeMaxBps: 1_000,
  platformShareMaxBps: 5_000,
  referralShareMaxBps: 5_000,
  creatorKeepMaxBps: 5_000,
  snipeStartMaxBps: 9_900,
  snipeDurationMaxSec: 300,
  creationFeeMaxEth: 0.05,
  openingFdvMinUsd: 1_000,
  openingFdvMaxUsd: 1_000_000,
} as const;

/** First-buy size above which the UI warns buyers may read it as a rug risk. */
export const FIRST_BUY_WARN_SUPPLY_FRACTION = 0.05;

/** Base produces a block every 2 seconds. */
export const BASE_BLOCK_TIME_SEC = 2;
