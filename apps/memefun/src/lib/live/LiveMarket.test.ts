import { afterEach, describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { fromUnits } from "@/core/format";
import { launchPoolAt, livePool, quoteBuy } from "@/core/pool";
import type { Coin } from "@/lib/market/types";
import { createApi } from "./api";
import { type EventSourceLike, LiveMarket, type PoolInfo } from "./LiveMarket";
import type { TxContext } from "./tx";

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
