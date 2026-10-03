import { describe, expect, it } from "vitest";
import { COIN_SUPPLY, TICK_SPACING } from "../constants";
import { launchPoolAt } from "../pool";
import { getAmount0Delta, getLiquidityForAmount0 } from "./sqrtPriceMath";
import { activeLiquidity, consistentTick, swapExactIn, type Position } from "./swap";
import { getSqrtPriceAtTick, getTickAtSqrtPrice } from "./tickMath";

// The exact-to-the-unit proof is test/vectors/swaps.json, replayed against a real PoolManager by
// packages/memefun-contracts/test/unit/SwapVectors.t.sol. These cover the edges by name.

// An ETH pair at a $5K open with ETH at $3,000: the coin is currency1 and the start tick is 202,000.
const launch = launchPoolAt(202_000, false, 18);
const launchPosition: Position = { tickLower: launch.tickLower, tickUpper: launch.tickUpper, liquidity: launch.liquidity };
const state = (positions: Position[], sqrtPriceX96 = launch.sqrtPriceX96, tick = launch.tick) => ({
  sqrtPriceX96,
  tick,
  positions,
  tickSpacing: TICK_SPACING,
});

describe("swapExactIn", () => {
  it("counts a position as active exactly on [tickLower, tickUpper)", () => {
    const p: Position = { tickLower: -400, tickUpper: 400, liquidity: 7n };
    expect(activeLiquidity([p], -400)).toBe(7n);
    expect(activeLiquidity([p], 399)).toBe(7n);
    expect(activeLiquidity([p], 400)).toBe(0n);
  });

  it("buys from a fresh launch: the price starts on the position's upper edge, which is crossed first", () => {
    // The coin is currency1, so its launch range ends at the start price and nothing is active there.
    expect(activeLiquidity([launchPosition], launch.tick)).toBe(0n);
    const r = swapExactIn(state([launchPosition]), true, 10n ** 17n);
    expect(r.partial).toBe(false);
    expect(r.amountOut).toBeGreaterThan(0n);
    expect(r.tickAfter).toBeLessThan(launch.tick);
  });

  it("cannot sell into a fresh launch: nothing is above the price, so it runs to the limit with no output", () => {
    const r = swapExactIn(state([launchPosition]), false, 10n ** 20n);
    expect(r.amountOut).toBe(0n);
    expect(r.amountIn).toBe(0n);
    expect(r.partial).toBe(true);
  });

  it("a floor band under the price makes a large sell pay more than the launch position alone", () => {
    // Buy first so there is something to sell, then put a quote-only band just above the start
    // tick (coin is currency1: above the tick is below the coin's price).
    const bought = swapExactIn(state([launchPosition]), true, 5n * 10n ** 17n);
    const after = state([launchPosition], bought.sqrtPriceAfterX96, bought.tickAfter);
    const band: Position = {
      tickLower: launch.tick + 2_000,
      tickUpper: launch.tick + 8_000,
      liquidity: getLiquidityForAmount0(getSqrtPriceAtTick(launch.tick + 2_000), getSqrtPriceAtTick(launch.tick + 8_000), 10n ** 17n),
    };
    const sellAll = bought.amountOut + 10n ** 26n; // more than was bought: runs past the start price
    const without = swapExactIn(after, false, sellAll);
    const withBand = swapExactIn({ ...after, positions: [launchPosition, band] }, false, sellAll);
    expect(withBand.amountOut).toBeGreaterThan(without.amountOut);
    // The extra is the band's quote, less the rounding of sizing its liquidity.
    const extra = withBand.amountOut - without.amountOut;
    expect(extra <= 10n ** 17n).toBe(true);
    expect(Number(extra) / 1e17).toBeGreaterThan(1 - 1e-9);
  });

  it("matches the closed form inside one position and one bitmap word", () => {
    const sqrtLower = getSqrtPriceAtTick(0);
    const sqrtUpper = getSqrtPriceAtTick(20_000);
    const liquidity = getLiquidityForAmount0(sqrtLower, sqrtUpper, COIN_SUPPLY);
    const p: Position = { tickLower: 0, tickUpper: 20_000, liquidity };
    const start = getSqrtPriceAtTick(10_000);
    const r = swapExactIn(state([p], start, 10_000), true, 10n ** 18n);
    // zeroForOne pays currency0: the input equals the amount0 between the two prices, rounded up.
    expect(getAmount0Delta(r.sqrtPriceAfterX96, start, liquidity, true)).toBeGreaterThanOrEqual(r.amountIn - 1n);
    expect(r.amountIn).toBe(10n ** 18n);
    expect(r.tickAfter).toBe(getTickAtSqrtPrice(r.sqrtPriceAfterX96));
  });

  it("keeps v4's tick one below a crossed edge, and repairs a stale tick", () => {
    const edge = getSqrtPriceAtTick(600);
    expect(consistentTick(edge, 600)).toBe(600);
    expect(consistentTick(edge, 599)).toBe(599);
    expect(consistentTick(edge, 200)).toBe(600);
    expect(consistentTick(edge + 1n, 599)).toBe(600);
  });

  it("refuses positions off the tick spacing", () => {
    expect(() => swapExactIn(state([{ tickLower: 1, tickUpper: 400, liquidity: 1n }]), true, 1n)).toThrow(RangeError);
  });
});
