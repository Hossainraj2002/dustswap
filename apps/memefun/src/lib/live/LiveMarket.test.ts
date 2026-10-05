import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { fromUnits } from "@/core/format";
import { COIN_SUPPLY } from "@/core/constants";
import { DEFAULT_SETTINGS } from "@/core/settings";
import type { QuoteAsset } from "@/core/types";
import { USDC } from "@/lib/market/quotes";
import { applyQuote, createLaunchPool, launchPoolAt, livePool, minOut, quoteBuy, quoteSell, type LaunchPool } from "@/core/pool";
import type { Coin } from "@/lib/market/types";
import { createApi } from "./api";
import { type EventSourceLike, LiveMarket, type PoolInfo } from "./LiveMarket";
import { sendTrade, type TxContext, type TradeFill } from "./tx";

vi.mock("./tx", () => ({ sendTrade: vi.fn() }));

const COIN = "0xb200000000000000000000000000000000000001";
const OTHER = "0xb200000000000000000000000000000000000002";
const USER = "0x00000000000000000000000000000000000a11ce";

function coin(address: string, overrides: Partial<Coin> = {}): Coin {
  return {
    address: address as `0x${string}`,
    name: "Toad",
    symbol: "TOAD",
    description: "",
    image: "",
    links: {},
    creator: "0x0000000000000000000000000000000000000001",
    createdAt: Date.now() - 3_600_000,
    quote: { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", name: "Ether", decimals: 18, kind: "native", usdPrice: 3_000 },
    terms: { feeBps: 100, mode: "creator", creatorKeepBps: 0, platformShareBps: 2_000, referralShareBps: 2_500, snipeStartBps: 5_000, snipeDurationSec: 15 },
    priceQuote: 0,
    priceUsd: 0.000005,
    marketCapUsd: 5_000,
    fdvUsd: 5_000,
    openingMarketCapUsd: 5_000,
    athMarketCapUsd: 5_000,
    liquidityUsd: 0,
    volume24hUsd: 0,
    volumeTotalUsd: 0,
    change5m: 0,
    change1h: 0,
    change24h: 0,
    holders: 1,
    circulating: 0,
    buys24h: 0,
    sells24h: 0,
    lastTradeAt: 0,
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
    ...overrides,
  };
}

// A fresh ETH pool for COIN (coin is currency1, start tick 202,000).
const launch = launchPoolAt(202_000, false, 18);
const POOL: PoolInfo = {
  coin: COIN,
  poolId: "0x01",
  quote: "0x0000000000000000000000000000000000000000",
  quoteDecimals: 18,
  coinIsCurrency0: false,
  startTick: launch.startTick,
  liquidity: launch.liquidity.toString(),
  sqrtPriceX96: launch.sqrtPriceX96.toString(),
  tick: launch.tick,
  floors: [],
};

type Handler = (url: URL, init?: RequestInit) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

class FakeApi {
  readonly calls: Array<{ path: string; method: string; body?: string; auth?: string }> = [];
  routes = new Map<string, Handler>();
  failAll = false;

  on(pathname: string, handler: Handler | unknown) {
    this.routes.set(pathname, typeof handler === "function" ? (handler as Handler) : () => ({ body: handler }));
    return this;
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    this.calls.push({ path: url.pathname + url.search, method: init?.method ?? "GET", body: init?.body as string | undefined, auth: headers.get("authorization") ?? undefined });
    if (this.failAll) throw new TypeError("network down");
    const handler = this.routes.get(url.pathname);
    if (!handler) return new Response(JSON.stringify({ error: { code: "not_found", message: "No such endpoint." } }), { status: 404 });
    const { status = 200, body } = await handler(url, init);
    return new Response(JSON.stringify(body), { status });
  };

  count(prefix: string) {
    return this.calls.filter((call) => call.path.startsWith(prefix)).length;
  }
}

class FakeStream implements EventSourceLike {
  readyState = 1;
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.readyState = 2;
  }
  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) } as MessageEvent);
  }
}

const client = {
  getBalance: async () => 2n * 10n ** 18n,
  readContract: async () => 0n,
  getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
} as unknown as PublicClient;

const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

let markets: LiveMarket[] = [];
function market(api: FakeApi, extra: Partial<ConstructorParameters<typeof LiveMarket>[0]> = {}) {
  const stream = new FakeStream();
  const m = new LiveMarket({ api: createApi("https://api.test", api.fetch), client, eventSource: () => stream, ...extra });
  m.start();
  markets.push(m);
  return { m, stream };
}

afterEach(() => {
  for (const m of markets) m.stop();
  markets = [];
  vi.clearAllMocks();
});

function baseApi() {
  return new FakeApi()
    .on("/v1/deployment", { error: "none" })
    .on("/v1/launch-settings", { settings: { feeMinBps: 0, feeMaxBps: 500 }, quotes: [coin(COIN).quote] })
    .on("/v1/moderation", { featured: [], banner: "" })
    .on("/v1/coins", { coins: [coin(COIN), coin(OTHER, { symbol: "FROG" })], nextCursor: null, total: 2 })
    .on(`/v1/coins/${COIN}`, { coin: coin(COIN) })
    .on(`/v1/coins/${COIN}/pool`, { pool: POOL, asOf: Date.now() });
}

describe("LiveMarket", () => {
  it("keeps same-ticker quote balances distinct and preserves successful balances when one token fails", async () => {
    const tokens: QuoteAsset[] = [COIN, OTHER].map(address => ({
      address: address as QuoteAsset["address"], symbol: "SAME", name: "Different token", decimals: 18,
      kind: "token", usdPrice: 1, registered: true, enabled: true, launchable: true,
    }));
    const unavailable = { ...tokens[0]!, address: "0x00000000000000000000000000000000000000ff" as const, symbol: "FAILED" };
    const api = baseApi().on("/v1/launch-settings", { settings: DEFAULT_SETTINGS, quotes: [coin(COIN).quote, ...tokens, unavailable] });
    const readContract = vi.fn(async ({ address }: { address: string }) => {
      if (address === unavailable.address) throw new Error("Token unavailable");
      return address === COIN ? 10n ** 18n : 2n * 10n ** 18n;
    });
    const { m } = market(api, { client: { ...client, readContract } as unknown as PublicClient });
    await settle();
    m.ensureUser(USER);
    await settle();
    expect(m.getQuoteBalance(USER, COIN)).toBe(1);
    expect(m.getQuoteBalance(USER, OTHER)).toBe(2);
    expect(m.getQuoteBalance(USER, coin(COIN).quote.address)).toBe(2);
    expect(m.getQuoteBalance(USER, "SAME")).toBe(0);
    expect(m.getQuoteBalance(USER, unavailable.address)).toBe(0);
  });

  it("keeps catalog discovery separate from registry launch eligibility", async () => {
    const registered: QuoteAsset = { address: COIN, symbol: "SAME", name: "Listed token", decimals: 18,
      kind: "token", usdPrice: 1, launchable: false, enabled: false, registered: true, unavailableReason: "Pair paused" };
    const discovered: QuoteAsset = { ...registered, address: OTHER, enabled: true, launchable: true, unavailableReason: undefined };
    const api = baseApi().on("/v1/launch-settings", { settings: DEFAULT_SETTINGS, quotes: [coin(COIN).quote, registered] })
      .on("/v1/pair-catalog", { quotes: [{ ...registered, enabled: true, launchable: true }, discovered],
        sources: { o1: { complete: false, message: "Private environment setup instructions" } } });
    const { m } = market(api);
    await settle();
    m.listPairCatalog("newest");
    await settle();
    const catalog = m.listPairCatalog("newest");
    expect(catalog.find(quote => quote.address === COIN)).toMatchObject({ launchable: false, enabled: false, unavailableReason: "Pair paused" });
    expect(catalog.find(quote => quote.address === OTHER)?.launchable).toBe(false);
    expect(m.getPairCatalogNotice("newest")).toContain("Complete launch history is currently unavailable");
    expect(m.getPairCatalogNotice("newest")).not.toContain("environment");
    expect(m.getPairCatalogNotice("newest")).not.toContain("Alpha");
    expect(api.calls.some(call => call.path === "/v1/pair-catalog?sort=newest")).toBe(true);
  });

  it("rejects expired, disabled and unverified pair assets before upload or wallet access", async () => {
    const now = Date.now();
    const active: QuoteAsset = { address: COIN, symbol: "SAME", name: "Listed token", decimals: 18,
      kind: "token", usdPrice: 1, launchable: true, enabled: true, registered: true,
      priceUpdatedAt: now - 61_000, priceMaxAgeSec: 60 };
    const txContext = vi.fn();
    for (const [quote, reason] of [
      [active, "Waiting for a fresh verified price"],
      [{ ...active, priceUpdatedAt: now, launchable: false, enabled: false, unavailableReason: "Pair paused" }, "Pair paused"],
      [{ ...active, priceUpdatedAt: now, launchable: undefined }, "Waiting for verified launch eligibility"],
    ] as const) {
      const api = baseApi().on("/v1/launch-settings", { settings: DEFAULT_SETTINGS, quotes: [coin(COIN).quote, quote] });
      const { m } = market(api, { now: () => now, txContext });
      await expect(m.launch(USER, { name: "New token", symbol: "NEW", description: "", image: "data:image/png;base64,AA==", links: {},
        quote: { ...quote, launchable: true, enabled: true }, mode: "creator", feeBps: 100, creatorKeepBps: 0, firstBuyQuote: 0 })).rejects.toThrow(reason);
      expect(api.count("/v1/media/")).toBe(0);
    }
    expect(txContext).not.toHaveBeenCalled();
  });

  it("uses registry decimals for a first buy even when saved draft metadata differs", async () => {
    const quote: QuoteAsset = { address: COIN, symbol: "SAME", name: "Listed token", decimals: 18,
      kind: "token", usdPrice: 1, launchable: true, enabled: true, registered: true };
    const api = baseApi().on("/v1/launch-settings", { settings: DEFAULT_SETTINGS, quotes: [quote] });
    const txContext = vi.fn();
    const { m } = market(api, { client: { ...client, readContract: async () => 10n ** 18n } as unknown as PublicClient, txContext });
    await expect(m.launch(USER, { name: "New token", symbol: "NEW", description: "", image: "data:image/png;base64,AA==", links: {},
      quote: { ...quote, decimals: 6 }, mode: "creator", feeBps: 100, creatorKeepBps: 0, firstBuyQuote: 2 })).rejects.toThrow("Not enough SAME for the first buy");
    expect(api.count("/v1/media/")).toBe(0);
    expect(txContext).not.toHaveBeenCalled();
  });

  it("fails closed on a launch settings refresh failure instead of reusing an eligible cached pair", async () => {
    const quote: QuoteAsset = { address: COIN, symbol: "SAME", name: "Listed token", decimals: 18,
      kind: "token", usdPrice: 1, launchable: true, enabled: true, registered: true,
      priceUpdatedAt: Date.now(), priceMaxAgeSec: 3600 };
    const api = baseApi().on("/v1/launch-settings", { settings: DEFAULT_SETTINGS, quotes: [quote] });
    const txContext = vi.fn();
    const onStage = vi.fn();
    const { m } = market(api, { txContext });
    await settle();
    expect(m.listQuotes()[0]?.launchable).toBe(true);
    api.on("/v1/launch-settings", () => ({ status: 503, body: { error: { code: "unavailable", message: "Try later" } } }));
    await expect(m.launch(USER, { name: "New token", symbol: "NEW", description: "", image: "data:image/png;base64,AA==", links: {},
      quote, mode: "creator", feeBps: 100, creatorKeepBps: 0, firstBuyQuote: 0 }, undefined, onStage)).rejects.toThrow("Could not verify the current launch settings");
    expect(api.count("/v1/media/")).toBe(0);
    expect(api.count("/v1/tweets/attestation")).toBe(0);
    expect(onStage).not.toHaveBeenCalled();
    expect(txContext).not.toHaveBeenCalled();
  });

  it("rechecks stock issuer availability at launch even after a valid catalog was cached", async () => {
    const stock: QuoteAsset = { address: COIN, symbol: "AAPL", name: "Apple tokenized stock", decimals: 18,
      kind: "stock", usdPrice: 200, launchable: true, enabled: true, registered: true,
      priceUpdatedAt: Date.now(), priceMaxAgeSec: 3600 };
    const txContext = vi.fn();
    for (const [response, reason] of [
      [{ quotes: [{ ...stock, launchable: false, unavailableReason: "Issuer paused" }], sources: { coinbase: { status: "ok" } } }, "Issuer paused"],
      [{ quotes: [{ ...stock, launchable: false, unavailableReason: "No circulating supply" }], sources: { coinbase: { status: "ok" } } }, "No circulating supply"],
      [{ quotes: [stock], sources: { coinbase: { status: "unavailable" } } }, "Stock issuer availability could not be verified"],
      [{ quotes: [], sources: { coinbase: { status: "ok" } } }, "Stock issuer availability could not be verified"],
      [null, "Could not verify stock issuer availability"],
    ] as const) {
      const api = baseApi().on("/v1/launch-settings", { settings: DEFAULT_SETTINGS, quotes: [stock] })
        .on("/v1/pair-catalog", { quotes: [stock], sources: { coinbase: { status: "ok" } } });
      const { m } = market(api, { txContext });
      await settle();
      m.listPairCatalog();
      await settle();
      expect(m.listPairCatalog().find(quote => quote.address === COIN)?.launchable).toBe(true);
      if (response) api.on("/v1/pair-catalog", response);
      else api.on("/v1/pair-catalog", () => ({ status: 503, body: { error: { code: "unavailable", message: "Try later" } } }));
      await expect(m.launch(USER, { name: "New token", symbol: "NEW", description: "", image: "data:image/png;base64,AA==", links: {},
        quote: stock, mode: "creator", feeBps: 100, creatorKeepBps: 0, firstBuyQuote: 0 })).rejects.toThrow(reason);
      expect(api.count("/v1/media/")).toBe(0);
      expect(api.count("/v1/tweets/attestation")).toBe(0);
      expect(api.count("/v1/pair-catalog")).toBeGreaterThanOrEqual(2);
      expect(m.listPairCatalog().find(quote => quote.address === COIN)?.launchable).toBe(false);
    }
    expect(txContext).not.toHaveBeenCalled();
  });

  it("waits for real settings and keeps selected pools, candles and streamed trades separate", async () => {
    const base = coin(COIN);
    const markets = [{ poolId: "0x01" as const, quote: base.quote }, { poolId: "0x02" as const, quote: USDC }].map((market) => ({ ...market,
      supplyRaw: (COIN_SUPPLY / 2n).toString(), supplyFraction: 0.5, poolCoins: 500000000,
      priceQuote: base.priceUsd / market.quote.usdPrice, priceUsd: base.priceUsd, liquidityUsd: 2500,
      volume24hUsd: 0, volumeTotalUsd: 0, change5m: 0, change1h: 0, change24h: 0, stats: base.stats }));
    const api = baseApi().on(`/v1/coins/${COIN}`, { coin: { ...base, markets } })
      .on(`/v1/coins/${COIN}/pool`, (url: URL) => ({ body: { pool: { ...POOL, poolId: url.searchParams.get("poolId") ?? "0x01" } } }))
      .on(`/v1/coins/${COIN}/trades`, (url: URL) => ({ body: { trades: [{ id: url.searchParams.get("poolId"), coin: COIN, ts: 1 }] } }))
      .on(`/v1/coins/${COIN}/candles`, { candles: [] });
    const { m, stream } = market(api);
    expect(m.isSettingsReady()).toBe(false);
    m.getCoin(COIN); await settle();
    expect(m.isSettingsReady()).toBe(true);
    m.quote(COIN, "buy", 0.01, Date.now(), false, "0x01");
    m.quote(COIN, "buy", 25, Date.now(), false, "0x02");
    m.getTrades(COIN, 100, "0x01"); m.getTrades(COIN, 100, "0x02"); m.getTrades(COIN);
    m.getCandles(COIN, 300, "price", "0x02");
    await settle();
    expect(api.calls.some((call) => call.path.endsWith("/pool?poolId=0x02"))).toBe(true);
    expect(api.calls.some((call) => call.path.includes("/candles?interval=300&metric=price&poolId=0x02"))).toBe(true);
    stream.emit("trade", { id: "new", poolId: "0x02", coin: COIN, trader: USER, ts: 2 });
    expect(m.getTrades(COIN, 100, "0x01").map((trade) => trade.id)).toEqual(["0x01"]);
    expect(m.getTrades(COIN).map((trade) => trade.id)).not.toContain("new");
    expect(m.getTrades(COIN, 100, "0x02").map((trade) => trade.id)).toEqual(["new", "0x02"]);
    expect(m.quote(COIN, "buy", 1, Date.now(), false, "0x03").reason).toBe("Pool not found.");
  });
  it("lists coins from the API and re-renders once they land", async () => {
    const api = baseApi();
    const { m } = market(api);
    let renders = 0;
    m.subscribe(() => renders++);
    expect(m.listCoins()).toEqual([]);
    await settle();
    expect(m.listCoins().map((c) => c.symbol)).toEqual(["TOAD", "FROG"]);
    expect(renders).toBeGreaterThan(0);
    // A second read inside the refresh interval does not refetch.
    m.listCoins();
    expect(api.count("/v1/coins?")).toBe(1);
  });

  it("loads a coin page by address, and remembers a coin that does not exist", async () => {
    const api = baseApi();
    const { m } = market(api);
    expect(m.getCoin(COIN)).toBeUndefined();
    expect(m.getCoin("not-an-address")).toBeUndefined();
    await settle();
    expect(m.getCoin(COIN.toUpperCase().replace("0X", "0x"))?.symbol).toBe("TOAD");
    m.getCoin("0x00000000000000000000000000000000000000ff");
    await settle();
    expect(m.getCoin("0x00000000000000000000000000000000000000ff")).toBeUndefined();
  });

  it("quotes from the pool endpoint with exactly the core math", async () => {
    const api = baseApi();
    const { m } = market(api);
    m.getCoin(COIN);
    await settle();
    const before = m.quote(COIN, "buy", 0.1);
    expect(before.ok).toBe(false);
    expect(before.reason).toBe("Loading the pool.");
    await settle();
    const quoted = m.quote(COIN, "buy", 0.1);
    const expected = quoteBuy(livePool({ ...POOL, liquidity: launch.liquidity, sqrtPriceX96: launch.sqrtPriceX96, floors: [] }), 10n ** 17n, 100);
    expect(quoted.ok).toBe(true);
    expect(quoted.amountOut).toBe(fromUnits(expected.amountOut, 18));
    expect(quoted.amountOutRaw).toBe(expected.amountOut.toString());
    expect(quoted.feeQuote).toBe(0.001);
    // Selling into a fresh pool has nothing to fill.
    expect(m.quote(COIN, "sell", 1_000).ok).toBe(false);
  });

  it("puts streamed trades on top and refreshes the pool they moved", async () => {
    const api = baseApi().on(`/v1/coins/${COIN}/trades`, { trades: [{ id: "a", coin: COIN, trader: USER, ts: 1 }] });
    const { m, stream } = market(api);
    m.getTrades(COIN);
    m.getCoin(COIN);
    await settle();
    m.quote(COIN, "buy", 0.1);
    await settle();
    const poolLoads = api.count(`/v1/coins/${COIN}/pool`);
    expect(poolLoads).toBe(1);
    stream.emit("trade", { id: "b", coin: COIN, trader: USER, ts: 2 });
    stream.emit("trade", { id: "b", coin: COIN, trader: USER, ts: 2 });
    await settle();
    expect(m.getTrades(COIN).map((t) => t.id)).toEqual(["b", "a"]);
    expect(api.count(`/v1/coins/${COIN}/pool`)).toBe(poolLoads + 1);
  });

  it("reports an outage after repeated failures and recovers on its own", async () => {
    const api = baseApi();
    api.failAll = true;
    const { m } = market(api);
    m.listCoins();
    m.getActivity();
    m.getCreators();
    await settle();
    expect(m.getStatus().state).toBe("offline");
    api.failAll = false;
    m.getCoin(COIN);
    await settle();
    expect(m.getStatus().state).toBe("ready");
  });

  it("holds back holder rewards still inside their veto window", async () => {
    const api = baseApi().on(`/v1/claimables/${USER}`, {
      claimables: [
        { coin: COIN, kind: "holders", amountQuote: 1, quoteSymbol: "ETH", amountUsd: 3_000, claimableAt: Date.now() + 3_600_000 },
        { coin: COIN, kind: "creator", amountQuote: 2, quoteSymbol: "ETH", amountUsd: 6_000 },
      ],
    });
    const { m } = market(api);
    m.getClaimables(USER);
    await settle();
    expect(m.getClaimables(USER).map((c) => c.kind)).toEqual(["creator"]);
  });

  it("signs in once to comment, and again when the server forgets the session", async () => {
    // Anvil's public test mnemonic: a key that holds nothing anywhere.
    const account = mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 1 });
    let commentCalls = 0;
    const api = baseApi()
      .on("/v1/auth/nonce", { nonce: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", chainId: 8453 })
      .on("/v1/auth/verify", { address: account.address, token: "session-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
      .on(`/v1/coins/${COIN}/comments`, (_url: URL, init?: RequestInit) => {
        if (init?.method !== "POST") return { body: { comments: [] } };
        commentCalls += 1;
        if (commentCalls === 1) return { status: 401, body: { error: { code: "sign_in_required", message: "Sign in with your wallet first." } } };
        return { status: 201, body: { comment: { id: "1", coin: COIN, author: account.address, body: "gm", ts: 1, isCreator: false } } };
      });
    const wallet = { account, signMessage: ({ message }: { message: string }) => account.signMessage({ message }) };
    const { m } = market(api, {
      location: { host: "memefun.test", origin: "https://memefun.test" },
      txContext: async () => ({ wallet }) as unknown as TxContext,
    });
    const comment = await m.addComment(account.address, COIN, "  gm  ");
    expect(comment.body).toBe("gm");
    expect(api.count("/v1/auth/verify")).toBe(2);
    const posts = api.calls.filter((call) => call.method === "POST" && call.path.endsWith("/comments"));
    expect(posts.every((call) => call.auth === "Bearer session-token")).toBe(true);
    expect(JSON.parse(posts[1]!.body!)).toEqual({ body: "gm" });
    expect(m.getComments(COIN)[0]?.id).toBe("1");
    await expect(m.addComment(account.address, COIN, " ")).rejects.toThrow("Write something first.");
  });
});

function tradeFixture(state: LaunchPool = launch, quote = coin(COIN).quote) {
  let current = state;
  const api = baseApi().on(`/v1/coins/${COIN}`, { coin: coin(COIN, { quote }) })
    .on(`/v1/coins/${COIN}/pool`, () => ({ body: { pool: {
      ...POOL, quote: quote.address, quoteDecimals: quote.decimals, startTick: current.startTick,
      liquidity: current.liquidity.toString(), sqrtPriceX96: current.sqrtPriceX96.toString(), tick: current.tick,
    } } }));
  const txContext = vi.fn(async () => ({}) as TxContext);
  const { m } = market(api, { txContext, client: {
    ...client, getBalance: async () => 2n * 10n ** 18n, readContract: async () => 2n * 10n ** 18n,
  } as unknown as PublicClient });
  vi.mocked(sendTrade).mockResolvedValue({ hash: `0x${"11".repeat(32)}`, isBuy: true,
    quoteAmount: 10n ** 17n, coinAmount: 1n, fee: 0n, feeBps: 100,
    sqrtPriceX96: state.sqrtPriceX96, tick: state.tick, blockNumber: 1n,
  } as TradeFill);
  return { m, txContext, movePool: (next: LaunchPool) => { current = next; } };
}

describe("live trade minimum received", () => {
  const amount = 10n ** 17n;
  const displayQuote = quoteBuy(launch, amount, 100);
  const displayedMinimum = minOut(displayQuote.amountOut, 500);

  it("preserves the displayed raw minimum after an unfavorable pool change within tolerance", async () => {
    const moved = applyQuote(launch, quoteBuy(launch, 5n * 10n ** 15n, 100));
    const freshOutput = quoteBuy(moved, amount, 100).amountOut;
    expect(freshOutput).toBeLessThan(displayQuote.amountOut);
    expect(freshOutput).toBeGreaterThan(displayedMinimum);
    const { m } = tradeFixture(moved);
    await m.trade(USER, COIN, "buy", 0.1, 0, { amountText: "0.1", slippageBps: 500, minAmountOutRaw: displayedMinimum.toString() });
    expect(sendTrade).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ minAmountOut: displayedMinimum }));
  });

  it("rejects a fresh output below the displayed floor before opening the wallet", async () => {
    const moved = applyQuote(launch, quoteBuy(launch, 10n ** 18n, 100));
    const { m, txContext } = tradeFixture(moved);
    await expect(m.trade(USER, COIN, "buy", 0.1, 0, { slippageBps: 500, minAmountOutRaw: displayedMinimum.toString() }))
      .rejects.toThrow("price changed beyond your minimum");
    expect(txContext).not.toHaveBeenCalled();
    expect(sendTrade).not.toHaveBeenCalled();
  });

  it("tightens the floor when a fresh quote is more favorable", async () => {
    const previouslyMoved = applyQuote(launch, quoteBuy(launch, 5n * 10n ** 15n, 100));
    const previousMinimum = minOut(quoteBuy(previouslyMoved, amount, 100).amountOut, 500);
    expect(previousMinimum).toBeLessThan(displayedMinimum);
    const { m } = tradeFixture();
    await m.trade(USER, COIN, "buy", 0.1, 0, { slippageBps: 500, minAmountOutRaw: previousMinimum.toString() });
    expect(sendTrade).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ minAmountOut: displayedMinimum }));
  });

  it.each(["", "0", "-1", "1.5", "1e18", " 1", "1 ", ((1n << 256n)).toString()])
    ("rejects an invalid exact raw floor %j before opening the wallet", async (minAmountOutRaw) => {
      const { m, txContext } = tradeFixture();
      await expect(m.trade(USER, COIN, "buy", 0.1, 0, { minAmountOutRaw })).rejects.toThrow("minimum received could not be verified");
      expect(txContext).not.toHaveBeenCalled();
      expect(sendTrade).not.toHaveBeenCalled();
    });

  it.each([-1, 0.5, 5001, NaN, Infinity])("rejects invalid slippage %j before opening the wallet", async (slippageBps) => {
    const { m, txContext } = tradeFixture();
    await expect(m.trade(USER, COIN, "buy", 0.1, 0, { slippageBps })).rejects.toThrow("valid slippage percentage");
    expect(txContext).not.toHaveBeenCalled();
    expect(sendTrade).not.toHaveBeenCalled();
  });

  it("checks insufficient funds before opening the wallet", async () => {
    const { m, txContext } = tradeFixture();
    await expect(m.trade(USER, COIN, "buy", 3, 0, { minAmountOutRaw: "1" })).rejects.toThrow("Not enough ETH");
    expect(txContext).not.toHaveBeenCalled();
    expect(sendTrade).not.toHaveBeenCalled();
  });

  it("retains the legacy default when no exact floor or slippage was provided", async () => {
    const { m } = tradeFixture();
    await m.trade(USER, COIN, "buy", 0.1, 0);
    expect(sendTrade).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ minAmountOut: minOut(displayQuote.amountOut, 200) }));
  });

  it("never submits zero minimum for a one-unit quote after integer rounding", async () => {
    const usdcLaunch = createLaunchPool({ coinIsCurrency0: false, quoteDecimals: 6, quoteUsd: 1, openingFdvUsd: 5000 });
    const seeded = applyQuote(usdcLaunch, quoteBuy(usdcLaunch, 10n * 10n ** 6n, 100));
    expect(quoteSell(seeded, 5n * 10n ** 17n, 100).amountOut).toBe(1n);
    const { m } = tradeFixture(seeded, USDC);
    await m.trade(USER, COIN, "sell", 0.5, 0, { amountText: "0.5", slippageBps: 5000 });
    expect(sendTrade).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ minAmountOut: 1n }));
  });
});
