// SYNCED from apps/memefun/src/core/pool.ts by scripts/sync-shared.ts. Edit the original, then run pnpm sync-shared.
/**
 * The memefun launch pool: the coin's whole fixed supply as ONE single-sided,
 * permanently locked Uniswap v4 position starting at the opening market cap.
 * Inside that range the price follows a constant-product curve whose virtual
 * quote reserve equals the opening market cap, so it behaves like a bonding
 * curve while trading on Uniswap from the first block.
 */
import { BPS, COIN_DECIMALS, COIN_SUPPLY, COIN_SUPPLY_HUMAN, TICK_SPACING } from "./constants";
import { feeOnAmount } from "./fees";
import {
  MAX_SQRT_PRICE,
  MAX_TICK,
  MIN_SQRT_PRICE,
  MIN_TICK,
  Q128,
  Q96,
  getSqrtPriceAtTick,
  getTickAtSqrtPrice,
  maxUsableTick,
  minUsableTick,
} from "./uniswap/tickMath";
import { getLiquidityForAmount0, getLiquidityForAmount1, mulDiv } from "./uniswap/sqrtPriceMath";
import { type Position, swapExactIn } from "./uniswap/swap";

export interface LaunchPoolInput {
  /** True when the coin's address sorts below the quote's (coin is currency0). */
  coinIsCurrency0: boolean;
  quoteDecimals: number;
  /** USD value of one whole quote unit (ETH price, 1 for USDC, NAV for stocks). */
  quoteUsd: number;
  /** Target opening fully diluted value in USD. */
  openingFdvUsd: number;
  coinDecimals?: number;
  supply?: bigint;
  tickSpacing?: number;
}

/**
 * A coin's pool: the launch position (the whole supply, `liquidity` over [tickLower, tickUpper))
 * plus any floor bands, at the current price.
 */
export interface LaunchPool {
  coinIsCurrency0: boolean;
  coinDecimals: number;
  quoteDecimals: number;
  startTick: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  sqrtPriceX96: bigint;
  /** slot0's tick (see PoolState.tick in uniswap/swap.ts). */
  tick: number;
  /** Floor-mode coins: the quote-only bands placed under the price. */
  floors?: readonly Position[];
}

export function sortsBefore(a: string, b: string): boolean {
  return BigInt(a) < BigInt(b);
}

/** Inputs to the opening price, in the integer units the contracts use. */
export interface OpeningPriceInput {
  coinIsCurrency0: boolean;
  quoteDecimals: number;
  /** USD value of one whole quote unit with 8 decimals (Chainlink scale). */
  quoteUsdE8: bigint;
  /** Target opening fully diluted value in USD with 8 decimals. */
  openingFdvUsdE8: bigint;
  supply?: bigint;
  tickSpacing?: number;
}

/** Prices below 2^64 keep full precision; see `openingSqrtPriceX96`. */
const FULL_PRECISION_PRICE_LIMIT = 1n << 64n;
const Q192 = 1n << 192n;

/** Floor square root, the same result as OpenZeppelin `Math.sqrt`. */
export function sqrtFloor(value: bigint): bigint {
  if (value < 0n) throw new RangeError("sqrt of a negative number");
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + value / x) >> 1n;
  }
  return x;
}

/** Converts a USD amount to the 8-decimal integer the contracts use. */
export function toUsdE8(usd: number): bigint {
  if (!Number.isFinite(usd) || !(usd > 0)) throw new RangeError("USD amount must be positive");
  return BigInt(Math.round(usd * 1e8));
}

/**
 * Opening sqrt price, with exactly the integer steps of LaunchMath.openingSqrtPriceX96 on chain.
 *
 * The raw Uniswap price (currency1 raw units per currency0 raw unit) is num / den. Below 2^64
 * it is computed at full precision as sqrt(price * 2^192). Above that, which only happens for an
 * expensive 8-decimal stock at a low FDV, price * 2^192 would overflow 256 bits, so the contract
 * uses sqrt(price * 2^128) * 2^32 instead, and so must we.
 */
export function openingSqrtPriceX96(input: OpeningPriceInput): bigint {
  const supply = input.supply ?? COIN_SUPPLY;
  if (input.quoteUsdE8 <= 0n || input.openingFdvUsdE8 <= 0n || supply <= 0n) {
    throw new RangeError("quote price, opening FDV and supply must be positive");
  }
  const coinSide = input.quoteUsdE8 * supply;
  const quoteSide = input.openingFdvUsdE8 * 10n ** BigInt(input.quoteDecimals);
  const [num, den] = input.coinIsCurrency0 ? [quoteSide, coinSide] : [coinSide, quoteSide];
  const sqrtPrice =
    num / den < FULL_PRECISION_PRICE_LIMIT ? sqrtFloor(mulDiv(num, Q192, den)) : sqrtFloor(mulDiv(num, Q128, den)) << 32n;
  if (sqrtPrice < MIN_SQRT_PRICE || sqrtPrice >= MAX_SQRT_PRICE) {
    throw new RangeError("opening price outside the representable range");
  }
  return sqrtPrice;
}

/**
 * Starting tick for an opening FDV, snapped to the tick spacing in the
 * direction that makes the coin slightly MORE expensive, so the real opening
 * market cap is never below the target (at most one spacing, about 2%, above).
 * Integer-exact: this is the tick MemeFunFactory computes on chain.
 */
export function startTickExact(input: OpeningPriceInput): number {
  const spacing = input.tickSpacing ?? TICK_SPACING;
  const sqrtPrice = openingSqrtPriceX96(input);
  const tick = getTickAtSqrtPrice(sqrtPrice);

  let snapped: number;
  if (input.coinIsCurrency0) {
    // A higher tick means a pricier coin: round the true (fractional) tick up.
    // getTickAtSqrtPrice floors, so step up first unless the price sits exactly on a tick.
    const ceilTick = getSqrtPriceAtTick(tick) === sqrtPrice ? tick : tick + 1;
    snapped = Math.ceil(ceilTick / spacing) * spacing;
  } else {
    // A higher tick means a cheaper coin: round down.
    snapped = Math.floor(tick / spacing) * spacing;
  }
  // Math.ceil can return -0, which must never reach an encoded PoolKey.
  if (snapped === 0) snapped = 0;

  const low = minUsableTick(spacing) + spacing;
  const high = maxUsableTick(spacing) - spacing;
  if (snapped < low || snapped > high) {
    throw new RangeError(`opening price outside the usable tick range (${snapped})`);
  }
  return snapped;
}

/** Float-input convenience for the UI; converts to the contracts' 8-decimal USD integers. */
export function startTickForFdv(input: LaunchPoolInput): number {
  if (!(input.quoteUsd > 0) || !(input.openingFdvUsd > 0)) {
    throw new RangeError("quoteUsd, openingFdvUsd and supply must be positive");
  }
  return startTickExact({
    coinIsCurrency0: input.coinIsCurrency0,
    quoteDecimals: input.quoteDecimals,
    quoteUsdE8: toUsdE8(input.quoteUsd),
    openingFdvUsdE8: toUsdE8(input.openingFdvUsd),
    supply: input.supply,
    tickSpacing: input.tickSpacing,
  });
}

/**
 * v4 per-tick liquidity cap for spacing 200 (Pool.tickSpacingToMaxLiquidityPerTick): uint128.max
 * over the 8,874 ticks from -4437 to 4436 spacings. A launch whose whole-supply position would
 * exceed it cannot be added to the pool, so LaunchMath rejects it and so do we.
 */
export const MAX_LIQUIDITY_PER_TICK = ((1n << 128n) - 1n) / 8874n;

/** Builds the launch position exactly as the factory will deposit it. */
export function createLaunchPool(input: LaunchPoolInput): LaunchPool {
  return launchPoolAt(startTickForFdv(input), input.coinIsCurrency0, input.quoteDecimals, input);
}

/**
 * The launch pool for a known start tick, exactly as MemeFunFactory seeds it
 * (LaunchMath.launchRange and liquidityForSupply): the whole supply, coin-only.
 */
export function launchPoolAt(
  startTick: number,
  coinIsCurrency0: boolean,
  quoteDecimals: number,
  options: { coinDecimals?: number; supply?: bigint; tickSpacing?: number } = {},
): LaunchPool {
  const coinDecimals = options.coinDecimals ?? COIN_DECIMALS;
  const spacing = options.tickSpacing ?? TICK_SPACING;
  const supply = options.supply ?? COIN_SUPPLY;
  const sqrtStart = getSqrtPriceAtTick(startTick);

  let tickLower: number;
  let tickUpper: number;
  let liquidity: bigint;
  if (coinIsCurrency0) {
    // Coin-only liquidity must sit ABOVE the current price.
    tickLower = startTick;
    tickUpper = maxUsableTick(spacing);
    liquidity = getLiquidityForAmount0(sqrtStart, getSqrtPriceAtTick(tickUpper), supply);
  } else {
    // Coin-only liquidity must sit BELOW the current price.
    tickLower = minUsableTick(spacing);
    tickUpper = startTick;
    liquidity = getLiquidityForAmount1(getSqrtPriceAtTick(tickLower), sqrtStart, supply);
  }
  if (liquidity > MAX_LIQUIDITY_PER_TICK) {
    throw new RangeError("opening price too close to the end of the tick range for the whole supply");
  }

  return {
    coinIsCurrency0,
    coinDecimals,
    quoteDecimals,
    startTick,
    tickLower,
    tickUpper,
    liquidity,
    sqrtPriceX96: sqrtStart,
    tick: startTick,
  };
}

/** The launch position's range: coin-only, above the price for currency0 and below it for currency1. */
export function launchRange(startTick: number, coinIsCurrency0: boolean): [number, number] {
  return coinIsCurrency0 ? [startTick, maxUsableTick(TICK_SPACING)] : [minUsableTick(TICK_SPACING), startTick];
}

/** A live pool as the index reports it (GET /v1/coins/:address/pool). */
export interface LivePoolInput {
  coinIsCurrency0: boolean;
  quoteDecimals: number;
  startTick: number;
  /** The launch position's liquidity. */
  liquidity: bigint;
  sqrtPriceX96: bigint;
  tick: number;
  floors: readonly Position[];
}

export function livePool(input: LivePoolInput): LaunchPool {
  const [tickLower, tickUpper] = launchRange(input.startTick, input.coinIsCurrency0);
  return {
    coinIsCurrency0: input.coinIsCurrency0,
    coinDecimals: COIN_DECIMALS,
    quoteDecimals: input.quoteDecimals,
    startTick: input.startTick,
    tickLower,
    tickUpper,
    liquidity: input.liquidity,
    sqrtPriceX96: input.sqrtPriceX96,
    tick: input.tick,
    floors: input.floors,
  };
}

function swapPool(pool: LaunchPool, zeroForOne: boolean, amountIn: bigint) {
  const launch: Position = { tickLower: pool.tickLower, tickUpper: pool.tickUpper, liquidity: pool.liquidity };
  return swapExactIn(
    {
      sqrtPriceX96: pool.sqrtPriceX96,
      tick: pool.tick,
      positions: pool.floors?.length ? [launch, ...pool.floors] : [launch],
      tickSpacing: TICK_SPACING,
    },
    zeroForOne,
    amountIn,
  );
}

/** Human price of one coin in quote units at a sqrt price. */
export function coinPriceInQuote(pool: Pick<LaunchPool, "coinIsCurrency0" | "coinDecimals" | "quoteDecimals">, sqrtPriceX96: bigint): number {
  const ratio = Number(sqrtPriceX96) / Number(Q96);
  const rawPrice = ratio * ratio;
  if (pool.coinIsCurrency0) {
    return rawPrice * 10 ** (pool.coinDecimals - pool.quoteDecimals);
  }
  return 1 / (rawPrice * 10 ** (pool.quoteDecimals - pool.coinDecimals));
}

export function fdvInQuote(pool: LaunchPool, sqrtPriceX96 = pool.sqrtPriceX96): number {
  return coinPriceInQuote(pool, sqrtPriceX96) * COIN_SUPPLY_HUMAN;
}

export interface TradeQuote {
  side: "buy" | "sell";
  /** Quote amount for buys, coin amount for sells (raw units). */
  amountIn: bigint;
  /** Coin amount for buys, quote amount for sells, after the fee (raw units). */
  amountOut: bigint;
  /** Fee in raw quote units. */
  fee: bigint;
  feeBps: number;
  sqrtPriceAfterX96: bigint;
  tickAfter: number;
  /** Spot price before and after, in quote per coin. */
  priceBefore: number;
  priceAfter: number;
  /** How much worse the average fill is than the spot price, as a fraction. */
  priceImpact: number;
  /** True if the request was larger than the position can fill. */
  partial: boolean;
}

/** Exact-input buy: pay quote, receive coin. Fee comes off the quote input. */
export function quoteBuy(pool: LaunchPool, quoteIn: bigint, feeBps: number): TradeQuote {
  const fee = feeOnAmount(quoteIn, feeBps);
  const swapIn = quoteIn - fee;
  // Quote is currency0 exactly when the coin is currency1.
  const zeroForOne = !pool.coinIsCurrency0;
  const step = swapPool(pool, zeroForOne, swapIn);
  const priceBefore = coinPriceInQuote(pool, pool.sqrtPriceX96);
  const priceAfter = coinPriceInQuote(pool, step.sqrtPriceAfterX96);
  const coinOutHuman = Number(step.amountOut) / 10 ** pool.coinDecimals;
  const quoteInHuman = Number(step.amountIn) / 10 ** pool.quoteDecimals;
  const avgPrice = coinOutHuman > 0 ? quoteInHuman / coinOutHuman : priceBefore;
  return {
    side: "buy",
    amountIn: quoteIn,
    amountOut: step.amountOut,
    fee,
    feeBps,
    sqrtPriceAfterX96: step.sqrtPriceAfterX96,
    tickAfter: step.tickAfter,
    priceBefore,
    priceAfter,
    priceImpact: priceBefore > 0 ? Math.max(0, avgPrice / priceBefore - 1) : 0,
    partial: step.partial,
  };
}

/** Exact-input sell: pay coin, receive quote. Fee comes off the quote output. */
export function quoteSell(pool: LaunchPool, coinIn: bigint, feeBps: number): TradeQuote {
  const zeroForOne = pool.coinIsCurrency0;
  const step = swapPool(pool, zeroForOne, coinIn);
  const fee = feeOnAmount(step.amountOut, feeBps);
  const priceBefore = coinPriceInQuote(pool, pool.sqrtPriceX96);
  const priceAfter = coinPriceInQuote(pool, step.sqrtPriceAfterX96);
  const coinInHuman = Number(step.amountIn) / 10 ** pool.coinDecimals;
  const quoteOutHuman = Number(step.amountOut) / 10 ** pool.quoteDecimals;
  const avgPrice = coinInHuman > 0 ? quoteOutHuman / coinInHuman : priceBefore;
  return {
    side: "sell",
    amountIn: coinIn,
    amountOut: step.amountOut - fee,
    fee,
    feeBps,
    sqrtPriceAfterX96: step.sqrtPriceAfterX96,
    tickAfter: step.tickAfter,
    priceBefore,
    priceAfter,
    priceImpact: priceBefore > 0 ? Math.max(0, 1 - avgPrice / priceBefore) : 0,
    partial: step.partial,
  };
}

/** Applies a quote to the pool (returns the new pool state). */
export function applyQuote(pool: LaunchPool, quote: TradeQuote): LaunchPool {
  return { ...pool, sqrtPriceX96: quote.sqrtPriceAfterX96, tick: quote.tickAfter };
}

/** Minimum output after slippage, rounded down. */
export function minOut(amountOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= BPS) {
    throw new RangeError("slippageBps must be an integer in [0, 10000)");
  }
  return (amountOut * BigInt(BPS - slippageBps)) / BigInt(BPS);
}

export const LAUNCH_POOL_TICK_BOUNDS = { MIN_TICK, MAX_TICK } as const;
