import { Hono } from "hono";
import { getAddress } from "viem";

import type { AppStore } from "../../lib/app-store";
import { DEAD, type Lower } from "../../lib/indexer/addresses";
import { type TradeView, costBasisUsd, coinValue, deriveTrade, fillCandles, toQuoteAsset } from "../../lib/market/derive";
import { priceUsdE18, toNumber } from "../../lib/market/math";
import { COIN_SUPPLY } from "../../shared/core/constants";
import type { ActivityItem, Candle, CandleInterval, Claimable, Coin, Comment, CreatorProfile, Holder, Position } from "../../shared/market-types";
import { HttpError, cachedJson, parseAddress, parseLimit } from "../http";
import type { SettingsReader } from "./settings";
import type { MarketSnapshot, SnapshotState } from "./snapshot";
import type { ReadStore, TradeCursor } from "./store";

export interface ReadDeps {
  snapshot: MarketSnapshot;
  store: ReadStore;
  app: AppStore;
  settings: SettingsReader;
  /** PoolManager and the holder-rewards distributor, for holder labels and claims. */
  poolManager: Lower;
}

/** Claimable as the app's type, plus what a holder-reward claim transaction needs. */
export type ClaimableView = Claimable & {
  currency: string;
  amountRaw: string;
  index?: string;
  proof?: string[];
  claimableAt?: number;
  expiresAt?: number;
};

const INTERVALS: readonly CandleInterval[] = [60, 300, 900, 3600, 14400, 86400];
const SORTS = ["trending", "new", "top", "movers"] as const;
const AGES: Record<string, number> = { "1h": 3_600, "6h": 21_600, "24h": 86_400, "7d": 604_800 };
const MAX_CANDLES = 320;
const VETO_WINDOW = 12 * 3_600;
const CLAIM_PERIOD = 90 * 86_400;

export function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor<T>(value: string | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "invalid_cursor", "The cursor is not valid. Start again without it.");
  }
}

function tradeCursor(value: string | undefined): TradeCursor | undefined {
  const raw = decodeCursor<{ b: string; l: number }>(value);
  if (!raw) return undefined;
  if (typeof raw.b !== "string" || !/^\d+$/.test(raw.b) || !Number.isInteger(raw.l)) {
    throw new HttpError(400, "invalid_cursor", "The cursor is not valid. Start again without it.");
  }
  return { blockNumber: BigInt(raw.b), logIndex: raw.l };
}

/** Lists, filters and sorts exactly as the Discover screen offers them. */
export function filterCoins(
  coins: Coin[],
  query: { sort?: string; pair?: string; mode?: string; age?: string; q?: string },
  nowSec: number,
): Coin[] {
  let list = coins.filter((c) => !c.hidden);
  const pair = query.pair?.toLowerCase();
  if (pair) {
    const kind = { eth: "native", native: "native", usdc: "stable", stable: "stable", stock: "stock", stocks: "stock" }[pair];
    list = list.filter((c) => (kind ? c.quote.kind === kind : c.quote.address.toLowerCase() === pair || c.quote.symbol.toLowerCase() === pair));
  }
  if (query.mode) {
    if (!["creator", "burn", "holders", "floor"].includes(query.mode)) throw new HttpError(400, "invalid_mode", "mode must be creator, burn, holders or floor.");
    list = list.filter((c) => c.terms.mode === query.mode);
  }
  if (query.age) {
    const seconds = AGES[query.age];
    if (!seconds) throw new HttpError(400, "invalid_age", "age must be 1h, 6h, 24h or 7d.");
    list = list.filter((c) => c.createdAt >= (nowSec - seconds) * 1000);
  }
  if (query.q) list = searchCoins(list, query.q);
  const sort = query.sort ?? "trending";
  if (!(SORTS as readonly string[]).includes(sort)) throw new HttpError(400, "invalid_sort", "sort must be trending, new, top or movers.");
  const sorted = [...list];
  if (sort === "trending") sorted.sort((a, b) => b.momentum - a.momentum || b.createdAt - a.createdAt);
  if (sort === "new") sorted.sort((a, b) => b.createdAt - a.createdAt);
  if (sort === "top") sorted.sort((a, b) => b.marketCapUsd - a.marketCapUsd);
  if (sort === "movers") sorted.sort((a, b) => b.change24h - a.change24h || b.volume24hUsd - a.volume24hUsd);
  return sorted;
}

/** Address, exact ticker, then ticker and name prefixes, then substrings. */
export function searchCoins(coins: Coin[], raw: string): Coin[] {
  const q = raw.trim().replace(/^\$/, "").toLowerCase();
  if (!q) return [];
  const score = (c: Coin) => {
    if (c.address.toLowerCase() === q) return 0;
    const symbol = c.symbol.toLowerCase();
    const name = c.name.toLowerCase();
    if (symbol === q) return 1;
    if (symbol.startsWith(q)) return 2;
    if (name.startsWith(q)) return 3;
    if (symbol.includes(q) || name.includes(q)) return 4;
    return 9;
  };
  return coins
    .map((c) => ({ c, s: score(c) }))
    .filter((x) => x.s < 9)
    .sort((a, b) => a.s - b.s || b.c.marketCapUsd - a.c.marketCapUsd)
    .map((x) => x.c);
}

function requireCoin(state: SnapshotState, address: Lower): Coin {
  const coin = state.byAddress.get(address);
  if (!coin) throw new HttpError(404, "coin_not_found", "No coin with this address on memefun.");
  return coin;
}

export function creatorProfiles(state: SnapshotState): CreatorProfile[] {
  const byCreator = new Map<string, CreatorProfile>();
  for (const coin of state.coins) {
    if (coin.hidden) continue;
    const key = coin.creator.toLowerCase();
    const profile = byCreator.get(key) ?? { address: coin.creator, name: "", coins: [], earnedUsd: 0, volumeUsd: 0, joinedAt: coin.createdAt };
    profile.coins.push(coin.address);
    profile.earnedUsd += coin.stats.creatorEarnedQuote * coin.quote.usdPrice;
    profile.volumeUsd += coin.volumeTotalUsd;
    profile.joinedAt = Math.min(profile.joinedAt, coin.createdAt);
    byCreator.set(key, profile);
  }
  return [...byCreator.values()];
}

export function readRoutes(deps: ReadDeps) {
  const app = new Hono();
  const snapshot = () => deps.snapshot.ready();
  const quoteDecimals = (state: SnapshotState, coin: string) => state.quotes.get(state.records.get(coin)?.quote ?? "")?.decimals ?? 18;
  const visible = (state: SnapshotState, coin: string) => {
    const c = state.byAddress.get(coin);
    return Boolean(c && !c.hidden);
  };

  app.get("/v1/coins", async (c) => {
    const state = await snapshot();
    const list = filterCoins(state.coins, c.req.query(), state.nowSec);
    const limit = parseLimit(c.req.query("limit"), 50, 200);
    const offset = decodeCursor<{ o: number }>(c.req.query("cursor"))?.o ?? 0;
    if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, "invalid_cursor", "The cursor is not valid. Start again without it.");
    const page = list.slice(offset, offset + limit);
    const next = offset + limit < list.length ? encodeCursor({ o: offset + limit }) : null;
    return cachedJson(c, { coins: page, nextCursor: next, total: list.length, asOf: state.nowSec * 1000 }, { maxAge: 2 });
  });

  app.get("/v1/coins/:address", async (c) => {
    const state = await snapshot();
    return cachedJson(c, { coin: requireCoin(state, parseAddress(c.req.param("address"))) }, { maxAge: 2 });
  });

  app.get("/v1/coins/:address/trades", async (c) => {
    const state = await snapshot();
    const address = parseAddress(c.req.param("address"));
    requireCoin(state, address);
    const limit = parseLimit(c.req.query("limit"), 60, 200);
    const trades = await deps.store.trades(address, { limit, before: tradeCursor(c.req.query("before")) });
    const decimals = quoteDecimals(state, address);
    const last = trades.at(-1);
    return cachedJson(
      c,
      {
        trades: trades.map((t) => deriveTrade(t, decimals)),
        nextCursor: trades.length === limit && last ? encodeCursor({ b: last.blockNumber.toString(), l: last.logIndex }) : null,
      },
      { maxAge: 1 },
    );
  });

  app.get("/v1/coins/:address/candles", async (c) => {
    const state = await snapshot();
    const address = parseAddress(c.req.param("address"));
    const coin = requireCoin(state, address);
    const record = state.records.get(address)!;
    const interval = Number(c.req.query("interval") ?? 300) as CandleInterval;
    if (!INTERVALS.includes(interval)) throw new HttpError(400, "invalid_interval", "interval must be 60, 300, 900, 3600, 14400 or 86400.");
    const metric = c.req.query("metric") === "mcap" ? "mcap" : "price";
    const endSec = Math.floor(state.nowSec / interval) * interval;
    const createdBucket = Math.floor(record.createdAt / interval) * interval;
    const startSec = Math.max(createdBucket, endSec - interval * (MAX_CANDLES - 1));
    const rows = await deps.store.candles(address, interval, startSec, metric);
    const before = startSec > createdBucket ? await deps.store.lastCloseBefore(address, interval, startSec, metric) : null;
    const opening = metric === "price" ? BigInt(Math.round((coin.openingMarketCapUsd / 1e9) * 1e18)) : BigInt(Math.round(coin.openingMarketCapUsd * 1e8));
    const candles: Candle[] = fillCandles({
      candles: rows,
      interval,
      startSec,
      endSec,
      openingValue: before ?? opening,
      scale: metric === "price" ? "usdE18" : "usdE8",
    });
    return cachedJson(c, { candles, interval, metric }, { maxAge: 2 });
  });

  // Everything needed to quote a trade exactly (apps/memefun src/core/pool.ts `livePool`): slot0,
  // the launch position and the floor bands, which are the pool's only liquidity.
  app.get("/v1/coins/:address/pool", async (c) => {
    const state = await snapshot();
    const address = parseAddress(c.req.param("address"));
    const coin = requireCoin(state, address);
    const pool = await deps.store.pool(address);
    if (!pool) throw new HttpError(404, "coin_not_found", "No coin with this address on memefun.");
    return cachedJson(
      c,
      {
        pool: {
          coin: coin.address,
          poolId: pool.poolId,
          quote: getAddress(pool.quote),
          quoteDecimals: coin.quote.decimals,
          coinIsCurrency0: !pool.quoteIsCurrency0,
          startTick: pool.startTick,
          liquidity: pool.liquidity.toString(),
          sqrtPriceX96: pool.sqrtPriceX96.toString(),
          tick: pool.tick,
          floors: pool.floors.map((f) => ({ tickLower: f.tickLower, tickUpper: f.tickUpper, liquidity: f.liquidity.toString() })),
        },
        asOf: state.nowSec * 1000,
      },
      { maxAge: 1 },
    );
  });

  app.get("/v1/coins/:address/holders", async (c) => {
    const state = await snapshot();
    const address = parseAddress(c.req.param("address"));
    const coin = requireCoin(state, address);
    const viewer = c.req.query("viewer") ? parseAddress(c.req.query("viewer"), "viewer") : null;
    const limit = parseLimit(c.req.query("limit"), 25, 100);
    const creator = coin.creator.toLowerCase();
    const holders: Holder[] = (await deps.store.holders(address, limit)).map((h) => {
      const account = h.account.toLowerCase();
      const label =
        account === deps.poolManager ? "pool" : account === DEAD ? "burn" : account === creator ? "creator" : viewer && account === viewer ? "you" : undefined;
      return { address: getAddress(h.account), balance: toNumber.coins(h.amount), pct: Number((h.amount * 1_000_000n) / COIN_SUPPLY) / 1_000_000, ...(label ? { label } : {}) };
    });
    return cachedJson(c, { holders }, { maxAge: 2 });
  });

  app.get("/v1/coins/:address/comments", async (c) => {
    const state = await snapshot();
    const address = parseAddress(c.req.param("address"));
    const coin = requireCoin(state, address);
    const limit = parseLimit(c.req.query("limit"), 50, 200);
    const creator = coin.creator.toLowerCase();
    const comments: Comment[] = (await deps.app.comments(address, limit)).map((m) => ({
      id: m.id,
      coin: coin.address,
      author: getAddress(m.author),
      body: m.body,
      ts: m.createdAt,
      isCreator: m.author === creator,
    }));
    return cachedJson(c, { comments }, { maxAge: 2 });
  });

  app.get("/v1/coins/:address/balance/:owner", async (c) => {
    const address = parseAddress(c.req.param("address"));
    const owner = parseAddress(c.req.param("owner"), "owner");
    const row = await deps.store.balance(address, owner);
    const amount = row?.amount ?? 0n;
    return cachedJson(c, { balance: toNumber.coins(amount), raw: amount.toString() }, { maxAge: 1, private: true });
  });

  app.get("/v1/activity", async (c) => {
    const state = await snapshot();
    const limit = parseLimit(c.req.query("limit"), 40, 200);
    const [trades, events] = await Promise.all([deps.store.recentTrades(limit * 2), deps.store.activity({ limit: limit * 2 })]);
    const items: Array<ActivityItem & { order: [bigint, number] }> = [];
    for (const t of trades) {
      if (!visible(state, t.coin)) continue;
      const trade = deriveTrade(t, quoteDecimals(state, t.coin));
      items.push({ id: t.id, kind: "trade", coin: trade.coin, ts: trade.ts, trade, order: [t.blockNumber, t.logIndex] });
    }
    for (const e of events) {
      if (!visible(state, e.coin)) continue;
      const decimals = quoteDecimals(state, e.coin);
      items.push({
        id: e.id,
        kind: e.kind as ActivityItem["kind"],
        coin: getAddress(e.coin),
        ts: e.timestamp * 1000,
        ...(e.amountQuote !== null ? { amountQuote: toNumber.units(e.amountQuote, decimals) } : {}),
        ...(e.amountCoins !== null ? { amountCoins: toNumber.coins(e.amountCoins) } : {}),
        ...(e.milestoneUsd !== null ? { milestone: e.milestoneUsd } : {}),
        order: [e.blockNumber, e.logIndex],
      });
    }
    items.sort((a, b) => (a.order[0] === b.order[0] ? b.order[1] - a.order[1] : a.order[0] < b.order[0] ? 1 : -1));
    return cachedJson(c, { items: items.slice(0, limit).map(({ order: _order, ...item }) => item) }, { maxAge: 1 });
  });

  app.get("/v1/creators/top", async (c) => {
    const state = await snapshot();
    const limit = parseLimit(c.req.query("limit"), 50, 200);
    const creators = creatorProfiles(state).sort((a, b) => b.volumeUsd - a.volumeUsd);
    return cachedJson(c, { creators: creators.slice(0, limit) }, { maxAge: 5 });
  });

  app.get("/v1/profiles/:address", async (c) => {
    const state = await snapshot();
    const address = parseAddress(c.req.param("address"));
    const profile = creatorProfiles(state).find((p) => p.address.toLowerCase() === address) ?? null;
    const trades = await deps.store.tradesByTrader(address, 50);
    return cachedJson(
      c,
      {
        profile,
        trades: trades.filter((t) => visible(state, t.coin)).map((t): TradeView => deriveTrade(t, quoteDecimals(state, t.coin))),
      },
      { maxAge: 2 },
    );
  });

  app.get("/v1/positions/:address", async (c) => {
    const state = await snapshot();
    const owner = parseAddress(c.req.param("address"), "owner");
    const positions: Position[] = [];
    for (const b of await deps.store.balancesOf(owner)) {
      const coin = state.byAddress.get(b.coin);
      const record = state.records.get(b.coin);
      const quote = record ? state.quotes.get(record.quote) : undefined;
      if (!coin || coin.hidden || !record || !quote) continue;
      const priceE18 = priceUsdE18(record.sqrtPriceX96, { quoteIsCurrency0: record.quoteIsCurrency0, quoteDecimals: quote.decimals }, quote.priceUsdE8);
      const valueUsd = coinValue(b.amount, priceE18);
      const basis = costBasisUsd({ amount: b.amount, boughtCoins: b.boughtCoins, boughtUsdE8: b.boughtUsdE8, priceUsdE18: priceE18 });
      positions.push({ coin: coin.address, balance: toNumber.coins(b.amount), costBasisUsd: basis, valueUsd, pnlUsd: valueUsd - basis });
    }
    positions.sort((a, b) => b.valueUsd - a.valueUsd);
    return cachedJson(c, { positions }, { maxAge: 2, private: true });
  });

  app.get("/v1/claimables/:address", async (c) => {
    const state = await snapshot();
    const owner = parseAddress(c.req.param("address"), "owner");
    const items: ClaimableView[] = [];

    // Creator fees: every coin this wallet is the creator of now.
    for (const coin of state.coins) {
      if (coin.creator.toLowerCase() !== owner) continue;
      const record = state.records.get(coin.address.toLowerCase())!;
      const pending = record.creatorEarned - record.creatorClaimed;
      if (pending <= 0n) continue;
      const amountQuote = toNumber.units(pending, coin.quote.decimals);
      items.push({
        coin: coin.address,
        kind: "creator",
        amountQuote,
        quoteSymbol: coin.quote.symbol,
        amountUsd: amountQuote * coin.quote.usdPrice,
        currency: coin.quote.address,
        amountRaw: pending.toString(),
      });
    }

    // Referral fees: FeeVault keeps them per pair asset, so `coin` is the pair asset here.
    for (const r of await deps.store.referralLedger(owner)) {
      const pending = r.earned - r.claimed;
      const quote = state.quotes.get(r.currency);
      if (pending <= 0n || !quote) continue;
      const asset = toQuoteAsset(quote);
      const amountQuote = toNumber.units(pending, quote.decimals);
      items.push({
        coin: asset.address,
        kind: "referral",
        amountQuote,
        quoteSymbol: asset.symbol,
        amountUsd: amountQuote * asset.usdPrice,
        currency: asset.address,
        amountRaw: pending.toString(),
      });
    }

    // Holder rewards: published leaves not yet claimed, within their claim window.
    const [leaves, claimed, epochs] = await Promise.all([deps.app.rewardLeavesOf(owner), deps.store.holderClaimsOf(owner), deps.store.epochs()]);
    for (const leaf of leaves) {
      const epoch = epochs.get(leaf.epoch.toString());
      if (!epoch || epoch.vetoed) continue;
      if (claimed.has(`${leaf.epoch}:${leaf.coin}:${leaf.index}`)) continue;
      const expiresAt = epoch.publishedAt + CLAIM_PERIOD;
      if (state.nowSec > expiresAt) continue;
      const coin = state.byAddress.get(leaf.coin);
      if (!coin) continue;
      const amountQuote = toNumber.units(leaf.amount, coin.quote.decimals);
      items.push({
        coin: coin.address,
        kind: "holders",
        amountQuote,
        quoteSymbol: coin.quote.symbol,
        amountUsd: amountQuote * coin.quote.usdPrice,
        epoch: Number(leaf.epoch),
        currency: coin.quote.address,
        amountRaw: leaf.amount.toString(),
        index: leaf.index.toString(),
        proof: leaf.proof,
        claimableAt: (epoch.publishedAt + VETO_WINDOW) * 1000,
        expiresAt: expiresAt * 1000,
      });
    }
    items.sort((a, b) => b.amountUsd - a.amountUsd);
    return cachedJson(c, { claimables: items }, { maxAge: 2, private: true });
  });

  app.get("/v1/launch-settings", async (c) => {
    const state = await snapshot();
    const settings = await deps.settings.get();
    const quotes = [...state.quotes.values()].map(toQuoteAsset);
    return cachedJson(c, { settings, quotes }, { maxAge: 10 });
  });

  app.get("/v1/moderation", async (c) => {
    const state = await snapshot();
    const featured = state.coins.filter((coin) => coin.featured && !coin.hidden).map((coin) => coin.address);
    return cachedJson(c, { featured, banner: state.banner }, { maxAge: 5 });
  });

  app.get("/v1/search", async (c) => {
    const state = await snapshot();
    const q = c.req.query("q") ?? "";
    if (q.length > 64) throw new HttpError(400, "query_too_long", "Search with 64 characters or fewer.");
    const limit = parseLimit(c.req.query("limit"), 20, 50);
    return cachedJson(c, { coins: searchCoins(state.coins.filter((coin) => !coin.hidden), q).slice(0, limit) }, { maxAge: 2 });
  });

  app.get("/v1/stats", async (c) => {
    const state = await snapshot();
    const visibleCoins = state.coins.filter((coin) => !coin.hidden);
    const totals = await deps.store.platformTotals();
    return cachedJson(
      c,
      {
        coins: visibleCoins.length,
        trades: totals.trades,
        volumeUsd: toNumber.usdE8(totals.volumeUsdE8),
        volume24hUsd: visibleCoins.reduce((sum, coin) => sum + coin.volume24hUsd, 0),
        launches24h: visibleCoins.filter((coin) => coin.createdAt >= (state.nowSec - 86_400) * 1000).length,
        asOf: state.nowSec * 1000,
      },
      { maxAge: 5 },
    );
  });

  return app;
}
