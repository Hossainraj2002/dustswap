import { describe, expect, it } from "vitest";

import {
  type CoinRecord,
  EMPTY_WINDOWS,
  costBasisUsd,
  deriveCoin,
  deriveTrade,
  fillCandles,
  momentumScore,
  nextEpochAt,
  openingMarketCapUsdE8,
  sparklineFrom,
  weightedMarketPrice,
} from "../../lib/market/derive";
import { getSqrtPriceAtTick } from "../../shared/core/uniswap/tickMath";
import { startTickExact } from "../../shared/core/pool";

const ETH_E8 = 300_000_000_000n;
const quote = { address: "0x0000000000000000000000000000000000000000", kind: 0, decimals: 18, symbol: "ETH", name: "Ether", priceUsdE8: ETH_E8 };
const startTick = startTickExact({ coinIsCurrency0: false, quoteDecimals: 18, quoteUsdE8: ETH_E8, openingFdvUsdE8: 5_000n * 10n ** 8n });

function record(overrides: Partial<CoinRecord> = {}): CoinRecord {
  return {
    address: "0xb2000000000000000000001b03710100dd44768f",
    creator: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    launcher: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    quote: quote.address,
    quoteIsCurrency0: true,
    mode: 0,
    module: "0x0000000000000000000000000000000000000000",
    feeBps: 100,
    platformShareBps: 2_000,
    referralShareBps: 2_500,
    creatorKeepBps: 0,
    protectionStartBps: 5_000,
    protectionDurationSec: 15,
    createdAt: 1_000_000,
    name: "Based Frog",
    symbol: "FROG",
    contractUri: "ipfs://x",
    startTick,
    launchQuoteUsdE8: ETH_E8,
    sqrtPriceX96: getSqrtPriceAtTick(startTick),
    poolQuote: 0n,
    poolCoins: 10n ** 27n,
    burned: 0n,
    athMarketCapUsdE8: 0n,
    volumeUsdE8: 0n,
    trades: 0,
    lastTradeAt: 1_000_000,
    holders: 0,
    feesTotal: 0n,
    platformFees: 0n,
    referralFees: 0n,
    creatorEarned: 0n,
    creatorClaimed: 0n,
    destinationEarned: 0n,
    buybacks: 0,
    buybackSpent: 0n,
    buybackBurned: 0n,
    floorQuote: 0n,
    floorNearTick: null,
    holdersReserved: 0n,
    holdersReturned: 0n,
    epochs: 0,
    devSold: false,
    snipers: 0,
    sameBlockBuys: 0,
    ...overrides,
  };
}

const derive = (overrides: Partial<CoinRecord> = {}, extra: Partial<Parameters<typeof deriveCoin>[0]> = {}) =>
  deriveCoin({
    coin: record(overrides),
    quote,
    windows: EMPTY_WINDOWS,
    holders: { top10: 0n, creatorBalance: 0n },
    metadata: null,
    flags: { hidden: false, featured: false },
    nowSec: 1_000_100,
    ...extra,
  });

describe("deriveCoin", () => {
  it("values mixed-decimal markets in USD and counts the shared token once", () => {
    const supply = 10n ** 27n;
    const usdc = { address: "0x00000000000000000000000000000000000000c0", kind: 1, decimals: 6, symbol: "USDC", name: "USD Coin", priceUsdE8: 100_000_000n };
    const secondTick = startTickExact({ coinIsCurrency0: false, quoteDecimals: 6, quoteUsdE8: usdc.priceUsdE8, openingFdvUsdE8: 10_000n * 10n ** 8n });
    const first = { ...record({ poolCoins: supply / 4n, poolQuote: 10n ** 18n, creatorEarned: 10n ** 18n, volumeUsdE8: 10n ** 8n }),
      poolId: `0x${"11".repeat(32)}`, supplyRaw: supply / 2n };
    const second = { ...record({ quote: usdc.address, startTick: secondTick, sqrtPriceX96: getSqrtPriceAtTick(secondTick),
      launchQuoteUsdE8: usdc.priceUsdE8, poolCoins: supply * 3n / 4n, poolQuote: 2_000_000n, creatorEarned: 2_000_000n, volumeUsdE8: 2n * 10n ** 8n }),
      poolId: `0x${"22".repeat(32)}`, supplyRaw: supply / 2n };
    const a = deriveCoin({ coin: first, quote, windows: EMPTY_WINDOWS, holders: { top10: 0n, creatorBalance: 0n }, metadata: null, flags: { hidden: false, featured: false }, nowSec: 1_000_100 });
    const b = deriveCoin({ coin: second, quote: usdc, windows: EMPTY_WINDOWS, holders: { top10: 0n, creatorBalance: 0n }, metadata: null, flags: { hidden: false, featured: false }, nowSec: 1_000_100 });
    const coin = derive({ poolCoins: supply, holders: 7 }, { markets: [
      { coin: first, quote, windows: { ...EMPTY_WINDOWS, volume24hUsdE8: 10n ** 8n } },
      { coin: second, quote: usdc, windows: { ...EMPTY_WINDOWS, volume24hUsdE8: 2n * 10n ** 8n } },
    ] });
    expect(coin.markets).toHaveLength(2);
    expect(coin.priceUsd).toBeCloseTo(a.priceUsd / 4 + b.priceUsd * 3 / 4, 14);
    expect(coin.marketCapUsd).toBeCloseTo(coin.priceUsd * 1e9, 6);
    expect(coin.liquidityUsd).toBeCloseTo(a.liquidityUsd + b.liquidityUsd, 6);
    expect(coin.volume24hUsd).toBe(3);
    expect(coin.volumeTotalUsd).toBe(3);
    expect(coin.holders).toBe(7);
    expect(coin.circulating).toBe(0);
    expect(coin.markets?.map((m) => m.stats.creatorEarnedQuote)).toEqual([1, 2]);
    expect(coin.markets?.map((m) => m.supplyFraction)).toEqual([0.5, 0.5]);
  });

  it("uses the primary price if no pool holds coins", () => {
    expect(weightedMarketPrice([{ poolCoins: 0n, priceUsdE18: 20n }, { poolCoins: 0n, priceUsdE18: 40n }], 10n)).toBe(10n);
    expect(weightedMarketPrice([{ poolCoins: 1n, priceUsdE18: 10n }, { poolCoins: 3n, priceUsdE18: 30n }], 99n)).toBe(25n);
  });
  it("a fresh coin sits at its opening market cap with everything in the pool", () => {
    const coin = derive();
    expect(coin.marketCapUsd).toBeGreaterThanOrEqual(4_999.99);
    expect(coin.marketCapUsd).toBeLessThan(5_000 * 1.0203);
    expect(coin.openingMarketCapUsd).toBeCloseTo(coin.marketCapUsd, 6);
    expect(coin.fdvUsd).toBeCloseTo(coin.marketCapUsd, 6);
    expect(coin.liquidityUsd).toBeCloseTo(coin.marketCapUsd, 6);
    expect(coin.circulating).toBe(0);
    expect(coin.createdAt).toBe(1_000_000_000);
    expect(coin.sparkline).toHaveLength(48);
    expect(coin.terms).toEqual({ feeBps: 100, mode: "creator", creatorKeepBps: 0, platformShareBps: 2_000, referralShareBps: 2_500, snipeStartBps: 5_000, snipeDurationSec: 15 });
    expect(coin.address).toBe("0xB2000000000000000000001b03710100DD44768F");
    expect(coin.quote).toMatchObject({ symbol: "ETH", kind: "native", usdPrice: 3_000 });
  });

  it("re-prices live with the pair asset's current USD price", () => {
    const cheaperEth = deriveCoin({
      coin: record(),
      quote: { ...quote, priceUsdE8: ETH_E8 / 2n },
      windows: EMPTY_WINDOWS,
      holders: { top10: 0n, creatorBalance: 0n },
      metadata: null,
      flags: { hidden: false, featured: false },
      nowSec: 1_000_100,
    });
    expect(cheaperEth.marketCapUsd).toBeCloseTo(derive().marketCapUsd / 2, 4);
    expect(cheaperEth.openingMarketCapUsd).toBeCloseTo(derive().openingMarketCapUsd, 6); // history keeps launch-time USD
  });

  it("leaves burned coins out of the market cap and counts circulating supply", () => {
    const coin = derive({ burned: 10n ** 26n, poolCoins: 6n * 10n ** 26n });
    expect(coin.marketCapUsd).toBeCloseTo(coin.fdvUsd * 0.9, 4);
    expect(coin.circulating).toBeCloseTo(3e8, 0);
  });

  it("reports changes against the look-back prices", () => {
    const now = derive().priceUsd;
    const half = BigInt(Math.round(now * 0.5 * 1e18));
    const coin = derive({}, { windows: { ...EMPTY_WINDOWS, priceAgoUsdE18: { m5: half, h1: half * 2n, h24: null } } });
    expect(coin.change5m).toBeCloseTo(1, 3);
    expect(coin.change1h).toBeCloseTo(0, 3);
    expect(coin.change24h).toBe(0);
  });

  it("fills each mode's stats from the right ledgers", () => {
    const burn = derive({ mode: 1, destinationEarned: 3n * 10n ** 18n, buybackSpent: 10n ** 18n, buybacks: 2, buybackBurned: 5n * 10n ** 24n });
    expect(burn.stats).toMatchObject({ burnBudgetQuote: 2, buybacks: 2, burnedCoins: 5_000_000, holdersPaidQuote: 0, floorQuote: 0 });
    const holders = derive({ mode: 2, destinationEarned: 5n * 10n ** 18n, holdersReserved: 4n * 10n ** 18n, holdersReturned: 10n ** 18n, epochs: 3 });
    expect(holders.stats).toMatchObject({ holdersPaidQuote: 3, epochPendingQuote: 2, epochs: 3 });
    const floor = derive({ mode: 3, floorQuote: 7n * 10n ** 17n, floorNearTick: startTick + 6_932 });
    expect(floor.stats.floorQuote).toBeCloseTo(0.7, 9);
    expect(floor.stats.floorPriceUsd).toBeCloseTo(floor.priceUsd / 2, 8); // 6932 ticks is 2x cheaper
  });

  it("flags, holder signals and metadata pass through", () => {
    const coin = derive(
      { devSold: true, snipers: 2, sameBlockBuys: 4 },
      {
        holders: { top10: 2n * 10n ** 26n, creatorBalance: 10n ** 25n },
        flags: { hidden: true, featured: false },
        metadata: { description: "gm", image: "https://x/y.webp", links: { x: "frog" } },
      },
    );
    expect(coin).toMatchObject({ devSold: true, snipers: 2, sameBlockBuys: 4, top10Pct: 0.2, devHoldsPct: 0.01, hidden: true, description: "gm", image: "https://x/y.webp", links: { x: "frog" } });
    expect(coin.featured).toBeUndefined();
  });
});

describe("helpers", () => {
  it("next epoch is the next 00:00 or 12:00 UTC", () => {
    const noon = Date.UTC(2026, 9, 2, 12) / 1000;
    expect(nextEpochAt(noon)).toBe(noon + 43_200);
    expect(nextEpochAt(noon - 1)).toBe(noon);
  });

  it("momentum favours fresh, rising, busy coins", () => {
    const base = { volume1hUsd: 1_000, change1h: 0, trades15m: 5, ageSec: 86_400 };
    expect(momentumScore(base)).toBe(1_000 + 200);
    expect(momentumScore({ ...base, ageSec: 600 })).toBeCloseTo(1_200 * 1.6, 9);
    expect(momentumScore({ ...base, change1h: 10 })).toBe(1_000 * 4 + 200); // change capped at +300%
    expect(momentumScore({ ...base, change1h: -0.9 })).toBe(1_000 * 0.4 + 200); // and at -60%
  });

  it("cost basis is average cost for bought coins, current value for received ones", () => {
    const price = 10n ** 13n; // $0.00001
    expect(costBasisUsd({ amount: 10n ** 24n, boughtCoins: 2n * 10n ** 24n, boughtUsdE8: 40n * 10n ** 8n, priceUsdE18: price })).toBe(20);
    expect(costBasisUsd({ amount: 10n ** 24n, boughtCoins: 0n, boughtUsdE8: 0n, priceUsdE18: price })).toBe(10);
    expect(costBasisUsd({ amount: 3n * 10n ** 24n, boughtCoins: 2n * 10n ** 24n, boughtUsdE8: 40n * 10n ** 8n, priceUsdE18: price })).toBe(40 + 10);
    expect(costBasisUsd({ amount: 0n, boughtCoins: 1n, boughtUsdE8: 1n, priceUsdE18: price })).toBe(0);
  });

  it("candles have no holes: empty buckets are flat at the previous close", () => {
    const candles = fillCandles({
      candles: [{ bucket: 120, open: 10n ** 18n, high: 3n * 10n ** 18n, low: 10n ** 18n, close: 2n * 10n ** 18n, volumeUsdE8: 5n * 10n ** 8n }],
      interval: 60,
      startSec: 60,
      endSec: 240,
      openingValue: 10n ** 18n,
      scale: "usdE18",
    });
    expect(candles.map((c) => c.time)).toEqual([60, 120, 180, 240]);
    expect(candles[0]).toEqual({ time: 60, open: 1, high: 1, low: 1, close: 1, volume: 0 });
    expect(candles[1]).toEqual({ time: 120, open: 1, high: 3, low: 1, close: 2, volume: 5 });
    expect(candles[3]).toEqual({ time: 240, open: 2, high: 2, low: 2, close: 2, volume: 0 });
  });

  it("the sparkline steps through closes in time order", () => {
    const points = sparklineFrom({
      closes: [
        { bucket: 900, close: 3n * 10n ** 18n },
        { bucket: 0, close: 2n * 10n ** 18n },
      ],
      interval: 900,
      fromSec: 0,
      nowSec: 4_700,
      priceBeforeE18: 10n ** 18n,
    });
    expect(points).toHaveLength(48);
    expect(points[0]).toBe(2);
    expect(points.at(-1)).toBe(3);
  });

  it("opening market cap uses the launch's own quote price", () => {
    expect(Number(openingMarketCapUsdE8(record(), 18)) / 1e8).toBeGreaterThanOrEqual(4_999.99);
  });

  it("trades convert to the app's units and keep their kind", () => {
    const view = deriveTrade(
      {
        id: "t1",
        coin: "0xb2000000000000000000001b03710100dd44768f",
        trader: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        kind: "buyback",
        isBuy: true,
        quoteAmount: 5n * 10n ** 17n,
        coinAmount: 10n ** 24n,
        fee: 0n,
        feeBps: 0,
        priceUsdE18: 5n * 10n ** 12n,
        marketCapUsdE8: 5_000n * 10n ** 8n,
        isCreator: false,
        inProtection: false,
        timestamp: 1_000,
        txHash: "0xabc",
      },
      18,
    );
    expect(view).toMatchObject({ ts: 1_000_000, side: "buy", quoteAmount: 0.5, coinAmount: 1_000_000, priceUsd: 0.000005, marketCapUsd: 5_000, kind: "buyback" });
    expect(view.trader).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  });
});
