import type { AppStore } from "../../lib/app-store";
import { parseIpfsUri } from "../../lib/cid";
import {
  type CoinMetadataView,
  type CoinRecord,
  type MarketRecord,
  type CoinWindows,
  EMPTY_WINDOWS,
  type HolderStats,
  type QuoteRecord,
  deriveCoin,
  sparklineFrom,
} from "../../lib/market/derive";
import { priceUsdE18 } from "../../lib/market/math";
import type { MediaStore } from "../../lib/media/store";
import type { Coin } from "../../shared/market-types";
import { getSqrtPriceAtTick } from "../../shared/core/uniswap/tickMath";
import type { ReadStore } from "./store";

const DAY = 86_400;
/** A coin with no trade in the last day (plus this margin) has flat rolling windows. */
const ACTIVE_MARGIN = 900;

export interface SnapshotState {
  version: number;
  nowSec: number;
  coins: Coin[];
  byAddress: Map<string, Coin>;
  records: Map<string, CoinRecord>;
  quotes: Map<string, QuoteRecord>;
  markets?: Map<string, MarketRecord>;
  banner: string;
}

/**
 * The market as the app sees it, rebuilt every few seconds from the index. Every request reads the
 * latest complete snapshot, so a list never mixes two refreshes, and the database sees one set of
 * queries per refresh no matter how many requests arrive.
 */
export class MarketSnapshot {
  private state: SnapshotState = { version: 0, nowSec: 0, coins: [], byAddress: new Map(), records: new Map(), quotes: new Map(), banner: "" };
  private holderCache = new Map<string, HolderStats & { creator: string }>();
  private transferWatermark = -1n;
  private metadataCache = new Map<string, CoinMetadataView>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<void> | null = null;
  private lastError: unknown = null;

  constructor(
    private readonly deps: {
      store: ReadStore;
      app: AppStore;
      media: MediaStore;
      clock?: () => number;
      onRefresh?: (state: SnapshotState) => void;
    },
  ) {}

  get current(): SnapshotState {
    return this.state;
  }

  get healthy(): boolean {
    return this.state.version > 0 && this.lastError === null;
  }

  start(intervalMs = 2_000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Waits for a snapshot to exist (first request after startup). */
  async ready(): Promise<SnapshotState> {
    if (this.state.version === 0) await this.refresh();
    return this.state;
  }

  refresh(): Promise<void> {
    // One refresh at a time; concurrent callers share it.
    this.refreshing ??= this.build()
      .then((state) => {
        this.state = state;
        this.lastError = null;
        this.deps.onRefresh?.(state);
      })
      .catch((error: unknown) => {
        this.lastError = error;
        throw error;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  private async build(): Promise<SnapshotState> {
    const { store, app } = this.deps;
    const clockSec = Math.floor((this.deps.clock?.() ?? Date.now()) / 1000);
    const [quoteRows, coinRows, latest, moderation, banner, marketRows, tweetRows] = await Promise.all([
      store.quotes(),
      store.coins(),
      store.latestTimestamp(),
      app.moderation(),
      app.setting<{ text: string }>("banner"),
      store.markets?.() ?? Promise.resolve([]),
      store.tweetAttributions?.() ?? Promise.resolve(new Map()),
    ]);
    const tweetSources = app.tweetSources ? await app.tweetSources([...new Set([...tweetRows.values()].map((tweet) => tweet.postId))]) : new Map();
    // A local chain that was fast-forwarded runs ahead of the wall clock; the market's "now" is
    // whichever is later, so windows and ages stay meaningful.
    const nowSec = Math.max(clockSec, latest);
    const quotes = new Map(quoteRows.map((q) => [q.address, q]));
    const marketsByCoin = new Map<string, MarketRecord[]>();
    for (const m of marketRows) {
      const list = marketsByCoin.get(m.address) ?? [];
      list.push(m);
      marketsByCoin.set(m.address, list);
    }

    const active = coinRows.filter((c) => c.lastTradeAt >= nowSec - DAY - ACTIVE_MARGIN).map((c) => c.address);
    const [windowRows, sparkRows] = await Promise.all([store.windows(active, nowSec), store.sparklineCloses(active, nowSec - DAY)]);
    const marketWindows = await store.marketWindows?.(marketRows.map((m) => m.poolId), nowSec) ?? new Map();

    // Holder stats only where balances moved since the last refresh, or the creator changed.
    const changed = await store.coinsWithTransfersSince(this.transferWatermark);
    const stale = new Set(changed.coins);
    for (const c of coinRows) {
      const cached = this.holderCache.get(c.address);
      if (!cached || cached.creator !== c.creator) stale.add(c.address);
    }
    if (stale.size > 0) {
      const creators = new Map(coinRows.map((c) => [c.address, c.creator]));
      const stats = await store.holderStats([...stale], creators);
      for (const [coin, value] of stats) this.holderCache.set(coin, { ...value, creator: creators.get(coin) ?? "" });
    }
    this.transferWatermark = changed.maxBlock;

    await this.loadMetadata(coinRows);

    const coins: Coin[] = [];
    const records = new Map<string, CoinRecord>();
    const markets = new Map<string, MarketRecord>();
    for (const c of coinRows) {
      const q = quotes.get(c.quote);
      if (!q) continue;
      records.set(c.address, c);
      const openingE18 = priceUsdE18(getSqrtPriceAtTick(c.startTick), { quoteIsCurrency0: c.quoteIsCurrency0, quoteDecimals: q.decimals }, c.launchQuoteUsdE8);
      const w = windowRows.get(c.address);
      const windows: CoinWindows = w
        ? {
            volume24hUsdE8: w.volume24hUsdE8,
            buys24h: w.buys24h,
            sells24h: w.trades24h - w.buys24h,
            volume1hUsdE8: w.volume1hUsdE8,
            trades15m: w.trades15m,
            // No close before a look-back moment means no trade before it: the coin was at its
            // opening price then (or did not exist yet, which reads the same).
            priceAgoUsdE18: { m5: w.priceAgo.m5 ?? openingE18, h1: w.priceAgo.h1 ?? openingE18, h24: w.priceAgo.h24 ?? openingE18 },
            sparkline: sparklineFrom({
              closes: sparkRows.get(c.address) ?? [],
              interval: 900,
              fromSec: Math.max(c.createdAt, nowSec - DAY),
              nowSec,
              priceBeforeE18: w.priceAgo.h24 ?? openingE18,
            }),
          }
        : EMPTY_WINDOWS;
      const holders = this.holderCache.get(c.address) ?? { top10: 0n, creatorBalance: 0n };
      const flags = moderation.get(c.address);
      const pairs = (marketsByCoin.get(c.address) ?? []).map((m) => {
        const merged = { ...m, creator: c.creator, pendingCreator: c.pendingCreator, burned: c.burned, holders: c.holders,
          devSold: c.devSold, snipers: c.snipers, sameBlockBuys: c.sameBlockBuys };
        markets.set(m.poolId, merged);
        const mq = quotes.get(m.quote);
        if (!mq) return null;
        const mw = marketWindows.get(m.poolId);
        const opening = priceUsdE18(getSqrtPriceAtTick(m.startTick), { quoteIsCurrency0: m.quoteIsCurrency0, quoteDecimals: mq.decimals }, m.launchQuoteUsdE8);
        return { coin: merged, quote: mq, windows: mw ? {
          volume24hUsdE8: mw.volume24hUsdE8, buys24h: mw.buys24h, sells24h: mw.trades24h - mw.buys24h,
          volume1hUsdE8: mw.volume1hUsdE8, trades15m: mw.trades15m,
          priceAgoUsdE18: { m5: mw.priceAgo.m5 ?? opening, h1: mw.priceAgo.h1 ?? opening, h24: mw.priceAgo.h24 ?? opening }, sparkline: [],
        } : EMPTY_WINDOWS };
      }).filter((m) => m !== null);
      pairs.sort((a, b) => Number(b.coin.poolId === c.poolId) - Number(a.coin.poolId === c.poolId));
      const dto = deriveCoin({
          coin: c,
          quote: q,
          windows,
          holders,
          metadata: this.metadataCache.get(c.contractUri) ?? null,
          flags: { hidden: flags?.hidden ?? false, featured: flags?.featured ?? false },
          nowSec,
          markets: pairs,
        });
      const tweet = tweetRows.get(c.address);
      if (tweet) {
        const source = tweetSources.get(tweet.postId);
        dto.tweet = { ...tweet, treasuryUnlocked: nowSec * 1_000 >= tweet.treasuryUnlockAt,
          ...(source?.author.id === tweet.authorXUserId ? { source: {
          postId: source.postId, url: source.url, text: source.text, author: source.author,
        } } : {}) };
      }
      coins.push(dto);
    }
    coins.sort((a, b) => b.createdAt - a.createdAt);
    return {
      version: this.state.version + 1,
      nowSec,
      coins,
      byAddress: new Map(coins.map((coin) => [coin.address.toLowerCase(), coin])),
      records,
      quotes,
      markets,
      banner: banner?.text ?? "",
    };
  }

  /**
   * Metadata comes from memefun_app: documents uploaded through our API are known by the CID in
   * the coin's contractURI; anything else is resolved by the keeper's metadata job.
   */
  private async loadMetadata(coins: CoinRecord[]) {
    const missing = coins.filter((c) => !this.metadataCache.has(c.contractUri));
    if (missing.length === 0) return;
    const resolved = await this.deps.app.coinMetadataCids();
    const cidFor = new Map<string, string>();
    for (const c of missing) {
      const cid = resolved.get(c.address) ?? parseIpfsUri(c.contractUri)?.cid;
      if (cid) cidFor.set(c.contractUri, cid);
    }
    const docs = await this.deps.app.metadataByCids([...new Set(cidFor.values())]);
    for (const [uri, cid] of cidFor) {
      const doc = docs.get(cid);
      if (!doc) continue;
      this.metadataCache.set(uri, {
        description: doc.description,
        image: this.imageUrl(doc.imageUri),
        links: doc.links,
      });
    }
  }

  private imageUrl(uri: string | null): string {
    if (!uri) return "";
    const ipfs = parseIpfsUri(uri);
    return ipfs ? this.deps.media.urlFor(ipfs.cid) : uri;
  }
}
