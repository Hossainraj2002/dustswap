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

/**
 * One poller per process turns new trades and tape items into Server-Sent Events for every
 * connected client, so a thousand open coin pages cost one query a second, not a thousand.
 */
export class LiveHub {
  private readonly subscribers = new Set<Subscriber>();
  private tradeCursor: TradeCursor | null = null;
  private activityCursor: TradeCursor | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(private readonly deps: { store: ReadStore; snapshot: MarketSnapshot }) {}

  get size() {
    return this.subscribers.size;
  }

  start(intervalMs = 1_000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll().catch(() => undefined), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  /** Emits everything newer than the last poll; the first poll only sets the starting point. */
  async poll(): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;
    try {
      const { store } = this.deps;
      if (!this.tradeCursor || !this.activityCursor) {
        const [lastTrade] = await store.recentTrades(1);
        const [lastActivity] = await store.activity({ limit: 1 });
        this.tradeCursor = lastTrade ? { blockNumber: lastTrade.blockNumber, logIndex: lastTrade.logIndex } : { blockNumber: -1n, logIndex: 0 };
        this.activityCursor = lastActivity ? { blockNumber: lastActivity.blockNumber, logIndex: lastActivity.logIndex } : { blockNumber: -1n, logIndex: 0 };
        return 0;
      }
      const state = this.deps.snapshot.current;
      const events: Array<LiveEvent & { order: TradeCursor }> = [];
      for (const t of await store.tradesAfter(this.tradeCursor, 500)) {
        const order = { blockNumber: t.blockNumber, logIndex: t.logIndex };
        if (after(order, this.tradeCursor)) this.tradeCursor = order;
        const coin = state.byAddress.get(t.coin);
        if (coin?.hidden) continue;
        const decimals = state.quotes.get(t.quote ?? state.records.get(t.coin)?.quote ?? "")?.decimals ?? 18;
        events.push({ event: "trade", coin: t.coin, data: deriveTrade(t, decimals), order });
      }
      const newActivity = (await store.activity({ limit: 200, after: this.activityCursor })).reverse();
      for (const a of newActivity) {
        const order = { blockNumber: a.blockNumber, logIndex: a.logIndex };
        if (after(order, this.activityCursor)) this.activityCursor = order;
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
      for (const { order: _order, ...event } of events) {
        for (const subscriber of this.subscribers) {
          if (subscriber.coin && subscriber.coin !== event.coin) continue;
          if (subscriber.poolId && event.event === "trade" && event.data.poolId !== subscriber.poolId) continue;
          subscriber.send(event);
        }
      }
      return events.length;
    } finally {
      this.polling = false;
    }
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
      try {
        await stream.writeSSE({ event: "ready", data: JSON.stringify({ coin }) });
        while (!stream.aborted && !stream.closed) {
          await stream.sleep(HEARTBEAT_MS);
          if (!stream.aborted && !stream.closed) await stream.writeSSE({ event: "ping", data: "" });
        }
      } finally {
        // However the stream ends (client gone, write failure), release its slot exactly once.
        unsubscribe();
        const left = (perIp.get(ip) ?? 1) - 1;
        if (left <= 0) perIp.delete(ip);
        else perIp.set(ip, left);
      }
    });
  });
}
