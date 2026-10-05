import { describe, expect, it } from "vitest";
import { COIN_SUPPLY } from "@/core/constants";
import { coinPriceInQuote, createLaunchPool, quoteBuy } from "@/core/pool";
import { ETH, USDC } from "./quotes";
import { equalAllocations, aggregateCoinMarkets, selectCoinMarket, tradeQuoteSymbol } from "./markets";
import type { Coin, CoinMarket } from "./types";

describe("multi-pool launch allocation", () => {
  for (const count of [2, 3, 5]) it(`${count} pools conserve supply and keep the global opening price`, () => {
    const allocations = equalAllocations(count);
    expect(allocations.reduce((sum, amount) => sum + amount, 0n)).toBe(COIN_SUPPLY);
    expect(allocations[count - 1]! - allocations[0]!).toBeLessThan(BigInt(count));
    for (const quote of [ETH, USDC]) {
      const input = { coinIsCurrency0: false, quoteDecimals: quote.decimals, quoteUsd: quote.usdPrice, openingFdvUsd: 5000 };
      const whole = createLaunchPool(input);
      const slice = createLaunchPool({ ...input, allocationSupply: allocations[0] });
      expect(slice.startTick).toBe(whole.startTick);
      expect(coinPriceInQuote(slice, slice.sqrtPriceX96)).toBe(coinPriceInQuote(whole, whole.sqrtPriceX96));
      expect(coinPriceInQuote(slice, slice.sqrtPriceX96) * quote.usdPrice * 1e9).toBeGreaterThanOrEqual(5000 * 0.99999);
      expect(coinPriceInQuote(slice, slice.sqrtPriceX96) * quote.usdPrice * 1e9).toBeLessThan(5102);
      expect(slice.liquidity).toBeLessThan(whole.liquidity);
      const buy = 10n ** BigInt(quote.decimals);
      expect(quoteBuy(slice, buy, 100).amountOut).toBeLessThan(quoteBuy(whole, buy, 100).amountOut);
    }
  });
  it("rejects zero and more than five pools", () => {
    expect(() => equalAllocations(0)).toThrow();
    expect(() => equalAllocations(6)).toThrow();
  });
});

describe("market views", () => {
  const pools = [{ poolId: "0x01", quote: ETH, supplyRaw: (COIN_SUPPLY / 2n).toString(), supplyFraction: 0.5, poolCoins: 300,
    priceQuote: 1, priceUsd: 3, liquidityUsd: 20, volume24hUsd: 40, volumeTotalUsd: 80, stats: { creatorEarnedQuote: 4 } },
    { poolId: "0x02", quote: USDC, supplyRaw: (COIN_SUPPLY / 2n).toString(), supplyFraction: 0.5, poolCoins: 100,
      priceQuote: 1, priceUsd: 1, liquidityUsd: 10, volume24hUsd: 5, volumeTotalUsd: 10, stats: { creatorEarnedQuote: 8 } }] as unknown as CoinMarket[];
  const coin = { quote: ETH, priceUsd: 3, marketCapUsd: 3e9, stats: pools[0]!.stats, markets: pools } as Coin;
  it("aggregates USD values using current pool inventory without summing quote earnings", () => {
    const aggregate = aggregateCoinMarkets(coin);
    expect(aggregate.priceUsd).toBe(2.5);
    expect(aggregate.liquidityUsd).toBe(30);
    expect(aggregate.volume24hUsd).toBe(45);
    expect(aggregate.stats.creatorEarnedQuote).toBe(4);
    expect(selectCoinMarket(aggregate, "0x02").stats.creatorEarnedQuote).toBe(8);
    expect(tradeQuoteSymbol(aggregate, { poolId: "0x02" })).toBe("USDC");
  });
  it("rejects an unrelated pool and falls back to primary price if every inventory is zero", () => {
    expect(() => selectCoinMarket(coin, "0x03")).toThrow();
    expect(aggregateCoinMarkets({ ...coin, markets: pools.map((pool) => ({ ...pool, poolCoins: 0 })) }).priceUsd).toBe(3);
  });
});
