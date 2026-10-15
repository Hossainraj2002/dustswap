import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarketSnapshot } from "../../api/read/snapshot";
import type { ReadStore, WindowAggregates } from "../../api/read/store";
import type { AppStore } from "../../lib/app-store";
import type { CoinRecord, MarketRecord, QuoteRecord } from "../../lib/market/derive";
import type { MediaStore } from "../../lib/media/store";
import { getSqrtPriceAtTick } from "../../shared/core/uniswap/tickMath";

const NOW = 1_000_100_000;
const ADDRESS = "0xb2000000000000000000001b03710100dd44768f";
const OWNER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const ETH = "0x0000000000000000000000000000000000000000";
const USDC = "0x00000000000000000000000000000000000000c0";
const POOL_A = `0x${"11".repeat(32)}`;
const POOL_B = `0x${"22".repeat(32)}`;

function record(): CoinRecord {
  return { address: ADDRESS, creator: OWNER, launcher: OWNER, quote: ETH, quoteIsCurrency0: true,
    mode: 0, module: ETH, feeBps: 100, platformShareBps: 2_000, referralShareBps: 2_500,
    creatorKeepBps: 0, protectionStartBps: 5_000, protectionDurationSec: 15, createdAt: NOW / 1000 - 100,
    name: "Based Frog", symbol: "FROG", contractUri: "", startTick: 200_000,
    launchQuoteUsdE8: 300_000_000_000n, sqrtPriceX96: getSqrtPriceAtTick(200_000), poolQuote: 0n,
    poolCoins: 10n ** 27n, burned: 0n, athMarketCapUsdE8: 0n, volumeUsdE8: 0n, trades: 0,
    lastTradeAt: NOW / 1000 - 100, holders: 0, feesTotal: 0n, platformFees: 0n, referralFees: 0n,
    creatorEarned: 0n, creatorClaimed: 0n, destinationEarned: 0n, buybacks: 0, buybackSpent: 0n,
    buybackBurned: 0n, floorQuote: 0n, floorNearTick: null, holdersReserved: 0n, holdersReturned: 0n,
    epochs: 0, devSold: false, snipers: 0, sameBlockBuys: 0 };
}

function fixture(withCoin = false) {
  const data = {
    coins: withCoin ? [record()] : [] as CoinRecord[],
    markets: [] as MarketRecord[],
    quotes: [{ address: ETH, kind: 0, decimals: 18, symbol: "ETH", name: "Ether", priceUsdE8: 300_000_000_000n }] as QuoteRecord[],
    moderation: new Map<string, { hidden: boolean; featured: boolean }>(),
    holders: { top10: 0n, creatorBalance: 0n },
    banner: "",
    audience: true,
  };
  const store = {
    quotes: vi.fn(async () => data.quotes),
    coins: vi.fn(async () => data.coins),
    markets: vi.fn(async () => data.markets),
    latestTimestamp: vi.fn(async () => 0),
    windows: vi.fn(async (_coins: string[], _now: number) => new Map<string, WindowAggregates>()),
    marketWindows: vi.fn(async (_pools: string[], _now: number) => new Map<string, WindowAggregates>()),
    sparklineCloses: vi.fn(async () => new Map()),
    coinsWithTransfersSince: vi.fn(async () => ({ coins: data.coins.map(c => c.address), maxBlock: 1n })),
    holderStats: vi.fn(async () => new Map(data.coins.map(c => [c.address, data.holders]))),
  };
  const app = {
    moderation: vi.fn(async () => data.moderation),
    setting: vi.fn(async () => ({ text: data.banner })),
    coinMetadataCids: vi.fn(async () => new Map()),
    metadataByCids: vi.fn(async () => new Map()),
  };
  const media = { urlFor: (cid: string) => `https://media.test/media/${cid}` } as MediaStore;
  const snapshot = new MarketSnapshot({ store: store as unknown as ReadStore, app: app as unknown as AppStore, media,
    hasAudience: () => data.audience });
  return { snapshot, store, app, data };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(yes => { release = yes; });
  return { promise, release };
}

describe("bounded market snapshot work", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("rebuilds a quiet market with readers once per ten seconds instead of on every two-second tick", async () => {
    const f = fixture();
    await f.snapshot.ready();
    f.snapshot.start();
    f.snapshot.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.store.coins).toHaveBeenCalledTimes(7); // Initial build and six quiet refreshes.
    expect(f.snapshot.current.nowSec).toBe((NOW + 60_000) / 1000);
    f.snapshot.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.store.coins).toHaveBeenCalledTimes(7);
  });

  it("uses only a minute heartbeat without streams or market reads", async () => {
    const f = fixture();
    f.data.audience = false;
    await f.snapshot.refresh(); // Startup initialization does not create reader interest.
    f.snapshot.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(f.store.coins).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.store.coins).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.store.coins).toHaveBeenCalledTimes(3);
    expect(f.snapshot.current.nowSec).toBe((NOW + 120_000) / 1000);
    f.snapshot.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.store.coins).toHaveBeenCalledTimes(3);
  });

  it("diagnostic current/healthy reads do not keep the market awake", async () => {
    const f = fixture();
    f.data.audience = false;
    await f.snapshot.refresh();
    f.snapshot.start();
    for (let i = 0; i < 29; i++) {
      await vi.advanceTimersByTimeAsync(2_000);
      expect(f.snapshot.current.version).toBe(1);
      expect(f.snapshot.healthy).toBe(true);
    }
    expect(f.store.coins).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.snapshot.current.version).toBe(2);
  });

  it("a market read wakes the ten-second cadence, then interest expires after twenty seconds", async () => {
    const f = fixture();
    f.data.audience = false;
    await f.snapshot.refresh();
    f.snapshot.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.store.coins).toHaveBeenCalledTimes(1);
    expect((await f.snapshot.ready()).version).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.store.coins).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(f.store.coins).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.store.coins).toHaveBeenCalledTimes(4);
  });

  it("fresh reads extend interest without immediately rebuilding the full market", async () => {
    const f = fixture();
    f.data.audience = false;
    await f.snapshot.ready();
    f.snapshot.start();
    await vi.advanceTimersByTimeAsync(12_000);
    const current = f.snapshot.current;
    expect(await f.snapshot.ready()).toBe(current);
    expect(f.store.coins).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.store.coins).toHaveBeenCalledTimes(4); // Refreshes at 20s and 30s under the renewed lease.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.store.coins).toHaveBeenCalledTimes(4);
  });

  it("a live subscriber wakes the quiet cadence and the last unsubscribe returns it to idle", async () => {
    const f = fixture();
    f.data.audience = false;
    await f.snapshot.refresh();
    f.snapshot.start();
    await vi.advanceTimersByTimeAsync(30_000);
    f.data.audience = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.store.coins).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.store.coins).toHaveBeenCalledTimes(3);
    f.data.audience = false;
    await vi.advanceTimersByTimeAsync(58_000);
    expect(f.store.coins).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.store.coins).toHaveBeenCalledTimes(4);
  });

  it("coalesces the first reads after a long idle period and returns updated monetary state", async () => {
    const f = fixture(true), blocked = gate();
    f.data.audience = false;
    await f.snapshot.refresh();
    f.snapshot.start();
    await vi.advanceTimersByTimeAsync(30_000);
    f.data.coins[0] = { ...f.data.coins[0]!, feeBps: 50, creatorClaimed: 10n ** 18n };
    f.store.coins.mockImplementationOnce(async () => { await blocked.promise; return f.data.coins; });
    let finished = false;
    const first = f.snapshot.ready().then(state => { finished = true; return state; });
    const second = f.snapshot.ready();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(finished).toBe(false);
    expect(f.store.coins).toHaveBeenCalledTimes(2);
    blocked.release();
    const state = await first;
    expect(await second).toBe(state);
    expect(state.coins[0]!).toMatchObject({ terms: { feeBps: 50 }, stats: { creatorClaimedQuote: 1 } });
  });

  it("an idle heartbeat failure retries promptly and restores healthy state", async () => {
    const f = fixture();
    f.data.audience = false;
    await f.snapshot.refresh();
    f.snapshot.start();
    f.store.coins.mockRejectedValueOnce(new Error("heartbeat database error"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.snapshot.healthy).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.snapshot.healthy).toBe(true);
    expect(f.store.coins).toHaveBeenCalledTimes(3);
  });

  it("observed activity retains the busy two-second cadence even without a subscriber lease", async () => {
    const f = fixture();
    f.data.audience = false;
    await f.snapshot.refresh();
    f.snapshot.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await f.snapshot.noteActivity();
    expect(f.store.coins).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(19_000);
    expect(f.store.coins).toHaveBeenCalledTimes(11);
    await vi.advanceTimersByTimeAsync(57_000);
    expect(f.store.coins).toHaveBeenCalledTimes(11);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.store.coins).toHaveBeenCalledTimes(12);
  });

  it("coalesces startup reads and waits for an already-running refresh", async () => {
    const f = fixture(), blocked = gate();
    f.store.coins.mockImplementationOnce(async () => { await blocked.promise; return []; });
    const a = f.snapshot.ready(), b = f.snapshot.ready();
    expect(f.store.coins).toHaveBeenCalledTimes(1);
    blocked.release();
    expect(await a).toBe(await b);
    expect(f.snapshot.healthy).toBe(true);
    const next = gate();
    f.store.coins.mockImplementationOnce(async () => { await next.promise; return []; });
    const refresh = f.snapshot.refresh();
    let finished = false;
    const ready = f.snapshot.ready().then(state => { finished = true; return state; });
    await Promise.resolve();
    expect(finished).toBe(false);
    next.release();
    await refresh;
    expect((await ready).version).toBe(2);
  });

  it("refreshes the first read after ten seconds idle even when its timer is stopped", async () => {
    const f = fixture();
    const first = await f.snapshot.ready();
    vi.setSystemTime(NOW + 9_999);
    expect(await f.snapshot.ready()).toBe(first);
    vi.setSystemTime(NOW + 10_000);
    const [a, b] = await Promise.all([f.snapshot.ready(), f.snapshot.ready()]);
    expect(a).toBe(b);
    expect(a.version).toBe(2);
    expect(f.store.coins).toHaveBeenCalledTimes(2);
  });

  it("refreshes promptly on activity, runs at two seconds while busy, then becomes quiet", async () => {
    const f = fixture();
    await f.snapshot.ready();
    f.snapshot.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await f.snapshot.noteActivity();
    expect(f.store.coins).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(19_000);
    expect(f.store.coins).toHaveBeenCalledTimes(11);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(f.store.coins).toHaveBeenCalledTimes(11);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.store.coins).toHaveBeenCalledTimes(12);
  });

  it("coalesces burst hints until two seconds have elapsed, without increasing busy rebuilds", async () => {
    const f = fixture();
    await f.snapshot.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    let resolved = false;
    const first = f.snapshot.noteActivity();
    const second = f.snapshot.noteActivity();
    expect(first).toBe(second);
    void first.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);
    expect(f.store.coins).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(f.store.coins).toHaveBeenCalledTimes(2);
  });

  it("an explicit write refresh adopts pending activity waiters without a second scheduled build", async () => {
    const f = fixture();
    await f.snapshot.ready();
    const hinted = f.snapshot.noteActivity();
    await f.snapshot.refresh();
    await hinted;
    expect(f.store.coins).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.store.coins).toHaveBeenCalledTimes(2);
  });

  it("settles pending activity waiters when stopped and cancels their database work", async () => {
    const f = fixture();
    await f.snapshot.ready();
    const hinted = f.snapshot.noteActivity();
    f.snapshot.stop();
    await hinted;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.store.coins).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous complete snapshot on error and retries on the next cheap tick", async () => {
    const f = fixture();
    const first = await f.snapshot.ready();
    f.snapshot.start();
    f.store.coins.mockRejectedValueOnce(new Error("temporary database error"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.snapshot.current).toBe(first);
    expect(f.snapshot.healthy).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.snapshot.current.version).toBe(2);
    expect(f.snapshot.healthy).toBe(true);
    expect(f.store.coins).toHaveBeenCalledTimes(3);
  });

  it("retries a failed scheduled activity refresh and rejects all of that build's waiters", async () => {
    const f = fixture();
    await f.snapshot.ready();
    f.store.coins.mockRejectedValueOnce(new Error("temporary activity failure"));
    const first = f.snapshot.noteActivity(), second = f.snapshot.noteActivity();
    const failures = Promise.allSettled([first, second]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await failures).map(result => result.status)).toEqual(["rejected", "rejected"]);
    expect(f.snapshot.current.version).toBe(1);
    await f.snapshot.noteActivity();
    expect(f.snapshot.current.version).toBe(2);
  });

  it("shares a slow build across timer ticks and coalesces its activity follow-up", async () => {
    const f = fixture(), blocked = gate();
    await f.snapshot.ready();
    f.snapshot.start();
    f.store.coins.mockImplementationOnce(async () => { await blocked.promise; return []; });
    await vi.advanceTimersByTimeAsync(10_000);
    const hinted = f.snapshot.noteActivity();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.store.coins).toHaveBeenCalledTimes(2);
    blocked.release();
    await hinted;
    expect(f.snapshot.current.version).toBe(3);
    expect(f.store.coins).toHaveBeenCalledTimes(3);
  });

  it("waits for a later build when a new launch was indexed after an in-flight build took its rows", async () => {
    const f = fixture(), blocked = gate();
    await f.snapshot.ready();
    f.snapshot.start();
    const oldCoins = [...f.data.coins], oldQuotes = [...f.data.quotes];
    f.store.coins.mockImplementationOnce(async () => { await blocked.promise; return oldCoins; });
    f.store.quotes.mockResolvedValueOnce(oldQuotes);
    await vi.advanceTimersByTimeAsync(10_000);
    f.data.coins.push({ ...record(), quote: USDC });
    f.data.quotes.push({ address: USDC, kind: 1, decimals: 6, symbol: "USDC", name: "USD Coin", priceUsdE8: 100_000_000n });
    const first = f.snapshot.noteActivity(), second = f.snapshot.noteActivity();
    expect(first).toBe(second);
    let resolved = false;
    void first.then(() => { resolved = true; });
    const oldBuild = f.snapshot.refresh(); // An ordinary tick cannot make that old build satisfy the hint.
    blocked.release();
    await oldBuild;
    expect(f.snapshot.current.coins).toEqual([]);
    expect(f.snapshot.current.quotes.has(USDC)).toBe(false);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(f.store.coins).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(f.store.coins).toHaveBeenCalledTimes(3);
    expect(f.snapshot.current.coins[0]!.quote).toMatchObject({ symbol: "USDC", decimals: 6 });
  });

  it("stop settles activity waiting behind a slow build and prevents its follow-up", async () => {
    const f = fixture(), blocked = gate();
    await f.snapshot.ready();
    f.store.coins.mockImplementationOnce(async () => { await blocked.promise; return []; });
    const building = f.snapshot.refresh(), hinted = f.snapshot.noteActivity();
    f.snapshot.stop();
    await hinted;
    blocked.release();
    await building;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.store.coins).toHaveBeenCalledTimes(2);
  });

  it("rejects an activity waiter behind a failed old build and allows the next hint to retry", async () => {
    const f = fixture(), blocked = gate();
    await f.snapshot.ready();
    f.store.coins.mockImplementationOnce(async () => { await blocked.promise; throw new Error("old build failed"); });
    const building = f.snapshot.refresh(), hinted = f.snapshot.noteActivity();
    const failures = Promise.allSettled([building, hinted]);
    blocked.release();
    expect((await failures).map(result => result.status)).toEqual(["rejected", "rejected"]);
    await f.snapshot.noteActivity();
    expect(f.snapshot.current.version).toBe(2);
    expect(f.store.coins).toHaveBeenCalledTimes(3);
  });

  it("updates balance, fee, quote, moderation and banner changes within the quiet bound", async () => {
    const f = fixture(true);
    await f.snapshot.ready();
    f.snapshot.start();
    f.data.coins[0] = { ...f.data.coins[0]!, feeBps: 50, creatorClaimed: 10n ** 18n, holders: 3 };
    f.data.quotes[0] = { ...f.data.quotes[0]!, priceUsdE8: 200_000_000_000n };
    f.data.holders = { top10: 2n * 10n ** 18n, creatorBalance: 10n ** 18n };
    f.data.moderation.set(ADDRESS, { hidden: true, featured: true });
    f.data.banner = "Updated";
    await vi.advanceTimersByTimeAsync(10_000);
    const coin = f.snapshot.current.coins[0]!;
    expect(coin).toMatchObject({ hidden: true, featured: true, holders: 3, terms: { feeBps: 50 },
      quote: { usdPrice: 2_000 }, stats: { creatorClaimedQuote: 1 } });
    expect(coin.devHoldsPct).toBeGreaterThan(0);
    expect(f.snapshot.current.banner).toBe("Updated");
  });

  it("keeps both pool windows and historical changes while advancing rolling-window time", async () => {
    const f = fixture(true);
    const coin = f.data.coins[0]!;
    f.data.quotes.push({ address: USDC, kind: 1, decimals: 6, symbol: "USDC", name: "USD Coin", priceUsdE8: 100_000_000n });
    f.data.markets = [
      { ...coin, poolId: POOL_A, supplyRaw: 5n * 10n ** 26n },
      { ...coin, poolId: POOL_B, quote: USDC, supplyRaw: 5n * 10n ** 26n, lastTradeAt: NOW / 1000 - 100_000 },
    ];
    f.store.marketWindows.mockImplementation(async (_pools, now) => new Map(f.data.markets.map((m, i) => [m.poolId, {
      volume24hUsdE8: now === NOW / 1000 ? BigInt(i + 1) * 100_000_000n : 0n,
      trades24h: 1, buys24h: 1, volume1hUsdE8: 0n, trades15m: 0,
      priceAgo: { m5: 10n ** 18n, h1: 10n ** 18n, h24: 10n ** 18n },
    }])));
    await f.snapshot.ready();
    f.snapshot.start();
    expect(f.snapshot.current.coins[0]!.volume24hUsd).toBe(3);
    expect(f.store.marketWindows).toHaveBeenLastCalledWith([POOL_A, POOL_B], NOW / 1000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.store.marketWindows).toHaveBeenLastCalledWith([POOL_A, POOL_B], NOW / 1000 + 10);
    expect(f.snapshot.current.coins[0]!.markets).toHaveLength(2);
    expect(f.snapshot.current.coins[0]!.volume24hUsd).toBe(0);
    expect(f.snapshot.current.coins[0]!.markets![1]!.change24h).not.toBe(0);
  });
});
