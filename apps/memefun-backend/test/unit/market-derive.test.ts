import { describe, expect, it } from "vitest";

import { deriveCoin, EMPTY_WINDOWS, type CoinRecord, type CoinWindows, type QuoteRecord } from "../../lib/market/derive";
import { COIN_SUPPLY } from "../../shared/core/constants";
import { startTickExact } from "../../shared/core/pool";
import { getSqrtPriceAtTick } from "../../shared/core/uniswap/tickMath";

type Input = Parameters<typeof deriveCoin>[0];
const UNIT = 10n ** 18n;
const OWNER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const ADDRESS = "0xb2000000000000000000001b03710100dd44768f";
const ZERO = "0x0000000000000000000000000000000000000000";
const NOW = 1_000_100;
const shapes = [
  { kind: 0, decimals: 18, symbol: "ETH", priceUsdE8: 300_000_000_000n },
  { kind: 1, decimals: 6, symbol: "USDC", priceUsdE8: 100_000_000n },
  { kind: 2, decimals: 8, symbol: "STOCK8", priceUsdE8: 24_110_000_000n },
  { kind: 2, decimals: 18, symbol: "STOCK18", priceUsdE8: 100_010_000_000n },
  { kind: 3, decimals: 9, symbol: "MEME9", priceUsdE8: 100_000n },
  { kind: 3, decimals: 0, symbol: "MEME0", priceUsdE8: 10_000_000n },
];

function record(overrides: Partial<CoinRecord> = {}): CoinRecord {
  return { address: ADDRESS, creator: OWNER, launcher: OWNER, pendingCreator: ZERO, quote: ZERO,
    quoteIsCurrency0: false, mode: 0, module: ZERO, feeBps: 125, platformShareBps: 2_000,
    referralShareBps: 2_500, creatorKeepBps: 700, protectionStartBps: 5_000, protectionDurationSec: 15,
    createdAt: 1_000_000, name: "Market Frog", symbol: "FROG", contractUri: "ipfs://metadata",
    startTick: 0, launchQuoteUsdE8: 200_000_000n, sqrtPriceX96: getSqrtPriceAtTick(0),
    poolQuote: 3n * UNIT, poolCoins: 100n * UNIT, burned: COIN_SUPPLY / 10n,
    athMarketCapUsdE8: 0n, volumeUsdE8: 17_000_000_000n, trades: 7, lastTradeAt: NOW - 1,
    holders: 15, feesTotal: 20n * UNIT, platformFees: 4n * UNIT, referralFees: UNIT,
    creatorEarned: 8n * UNIT, creatorClaimed: 3n * UNIT, destinationEarned: 15n * UNIT,
    buybacks: 2, buybackSpent: 5n * UNIT, buybackBurned: 123n * UNIT, floorQuote: 7n * UNIT,
    floorNearTick: 0, holdersReserved: 9n * UNIT, holdersReturned: 2n * UNIT,
    epochs: 3, devSold: true, snipers: 2, sameBlockBuys: 3, ...overrides };
}

function input(coin: CoinRecord, quote: QuoteRecord): Input {
  return { coin, quote, windows: EMPTY_WINDOWS, holders: { top10: COIN_SUPPLY / 10n, creatorBalance: COIN_SUPPLY / 100n },
    metadata: { description: "Same metadata", image: "https://media.test/frog.webp", links: { x: "https://x.com/frog" } },
    flags: { hidden: false, featured: true }, nowSec: NOW };
}

describe("market view derivation", () => {
  for (const mode of [0, 1, 2, 3]) {
    for (const empty of [true, false]) {
      it(`matches standalone pool values for mode ${mode}, ${empty ? "empty" : "populated"} windows and mixed quote decimals`, () => {
        for (const quoteIsCurrency0 of [true, false]) {
          const markets = shapes.map((shape, index) => {
            const quote: QuoteRecord = { ...shape, address: `0x${(index + 100).toString(16).padStart(40, "0")}`, name: shape.symbol };
            const tick = startTickExact({ coinIsCurrency0: !quoteIsCurrency0, quoteDecimals: quote.decimals,
              quoteUsdE8: quote.priceUsdE8, openingFdvUsdE8: 500_000_000_000n });
            const unit = 10n ** BigInt(quote.decimals);
            const coin = { ...record({ mode, quote: quote.address, quoteIsCurrency0, startTick: tick,
              launchQuoteUsdE8: quote.priceUsdE8, sqrtPriceX96: getSqrtPriceAtTick(tick + index * 200),
              poolQuote: 3n * unit, poolCoins: COIN_SUPPLY / BigInt(index + 10), burned: COIN_SUPPLY / 2n,
              feesTotal: 20n * unit, platformFees: 4n * unit, referralFees: unit, creatorEarned: 8n * unit,
              creatorClaimed: 3n * unit, destinationEarned: 15n * unit, buybackSpent: 5n * unit,
              floorQuote: 7n * unit, floorNearTick: index % 2 ? tick : null,
              holdersReserved: 9n * unit, holdersReturned: 2n * unit }),
              poolId: `0x${(index + 1).toString(16).padStart(64, "0")}`, supplyRaw: COIN_SUPPLY / BigInt(shapes.length) };
            const windows: CoinWindows = empty ? EMPTY_WINDOWS : { volume24hUsdE8: BigInt(index + 1) * 100_000_000n,
              buys24h: index + 1, sells24h: index + 2, volume1hUsdE8: 2_000_000_000n, trades15m: 4,
              priceAgoUsdE18: { m5: 2_000_000_000_000n, h1: 0n, h24: null }, sparkline: [1, 2, 3] };
            return { coin, quote, windows };
          });
          const first = markets[0]!;
          const aggregate = { ...input(record({ mode }), first.quote), markets };
          const result = deriveCoin(aggregate);
          expect(result.markets).toHaveLength(shapes.length);
          for (const [index, market] of markets.entries()) {
            // Per-pool views have the same unit/price/stat contract as a standalone Coin.
            // Shared token burns are supplied by the aggregate, not a pool-local copy.
            const standalone = deriveCoin({ ...aggregate, markets: undefined, coin: { ...market.coin, burned: aggregate.coin.burned },
              quote: market.quote, windows: market.windows });
            expect(result.markets![index]).toEqual({ poolId: market.coin.poolId, quote: standalone.quote,
              supplyRaw: market.coin.supplyRaw.toString(), supplyFraction: 0.166666666,
              poolCoins: Number(market.coin.poolCoins) / 1e18,
              priceQuote: standalone.priceQuote, priceUsd: standalone.priceUsd, liquidityUsd: standalone.liquidityUsd,
              volume24hUsd: standalone.volume24hUsd, volumeTotalUsd: standalone.volumeTotalUsd,
              change5m: standalone.change5m, change1h: standalone.change1h, change24h: standalone.change24h, stats: standalone.stats });
          }
        }
      });
    }
  }

  for (const mode of [0, 1, 2, 3]) {
    it(`retains exact known ledger, price, liquidity and shared-burn values in mode ${mode}`, () => {
      const firstQuote: QuoteRecord = { address: ZERO, kind: 0, decimals: 18, symbol: "ETH", name: "Ether", priceUsdE8: 200_000_000n };
      const secondQuote: QuoteRecord = { ...firstQuote, address: "0x0000000000000000000000000000000000000001", kind: 3, symbol: "PAIR", priceUsdE8: 400_000_000n };
      const first = { coin: { ...record({ mode, burned: COIN_SUPPLY / 2n }), poolId: `0x${"1".repeat(64)}`, supplyRaw: COIN_SUPPLY / 2n },
        quote: firstQuote, windows: { ...EMPTY_WINDOWS, volume24hUsdE8: 250_000_000n, buys24h: 3, sells24h: 4,
          priceAgoUsdE18: { m5: UNIT, h1: 0n, h24: null } } };
      const second = { coin: { ...record({ mode, burned: COIN_SUPPLY * 2n, poolCoins: 300n * UNIT, poolQuote: 5n * UNIT,
        volumeUsdE8: 23_000_000_000n }), poolId: `0x${"2".repeat(64)}`, supplyRaw: COIN_SUPPLY / 2n }, quote: secondQuote,
        windows: { ...EMPTY_WINDOWS, volume24hUsdE8: 375_000_000n, buys24h: 5, sells24h: 6,
          priceAgoUsdE18: { m5: 8n * UNIT, h1: 2n * UNIT, h24: 4n * UNIT } } };
      const base = input(record({ mode, poolCoins: 400n * UNIT }), firstQuote);
      const result = deriveCoin({ ...base, windows: first.windows, markets: [first, second] });
      expect(result.markets![0]).toMatchObject({ priceQuote: 1, priceUsd: 2, liquidityUsd: 206,
        supplyFraction: 0.5, poolCoins: 100, volume24hUsd: 2.5, volumeTotalUsd: 170,
        change5m: 1, change1h: 0, change24h: 0 });
      expect(result.markets![1]).toMatchObject({ priceQuote: 1, priceUsd: 4, liquidityUsd: 1220,
        supplyFraction: 0.5, poolCoins: 300, volume24hUsd: 3.75, volumeTotalUsd: 230,
        change5m: -0.5, change1h: 1, change24h: 0 });
      expect(result.markets![0]!.stats).toEqual({ feesTotalQuote: 20, platformQuote: 4, referralQuote: 1,
        creatorEarnedQuote: 8, creatorClaimedQuote: 3, burnedCoins: 123, burnBudgetQuote: mode === 1 ? 10 : 0,
        buybacks: 2, holdersPaidQuote: mode === 2 ? 7 : 0, epochPendingQuote: mode === 2 ? 8 : 0,
        nextEpochAt: 1_036_800_000, epochs: 3, floorQuote: mode === 3 ? 7 : 0, floorPriceUsd: 2 });
      expect(result).toMatchObject({ priceUsd: 3.5, fdvUsd: 3_500_000_000, marketCapUsd: 3_150_000_000,
        athMarketCapUsd: 3_150_000_000, liquidityUsd: 1426, volume24hUsd: 6.25, volumeTotalUsd: 400,
        buys24h: 8, sells24h: 10, circulating: 899_999_600, change5m: 2.5, change1h: 0, change24h: 0 });
      expect(result.sparkline).toEqual(Array(48).fill(3.5));
    });
  }

  it("keeps the primary fallback when every market reserve is empty, including a zero-priced quote", () => {
    const quote: QuoteRecord = { address: ZERO, kind: 0, decimals: 18, symbol: "ETH", name: "Ether", priceUsdE8: 200_000_000n };
    const base = input(record({ burned: COIN_SUPPLY * 2n }), quote);
    const markets = [
      { coin: { ...record({ poolCoins: 0n }), poolId: `0x${"1".repeat(64)}`, supplyRaw: 0n }, quote, windows: EMPTY_WINDOWS },
      { coin: { ...record({ poolCoins: 0n, sqrtPriceX96: 0n }), poolId: `0x${"2".repeat(64)}`, supplyRaw: 0n },
        quote: { ...quote, kind: 99, priceUsdE8: 0n }, windows: EMPTY_WINDOWS },
    ];
    const result = deriveCoin({ ...base, markets });
    expect(result.priceUsd).toBe(2);
    expect(result.marketCapUsd).toBe(0);
    expect(result.markets![1]).toMatchObject({ priceQuote: 0, priceUsd: 0, liquidityUsd: 0,
      supplyFraction: 0, quote: { kind: "stable", usdPrice: 0 }, stats: { floorPriceUsd: 0 } });
  });

  it("leaves input records, metadata and window arrays unchanged", () => {
    const quote: QuoteRecord = { address: ZERO, kind: 0, decimals: 18, symbol: "ETH", name: "Ether", priceUsdE8: 200_000_000n };
    const base = input(record(), quote);
    const fixture = { ...base, windows: { ...EMPTY_WINDOWS, sparkline: [1, 2, 3] },
      markets: [{ coin: { ...record(), poolId: `0x${"1".repeat(64)}`, supplyRaw: COIN_SUPPLY }, quote,
        windows: { ...EMPTY_WINDOWS, sparkline: [3, 4, 5] } }] };
    const saved = structuredClone(fixture);
    deriveCoin(fixture);
    expect(fixture).toEqual(saved);
  });
});
