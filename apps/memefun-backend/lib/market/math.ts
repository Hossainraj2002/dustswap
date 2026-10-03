import { COIN_SUPPLY } from "../../shared/core/constants";
import { getSqrtPriceAtTick } from "../../shared/core/uniswap/tickMath";

/**
 * Exact integer conversions from pool state to the numbers the app shows. Everything stays in
 * bigint until the API formats it; scales are in the names (UsdE8, UsdE18, Wad).
 *
 * Uniswap's price is currency1 per currency0 in raw units: (sqrtPriceX96 / 2^96)^2. A coin is
 * currency0 exactly when its pair asset is currency1 (`quoteIsCurrency0 === false`).
 */
const Q192 = 1n << 192n;
const E18 = 10n ** 18n;
const E28 = 10n ** 28n;
const E36 = 10n ** 36n;

export interface PoolSide {
  quoteIsCurrency0: boolean;
  quoteDecimals: number;
}

/** Whole pair-asset units per whole coin, times 1e18. */
export function priceQuoteWad(sqrtPriceX96: bigint, side: PoolSide): bigint {
  if (sqrtPriceX96 <= 0n) return 0n;
  const square = sqrtPriceX96 * sqrtPriceX96;
  const quoteScale = 10n ** BigInt(side.quoteDecimals);
  return side.quoteIsCurrency0 ? (Q192 * E36) / (square * quoteScale) : (square * E36) / (Q192 * quoteScale);
}

/** USD per whole coin, times 1e18. */
export function priceUsdE18(sqrtPriceX96: bigint, side: PoolSide, quoteUsdE8: bigint): bigint {
  if (sqrtPriceX96 <= 0n || quoteUsdE8 <= 0n) return 0n;
  const square = sqrtPriceX96 * sqrtPriceX96;
  const quoteScale = 10n ** BigInt(side.quoteDecimals);
  return side.quoteIsCurrency0
    ? (Q192 * E28 * quoteUsdE8) / (square * quoteScale)
    : (square * E28 * quoteUsdE8) / (Q192 * quoteScale);
}

/** Market cap as the app defines it: price times every coin not burned (USD, 8 decimals). */
export function marketCapUsdE8(coinPriceUsdE18: bigint, burned: bigint): bigint {
  const counted = COIN_SUPPLY > burned ? COIN_SUPPLY - burned : 0n;
  return (coinPriceUsdE18 * counted) / E28;
}

/** Fully diluted value: price times the whole supply (USD, 8 decimals). */
export function fdvUsdE8(coinPriceUsdE18: bigint): bigint {
  return (coinPriceUsdE18 * COIN_SUPPLY) / E28;
}

/** USD value (8 decimals) of a raw pair-asset amount. */
export function quoteValueUsdE8(amount: bigint, quoteDecimals: number, quoteUsdE8: bigint): bigint {
  return (amount * quoteUsdE8) / 10n ** BigInt(quoteDecimals);
}

/** USD value (8 decimals) of a raw coin amount at a coin price. */
export function coinValueUsdE8(coins: bigint, coinPriceUsdE18: bigint): bigint {
  return (coins * coinPriceUsdE18) / E28;
}

/** The coin price (USD, 18 decimals) at a tick, e.g. the floor's supported price. */
export function priceUsdE18AtTick(tick: number, side: PoolSide, quoteUsdE8: bigint): bigint {
  return priceUsdE18(getSqrtPriceAtTick(tick), side, quoteUsdE8);
}

export const toNumber = {
  usdE8: (value: bigint) => Number(value) / 1e8,
  usdE18: (value: bigint) => Number(value) / 1e18,
  wad: (value: bigint) => Number(value) / 1e18,
  units: (value: bigint, decimals: number) => Number(value) / 10 ** decimals,
  coins: (value: bigint) => Number(value) / Number(E18),
};
