// SYNCED from apps/memefun/src/core/uniswap/swap.ts by scripts/sync-shared.ts. Edit the original, then run pnpm sync-shared.
/**
 * Uniswap v4's exact-input swap loop (Pool.swap) for a pool with a 0 LP fee, over an explicit
 * list of positions instead of the on-chain tick bitmap.
 *
 * memefun pools charge their fee in the hook, and their only liquidity is the launch position
 * plus any floor bands (the hook refuses every other deposit). Given slot0 and those positions,
 * this returns what the PoolManager returns, to the unit: steps break at the same ticks,
 * including the bitmap's 256-spacing word edges where nothing is initialized, and every step
 * rounds the way SwapMath.computeSwapStep does.
 */
import { MAX_SQRT_PRICE, MAX_TICK, MIN_SQRT_PRICE, MIN_TICK, getSqrtPriceAtTick, getTickAtSqrtPrice } from "./tickMath";
import { getAmount0Delta, getAmount1Delta, getNextSqrtPriceFromInput } from "./sqrtPriceMath";

export interface Position {
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

export interface PoolState {
  sqrtPriceX96: bigint;
  /**
   * slot0's tick. After a downward cross v4 leaves it one below the tick of the price, which
   * decides whether a position starting exactly at the price is active.
   */
  tick: number;
  positions: readonly Position[];
  tickSpacing: number;
}

export interface SwapResult {
  /** Input consumed: less than requested only when the pool ran out of liquidity. */
  amountIn: bigint;
  amountOut: bigint;
  sqrtPriceAfterX96: bigint;
  tickAfter: number;
  /** True when the input was not used up (the price reached the swap's limit). */
  partial: boolean;
}

/** Liquidity in range at `tick`, as Pool.modifyLiquidity counts it: tickLower <= tick < tickUpper. */
export function activeLiquidity(positions: readonly Position[], tick: number): bigint {
  let total = 0n;
  for (const p of positions) {
    if (p.tickLower <= tick && tick < p.tickUpper) total += p.liquidity;
  }
  return total;
}

interface TickTable {
  /** Initialized ticks, compressed (tick / spacing), ascending. */
  compressed: number[];
  net: Map<number, bigint>;
}

function tickTable(positions: readonly Position[], spacing: number): TickTable {
  const net = new Map<number, bigint>();
  const initialized = new Set<number>();
  for (const p of positions) {
    if (p.liquidity <= 0n) continue;
    if (p.tickLower >= p.tickUpper || p.tickLower % spacing !== 0 || p.tickUpper % spacing !== 0) {
      throw new RangeError(`invalid position [${p.tickLower}, ${p.tickUpper})`);
    }
    net.set(p.tickLower, (net.get(p.tickLower) ?? 0n) + p.liquidity);
    net.set(p.tickUpper, (net.get(p.tickUpper) ?? 0n) - p.liquidity);
    // A tick stays initialized while any liquidity references it, even when the nets cancel.
    initialized.add(p.tickLower / spacing);
    initialized.add(p.tickUpper / spacing);
  }
  return { compressed: [...initialized].sort((a, b) => a - b), net };
}

/** TickBitmap.nextInitializedTickWithinOneWord, answered from the sorted tick list. */
function nextTickWithinOneWord(
  table: TickTable,
  tick: number,
  spacing: number,
  lte: boolean,
): { next: number; initialized: boolean } {
  // compress() rounds toward negative infinity.
  let compressed = Math.floor(tick / spacing);
  if (lte) {
    const wordStart = Math.floor(compressed / 256) * 256;
    let found: number | undefined;
    for (const c of table.compressed) {
      if (c > compressed) break;
      found = c;
    }
    return found !== undefined && found >= wordStart
      ? { next: found * spacing, initialized: true }
      : { next: wordStart * spacing, initialized: false };
  }
  compressed += 1;
  const wordEnd = Math.floor(compressed / 256) * 256 + 255;
  const found = table.compressed.find((c) => c >= compressed);
  return found !== undefined && found <= wordEnd
    ? { next: found * spacing, initialized: true }
    : { next: wordEnd * spacing, initialized: false };
}

/**
 * slot0's tick for a price: the given one when v4 could hold it (the price's own tick, or one
 * below when the price sits exactly on a tick after a downward cross), otherwise the price's own.
 * A caller that moved the price but kept an old tick still gets an exact swap.
 */
export function consistentTick(sqrtPriceX96: bigint, tick: number): number {
  const own = getTickAtSqrtPrice(sqrtPriceX96);
  if (tick === own) return tick;
  if (tick === own - 1 && getSqrtPriceAtTick(own) === sqrtPriceX96) return tick;
  return own;
}

/**
 * Exact-input swap of `amountIn` into the pool. Without a limit it runs like memefun's router,
 * which sets none (MIN_SQRT_PRICE + 1 or MAX_SQRT_PRICE - 1).
 */
export function swapExactIn(
  state: PoolState,
  zeroForOne: boolean,
  amountIn: bigint,
  sqrtPriceLimitX96: bigint = zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n,
): SwapResult {
  if (amountIn < 0n) throw new RangeError("amountIn must be non-negative");
  const limitPassed = zeroForOne ? sqrtPriceLimitX96 >= state.sqrtPriceX96 : sqrtPriceLimitX96 <= state.sqrtPriceX96;
  if (amountIn === 0n || limitPassed) {
    return { amountIn: 0n, amountOut: 0n, sqrtPriceAfterX96: state.sqrtPriceX96, tickAfter: state.tick, partial: amountIn > 0n };
  }

  const table = tickTable(state.positions, state.tickSpacing);
  let sqrtPrice = state.sqrtPriceX96;
  let tick = consistentTick(state.sqrtPriceX96, state.tick);
  let liquidity = activeLiquidity(state.positions, tick);
  let remaining = amountIn;
  let amountOut = 0n;

  while (remaining !== 0n && sqrtPrice !== sqrtPriceLimitX96) {
    const stepStart = sqrtPrice;
    let { next, initialized } = nextTickWithinOneWord(table, tick, state.tickSpacing, zeroForOne);
    // The bitmap knows nothing of the tick bounds.
    if (next <= MIN_TICK) next = MIN_TICK;
    if (next >= MAX_TICK) next = MAX_TICK;
    const sqrtNext = getSqrtPriceAtTick(next);
    const target = zeroForOne
      ? sqrtNext < sqrtPriceLimitX96
        ? sqrtPriceLimitX96
        : sqrtNext
      : sqrtNext > sqrtPriceLimitX96
        ? sqrtPriceLimitX96
        : sqrtNext;

    // SwapMath.computeSwapStep, exact input, 0 fee.
    const maxIn = zeroForOne
      ? getAmount0Delta(target, sqrtPrice, liquidity, true)
      : getAmount1Delta(sqrtPrice, target, liquidity, true);
    let stepIn: bigint;
    if (remaining >= maxIn) {
      stepIn = maxIn;
      sqrtPrice = target;
    } else {
      stepIn = remaining;
      sqrtPrice = getNextSqrtPriceFromInput(sqrtPrice, liquidity, remaining, zeroForOne);
    }
    amountOut += zeroForOne
      ? getAmount1Delta(sqrtPrice, stepStart, liquidity, false)
      : getAmount0Delta(stepStart, sqrtPrice, liquidity, false);
    remaining -= stepIn;

    if (sqrtPrice === sqrtNext) {
      if (initialized) {
        const net = table.net.get(next) ?? 0n;
        liquidity += zeroForOne ? -net : net;
      }
      tick = zeroForOne ? next - 1 : next;
    } else if (sqrtPrice !== stepStart) {
      tick = getTickAtSqrtPrice(sqrtPrice);
    }
  }

  return { amountIn: amountIn - remaining, amountOut, sqrtPriceAfterX96: sqrtPrice, tickAfter: tick, partial: remaining > 0n };
}
