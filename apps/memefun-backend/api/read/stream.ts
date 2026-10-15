import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getAddress } from "viem";

import { type TradeView, deriveTrade } from "../../lib/market/derive";
import { toNumber } from "../../lib/market/math";
import type { ActivityItem } from "../../shared/market-types";
import { HttpError, clientIp, parseAddress } from "../http";
import type { MarketSnapshot } from "./snapshot";
import type { ReadStore, TradeCursor } from "./store";

type LiveEvent = { event: "trade"; coin: string; data: TradeView } | { event: "activity"; coin: string; data: ActivityItem };

interface Subscriber {
  coin: string | null;
  poolId?: string | null;
  send: (event: LiveEvent) => void;
}

const after = (a: TradeCursor, b: TradeCursor) => a.blockNumber > b.blockNumber || (a.blockNumber === b.blockNumber && a.logIndex > b.logIndex);

/** A failed sibling must settle before another poll can reuse its database connections. */
async function readTogether<A, B>(one: Promise<A>, two: Promise<B>): Promise<[A, B]> {
  const [a, b] = await Promise.allSettled([one, two]);
  if (a.status === "rejected") throw a.reason;
  if (b.status === "rejected") throw b.reason;
  return [a.value, b.value];
}

/**
 * One poller per process turns new trades and tape items into Server-Sent Events for every
 * connected client, so a thousand open coin pages cost one query a second, not a thousand.
 */
export class LiveHub {
  private readonly subscribers = new Set<Subscriber>();
  private tradeCursor: TradeCursor | null = null;
  private activityCursor: TradeCursor | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<number> | null = null;
  /** In-flight reads from an earlier audience must never seed or emit to a new one. */
  private audience = 0;

  constructor(private readonly deps: { store: ReadStore; snapshot: MarketSnapshot; onActivity?: () => void | Promise<void> }) {}

  get size() {
    return this.subscribers.size;
  }

  start(intervalMs = 1_000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll().catch(() => undefined), intervalMs);
    this.timer.unref?.();
    if (this.subscribers.size) void this.poll().catch(() => undefined);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.resetAudience();
  }

  subscribe(subscriber: Subscriber): () => void {
    const first = this.subscribers.size === 0;
    this.subscribers.add(subscriber);
    if (first) {
      this.resetAudience();
      if (this.timer) void this.poll().catch(() => undefined);
    }
    return () => {
      if (this.subscribers.delete(subscriber) && this.subscribers.size === 0) this.resetAudience();
    };
  }

  private resetAudience() {
    this.audience += 1;
    this.tradeCursor = null;
    this.activityCursor = null;
  }

  private hasAudience(audience: number) {
    return audience === this.audience && this.subscribers.size > 0;
  }

  /** A stream is ready only after the current audience has its own live-event baseline. */
  async waitUntilInitialized(): Promise<boolean> {
    const audience = this.audience;
    while (this.hasAudience(audience)) {
      if (this.tradeCursor && this.activityCursor) return true;
      // A reconnect can initially share an older audience's pending read. Its settlement
      // cannot satisfy this loop: both current cursors must actually have been initialized.
      await this.poll();
    }
    return false;
  }

  /** Emits everything newer than the last poll; the first poll only sets the starting point. */
  poll(): Promise<number> {
    if (!this.subscribers.size) return Promise.resolve(0);
    if (this.polling) return this.polling;
    const audience = this.audience;
    const polling = this.read(audience);
    this.polling = polling;
    const settled = () => {
      if (this.polling !== polling) return;
      this.polling = null;
      // A reconnect during a database read gets its own fresh baseline as soon as that read
      // settles, without overlapping queries or waiting for another interval tick.
      if (this.timer && audience !== this.audience && this.subscribers.size) void this.poll().catch(() => undefined);
    };
    void polling.then(settled, settled);
    return polling;
  }

  private async read(audience: number): Promise<number> {
    const { store } = this.deps;
    if (!this.tradeCursor || !this.activityCursor) {
      const [[lastTrade], [lastActivity]] = await readTogether(store.recentTrades(1), store.activity({ limit: 1 }));
      if (!this.hasAudience(audience)) return 0;
      this.tradeCursor = lastTrade ? { blockNumber: lastTrade.blockNumber, logIndex: lastTrade.logIndex } : { blockNumber: -1n, logIndex: 0 };
      this.activityCursor = lastActivity ? { blockNumber: lastActivity.blockNumber, logIndex: lastActivity.logIndex } : { blockNumber: -1n, logIndex: 0 };
      return 0;
    }
    let tradeCursor = this.tradeCursor;
    let activityCursor = this.activityCursor;
    const [trades, activities] = await readTogether(store.tradesAfter(tradeCursor, 500), store.activity({ limit: 200, after: activityCursor }));
    if (!this.hasAudience(audience)) return 0;
    const newTrades = trades.filter(t => after(t, tradeCursor));
    const newActivity = activities.filter(a => after(a, activityCursor)).reverse();
    // A new launch may introduce a quote/coin absent from the quiet snapshot. Refresh once
    // before deriving the batch, and keep both cursors unchanged if that refresh fails.
    if (newTrades.length || newActivity.length) await this.deps.onActivity?.();
    if (!this.hasAudience(audience)) return 0;
    const state = this.deps.snapshot.current;
    const events: Array<LiveEvent & { order: TradeCursor }> = [];
    for (const t of newTrades) {
      const order = { blockNumber: t.blockNumber, logIndex: t.logIndex };
      if (after(order, tradeCursor)) tradeCursor = order;
      const coin = state.byAddress.get(t.coin);
      if (coin?.hidden) continue;
      const decimals = state.quotes.get(t.quote ?? state.records.get(t.coin)?.quote ?? "")?.decimals ?? 18;
      events.push({ event: "trade", coin: t.coin, data: deriveTrade(t, decimals), order });
    }
    for (const a of newActivity) {
      const order = { blockNumber: a.blockNumber, logIndex: a.logIndex };
      if (after(order, activityCursor)) activityCursor = order;
      const coin = state.byAddress.get(a.coin);
      if (coin?.hidden) continue;
      const decimals = state.quotes.get(a.currency ?? state.records.get(a.coin)?.quote ?? "")?.decimals ?? 18;
      events.push({
        event: "activity",
        coin: a.coin,
        data: {
          id: a.id,
          kind: a.kind as ActivityItem["kind"],
          coin: getAddress(a.coin),
          ...(a.poolId ? { poolId: a.poolId as `0x${string}` } : {}),
          ...(a.currency ? { quote: getAddress(a.currency) } : {}),
          ts: a.timestamp * 1000,
          ...(a.amountQuote !== null ? { amountQuote: toNumber.units(a.amountQuote, decimals) } : {}),
          ...(a.amountCoins !== null ? { amountCoins: toNumber.coins(a.amountCoins) } : {}),
          ...(a.milestoneUsd !== null ? { milestone: a.milestoneUsd } : {}),
        },
        order,
      });
    }
    events.sort((x, y) => (after(x.order, y.order) ? 1 : after(y.order, x.order) ? -1 : 0));
    this.tradeCursor = tradeCursor;
    this.activityCursor = activityCursor;
    for (const { order: _order, ...event } of events) {
      for (const subscriber of this.subscribers) {
        if (!this.hasAudience(audience)) return events.length;
        if (subscriber.coin && subscriber.coin !== event.coin) continue;
        if (subscriber.poolId && event.event === "trade" && event.data.poolId !== subscriber.poolId) continue;
        subscriber.send(event);
      }
    }
    return events.length;
  }
}

const MAX_CLIENTS = 5_000;
const MAX_PER_IP = 8;
const HEARTBEAT_MS = 15_000;

export function mountStream(app: Hono, hub: LiveHub) {
  const perIp = new Map<string, number>();
  app.get("/v1/stream", (c) => {
    const coin = c.req.query("coin") ? parseAddress(c.req.query("coin"), "coin") : null;
    const poolId = c.req.query("poolId")?.toLowerCase() ?? null;
    if (poolId && !/^0x[0-9a-f]{64}$/.test(poolId)) throw new HttpError(400, "invalid_pool", "poolId must be a pool ID.");
    const ip = clientIp(c);
    if (hub.size >= MAX_CLIENTS) throw new HttpError(503, "stream_full", "Live updates are at capacity. The page refreshes on its own.");
    if ((perIp.get(ip) ?? 0) >= MAX_PER_IP) throw new HttpError(429, "too_many_streams", "Too many live connections from this network.");
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let id = 0;
      const unsubscribe = hub.subscribe({
        coin,
        poolId,
        send: (event) => void stream.writeSSE({ event: event.event, data: JSON.stringify(event.data), id: String(++id) }).catch(() => undefined),
      });
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        unsubscribe();
        const left = (perIp.get(ip) ?? 1) - 1;
        if (left <= 0) perIp.delete(ip);
        else perIp.set(ip, left);
      };
      // Release the audience and per-IP slot promptly even if initialization is still waiting
      // for the database. The finally block also covers initialization failure and normal end.
      stream.onAbort(release);
      try {
        if (!await hub.waitUntilInitialized() || stream.aborted || stream.closed) return;
        await stream.writeSSE({ event: "ready", data: JSON.stringify({ coin }) });
        while (!stream.aborted && !stream.closed) {
          await stream.sleep(HEARTBEAT_MS);
          if (!stream.aborted && !stream.closed) await stream.writeSSE({ event: "ping", data: "" });
        }
      } finally {
        // However the stream ends (client gone, write failure), release its slot exactly once.
        release();
      }
    });
  });
}
