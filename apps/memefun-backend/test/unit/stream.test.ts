import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LiveHub, mountStream } from "../../api/read/stream";
import type { MarketSnapshot, SnapshotState } from "../../api/read/snapshot";
import type { ActivityRecord, ReadStore, StoredTrade, TradeCursor } from "../../api/read/store";
import type { Coin } from "../../shared/market-types";

const COIN = "0x0000000000000000000000000000000000000001";
const OTHER = "0x0000000000000000000000000000000000000002";
const USDC = "0x0000000000000000000000000000000000000003";
const POOL = `0x${"1".repeat(64)}`;
const POOL2 = `0x${"2".repeat(64)}`;
const newer = (a: TradeCursor, b: TradeCursor) => a.blockNumber > b.blockNumber || a.blockNumber === b.blockNumber && a.logIndex > b.logIndex;
const ascending = (a: TradeCursor, b: TradeCursor) => newer(a, b) ? 1 : newer(b, a) ? -1 : 0;

function trade(block: number, overrides: Partial<StoredTrade> = {}): StoredTrade {
  return { id: `t${block}`, coin: COIN, poolId: POOL, quote: USDC, trader: OTHER, kind: "trade", isBuy: true,
    quoteAmount: 2_500_000n, coinAmount: 10n ** 18n, fee: 25_000n, feeBps: 100, priceUsdE18: 10n ** 18n,
    marketCapUsdE8: 5_000n * 10n ** 8n, isCreator: false, inProtection: false, timestamp: block,
    txHash: `0x${"0".repeat(64)}`, blockNumber: BigInt(block), logIndex: 0, ...overrides };
}

function activity(block: number, overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  return { id: `a${block}`, kind: "launch", coin: COIN, currency: USDC, amountQuote: 2_500_000n,
    amountCoins: null, milestoneUsd: null, blockNumber: BigInt(block), logIndex: 1, timestamp: block, ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const hubs: LiveHub[] = [];
function setup(onActivity?: () => void | Promise<void>) {
  const trades: StoredTrade[] = [];
  const activities: ActivityRecord[] = [];
  const store = {
    recentTrades: vi.fn(async (limit: number) => [...trades].sort(ascending).reverse().slice(0, limit)),
    tradesAfter: vi.fn(async (cursor: TradeCursor, limit: number) => trades.filter(t => newer(t, cursor)).sort(ascending).slice(0, limit)),
    activity: vi.fn(async ({ limit, after }: { limit: number; after?: TradeCursor }) => activities.filter(a => !after || newer(a, after)).sort(ascending).reverse().slice(0, limit)),
  };
  const state: SnapshotState = { version: 1, nowSec: 100, coins: [], byAddress: new Map(), records: new Map(), quotes: new Map(), banner: "" };
  state.quotes.set(USDC, { address: USDC, kind: 1, decimals: 6, symbol: "USDC", name: "USD Coin", priceUsdE8: 100_000_000n });
  const snapshot = { current: state };
  const hub = new LiveHub({ store: store as unknown as ReadStore, snapshot: snapshot as MarketSnapshot, onActivity });
  hubs.push(hub);
  const send = vi.fn();
  const subscribe = () => hub.subscribe({ coin: null, send });
  return { hub, trades, activities, store, snapshot, state, send, subscribe };
}

afterEach(() => { for (const hub of hubs.splice(0)) hub.stop(); vi.useRealTimers(); });

describe("LiveHub demand-driven polling", () => {
  it("does no SQL with no subscribers, including scheduled ticks", async () => {
    vi.useFakeTimers();
    const { hub, store } = setup();
    hub.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await hub.poll()).toBe(0);
    expect(store.recentTrades).not.toHaveBeenCalled();
    expect(store.tradesAfter).not.toHaveBeenCalled();
    expect(store.activity).not.toHaveBeenCalled();
  });

  it("seeds the first subscriber immediately and preserves the active one-second cadence", async () => {
    vi.useFakeTimers();
    const { hub, trades, activities, store, subscribe, send } = setup();
    trades.push(trade(10)); activities.push(activity(10));
    hub.start(); subscribe();
    await hub.poll();
    expect(store.recentTrades).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    trades.push(trade(11)); activities.push(activity(11));
    await vi.advanceTimersByTimeAsync(999);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send.mock.calls.map(([e]) => e.data.id)).toEqual(["t11", "a11"]);
    expect(send.mock.calls[0]![0].data.quoteAmount).toBe(2.5);
    expect(send.mock.calls[1]![0].data.amountQuote).toBe(2.5);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.tradesAfter).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("initializes empty tables and emits the first new rows without replay", async () => {
    const { hub, trades, activities, subscribe, send } = setup();
    subscribe(); await hub.poll();
    trades.push(trade(0)); activities.push(activity(0));
    expect(await hub.poll()).toBe(2);
    expect(send.mock.calls.map(([e]) => e.data.id)).toEqual(["t0", "a0"]);
    expect(await hub.poll()).toBe(0);
  });

  it("retains new rows arriving after baseline reads while initialization is still in flight", async () => {
    const { hub, trades, activities, store, subscribe, send } = setup();
    trades.push(trade(10)); activities.push(activity(10));
    const baseline = deferred<ActivityRecord[]>();
    store.activity.mockImplementationOnce(() => baseline.promise);
    subscribe(); const pending = hub.poll();
    trades.push(trade(11)); activities.push(activity(11));
    baseline.resolve([activity(10)]); await pending;
    expect(send).not.toHaveBeenCalled();
    await hub.poll();
    expect(send.mock.calls.map(([e]) => e.data.id)).toEqual(["t11", "a11"]);
  });

  it("suspends after the last unsubscribe and reconnects at a fresh baseline", async () => {
    vi.useFakeTimers();
    const { hub, trades, activities, store, subscribe, send } = setup();
    trades.push(trade(10)); activities.push(activity(10));
    hub.start(); const unsubscribe = subscribe(); await hub.poll();
    unsubscribe(); unsubscribe();
    expect(hub.size).toBe(0);
    const calls = store.activity.mock.calls.length;
    trades.push(trade(20)); activities.push(activity(20));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.activity).toHaveBeenCalledTimes(calls);
    subscribe(); await hub.poll();
    expect(send).not.toHaveBeenCalled();
    trades.push(trade(21)); activities.push(activity(21));
    await hub.poll();
    expect(send.mock.calls.map(([e]) => e.data.id)).toEqual(["t21", "a21"]);
  });

  it("discards an old in-flight initialization and reseeds a reconnect without concurrent queries", async () => {
    const { hub, trades, activities, store, subscribe, send } = setup();
    const initial = deferred<StoredTrade[]>();
    store.recentTrades.mockImplementationOnce(() => initial.promise);
    hub.start(); const unsubscribe = subscribe();
    const pending = hub.poll();
    unsubscribe(); trades.push(trade(20)); activities.push(activity(20)); subscribe();
    expect(store.recentTrades).toHaveBeenCalledOnce();
    initial.resolve([trade(10)]);
    await pending; await hub.poll();
    expect(store.recentTrades).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
    trades.push(trade(21)); activities.push(activity(21)); await hub.poll();
    expect(send.mock.calls.map(([e]) => e.data.id)).toEqual(["t21", "a21"]);
  });

  it("drops an old in-flight event batch before a reconnect and does not overwrite its baseline", async () => {
    const { hub, trades, activities, store, subscribe, send } = setup();
    trades.push(trade(10)); activities.push(activity(10));
    hub.start(); const unsubscribe = subscribe(); await hub.poll();
    const batch = deferred<StoredTrade[]>();
    store.tradesAfter.mockImplementationOnce(() => batch.promise);
    const pending = hub.poll();
    unsubscribe(); trades.push(trade(20)); activities.push(activity(20)); subscribe();
    batch.resolve([trade(11)]); await pending; await hub.poll();
    expect(send).not.toHaveBeenCalled();
    trades.push(trade(21)); activities.push(activity(21)); await hub.poll();
    expect(send.mock.calls.map(([e]) => e.data.id)).toEqual(["t21", "a21"]);
  });

  it("coalesces concurrent polls and interval ticks while reads are in flight", async () => {
    vi.useFakeTimers();
    const { hub, store, subscribe } = setup();
    hub.start(); subscribe(); await hub.poll();
    const batch = deferred<StoredTrade[]>();
    store.tradesAfter.mockImplementationOnce(() => batch.promise);
    const one = hub.poll(); const two = hub.poll();
    expect(one).toBe(two);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(store.tradesAfter).toHaveBeenCalledOnce();
    batch.resolve([]); await one;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.tradesAfter).toHaveBeenCalledTimes(2);
  });

  it("does not advance either cursor when one database read fails", async () => {
    const { hub, trades, activities, store, subscribe, send } = setup();
    trades.push(trade(10)); activities.push(activity(10)); subscribe(); await hub.poll();
    trades.push(trade(11)); activities.push(activity(11));
    store.activity.mockRejectedValueOnce(new Error("temporary database failure"));
    await expect(hub.poll()).rejects.toThrow("temporary database failure");
    expect(send).not.toHaveBeenCalled();
    await hub.poll();
    expect(store.tradesAfter.mock.calls.at(-1)![0]).toEqual({ blockNumber: 10n, logIndex: 0 });
    expect(send.mock.calls.map(([e]) => e.data.id)).toEqual(["t11", "a11"]);
  });

  it("keeps a failed pair coalesced until its other database read settles", async () => {
    const { hub, store, subscribe } = setup();
    subscribe(); await hub.poll();
    const batch = deferred<StoredTrade[]>();
    store.tradesAfter.mockImplementationOnce(() => batch.promise);
    store.activity.mockRejectedValueOnce(new Error("temporary activity failure"));
    const pending = hub.poll();
    const failure = expect(pending).rejects.toThrow("temporary activity failure");
    await Promise.resolve(); await Promise.resolve();
    expect(hub.poll()).toBe(pending);
    expect(store.tradesAfter).toHaveBeenCalledOnce();
    batch.resolve([]); await failure;
    await hub.poll();
    expect(store.tradesAfter).toHaveBeenCalledTimes(2);
  });

  it("refreshes once before derivation, waits for the fresh quote, and retries failed refreshes", async () => {
    const refresh = vi.fn<() => Promise<void>>();
    const { hub, trades, activities, state, subscribe, send } = setup(refresh);
    trades.push(trade(10)); activities.push(activity(10)); subscribe(); await hub.poll();
    state.quotes.clear();
    trades.push(trade(11)); activities.push(activity(11));
    refresh.mockRejectedValueOnce(new Error("snapshot unavailable"));
    await expect(hub.poll()).rejects.toThrow("snapshot unavailable");
    expect(send).not.toHaveBeenCalled();
    const ready = deferred<void>();
    const entered = deferred<void>();
    refresh.mockImplementationOnce(async () => {
      entered.resolve();
      await ready.promise;
      state.quotes.set(USDC, { address: USDC, kind: 1, decimals: 6, symbol: "USDC", name: "USD Coin", priceUsdE8: 100_000_000n });
    });
    const pending = hub.poll(); await entered.promise;
    expect(send).not.toHaveBeenCalled(); ready.resolve(); await pending;
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0].data.quoteAmount).toBe(2.5);
    expect(send.mock.calls[1]![0].data.amountQuote).toBe(2.5);
    await hub.poll(); expect(refresh).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("drops a disconnected batch while its snapshot refresh is in flight", async () => {
    const ready = deferred<void>();
    const entered = deferred<void>();
    const refresh = vi.fn(() => { entered.resolve(); return ready.promise; });
    const { hub, trades, activities, subscribe, send } = setup(refresh);
    trades.push(trade(10)); activities.push(activity(10));
    hub.start(); const unsubscribe = subscribe(); await hub.poll();
    trades.push(trade(11)); activities.push(activity(11));
    const pending = hub.poll(); await entered.promise;
    expect(refresh).toHaveBeenCalledOnce();
    unsubscribe(); trades.push(trade(20)); activities.push(activity(20)); subscribe();
    ready.resolve(); await pending; await hub.poll();
    expect(send).not.toHaveBeenCalled();
    trades.push(trade(21)); activities.push(activity(21)); await hub.poll();
    expect(send.mock.calls.map(([e]) => e.data.id)).toEqual(["t21", "a21"]);
  });

  it("preserves hidden-coin and per-coin/per-pool filtering while advancing consumed rows", async () => {
    const { hub, trades, activities, state, subscribe, send } = setup();
    const poolSend = vi.fn();
    subscribe(); hub.subscribe({ coin: COIN, poolId: POOL, send: poolSend }); await hub.poll();
    state.byAddress.set(OTHER, { hidden: true } as Coin);
    trades.push(trade(1, { coin: OTHER }), trade(2, { poolId: POOL2 }), trade(3));
    activities.push(activity(1, { coin: OTHER }), activity(2));
    await hub.poll();
    expect(send.mock.calls.map(([e]) => e.data.id)).toEqual(["t2", "a2", "t3"]);
    expect(poolSend.mock.calls.map(([e]) => e.data.id)).toEqual(["a2", "t3"]);
    await hub.poll(); expect(send).toHaveBeenCalledTimes(3);
  });

  it("ignores duplicate or older database rows instead of replaying them", async () => {
    const { hub, trades, activities, store, subscribe, send } = setup();
    trades.push(trade(10)); activities.push(activity(10)); subscribe(); await hub.poll();
    store.tradesAfter.mockResolvedValueOnce([trade(9), trade(10), trade(11)]);
    store.activity.mockResolvedValueOnce([activity(11), activity(10)]);
    await hub.poll();
    expect(send.mock.calls.map(([e]) => e.data.id)).toEqual(["t11", "a11"]);
  });

  it("does not deliver or restart in-flight work after stop", async () => {
    vi.useFakeTimers();
    const { hub, trades, store, subscribe, send } = setup();
    hub.start(); subscribe(); await hub.poll();
    const batch = deferred<StoredTrade[]>(); store.tradesAfter.mockImplementationOnce(() => batch.promise);
    const pending = hub.poll(); hub.stop(); trades.push(trade(1));
    batch.resolve([trade(1)]); await pending;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(send).not.toHaveBeenCalled();
    expect(store.recentTrades).toHaveBeenCalledOnce();
    expect(store.tradesAfter).toHaveBeenCalledOnce();
  });

  it("waits for the new audience's initialization when reconnecting during an old read", async () => {
    const { hub, store, subscribe } = setup();
    const old = deferred<StoredTrade[]>(); const current = deferred<StoredTrade[]>();
    const entered = deferred<void>();
    store.recentTrades.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => { entered.resolve(); return current.promise; });
    hub.start(); const unsubscribe = subscribe();
    unsubscribe(); subscribe();
    let initialized = false;
    const waiting = hub.waitUntilInitialized().then(value => { initialized = value; });
    old.resolve([trade(10)]);
    await entered.promise;
    expect(initialized).toBe(false);
    current.resolve([trade(20)]); await waiting;
    expect(initialized).toBe(true);
    expect(store.recentTrades).toHaveBeenCalledTimes(2);
  });

  it("does not reinitialize after stop or unsubscribe while waiting for a baseline", async () => {
    const { hub, store, subscribe } = setup();
    const baseline = deferred<StoredTrade[]>();
    store.recentTrades.mockImplementationOnce(() => baseline.promise);
    hub.start(); const unsubscribe = subscribe();
    const waiting = hub.waitUntilInitialized();
    hub.stop(); unsubscribe(); baseline.resolve([trade(10)]);
    expect(await waiting).toBe(false);
    expect(store.recentTrades).toHaveBeenCalledOnce();
    expect(await hub.waitUntilInitialized()).toBe(false);
  });
});

describe("SSE initialization handshake", () => {
  it("sends ready only after the baseline, then emits trades indexed after ready", async () => {
    vi.useFakeTimers();
    const { hub, store, trades } = setup();
    const baseline = deferred<StoredTrade[]>();
    store.recentTrades.mockImplementationOnce(() => baseline.promise);
    const app = new Hono(); mountStream(app, hub);
    const response = await app.request("/v1/stream");
    const reader = response.body!.getReader();
    let delivered = false;
    const first = reader.read().then(value => { delivered = true; return value; });
    await Promise.resolve(); await Promise.resolve();
    expect(delivered).toBe(false);
    trades.push(trade(11)); baseline.resolve([trade(11)]);
    expect(new TextDecoder().decode((await first).value)).toContain("event: ready\n");
    trades.push(trade(12));
    const second = reader.read(); await hub.poll();
    const frame = new TextDecoder().decode((await second).value);
    expect(frame).toContain("event: trade\n");
    expect(frame).toContain('"id":"t12"');
    await reader.cancel();
    expect(hub.size).toBe(0);
  });

  it("closes without false ready on database failure and releases every connection slot", async () => {
    vi.useFakeTimers();
    const { hub, store } = setup();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const app = new Hono(); mountStream(app, hub);
      // More than MAX_PER_IP failed attempts must remain available to reconnect.
      for (let attempt = 0; attempt < 9; attempt++) {
        store.recentTrades.mockRejectedValueOnce(new Error("temporary initialization failure"));
        const response = await app.request("/v1/stream");
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("");
        expect(hub.size).toBe(0);
      }
      const response = await app.request("/v1/stream");
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: ready\n");
      await reader.cancel(); expect(hub.size).toBe(0);
    } finally { logged.mockRestore(); }
  });

  it("releases an aborted connection while its baseline is pending", async () => {
    vi.useFakeTimers();
    const { hub, store } = setup();
    const baseline = deferred<StoredTrade[]>();
    store.recentTrades.mockImplementationOnce(() => baseline.promise);
    const app = new Hono(); mountStream(app, hub);
    const response = await app.request("/v1/stream");
    expect(hub.size).toBe(1);
    await response.body!.cancel();
    expect(hub.size).toBe(0);
    baseline.resolve([trade(10)]); await hub.poll();
    expect(store.recentTrades).toHaveBeenCalledOnce();
  });
});
