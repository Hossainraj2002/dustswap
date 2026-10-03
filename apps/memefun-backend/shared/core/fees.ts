// SYNCED from apps/memefun/src/core/fees.ts by scripts/sync-shared.ts. Edit the original, then run pnpm sync-shared.
import { BPS } from "./constants";
import type { FeeMode } from "./types";

export interface FeeSplitConfig {
  mode: FeeMode;
  /** Platform share of the fee, in bps of the fee. */
  platformShareBps: number;
  /** Referral share, in bps of the platform share. Paid only with a referrer. */
  referralShareBps: number;
  /** Community modes: creator's slice of the non-platform share, in bps. */
  creatorKeepBps: number;
}

export interface FeeSplit {
  total: bigint;
  platform: bigint;
  referral: bigint;
  creator: bigint;
  /** Burn budget, holder rewards or floor liquidity. Zero in creator mode. */
  destination: bigint;
}

function assertBps(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0 || value > BPS) {
    throw new RangeError(`${label} must be an integer between 0 and ${BPS}, got ${value}`);
  }
}

/**
 * Fee charged on a quote amount. Rounds UP so the protocol never
 * under-collects; the contracts use the same rounding.
 */
export function feeOnAmount(amount: bigint, feeBps: number): bigint {
  assertBps(feeBps, "feeBps");
  if (amount < 0n) throw new RangeError("amount must be non-negative");
  const numerator = amount * BigInt(feeBps);
  return (numerator + BigInt(BPS) - 1n) / BigInt(BPS);
}

/**
 * Fee for an exact-output trade, where the user fixes the NET quote amount
 * (quote received on a sell, or quote the pool takes on a buy). Grossed up so
 * the fee is `feeBps` of net + fee, rounded UP like `feeOnAmount`; the hook
 * computes the same `ceil(net * feeBps / (BPS - feeBps))`.
 */
export function feeOnNet(net: bigint, feeBps: number): bigint {
  assertBps(feeBps, "feeBps");
  if (feeBps === BPS) throw new RangeError("feeBps must be below 100% for exact-output trades");
  if (net < 0n) throw new RangeError("amount must be non-negative");
  const denominator = BigInt(BPS - feeBps);
  return (net * BigInt(feeBps) + denominator - 1n) / denominator;
}

/**
 * Splits a collected fee exactly. Each share rounds down and the last share
 * takes the remainder, so platform + referral + creator + destination always
 * equals the fee to the wei.
 */
export function splitFee(fee: bigint, config: FeeSplitConfig, hasReferrer: boolean): FeeSplit {
  if (fee < 0n) throw new RangeError("fee must be non-negative");
  assertBps(config.platformShareBps, "platformShareBps");
  assertBps(config.referralShareBps, "referralShareBps");
  assertBps(config.creatorKeepBps, "creatorKeepBps");

  const platformGross = (fee * BigInt(config.platformShareBps)) / BigInt(BPS);
  const referral = hasReferrer
    ? (platformGross * BigInt(config.referralShareBps)) / BigInt(BPS)
    : 0n;
  const platform = platformGross - referral;
  const rest = fee - platformGross;

  if (config.mode === "creator") {
    return { total: fee, platform, referral, creator: rest, destination: 0n };
  }

  const creator = (rest * BigInt(config.creatorKeepBps)) / BigInt(BPS);
  return { total: fee, platform, referral, creator, destination: rest - creator };
}

/** Human-readable shares of the fee, as fractions summing to 1. */
export function feeShareFractions(config: FeeSplitConfig, hasReferrer: boolean) {
  const platformGross = config.platformShareBps / BPS;
  const referral = hasReferrer ? platformGross * (config.referralShareBps / BPS) : 0;
  const platform = platformGross - referral;
  const rest = 1 - platformGross;
  const creator = config.mode === "creator" ? rest : rest * (config.creatorKeepBps / BPS);
  const destination = config.mode === "creator" ? 0 : rest - creator;
  return { platform, referral, creator, destination };
}
