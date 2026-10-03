import { describe, expect, it } from "vitest";
import { COIN_SUPPLY, TICK_SPACING } from "./constants";
import { openingSqrtPriceX96, sqrtFloor, startTickExact, toUsdE8, type OpeningPriceInput } from "./pool";
import { Q96, getSqrtPriceAtTick } from "./uniswap/tickMath";
import { createRng } from "../lib/preview/random";

const SPACING_FACTOR = 1.0001 ** TICK_SPACING;

function fdvAtSqrtPrice(input: OpeningPriceInput, sqrtPriceX96: bigint): number {
  const ratio = Number(sqrtPriceX96) / Number(Q96);
  const rawPrice = ratio * ratio; // currency1 raw per currency0 raw
  const quoteUsd = Number(input.quoteUsdE8) / 1e8;
  // Coin price in quote raw units per coin raw unit, then scaled to whole units.
  const coinInQuoteRaw = input.coinIsCurrency0 ? rawPrice : 1 / rawPrice;
  const coinPriceUsd = coinInQuoteRaw * 10 ** (18 - input.quoteDecimals) * quoteUsd;
  return coinPriceUsd * Number(COIN_SUPPLY / 10n ** 18n);
}

describe("sqrtFloor", () => {
  it("matches the definition of a floor square root", () => {
    const rand = createRng(7);
    const samples = [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, (1n << 128n) - 1n, 1n << 128n, (1n << 255n) + 12345n];
    for (let i = 0; i < 200; i++) samples.push(BigInt(Math.floor(rand() * 2 ** 53)) * BigInt(Math.floor(rand() * 2 ** 53)) * 1_000_003n);
    for (const x of samples) {
      const s = sqrtFloor(x);
      expect(s * s <= x).toBe(true);
      expect((s + 1n) * (s + 1n) > x).toBe(true);
    }
  });
});

describe("openingSqrtPriceX96", () => {
  it("uses full precision for ordinary prices and agrees with floating point", () => {
    const input = { coinIsCurrency0: false, quoteDecimals: 18, quoteUsdE8: toUsdE8(2751.1205), openingFdvUsdE8: toUsdE8(5000) };
    const fdv = fdvAtSqrtPrice(input, openingSqrtPriceX96(input));
    expect(Math.abs(fdv / 5000 - 1)).toBeLessThan(1e-9);
  });

  it("drops to the reduced-precision branch for an expensive 8-decimal stock at a low FDV", () => {
    // Raw price = 5000 * 1e27 / (1000 * 1e8) = 5e19, above 2^64, so price * 2^192 would overflow.
    const input = { coinIsCurrency0: false, quoteDecimals: 8, quoteUsdE8: toUsdE8(5000), openingFdvUsdE8: toUsdE8(1000) };
    const sqrtPrice = openingSqrtPriceX96(input);
    expect(sqrtPrice % (1n << 32n)).toBe(0n);
    expect(Math.abs(fdvAtSqrtPrice(input, sqrtPrice) / 1000 - 1)).toBeLessThan(1e-9);
  });

  it("rejects non-positive inputs", () => {
    expect(() => openingSqrtPriceX96({ coinIsCurrency0: false, quoteDecimals: 18, quoteUsdE8: 0n, openingFdvUsdE8: 1n })).toThrow(RangeError);
    expect(() => openingSqrtPriceX96({ coinIsCurrency0: false, quoteDecimals: 18, quoteUsdE8: 1n, openingFdvUsdE8: 0n })).toThrow(RangeError);
  });
});

describe("startTickExact", () => {
  it("never opens below the target FDV and at most one spacing above, in both orderings", () => {
    const rand = createRng(42);
    for (let i = 0; i < 400; i++) {
      const quoteDecimals = [6, 8, 18][i % 3] as number;
      const coinIsCurrency0 = rand() < 0.5;
      const quoteUsd = 10 ** (rand() * 5 - 1); // $0.10 to $10,000
      const fdv = 10 ** (3 + rand() * 3); // $1k to $1M
      const input = { coinIsCurrency0, quoteDecimals, quoteUsdE8: toUsdE8(quoteUsd), openingFdvUsdE8: toUsdE8(fdv) };
      const tick = startTickExact(input);
      expect(Math.abs(tick % TICK_SPACING)).toBe(0);
      const target = Number(input.openingFdvUsdE8) / 1e8;
      const opened = fdvAtSqrtPrice(input, getSqrtPriceAtTick(tick));
      expect(opened / target).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(opened / target).toBeLessThan(SPACING_FACTOR * (1 + 1e-9));
    }
  });

  it("snaps toward a pricier coin exactly at the integer level", () => {
    const rand = createRng(99);
    for (let i = 0; i < 200; i++) {
      const coinIsCurrency0 = i % 2 === 0;
      const input = {
        coinIsCurrency0,
        quoteDecimals: [6, 8, 18][i % 3] as number,
        quoteUsdE8: toUsdE8(10 ** (rand() * 4)),
        openingFdvUsdE8: toUsdE8(10 ** (3 + rand() * 3)),
      };
      const sqrtPrice = openingSqrtPriceX96(input);
      const tick = startTickExact(input);
      if (coinIsCurrency0) {
        // Coin is currency0: a higher sqrt price means a pricier coin.
        expect(getSqrtPriceAtTick(tick) >= sqrtPrice).toBe(true);
        expect(getSqrtPriceAtTick(tick - TICK_SPACING) < sqrtPrice).toBe(true);
      } else {
        // Coin is currency1: a lower sqrt price means a pricier coin.
        expect(getSqrtPriceAtTick(tick) <= sqrtPrice).toBe(true);
        expect(getSqrtPriceAtTick(tick + TICK_SPACING) > sqrtPrice).toBe(true);
      }
    }
  });
});
