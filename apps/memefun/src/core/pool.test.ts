import { describe, expect, it } from "vitest";
import { COIN_SUPPLY, TICK_SPACING } from "./constants";
import {
  coinPriceInQuote,
  createLaunchPool,
  fdvInQuote,
  minOut,
  quoteBuy,
  quoteSell,
  sortsBefore,
  type LaunchPool,
} from "./pool";
import { getSqrtPriceAtTick } from "./uniswap/tickMath";
import { getAmount0Delta, getAmount1Delta } from "./uniswap/sqrtPriceMath";

const ONE_ETH = 10n ** 18n;
const SPACING_FACTOR = 1.0001 ** TICK_SPACING; // one tick spacing, about 2.02%

const cases = [
  { label: "ETH, coin is currency1", coinIsCurrency0: false, quoteDecimals: 18, quoteUsd: 3000 },
  { label: "USDC, coin is currency1", coinIsCurrency0: false, quoteDecimals: 6, quoteUsd: 1 },
  { label: "stock (18 dec), coin is currency0", coinIsCurrency0: true, quoteDecimals: 18, quoteUsd: 182.4 },
  { label: "stock (6 dec), coin is currency0", coinIsCurrency0: true, quoteDecimals: 6, quoteUsd: 241.1 },
  { label: "stock (8 dec), coin is currency1", coinIsCurrency0: false, quoteDecimals: 8, quoteUsd: 455.9 },
] as const;

function poolFor(c: (typeof cases)[number], openingFdvUsd = 5000): LaunchPool {
  return createLaunchPool({ ...c, openingFdvUsd });
}

describe("createLaunchPool", () => {
  for (const c of cases) {
    it(`${c.label}: opens at or just above the target market cap`, () => {
      const pool = poolFor(c);
      expect(Math.abs(pool.startTick % TICK_SPACING)).toBe(0);
      expect(Object.is(pool.startTick, -0)).toBe(false);
      const fdvUsd = fdvInQuote(pool) * c.quoteUsd;
      expect(fdvUsd).toBeGreaterThanOrEqual(5000 * (1 - 1e-9));
      expect(fdvUsd).toBeLessThanOrEqual(5000 * SPACING_FACTOR * (1 + 1e-9));
    });

    it(`${c.label}: the position holds the whole supply and no more`, () => {
      const pool = poolFor(c);
      const lower = getSqrtPriceAtTick(pool.tickLower);
      const upper = getSqrtPriceAtTick(pool.tickUpper);
      const needed = pool.coinIsCurrency0
        ? getAmount0Delta(pool.sqrtPriceX96, upper, pool.liquidity, true)
        : getAmount1Delta(lower, pool.sqrtPriceX96, pool.liquidity, true);
      expect(needed <= COIN_SUPPLY).toBe(true);
      // Rounding leaves at most dust behind (far below one whole coin).
      expect(COIN_SUPPLY - needed < 10n ** 12n).toBe(true);
    });

    it(`${c.label}: buys raise the price and follow a constant-product curve`, () => {
      const pool = poolFor(c);
      const unit = 10n ** BigInt(c.quoteDecimals);
      const virtualQuote = fdvInQuote(pool); // opening FDV equals the virtual quote reserve
      const quoteIn = unit / 2n; // half a unit of quote, 0 fee
      const quote = quoteBuy(pool, quoteIn, 0);
      expect(quote.priceAfter).toBeGreaterThan(quote.priceBefore);
      const x = Number(quoteIn) / Number(unit);
      const expectedFraction = x / (virtualQuote + x);
      const actualFraction = Number(quote.amountOut) / Number(COIN_SUPPLY);
      expect(Math.abs(actualFraction / expectedFraction - 1)).toBeLessThan(1e-6);
    });

    it(`${c.label}: a buy then a full sell returns less than was paid, by about two fees`, () => {
      const pool = poolFor(c);
      const unit = 10n ** BigInt(c.quoteDecimals);
      const quoteIn = unit / 10n;
      const buy = quoteBuy(pool, quoteIn, 100);
      const afterBuy = { ...pool, sqrtPriceX96: buy.sqrtPriceAfterX96 };
      const sell = quoteSell(afterBuy, buy.amountOut, 100);
      expect(sell.amountOut < quoteIn).toBe(true);
      const returned = Number(sell.amountOut) / Number(quoteIn);
      expect(returned).toBeGreaterThan(0.98 - 1e-6);
      expect(returned).toBeLessThan(0.9901);
      expect(sell.priceAfter).toBeLessThan(sell.priceBefore);
    });
  }

  it("ETH pool: 1 ETH at a 1% fee buys roughly 37% of supply at a $5K open", () => {
    const pool = poolFor(cases[0]);
    const quote = quoteBuy(pool, ONE_ETH, 100);
    expect(quote.fee).toBe(ONE_ETH / 100n);
    const fraction = Number(quote.amountOut) / Number(COIN_SUPPLY);
    expect(fraction).toBeGreaterThan(0.3);
    expect(fraction).toBeLessThan(0.4);
  });

  it("selling into a fresh pool fills nothing", () => {
    const pool = poolFor(cases[0]);
    const sell = quoteSell(pool, 10n ** 24n, 100);
    expect(sell.amountOut).toBe(0n);
    expect(sell.partial).toBe(true);
  });

  it("both currency orderings price the same economics", () => {
    const asCurrency1 = createLaunchPool({ coinIsCurrency0: false, quoteDecimals: 18, quoteUsd: 3000, openingFdvUsd: 5000 });
    const asCurrency0 = createLaunchPool({ coinIsCurrency0: true, quoteDecimals: 18, quoteUsd: 3000, openingFdvUsd: 5000 });
    const a = quoteBuy(asCurrency1, ONE_ETH / 4n, 100).amountOut;
    const b = quoteBuy(asCurrency0, ONE_ETH / 4n, 100).amountOut;
    const ratio = Number(a) / Number(b);
    expect(ratio).toBeGreaterThan(1 / SPACING_FACTOR - 1e-6);
    expect(ratio).toBeLessThan(SPACING_FACTOR + 1e-6);
  });

  it("successive buys always raise the price", () => {
    let pool = poolFor(cases[1]);
    let last = coinPriceInQuote(pool, pool.sqrtPriceX96);
    for (let i = 0; i < 25; i += 1) {
      const buy = quoteBuy(pool, 250n * 10n ** 6n, 150);
      pool = { ...pool, sqrtPriceX96: buy.sqrtPriceAfterX96 };
      const price = coinPriceInQuote(pool, pool.sqrtPriceX96);
      expect(price).toBeGreaterThan(last);
      last = price;
    }
  });

  it("rejects a market cap the tick range cannot express", () => {
    expect(() => createLaunchPool({ coinIsCurrency0: false, quoteDecimals: 18, quoteUsd: 3000, openingFdvUsd: 0 })).toThrow(RangeError);
  });
});

describe("minOut", () => {
  it("applies slippage rounding down", () => {
    expect(minOut(10_000n, 100)).toBe(9_900n);
    expect(minOut(999n, 50)).toBe(994n);
    expect(() => minOut(1n, 10_000)).toThrow(RangeError);
  });
});

describe("sortsBefore", () => {
  it("compares addresses numerically", () => {
    expect(sortsBefore("0x0000000000000000000000000000000000000000", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")).toBe(true);
    expect(sortsBefore("0xB200000000000000000000000000000000000001", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")).toBe(false);
  });
});
