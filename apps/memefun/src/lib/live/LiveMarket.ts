import { type Address, type Hash, type PublicClient, createPublicClient, erc20Abi, getAddress, http, parseAbi, toHex, zeroAddress } from "viem";
import { launchFeeBps } from "@/core/antiSnipe";
import { COIN_DECIMALS, COIN_SUPPLY_HUMAN } from "@/core/constants";
import { aggregateCoinMarkets, equalAllocations, selectCoinMarket } from "@/lib/market/markets";
import { fromUnits, toUnits } from "@/core/format";
import { type LaunchPool, coinPriceInQuote, livePool, minOut, quoteBuy, quoteSell } from "@/core/pool";
import { DEFAULT_SETTINGS, type LaunchSettings } from "@/core/settings";
import type { QuoteAsset, TradeSide } from "@/core/types";
import { AUTHOR_RESERVE_DAYS, validateAuthorShareBps, type AuthorVerification, type TweetImport, type TweetLaunchAttestation } from "@/core/tweet";
import type { AuthorReward, AuthorSession } from "@/lib/create/tweet";
import { ownerCalls } from "@/lib/admin/ownerCalls";
import { TARGET_CHAIN, TARGET_CHAIN_ID } from "@/lib/chain";
import type { MemefunDeployment } from "@/lib/contracts/deployments";
import {
  type LaunchInput,
  type Market,
  type MarketQuote,
  type MarketStatus,
  type Moderation,
  type TradeOptions,
  type TxOutcome,
  TxError,
} from "@/lib/market/Market";
import type {
  ActivityItem,
  Candle,
  CandleInterval,
  Claimable,
  Coin,
  Comment,
  CreatorProfile,
  Holder,
  Position,
  Trade,
} from "@/lib/market/types";
import { DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS } from "@/lib/trade/cta";
import { findPair, mergePairCatalog, pairId, pairUnavailableReason, type PairCatalogSort } from "@/lib/market/pairs";
import { getRpcUrlsForChain, rotatingFetch } from "@/lib/wallet/rpc";
import { ApiError, type ApiClient, createApi, dataUrlToBlob } from "./api";
import { API_URL, DeploymentMismatch, resolveDeployment } from "./config";
import { clearSession, loadSession, saveSession, signIn } from "./session";
import { AuthorCompletion, type VerifiedAuthor } from "./authorCompletion";
import type { ClaimRequest, TxContext, TxStage } from "./tx";

/** Transactions (and the contract ABIs they carry) load with the first action. */
const txModule = () => import("./tx");

/**
 * The market on a real deployment: the memefun API's data, refreshed while a screen reads it,
 * pushed live over Server-Sent Events, and the chain for balances and transactions.
 *
 * Every getter is synchronous and answers from cache. Reading a value marks it wanted; anything
 * wanted in the last 30 seconds is refetched on its own interval and right after the trades that
 * change it. Screens re-render through `subscribe` when data lands.
 */

const KEEP_ALIVE_MS = 30_000;
const EVICT_MS = 10 * 60_000;
const SCHEDULER_MS = 1_000;
const OFFLINE_AFTER_FAILURES = 3;
const MAX_COIN_PAGES = 5;
const INDEXER_WAIT_MS = 20_000;
const LAUNCH_SLIPPAGE_BPS = 500;
/** Transactions may wait this long in a wallet before the contracts refuse them. */
const DEADLINE_SEC = 20 * 60;
const treasuryAbi = parseAbi(["function treasury() view returns (address)"]);
const poolIdentityAbi = parseAbi(["function poolIdFor(address coin, address quote) view returns (bytes32)"]);

interface AuthorReserveResponse {
  coin: Address;
  markets: Array<{ poolId: Hash; currency: Address; symbol: string; decimals: number; pendingRaw: string }>;
}

interface Entry {
  fetchedAt: number;
  touchedAt: number;
  intervalMs: number;
  loader: () => Promise<void>;
  inflight: Promise<void> | null;
  failures: number;
}

export interface PoolInfo {
  coin: Address;
  poolId: `0x${string}`;
  quote: Address;
  quoteDecimals: number;
  coinIsCurrency0: boolean;
  startTick: number;
  liquidity: string;
  sqrtPriceX96: string;
  tick: number;
  floors: Array<{ tickLower: number; tickUpper: number; liquidity: string }>;
}

/** The parts of EventSource LiveMarket uses (a fake in tests). */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
  readonly readyState: number;
  onerror: ((event: Event) => void) | null;
}

export interface LiveMarketOptions {
  api?: ApiClient;
  client?: PublicClient;
  now?: () => number;
  eventSource?: ((url: string) => EventSourceLike) | null;
  /** Tests: a wallet without the browser's wagmi stack. */
  txContext?: (user: Address | undefined, onStage?: (stage: TxStage) => void) => Promise<TxContext>;
  /** Tests: the page location a sign-in message names. */
  location?: { host: string; origin: string };
}

const lower = (value: string) => value.toLowerCase();

/** A float as a plain decimal string ("0.0000001", never "1e-7"). */
function plain(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
}

const QUOTE_ORDER: Record<QuoteAsset["kind"], number> = { native: 0, stable: 1, stock: 2, token: 3 };

export class LiveMarket implements Market {
  readonly kind = "live" as const;

  private readonly api: ApiClient;
  private readonly client: PublicClient;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private emitQueued = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stream: EventSourceLike | null = null;
  private streamRetry: ReturnType<typeof setTimeout> | null = null;
  private status: MarketStatus = { state: "loading" };
  private apiFailures = 0;

  private deployment: MemefunDeployment | null = null;
  private deploymentError: Error | null = null;
  private readonly coins = new Map<string, Coin>();
  private listOrder: string[] = [];
  private listLoaded = false;
  private readonly missing = new Set<string>();
  private readonly trades = new Map<string, Trade[]>();
  private readonly candles = new Map<string, Candle[]>();
  private readonly holders = new Map<string, Holder[]>();
  private readonly comments = new Map<string, Comment[]>();
  private readonly pools = new Map<string, LaunchPool>();
  private readonly profiles = new Map<string, { profile: CreatorProfile | null; trades: Trade[] }>();
  private readonly positions = new Map<string, Position[]>();
  private readonly claimables = new Map<string, Claimable[]>();
  private readonly authorSessions = new Map<string, AuthorSession | null>();
  private authorTreasury: Address | null = null;
  private readonly authorCompletion: AuthorCompletion;
  private activeAuthorWallet: string | null = null;
  private readonly quoteBalances = new Map<string, Map<string, bigint>>();
  private readonly coinBalances = new Map<string, bigint>();
  private activity: ActivityItem[] = [];
  private creators: CreatorProfile[] = [];
  private settings: LaunchSettings | null = null;
  private quotes: QuoteAsset[] = [];
  private catalogs = new Map<PairCatalogSort, { quotes: QuoteAsset[]; notice?: string; stockIssuerVerified: boolean }>();
  private featured: Address[] = [];
  private banner = "";
  private adminToken: string | null = null;
  private adminHidden: Address[] = [];
  private readonly debounces = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: LiveMarketOptions = {}) {
    this.api = options.api ?? createApi(API_URL);
    this.now = options.now ?? Date.now;
    this.authorCompletion = new AuthorCompletion(this.api, this.now, typeof window === "undefined" ? undefined : window);
    this.client =
      options.client ??
      (createPublicClient({
        chain: TARGET_CHAIN,
        transport: http(getRpcUrlsForChain(TARGET_CHAIN_ID)[0], { fetchFn: rotatingFetch(getRpcUrlsForChain(TARGET_CHAIN_ID)) }),
      }) as PublicClient);
  }

  /* ------------------------------------------------------------------ store */

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = () => this.version;

  /** Coalesces every change in one task into a single re-render. */
  private emit() {
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      this.version += 1;
      this.listeners.forEach((listener) => listener());
    });
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), SCHEDULER_MS);
    this.read("deployment", 10 * 60_000, () => this.loadDeployment());
    this.read("settings", 30_000, () => this.loadSettings());
    this.read("moderation", 30_000, () => this.loadModeration());
    this.openStream();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.streamRetry) clearTimeout(this.streamRetry);
    this.streamRetry = null;
    this.stream?.close();
    this.stream = null;
    for (const handle of this.debounces.values()) clearTimeout(handle);
    this.debounces.clear();
  }

  getStatus(): MarketStatus {
    if (this.deploymentError) return { state: "misconfigured", message: this.deploymentError.message };
    return this.status;
  }

  /* -------------------------------------------------------------- the cache */

  /** Marks `key` wanted and starts a load if it has none or its data is older than `intervalMs`. */
  private read(key: string, intervalMs: number, loader: () => Promise<void>) {
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { fetchedAt: 0, touchedAt: now, intervalMs, loader, inflight: null, failures: 0 };
      this.entries.set(key, entry);
    }
    entry.touchedAt = now;
    entry.loader = loader;
    entry.intervalMs = intervalMs;
    if (!entry.inflight && now - entry.fetchedAt >= this.backoff(entry)) void this.load(key, entry);
  }

  private backoff(entry: Entry): number {
    // Failing loads wait longer, up to a minute.
    return entry.failures === 0 ? entry.intervalMs : Math.min(60_000, entry.intervalMs * 2 ** Math.min(entry.failures, 4));
  }

  private load(key: string, entry: Entry): Promise<void> {
    entry.inflight = entry
      .loader()
      .then(() => {
        entry.failures = 0;
        this.noteApi(true);
      })
      .catch((error: unknown) => {
        entry.failures += 1;
        if (!(error instanceof ApiError) || error.status >= 500) this.noteApi(false, error);
      })
      .finally(() => {
        entry.fetchedAt = this.now();
        entry.inflight = null;
        this.emit();
      });
    return entry.inflight;
  }

  private noteApi(ok: boolean, error?: unknown) {
    const before = this.status.state;
    if (ok) {
      this.apiFailures = 0;
      this.status = { state: "ready" };
    } else {
      this.apiFailures += 1;
      if (this.apiFailures >= OFFLINE_AFTER_FAILURES) {
        this.status = { state: "offline", message: error instanceof Error ? error.message : "Live data is unavailable." };
      }
    }
    if (before !== this.status.state) this.emit();
  }

  /** Refetches everything under `prefix` that a screen still wants, now. */
  private invalidate(prefix: string) {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue;
      entry.fetchedAt = 0;
      entry.failures = 0;
      if (!entry.inflight && now - entry.touchedAt < KEEP_ALIVE_MS) void this.load(key, entry);
    }
  }

  private debounce(key: string, ms: number, run: () => void) {
    if (this.debounces.has(key)) return;
    this.debounces.set(
      key,
      setTimeout(() => {
        this.debounces.delete(key);
        run();
      }, ms),
    );
  }

  private tick() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.touchedAt > EVICT_MS) {
        this.entries.delete(key);
        continue;
      }
      if (entry.inflight || now - entry.touchedAt > KEEP_ALIVE_MS) continue;
      if (now - entry.fetchedAt >= this.backoff(entry)) void this.load(key, entry);
    }
  }

  /* ---------------------------------------------------------------- loaders */

  private async loadDeployment() {
    let api: MemefunDeployment | null = null;
    try {
      api = (await this.api.get<{ deployment: MemefunDeployment }>("/v1/deployment")).deployment;
    } catch (error) {
      // The build's own addresses still work; only a local chain needs the API's.
      if (!(error instanceof ApiError)) throw error;
    }
    try {
      this.deployment = resolveDeployment(api);
      this.deploymentError = null;
    } catch (error) {
      if (error instanceof DeploymentMismatch) this.deploymentError = error;
      else throw error;
    }
  }

  private async requireDeployment(): Promise<MemefunDeployment> {
    if (!this.deployment && !this.deploymentError) await this.loadDeployment();
    if (this.deploymentError) throw new TxError(`${this.deploymentError.message} Nothing can be sent until that is fixed.`, "reverted");
    if (!this.deployment) throw new TxError("memefun is not available on this network yet.", "reverted");
    return this.deployment;
  }

  private async loadSettings() {
    const body = await this.api.get<{ settings: LaunchSettings; quotes: QuoteAsset[] }>("/v1/launch-settings");
    this.settings = body.settings;
    this.quotes = body.quotes.map(quote => quote.kind === "stock" || quote.kind === "token"
      ? { ...quote, launchable: quote.launchable === true, unavailableReason: quote.unavailableReason || (quote.launchable === true ? undefined : "Waiting for verified launch eligibility") }
      : quote).sort((a, b) => QUOTE_ORDER[a.kind] - QUOTE_ORDER[b.kind] || a.symbol.localeCompare(b.symbol));
  }

  private async loadPairCatalog(sort: PairCatalogSort) {
    const body = await this.api.get<{ quotes?: QuoteAsset[]; stocks?: QuoteAsset[]; crypto?: QuoteAsset[];
      sources?: { coinbase?: { status?: string }; o1?: { complete?: boolean; status?: string } } }>(`/v1/pair-catalog?sort=${sort}`).catch(error => {
        const previous = this.catalogs.get(sort);
        this.catalogs.set(sort, { quotes: previous?.quotes ?? [], notice: previous?.notice, stockIssuerVerified: false });
        throw error;
      });
    const quotes = body.quotes ?? [...(body.stocks ?? []), ...(body.crypto ?? [])];
    const source = body.sources?.o1;
    this.catalogs.set(sort, { quotes, stockIssuerVerified: body.sources?.coinbase?.status === "ok",
      ...(source?.complete === false ? { notice: source.status === "alpha_fallback"
        ? "Showing the available o1 Alpha list. Complete launch history is currently unavailable."
        : "The available token list is incomplete. Complete launch history is currently unavailable." } : {}) });
  }

  private async loadModeration() {
    const body = await this.api.get<{ featured: Address[]; banner: string }>("/v1/moderation");
    this.featured = body.featured;
    this.banner = body.banner;
  }

  private async loadCoins() {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_COIN_PAGES; page++) {
      const body: { coins: Coin[]; nextCursor: string | null } = await this.api.get(`/v1/coins?sort=new&limit=200${cursor ? `&cursor=${cursor}` : ""}`);
      for (const coin of body.coins) {
        this.coins.set(lower(coin.address), aggregateCoinMarkets(coin));
        seen.push(lower(coin.address));
      }
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    this.listOrder = seen;
    this.listLoaded = true;
  }

  private async loadCoin(address: string) {
    try {
      const { coin } = await this.api.get<{ coin: Coin }>(`/v1/coins/${address}`);
      this.coins.set(address, aggregateCoinMarkets(coin));
      this.missing.delete(address);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) this.missing.add(address);
      else throw error;
    }
  }

  private async loadPool(address: string, poolId?: Hash): Promise<LaunchPool> {
    const { pool } = await this.api.get<{ pool: PoolInfo }>(`/v1/coins/${address}/pool${poolId ? `?poolId=${poolId}` : ""}`);
    if (poolId && lower(pool.poolId) !== lower(poolId)) throw new Error("The API returned a different pool.");
    const state = livePool({
      coinIsCurrency0: pool.coinIsCurrency0,
      quoteDecimals: pool.quoteDecimals,
      startTick: pool.startTick,
      liquidity: BigInt(pool.liquidity),
      sqrtPriceX96: BigInt(pool.sqrtPriceX96),
      tick: pool.tick,
      floors: pool.floors.map((f) => ({ tickLower: f.tickLower, tickUpper: f.tickUpper, liquidity: BigInt(f.liquidity) })),
    });
    this.pools.set(`${address}${poolId ? `:${lower(poolId)}` : ""}`, state);
    return state;
  }

  private async loadQuoteBalances(owner: Address) {
    const quotes = this.listQuotes();
    const values = await Promise.allSettled(
      quotes.map((quote) =>
        quote.address === zeroAddress
          ? this.client.getBalance({ address: owner })
          : this.client.readContract({ address: quote.address, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
      ),
    );
    const balances = new Map<string, bigint>();
    quotes.forEach((quote, i) => {
      const result = values[i];
      if (result?.status === "fulfilled") balances.set(pairId(quote), result.value);
    });
    this.quoteBalances.set(lower(owner), balances);
  }

  private async readCoinBalance(owner: Address, coin: string): Promise<bigint> {
    const balance = await this.client.readContract({ address: getAddress(coin), abi: erc20Abi, functionName: "balanceOf", args: [owner] });
    this.coinBalances.set(`${lower(owner)}:${lower(coin)}`, balance);
    return balance;
  }

  /* -------------------------------------------------------- live updates */

  private openStream() {
    const factory = this.options.eventSource === undefined ? (url: string) => new EventSource(url) as unknown as EventSourceLike : this.options.eventSource;
    if (!factory || !this.api.baseUrl) return;
    const stream = factory(`${this.api.baseUrl}/v1/stream`);
    this.stream = stream;
    stream.addEventListener("trade", (event) => this.onTrade(event));
    stream.addEventListener("activity", (event) => this.onActivity(event));
    stream.onerror = () => {
      // EventSource retries by itself; a closed one (CLOSED = 2) is reopened here.
      if (stream.readyState === 2 && this.stream === stream && this.timer) {
        this.stream = null;
        this.streamRetry = setTimeout(() => this.openStream(), 5_000);
      }
    };
  }

  private onTrade(event: MessageEvent) {
    let trade: Trade;
    try {
      trade = JSON.parse(String(event.data)) as Trade;
    } catch {
      return;
    }
    const coin = lower(trade.coin);
    const primaryPool = this.coins.get(coin)?.markets?.[0]?.poolId;
    for (const [key, list] of this.trades) {
      if (key !== coin && key !== `${coin}:${trade.poolId ? lower(trade.poolId) : ""}`) continue;
      if (key === coin && primaryPool && trade.poolId && lower(trade.poolId) !== lower(primaryPool)) continue;
      if (!list.some((item) => item.id === trade.id)) this.trades.set(key, [trade, ...list].slice(0, 500));
    }
    this.invalidate(`pool:${coin}`);
    this.debounce(`coin:${coin}`, 400, () => this.invalidate(`coin:${coin}`));
    this.debounce(`candles:${coin}`, 1_500, () => this.invalidate(`candles:${coin}:`));
    this.debounce(`holders:${coin}`, 2_500, () => this.invalidate(`holders:${coin}:`));
    this.debounce("coins", 3_000, () => this.invalidate("coins"));
    const trader = lower(trade.trader);
    this.invalidate(`cbal:${trader}:${coin}`);
    this.debounce(`account:${trader}`, 2_500, () => {
      this.invalidate(`positions:${trader}`);
      this.invalidate(`claimables:${trader}`);
      this.invalidate(`profile:${trader}`);
    });
    this.emit();
  }

  private onActivity(event: MessageEvent) {
    let item: ActivityItem;
    try {
      item = JSON.parse(String(event.data)) as ActivityItem;
    } catch {
      return;
    }
    if (!this.activity.some((existing) => existing.id === item.id)) {
      this.activity = [item, ...this.activity].slice(0, 200);
      this.emit();
    }
    if (item.kind === "launch") this.debounce("coins", 1_000, () => this.invalidate("coins"));
  }

  /* ---------------------------------------------------------------- readers */

  isCoinsReady(): boolean {
    return this.listLoaded;
  }

  listCoins(includeHidden = false): Coin[] {
    this.read("coins", 5_000, () => this.loadCoins());
    const list = this.listOrder.map((address) => this.coins.get(address)).filter((coin): coin is Coin => Boolean(coin));
    if (!includeHidden) return list.filter((coin) => !coin.hidden);
    const extra = this.adminHidden.map((address) => this.getCoin(address)).filter((coin): coin is Coin => Boolean(coin) && !this.listOrder.includes(lower(coin!.address)));
    return [...list, ...extra];
  }

  getCoin(address: string): Coin | undefined {
    const key = lower(address);
    if (!/^0x[0-9a-f]{40}$/.test(key)) return undefined;
    this.read(`coin:${key}`, this.missing.has(key) ? 30_000 : 4_000, () => this.loadCoin(key));
    const coin = this.coins.get(key);
    return coin ? { ...coin, featured: this.featured.some((f) => lower(f) === key) || coin.featured } : undefined;
  }

  getTrades(address: string, limit = 100, poolId?: Hash): Trade[] {
    const key = `${lower(address)}${poolId ? `:${lower(poolId)}` : ""}`;
    this.read(`trades:${key}`, 20_000, async () => {
      const { trades } = await this.api.get<{ trades: Trade[] }>(`/v1/coins/${lower(address)}/trades?limit=${Math.min(200, Math.max(60, limit))}${poolId ? `&poolId=${poolId}` : ""}`);
      this.trades.set(key, trades);
    });
    return (this.trades.get(key) ?? []).slice(0, limit);
  }

  getComments(address: string): Comment[] {
    const key = lower(address);
    this.read(`comments:${key}`, 15_000, async () => {
      const { comments } = await this.api.get<{ comments: Comment[] }>(`/v1/coins/${key}/comments?limit=100`);
      this.comments.set(key, comments);
    });
    return this.comments.get(key) ?? [];
  }

  getActivity(limit = 40): ActivityItem[] {
    this.read("activity", 30_000, async () => {
      const { items } = await this.api.get<{ items: ActivityItem[] }>("/v1/activity?limit=80");
      const known = new Set(items.map((item) => item.id));
      // Keep anything the stream added since the request went out.
      this.activity = [...this.activity.filter((item) => !known.has(item.id) && item.ts > (items[0]?.ts ?? 0)), ...items].slice(0, 200);
    });
    return this.activity.slice(0, limit);
  }

  getCandles(address: string, interval: CandleInterval, metric: "price" | "mcap" = "price", poolId?: Hash): Candle[] {
    const key = `candles:${lower(address)}:${interval}:${metric}:${poolId ?? ""}`;
    this.read(key, Math.max(15_000, Math.min(interval * 1000, 60_000)), async () => {
      const { candles } = await this.api.get<{ candles: Candle[] }>(`/v1/coins/${lower(address)}/candles?interval=${interval}&metric=${metric}${poolId ? `&poolId=${poolId}` : ""}`);
      this.candles.set(key, candles);
    });
    return this.candles.get(key) ?? [];
  }

  getHolders(address: string, viewer?: Address, limit = 25): Holder[] {
    const key = `holders:${lower(address)}:${viewer ? lower(viewer) : ""}:${limit}`;
    this.read(key, 15_000, async () => {
      const { holders } = await this.api.get<{ holders: Holder[] }>(`/v1/coins/${lower(address)}/holders?limit=${limit}${viewer ? `&viewer=${viewer}` : ""}`);
      this.holders.set(key, holders);
    });
    return this.holders.get(key) ?? [];
  }

  getCreators(): CreatorProfile[] {
    this.read("creators", 60_000, async () => {
      this.creators = (await this.api.get<{ creators: CreatorProfile[] }>("/v1/creators/top?limit=100")).creators;
    });
    return this.creators;
  }

  private profile(address: string) {
    const key = lower(address);
    this.read(`profile:${key}`, 15_000, async () => {
      this.profiles.set(key, await this.api.get<{ profile: CreatorProfile | null; trades: Trade[] }>(`/v1/profiles/${key}`));
    });
    return this.profiles.get(key);
  }

  creatorProfile(address: string): CreatorProfile | undefined {
    return this.profile(address)?.profile ?? undefined;
  }

  getTradesByTrader(trader: string, limit = 50): Trade[] {
    return (this.profile(trader)?.trades ?? []).slice(0, limit);
  }

  getSettings(): LaunchSettings {
    this.read("settings", 30_000, () => this.loadSettings());
    return this.settings ?? DEFAULT_SETTINGS;
  }

  isSettingsReady() { return this.settings !== null; }

  listQuotes(): QuoteAsset[] {
    this.read("settings", 30_000, () => this.loadSettings());
    return this.quotes;
  }

  listPairCatalog(sort: PairCatalogSort = "trending"): QuoteAsset[] {
    this.read(`pairs:${sort}`, 60_000, () => this.loadPairCatalog(sort));
    const catalog = this.catalogs.get(sort);
    return mergePairCatalog(this.listQuotes(), catalog?.quotes ?? [], { requireStockIssuer: TARGET_CHAIN_ID === 8453, stockIssuerVerified: catalog?.stockIssuerVerified });
  }

  getPairCatalogNotice(sort: PairCatalogSort = "trending") { return this.catalogs.get(sort)?.notice; }

  getModeration(): Moderation {
    this.read("moderation", 30_000, () => this.loadModeration());
    if (this.adminToken) this.read("admin", 15_000, () => this.loadAdmin());
    return { hidden: this.adminHidden, featured: this.featured, banner: this.banner };
  }

  ensureUser(address: Address): void {
    this.read(`qbal:${lower(address)}`, 10_000, () => this.loadQuoteBalances(address));
  }

  getQuoteBalance(address: Address, id: string): number {
    this.ensureUser(address);
    const quote = findPair(this.quotes, id);
    const raw = quote && this.quoteBalances.get(lower(address))?.get(pairId(quote));
    return raw !== undefined && quote ? fromUnits(raw, quote.decimals) : 0;
  }

  getCoinBalance(address: Address, coin: string): number {
    const key = `${lower(address)}:${lower(coin)}`;
    this.read(`cbal:${key}`, 8_000, async () => {
      await this.readCoinBalance(address, coin);
    });
    const raw = this.coinBalances.get(key);
    return raw !== undefined ? fromUnits(raw, COIN_DECIMALS) : 0;
  }

  getPositions(address: Address): Position[] {
    const key = lower(address);
    this.read(`positions:${key}`, 10_000, async () => {
      this.positions.set(key, (await this.api.get<{ positions: Position[] }>(`/v1/positions/${key}`)).positions);
    });
    return this.positions.get(key) ?? [];
  }

  getClaimables(address: Address): Claimable[] {
    const key = lower(address);
    this.read(`claimables:${key}`, 15_000, async () => {
      this.claimables.set(key, (await this.api.get<{ claimables: Claimable[] }>(`/v1/claimables/${key}`)).claimables);
    });
    const now = this.now();
    // Holder rewards in their 12-hour veto window are not claimable yet.
    return (this.claimables.get(key) ?? []).filter((item) => !item.claimableAt || item.claimableAt <= now);
  }

  async importTweet(url: string): Promise<TweetImport> {
    try { return await this.api.post<TweetImport>("/v1/tweets/import", { url }); }
    catch (error) { throw error instanceof ApiError ? new TxError(error.message, "reverted") : new TxError("Could not import this public X post. Try again later.", "reverted"); }
  }

  getAuthorSession(user?: Address): AuthorSession | null {
    this.activeAuthorWallet = user ? lower(user) : null;
    if (!user) return null;
    const key = lower(user);
    const session = loadSession(user, this.now());
    // Read hooks never open wallet sign-in prompts. Connecting X is an explicit action.
    if (!session) { this.authorSessions.delete(key); return null; }
    this.read(`author-session:${key}`, 10_000, async () => {
      if (this.activeAuthorWallet !== key) return;
      const current = loadSession(user, this.now());
      if (!current) { this.authorSessions.delete(key); return; }
      try {
        const completion = await this.authorCompletion.complete(user, current.token);
        if (completion.state === "waiting") { this.authorSessions.delete(key); return; }
        if (completion.state === "completed") {
          this.authorSessions.set(key, this.authorSession(user, completion.author));
          return;
        }
        if (this.activeAuthorWallet !== key) return;
        const result = await this.api.get<{ author: VerifiedAuthor | null }>("/v1/author/me", { token: current.token });
        this.authorSessions.set(key, result.author ? this.authorSession(user, result.author) : null);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) { clearSession(user); this.authorSessions.delete(key); }
        throw error;
      }
    });
    return this.authorSessions.get(key) ?? null;
  }

  private authorSession(user: Address, author: VerifiedAuthor): AuthorSession {
    return { authorId: author.id, handle: author.handle, wallet: user, simulated: false };
  }

  async beginAuthorVerification(user: Address, coin?: Address): Promise<void> {
    try {
      // This explicit action may sign in; synchronous read hooks never do.
      if (this.authorCompletion.hasPending()) {
        const completion = await this.authorCompletion.complete(user, await this.sessionToken(user));
        if (completion.state === "completed") { this.authorSessions.set(lower(user), this.authorSession(user, completion.author)); this.emit(); return; }
        if (completion.state === "waiting") throw new TxError("This X verification belongs to another wallet. Connect the wallet that started it, or reconnect X after the completion expires.", "reverted");
      }
      const origin = this.options.location?.origin ?? (typeof window !== "undefined" ? window.location.origin : undefined);
      if (!origin) throw new TxError("Open memefun in your browser to connect X.", "reverted");
      const returnTo = new URL("/rewards/author", origin);
      if (coin) returnTo.searchParams.set("coin", coin);
      const { authUrl } = await this.api.post<{ authUrl: string }>("/v1/author/connect", { returnTo: returnTo.toString() }, { token: await this.sessionToken(user) });
      const target = new URL(authUrl);
      if (target.protocol !== "https:" || !["x.com", "twitter.com"].includes(target.hostname) || target.username || target.password || target.port || target.pathname !== "/i/oauth2/authorize") {
        throw new TxError("The X sign-in link could not be verified. Try again later.", "reverted");
      }
      if (typeof window === "undefined") throw new TxError("Open memefun in your browser to connect X.", "reverted");
      window.location.assign(target.toString());
    } catch (error) { throw error instanceof ApiError ? new TxError(error.message, "reverted") : error; }
  }

  async bindAuthorWallet(user: Address, coin: Address): Promise<void> {
    try {
      const verification = await this.api.post<AuthorVerification>("/v1/author/verification", { coin }, { token: await this.sessionToken(user) });
      if (verification.coin.toLowerCase() !== coin.toLowerCase()) throw new TxError("The X verification is for a different coin. Try again.", "reverted");
      await (await txModule()).sendAuthorVerification(await this.txContext(user), verification);
      this.invalidate(`coin:${lower(coin)}`);
      this.invalidate(`author-session:${lower(user)}`);
      this.invalidate(`claimables:${lower(user)}`);
      this.invalidate("coins");
      await this.loadCoin(lower(coin)).catch(() => undefined);
      this.emit();
    } catch (error) { throw error instanceof ApiError ? new TxError(error.message, "reverted") : error; }
  }

  getAuthorRewards(user?: Address): AuthorReward[] {
    if (!user) return [];
    return this.getClaimables(user).filter(item => item.kind === "author" && item.poolId).map(item => ({ coin: item.coin, poolId: item.poolId!,
      quoteSymbol: item.quoteSymbol, amountQuote: item.amountQuote, amountUsd: item.amountUsd,
      ...(item.currency ? { currency: getAddress(item.currency) } : {}), ...(item.amountRaw ? { amountRaw: item.amountRaw } : {}) }));
  }

  async claimAuthorRewards(user: Address, coin: Address): Promise<Hash> {
    const items = this.getClaimables(user).filter(item => item.kind === "author" && lower(item.coin) === lower(coin));
    if (!items.length) throw new TxError("There are no claimable author rewards for this wallet yet. Verify it and refresh rewards.", "reverted");
    return this.claim(user, items);
  }

  /** This read hook never requests a wallet signature or an X session. */
  isAuthorTreasury(user?: Address): boolean {
    if (!user) return false;
    this.read("author-treasury", 30_000, async () => {
      try { await this.readAuthorTreasury(); }
      catch (error) { this.authorTreasury = null; throw error; }
    });
    return this.authorTreasury !== null && lower(this.authorTreasury) === lower(user);
  }

  private async readAuthorTreasury(): Promise<Address> {
    const deployment = await this.requireDeployment();
    const treasury = getAddress(await this.client.readContract({ address: deployment.config, abi: treasuryAbi, functionName: "treasury" }));
    this.authorTreasury = treasury;
    return treasury;
  }

  /** Fetch one coin explicitly; scanning every coin would consume the public API quota. */
  async getTreasuryAuthorRewards(user: Address, coin: Address): Promise<AuthorReward[]> {
    try {
      if (lower(await this.readAuthorTreasury()) !== lower(user)) throw new TxError("Connect the current DustSwap treasury wallet to withdraw these rewards.", "reverted");
      const result = await this.api.get<AuthorReserveResponse>(`/v1/coins/${lower(coin)}/author`);
      if (lower(result.coin) !== lower(coin)) throw new TxError("The reward balance is for a different coin. Refresh and try again.", "reverted");
      const seen = new Set<string>();
      return result.markets.map((item): AuthorReward => {
        if (!/^0x[0-9a-fA-F]{64}$/.test(item.poolId) || seen.has(lower(item.poolId)) || !Number.isInteger(item.decimals)
          || item.decimals < 0 || item.decimals > 255 || !/^\d{1,78}$/.test(item.pendingRaw) || BigInt(item.pendingRaw) >= 2n ** 256n) {
          throw new TxError("The reward balance could not be verified. Refresh and try again.", "reverted");
        }
        seen.add(lower(item.poolId));
        const currency = getAddress(item.currency);
        const amountQuote = fromUnits(BigInt(item.pendingRaw), item.decimals);
        const cachedCoin = this.coins.get(lower(coin));
        const quote = cachedCoin?.markets?.find(market => lower(market.poolId) === lower(item.poolId) && lower(market.quote.address) === lower(currency))?.quote
          ?? this.quotes.find(asset => lower(asset.address) === lower(currency));
        return { coin: getAddress(coin), poolId: item.poolId, currency, quoteSymbol: item.symbol, amountRaw: item.pendingRaw,
          amountQuote, amountUsd: amountQuote * (quote?.usdPrice ?? 0) };
      });
    } catch (error) { throw error instanceof ApiError ? new TxError(error.message, "reverted") : error; }
  }

  async claimTreasuryAuthorRewards(user: Address, coin: Address, poolId: Hash): Promise<Hash> {
    // Refresh the canonical pool currency and shared balance before opening the wallet.
    const rewards = await this.getTreasuryAuthorRewards(user, coin);
    const reward = rewards.find(item => lower(item.poolId) === lower(poolId));
    if (!reward?.currency || !reward.amountRaw || BigInt(reward.amountRaw) === 0n) throw new TxError("There is nothing left to withdraw from this pool.", "reverted");
    const deployment = await this.requireDeployment();
    const chainPoolId = await this.client.readContract({ address: deployment.hook, abi: poolIdentityAbi, functionName: "poolIdFor", args: [coin, reward.currency] });
    if (lower(chainPoolId) !== lower(poolId)) throw new TxError("The pool's pair asset could not be verified on chain. Refresh and try again.", "reverted");
    const ctx = await this.txContext(user);
    if (lower(ctx.wallet.account.address) !== lower(user)) throw new TxError("The connected wallet changed. Connect the treasury wallet and try again.", "reverted");
    const hash = await (await txModule()).sendTreasuryAuthorWithdrawal(ctx, coin, reward.currency);
    this.invalidate("claimables:");
    this.invalidate(`coin:${lower(coin)}`);
    this.invalidate("coins");
    this.invalidate(`qbal:${lower(user)}`);
    await this.loadCoin(lower(coin)).catch(() => undefined);
    this.emit();
    return hash;
  }

  /* ------------------------------------------------------------------ quotes */

  /** The coin's pool, refreshed after every trade on it; undefined until loaded. */
  private pool(address: string, poolId?: Hash): LaunchPool | undefined {
    const key = `${lower(address)}${poolId ? `:${lower(poolId)}` : ""}`;
    this.read(`pool:${key}`, 10_000, async () => {
      await this.loadPool(lower(address), poolId);
    });
    return this.pools.get(key);
  }

  private feeBpsNow(coin: Coin, nowMs: number): number {
    return launchFeeBps(coin.terms.feeBps, { startBps: coin.terms.snipeStartBps, durationSec: coin.terms.snipeDurationSec }, (nowMs - coin.createdAt) / 1000);
  }

  quote(coinAddress: string, side: TradeSide, amountIn: number, now = this.now(), payWithEth = false, poolId?: Hash): MarketQuote {
    const empty: MarketQuote = { side, amountIn, amountOut: 0, feeQuote: 0, feeBps: 0, priceImpact: 0, priceAfterUsd: 0, marketCapAfterUsd: 0, ok: false };
    const found = this.getCoin(coinAddress);
    if (!found) return { ...empty, reason: "Coin not found." };
    let coin: Coin;
    try { coin = selectCoinMarket(found, poolId); } catch { return { ...empty, reason: "Pool not found." }; }
    const feeBps = this.feeBpsNow(coin, now);
    if (payWithEth && side === "buy" && coin.quote.kind !== "native") {
      return { ...empty, feeBps, reason: `Pay with ${coin.quote.symbol} for this coin.` };
    }
    const pool = this.pool(coin.address, poolId);
    if (!(amountIn > 0)) return { ...empty, feeBps };
    if (!pool) return { ...empty, feeBps, reason: "Loading the pool." };
    const decimals = side === "buy" ? coin.quote.decimals : COIN_DECIMALS;
    const raw = toUnits(plain(amountIn), decimals);
    if (raw === 0n) return { ...empty, feeBps };
    const q = side === "buy" ? quoteBuy(pool, raw, feeBps) : quoteSell(pool, raw, feeBps);
    const priceAfterQuote = coinPriceInQuote(pool, q.sqrtPriceAfterX96);
    const priceAfterUsd = priceAfterQuote * coin.quote.usdPrice;
    // Market cap counts circulating coins; the coin record knows how many are burned.
    const supply = coin.priceUsd > 0 ? coin.marketCapUsd / coin.priceUsd : COIN_SUPPLY_HUMAN;
    return {
      side,
      amountIn,
      amountOut: fromUnits(q.amountOut, side === "buy" ? COIN_DECIMALS : coin.quote.decimals),
      amountOutRaw: q.amountOut.toString(),
      feeQuote: fromUnits(q.fee, coin.quote.decimals),
      feeBps,
      priceImpact: q.priceImpact,
      priceAfterUsd,
      marketCapAfterUsd: priceAfterUsd * supply,
      ok: !q.partial && q.amountOut > 0n,
      ...(q.partial ? { reason: "More than the pool can fill." } : {}),
    };
  }

  /* ----------------------------------------------------------------- actions */

  private async txContext(user: Address | undefined, onStage?: (stage: TxStage) => void): Promise<TxContext> {
    if (this.options.txContext) return this.options.txContext(user, onStage);
    const deployment = await this.requireDeployment();
    const { connectedWallet, DATA_SUFFIX } = await import("./wallet");
    const wallet = await connectedWallet(user);
    return { wallet, client: this.client, deployment, dataSuffix: DATA_SUFFIX, onStage };
  }

  private async deadline(): Promise<bigint> {
    // The chain's clock, not this device's, decides whether a transaction expired.
    const block = await this.client.getBlock();
    return block.timestamp + BigInt(DEADLINE_SEC);
  }

  async trade(user: Address, coinAddress: string, side: TradeSide, amountIn: number, _minOut: number, options: TradeOptions = {}): Promise<Trade> {
    const slippageBps = options.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
      throw new TxError("Choose a valid slippage percentage up to 50%.", "reverted");
    }
    let displayedMinimum = 0n;
    if (options.minAmountOutRaw !== undefined) {
      if (typeof options.minAmountOutRaw !== "string" || !/^\d{1,78}$/.test(options.minAmountOutRaw)) {
        throw new TxError("The minimum received could not be verified. Refresh the quote and try again.", "reverted");
      }
      displayedMinimum = BigInt(options.minAmountOutRaw);
      if (displayedMinimum <= 0n || displayedMinimum > (1n << 256n) - 1n) {
        throw new TxError("The minimum received could not be verified. Refresh the quote and try again.", "reverted");
      }
    }
    const key = lower(coinAddress);
    if (!this.coins.has(key)) await this.loadCoin(key);
    const found = this.coins.get(key);
    if (!found) throw new TxError("This coin is not available.", "reverted");
    const coin = selectCoinMarket(found, options.poolId);
    if (side === "buy" && options.payWithEth && coin.quote.kind !== "native") {
      throw new TxError(`Pay with ${coin.quote.symbol} for this coin.`, "reverted");
    }
    const decimals = side === "buy" ? coin.quote.decimals : COIN_DECIMALS;
    const paying = side === "buy" ? coin.quote.symbol : coin.symbol;

    const [balance, pool, deadline] = await Promise.all([
      side === "buy" ? this.rawQuoteBalance(user, coin.quote) : this.readCoinBalance(user, coin.address),
      this.loadPool(key, options.poolId),
      this.deadline(),
    ]);
    const raw = side === "sell" && options.max ? balance : toUnits(options.amountText ?? plain(amountIn), decimals);
    if (raw <= 0n) throw new TxError("Enter an amount above zero.", "reverted");
    if (raw > balance) throw new TxError(`Not enough ${paying} in your wallet.`, "insufficient");

    // The fee now is the highest the trade can pay (launch protection only falls), so the
    // minimum output computed with it never rejects a fair fill.
    const feeBps = this.feeBpsNow(coin, this.now());
    const quoted = side === "buy" ? quoteBuy(pool, raw, feeBps) : quoteSell(pool, raw, feeBps);
    if (quoted.partial || quoted.amountOut === 0n) throw new TxError("That amount is more than the pool can fill. Try a smaller amount.", "reverted");
    if (quoted.amountOut < displayedMinimum) {
      throw new TxError("The price changed beyond your minimum received. Review the updated quote and try again.", "reverted");
    }
    const freshMinimum = minOut(quoted.amountOut, slippageBps);
    // Keep the displayed quote's exact floor if an intervening trade moved the pool. A
    // fresh quote may tighten protection, but must never silently loosen that promise.
    const protectedMinimum = freshMinimum > displayedMinimum ? freshMinimum : displayedMinimum;
    const minAmountOut = protectedMinimum > 0n ? protectedMinimum : 1n;

    const ctx = await this.txContext(user, options.onStage);
    const fill = await (await txModule()).sendTrade(ctx, { side, coin: coin.address, quote: coin.quote.address, explicitPool: Boolean(options.poolId), amountIn: raw, minAmountOut, referrer: options.referrer ?? null, deadline });

    this.invalidate(`pool:${key}`);
    this.invalidate(`coin:${key}`);
    this.invalidate(`trades:${key}`);
    this.invalidate(`cbal:${lower(user)}:${key}`);
    this.invalidate(`qbal:${lower(user)}`);
    this.invalidate(`positions:${lower(user)}`);

    const quoteAmount = fromUnits(fill.quoteAmount, coin.quote.decimals);
    const coinAmount = fromUnits(fill.coinAmount, COIN_DECIMALS);
    const priceUsd = coinAmount > 0 ? (quoteAmount / coinAmount) * coin.quote.usdPrice : coin.priceUsd;
    return {
      id: fill.hash,
      coin: coin.address,
      poolId: options.poolId,
      quote: coin.quote.address,
      ts: this.now(),
      side,
      trader: user,
      quoteAmount,
      coinAmount,
      priceUsd,
      marketCapUsd: coin.marketCapUsd,
      feeQuote: fromUnits(fill.fee, coin.quote.decimals),
      feeBps: fill.feeBps,
      txHash: fill.hash,
      isCreator: lower(coin.creator) === lower(user),
      inProtection: fill.feeBps > coin.terms.feeBps,
    };
  }

  private async rawQuoteBalance(owner: Address, quote: QuoteAsset): Promise<bigint> {
    return quote.address === zeroAddress
      ? this.client.getBalance({ address: owner })
      : this.client.readContract({ address: quote.address, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  }

  async launch(user: Address, input: LaunchInput, _outcome?: TxOutcome, onStage?: (stage: TxStage) => void): Promise<Coin> {
    try { await this.loadSettings(); }
    catch { throw new TxError("Could not verify the current launch settings. Check your connection and try again.", "reverted"); }
    const settings = this.getSettings();
    if (settings.launchesPaused) throw new TxError("New launches are paused right now. Existing coins trade as normal.", "reverted");
    if (!settings.enabledModes.includes(input.mode)) throw new TxError("That fee destination is not available right now.", "reverted");
    if (input.tweet && (input.mode !== "creator" || !validateAuthorShareBps(input.tweet.authorShareBps))) throw new TxError("Tweet launches use Creator fees and an author share from 20% to 100%.", "reverted");
    const requestedMarkets = input.markets?.length ? input.markets : [{ quote: input.quote, firstBuyQuote: input.firstBuyQuote, firstBuyText: input.firstBuyText }];
    if (requestedMarkets.length > 5 || new Set(requestedMarkets.map((market) => lower(market.quote.address))).size !== requestedMarkets.length) throw new TxError("Choose up to five different pair assets.", "reverted");
    if (requestedMarkets.some((market) => !this.quotes.some((listed) => lower(listed.address) === lower(market.quote.address)))) throw new TxError("Choose listed pair assets.", "reverted");
    // Registry identity, kind, decimals and price stay authoritative after a draft or catalog refresh.
    let markets = requestedMarkets.map(market => ({ ...market, quote: findPair(this.quotes, market.quote.address)! }));
    if (TARGET_CHAIN_ID === 8453 && markets.some(market => market.quote.kind === "stock")) {
      try { await this.loadPairCatalog("trending"); }
      catch { throw new TxError("Could not verify stock issuer availability. Try again before launching.", "reverted"); }
      const catalog = this.catalogs.get("trending")!;
      const verified = mergePairCatalog(this.quotes, catalog.quotes, { requireStockIssuer: true, stockIssuerVerified: catalog.stockIssuerVerified });
      markets = markets.map(market => ({ ...market, quote: findPair(verified, market.quote.address)! }));
    }
    const unavailable = markets.map(market => pairUnavailableReason(market.quote, settings.enabledQuoteKinds, this.now())).find(Boolean);
    if (unavailable) throw new TxError(unavailable, "reverted");
    if (markets.some((market) => !settings.enabledQuoteKinds.includes(market.quote.kind))) throw new TxError("That pair is not available right now.", "reverted");
    if (input.feeBps < settings.feeMinBps || input.feeBps > settings.feeMaxBps) throw new TxError("The trading fee is outside the allowed range.", "reverted");
    if (input.mode !== "creator" && (input.creatorKeepBps < 0 || input.creatorKeepBps > settings.creatorKeepMaxBps)) {
      throw new TxError("The creator share is above the allowed limit.", "reverted");
    }
    const pairs = await Promise.all(markets.map(async (market) => {
      const firstBuy = toUnits(market.firstBuyText ?? plain(market.firstBuyQuote), market.quote.decimals);
      if (firstBuy > 0n && firstBuy > await this.rawQuoteBalance(user, market.quote)) throw new TxError(`Not enough ${market.quote.symbol} for the first buy.`, "insufficient");
      return { quote: market.quote.address, quoteDecimals: market.quote.decimals, firstBuy };
    }));
    const primary = pairs[0]!;
    let tweet: TweetLaunchAttestation | undefined;
    if (input.tweet) {
      try {
        const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
        tweet = await this.api.post<TweetLaunchAttestation>("/v1/tweets/attestation", { url: input.tweet.source.url, authorShareBps: input.tweet.authorShareBps, salt }, { token: await this.sessionToken(user) });
        if (tweet.source.postId !== input.tweet.source.postId || tweet.source.author.id !== input.tweet.source.author.id || tweet.tweet.authorShareBps !== input.tweet.authorShareBps
          || tweet.salt !== salt || tweet.launcher.toLowerCase() !== user.toLowerCase()) throw new TxError("The post attribution changed. Import the X post again before launching.", "reverted");
      } catch (error) { throw error instanceof ApiError ? new TxError(error.message, "reverted") : error; }
    }

    // Upload the image and metadata before creating its permanent reference.
    onStage?.("upload");
    let contractURI: string;
    try {
      const image = await this.api.upload<{ uri: string }>("/v1/media/image", dataUrlToBlob(input.image), "coin.webp");
      const metadata = await this.api.post<{ contractURI: string }>("/v1/media/metadata", {
        name: input.name,
        symbol: input.symbol,
        description: input.description || undefined,
        image: image.uri,
        x: input.links.x || undefined,
        telegram: input.links.telegram || undefined,
        website: input.links.website || undefined,
      });
      contractURI = metadata.contractURI;
    } catch (error) {
      if (error instanceof ApiError) {
        const detail = error.details ? Object.values(error.details)[0] : undefined;
        throw new TxError(detail ?? error.message, "reverted");
      }
      throw new TxError("Could not save the coin's image and details. Check your connection and try again.", "reverted");
    }

    const [ctx, deadline] = await Promise.all([this.txContext(user, onStage), this.deadline()]);
    const result = await (await txModule()).sendLaunch(ctx, {
      name: input.name,
      symbol: input.symbol,
      contractURI,
      quote: primary.quote,
      quoteDecimals: primary.quoteDecimals,
      mode: input.mode,
      feeBps: input.feeBps,
      creatorKeepBps: input.creatorKeepBps,
      firstBuy: primary.firstBuy,
      pairs,
      slippageBps: LAUNCH_SLIPPAGE_BPS,
      deadline,
      ...(tweet ? { tweet, salt: tweet.salt } : {}),
    });
    this.invalidate("coins");
    this.invalidate(`qbal:${lower(user)}`);
    const indexed = await this.waitForCoin(result.coin);
    if (indexed) return indexed;
    const provisional = this.provisionalCoin(user, { ...input, quote: markets[0]!.quote }, result.coin, settings);
    if (result.markets?.length) provisional.markets = result.markets.map((market, i) => ({
      poolId: market.poolId, quote: markets[i]!.quote, supplyRaw: equalAllocations(markets.length)[i]!.toString(), supplyFraction: 1 / markets.length,
      poolCoins: Number(equalAllocations(markets.length)[i]!) / 1e18 - Number(market.coinsBought) / 1e18,
      priceQuote: provisional.priceUsd / markets[i]!.quote.usdPrice, priceUsd: provisional.priceUsd,
      liquidityUsd: settings.openingFdvUsd / markets.length, volume24hUsd: 0, volumeTotalUsd: 0,
      change5m: 0, change1h: 0, change24h: 0, stats: { ...provisional.stats },
    }));
    return provisional;
  }

  /** The indexed coin, once the indexer has it (usually within seconds). */
  private async waitForCoin(address: Address): Promise<Coin | null> {
    const key = lower(address);
    const deadline = this.now() + INDEXER_WAIT_MS;
    while (this.now() < deadline) {
      await this.loadCoin(key).catch(() => undefined);
      const coin = this.coins.get(key);
      if (coin) {
        this.emit();
        return coin;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return null;
  }

  /** What the launch screen shows if the indexer is slow: the coin as it was just created. */
  private provisionalCoin(user: Address, input: LaunchInput, address: Address, settings: LaunchSettings): Coin {
    const now = this.now();
    return {
      ...(input.tweet ? { tweet: { postId: input.tweet.source.postId, authorXUserId: input.tweet.source.author.id, authorShareBps: input.tweet.authorShareBps,
        treasuryUnlockAt: now + AUTHOR_RESERVE_DAYS * 86_400_000, treasuryUnlocked: false,
        verifyBy: now + AUTHOR_RESERVE_DAYS * 86_400_000, source: input.tweet.source } } : {}),
      address,
      name: input.name,
      symbol: input.symbol,
      description: input.description,
      image: input.image,
      links: input.links,
      creator: user,
      createdAt: now,
      quote: input.quote,
      terms: {
        feeBps: input.feeBps,
        mode: input.mode,
        creatorKeepBps: input.mode === "creator" ? 0 : input.creatorKeepBps,
        platformShareBps: settings.platformShareBps,
        referralShareBps: settings.referralShareBps,
        snipeStartBps: settings.snipeStartBps,
        snipeDurationSec: settings.snipeDurationSec,
      },
      priceQuote: settings.openingFdvUsd / COIN_SUPPLY_HUMAN / input.quote.usdPrice,
      priceUsd: settings.openingFdvUsd / COIN_SUPPLY_HUMAN,
      marketCapUsd: settings.openingFdvUsd,
      fdvUsd: settings.openingFdvUsd,
      openingMarketCapUsd: settings.openingFdvUsd,
      athMarketCapUsd: settings.openingFdvUsd,
      liquidityUsd: settings.openingFdvUsd,
      volume24hUsd: 0,
      volumeTotalUsd: 0,
      change5m: 0,
      change1h: 0,
      change24h: 0,
      holders: 1,
      circulating: 0,
      buys24h: 0,
      sells24h: 0,
      lastTradeAt: now,
      sparkline: [],
      stats: {
        feesTotalQuote: 0,
        platformQuote: 0,
        referralQuote: 0,
        creatorEarnedQuote: 0,
        creatorClaimedQuote: 0,
        burnedCoins: 0,
        burnBudgetQuote: 0,
        buybacks: 0,
        holdersPaidQuote: 0,
        epochPendingQuote: 0,
        nextEpochAt: 0,
        epochs: 0,
        floorQuote: 0,
        floorPriceUsd: 0,
      },
      momentum: 0,
      devHoldsPct: 0,
      devSold: false,
      top10Pct: 0,
      snipers: 0,
      sameBlockBuys: 0,
      milestonesReached: 0,
    };
  }

  async claim(user: Address, items: Claimable[], _outcome?: TxOutcome, onStage?: (stage: TxStage) => void, to?: Address): Promise<Hash> {
    const requests: ClaimRequest[] = items.map((item) => {
      if (!item.currency || !item.amountRaw) throw new TxError("These rewards are still loading. Try again in a moment.", "reverted");
      return {
        kind: item.kind,
        coin: item.coin,
        poolId: item.poolId,
        currency: getAddress(item.currency),
        amount: BigInt(item.amountRaw),
        ...(item.kind === "holders"
          ? { epoch: item.epoch, index: item.index !== undefined ? BigInt(item.index) : undefined, proof: item.proof as `0x${string}`[] | undefined }
          : {}),
      };
    });
    const ctx = await this.txContext(user, onStage);
    const hash = await (await txModule()).sendClaims(ctx, requests, to);
    this.invalidate(`claimables:${lower(user)}`);
    this.invalidate(`qbal:${lower(user)}`);
    return hash;
  }

  private async creatorAction(user: Address, coin: Address, action: "lowerFee" | "proposeCreator" | "acceptCreator", value?: Address | number, onStage?: (stage: TxStage) => void): Promise<Hash> {
    const hash = await (await txModule()).sendCreatorAction(await this.txContext(user, onStage), coin, action, value);
    this.invalidate(`coin:${lower(coin)}`);
    this.invalidate("coins");
    this.invalidate("claimables:");
    this.invalidate("profile:");
    this.invalidate(`pool:${lower(coin)}`);
    await this.loadCoin(lower(coin)).catch(() => undefined);
    this.emit();
    return hash;
  }

  lowerFee(user: Address, coin: Address, feeBps: number, onStage?: (stage: TxStage) => void) { return this.creatorAction(user, coin, "lowerFee", feeBps, onStage); }
  proposeCreator(user: Address, coin: Address, proposed: Address, onStage?: (stage: TxStage) => void) { return this.creatorAction(user, coin, "proposeCreator", proposed, onStage); }
  acceptCreator(user: Address, coin: Address, onStage?: (stage: TxStage) => void) { return this.creatorAction(user, coin, "acceptCreator", undefined, onStage); }

  async addComment(author: Address, coinAddress: string, body: string): Promise<Comment> {
    const text = body.replace(/\s+/g, " ").trim();
    if (!text) throw new TxError("Write something first.", "reverted");
    if (text.length > 280) throw new TxError("Comments can be up to 280 characters.", "reverted");
    const key = lower(coinAddress);
    const post = async (token: string) => (await this.api.post<{ comment: Comment }>(`/v1/coins/${key}/comments`, { body: text }, { token })).comment;

    let comment: Comment;
    try {
      comment = await post(await this.sessionToken(author));
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.status !== 401) throw new TxError(error.message, "reverted");
      // The session expired on the server: sign in again, once.
      clearSession(author);
      try {
        comment = await post(await this.sessionToken(author));
      } catch (retry) {
        throw retry instanceof ApiError ? new TxError(retry.message, "reverted") : retry;
      }
    }
    this.comments.set(key, [comment, ...(this.comments.get(key) ?? []).filter((c) => c.id !== comment.id)]);
    this.emit();
    return comment;
  }

  private async sessionToken(address: Address): Promise<string> {
    const existing = loadSession(address, this.now());
    if (existing) return existing.token;
    const wallet = this.options.txContext
      ? (await this.options.txContext(address)).wallet
      : await (await import("./wallet")).connectedWallet(address, { onChain: false });
    const session = await signIn(this.api, wallet, TARGET_CHAIN_ID, this.options.location);
    saveSession(session);
    return session.token;
  }

  /** Testnets: mints the day's test stock to the connected wallet. */
  async dripTestStock(user: Address): Promise<Hash> {
    const ctx = await this.txContext(user);
    const hash = await (await txModule()).sendDrip(ctx);
    this.invalidate(`qbal:${lower(user)}`);
    return hash;
  }

  hasTestStockFaucet(): boolean {
    this.read("deployment", 10 * 60_000, () => this.loadDeployment());
    return Boolean(this.deployment?.stockFaucet);
  }

  /* ------------------------------------------------------------------- admin */

  /** The admin page's token, for moderation reads and writes. */
  setAdminToken(token: string | null) {
    this.adminToken = token;
    if (token) this.invalidate("admin");
  }

  private async loadAdmin() {
    if (!this.adminToken) return;
    const body = await this.api.get<{ hiddenCoins: Address[]; featuredCoins: Address[]; banner: string }>("/v1/admin/overview", { adminToken: this.adminToken });
    this.adminHidden = body.hiddenCoins;
    this.featured = body.featuredCoins;
    this.banner = body.banner;
  }

  async updateSettings(next: LaunchSettings): Promise<void> {
    await this.loadSettings();
    const calls = ownerCalls(this.getSettings(), next);
    if (calls.length === 0) return;
    const ctx = await this.txContext(undefined);
    await (await txModule()).sendOwnerCalls(ctx, calls);
    this.invalidate("settings");
  }

  private async moderate(path: string, body: unknown, adminToken?: string) {
    const token = adminToken ?? this.adminToken;
    if (!token) throw new TxError("Enter the admin token first.", "reverted");
    try {
      await this.api.post(path, body, { adminToken: token });
    } catch (error) {
      throw error instanceof ApiError ? new TxError(error.message, "reverted") : error;
    }
    this.invalidate("admin");
    this.invalidate("moderation");
    this.invalidate("coins");
  }

  async setHidden(address: Address, hidden: boolean, adminToken?: string): Promise<void> {
    await this.moderate(`/v1/admin/coins/${lower(address)}/moderation`, { hidden }, adminToken);
    this.invalidate(`coin:${lower(address)}`);
  }

  async setFeatured(address: Address, featured: boolean, adminToken?: string): Promise<void> {
    await this.moderate(`/v1/admin/coins/${lower(address)}/moderation`, { featured }, adminToken);
    this.invalidate(`coin:${lower(address)}`);
  }

  async setBanner(text: string, adminToken?: string): Promise<void> {
    await this.moderate("/v1/admin/banner", { text }, adminToken);
  }
}
