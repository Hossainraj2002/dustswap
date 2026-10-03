import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { HttpError, RateLimiter, cachedJson, errorBody, normalizeOrigins, originGuard, parseAddress, parseLimit } from "../../api/http";
import { creatorProfiles, decodeCursor, encodeCursor, filterCoins, searchCoins } from "../../api/read/routes";
import type { SnapshotState } from "../../api/read/snapshot";
import { adminGuard } from "../../api/write/admin";
import { normalizeComment } from "../../api/write/routes";
import { bearerToken, createSessions } from "../../api/write/session";
import type { Coin } from "../../shared/market-types";

function coin(overrides: Partial<Coin> & { symbol: string }): Coin {
  return {
    address: `0x${overrides.symbol.toLowerCase().padEnd(40, "0")}` as `0x${string}`,
    name: overrides.symbol,
    description: "",
    image: "",
    links: {},
    creator: "0x0000000000000000000000000000000000000001",
    createdAt: 0,
    quote: { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", name: "Ether", decimals: 18, kind: "native", usdPrice: 3_000 },
    terms: { feeBps: 100, mode: "creator", creatorKeepBps: 0, platformShareBps: 2_000, referralShareBps: 2_500, snipeStartBps: 5_000, snipeDurationSec: 15 },
    priceQuote: 0,
    priceUsd: 0,
    marketCapUsd: 0,
    fdvUsd: 0,
    openingMarketCapUsd: 5_000,
    athMarketCapUsd: 0,
    liquidityUsd: 0,
    volume24hUsd: 0,
    volumeTotalUsd: 0,
    change5m: 0,
    change1h: 0,
    change24h: 0,
    holders: 0,
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

const NOW = 1_000_000;
const coins = [
  coin({ symbol: "FROG", name: "Based Frog", momentum: 50, createdAt: (NOW - 7_200) * 1000, marketCapUsd: 8_000, change24h: 0.5 }),
  coin({ symbol: "BCAT", name: "Burn Cat", momentum: 90, createdAt: (NOW - 100_000) * 1000, marketCapUsd: 20_000, change24h: -0.2, terms: { ...coin({ symbol: "x" }).terms, mode: "burn" } }),
  coin({
    symbol: "HDOG",
    name: "Holder Dog",
    momentum: 10,
    createdAt: (NOW - 600) * 1000,
    marketCapUsd: 6_000,
    change24h: 2,
    quote: { address: "0x00000000000000000000000000000000000000c0", symbol: "USDC", name: "USD Coin", decimals: 6, kind: "stable", usdPrice: 1 },
  }),
  coin({ symbol: "GONE", name: "Hidden", momentum: 999, hidden: true }),
];

describe("filterCoins", () => {
  it("sorts the four ways Discover offers and never lists hidden coins", () => {
    expect(filterCoins(coins, {}, NOW).map((c) => c.symbol)).toEqual(["BCAT", "FROG", "HDOG"]);
    expect(filterCoins(coins, { sort: "new" }, NOW).map((c) => c.symbol)).toEqual(["HDOG", "FROG", "BCAT"]);
    expect(filterCoins(coins, { sort: "top" }, NOW).map((c) => c.symbol)).toEqual(["BCAT", "FROG", "HDOG"]);
    expect(filterCoins(coins, { sort: "movers" }, NOW).map((c) => c.symbol)).toEqual(["HDOG", "FROG", "BCAT"]);
  });

  it("filters by pair, mode and age", () => {
    expect(filterCoins(coins, { pair: "usdc" }, NOW).map((c) => c.symbol)).toEqual(["HDOG"]);
    expect(filterCoins(coins, { pair: "eth" }, NOW).map((c) => c.symbol).sort()).toEqual(["BCAT", "FROG"]);
    expect(filterCoins(coins, { mode: "burn" }, NOW).map((c) => c.symbol)).toEqual(["BCAT"]);
    expect(filterCoins(coins, { age: "1h" }, NOW).map((c) => c.symbol)).toEqual(["HDOG"]);
  });

  it("rejects unknown options with a clear message", () => {
    expect(() => filterCoins(coins, { sort: "random" }, NOW)).toThrow("sort must be");
    expect(() => filterCoins(coins, { mode: "x" }, NOW)).toThrow("mode must be");
    expect(() => filterCoins(coins, { age: "2y" }, NOW)).toThrow("age must be");
  });
});

describe("searchCoins", () => {
  it("ranks exact ticker, then prefixes, then substrings, and accepts $TICKER and addresses", () => {
    expect(searchCoins(coins, "$frog").map((c) => c.symbol)).toEqual(["FROG"]);
    expect(searchCoins(coins, "do").map((c) => c.symbol)).toEqual(["HDOG"]);
    expect(searchCoins(coins, coins[1]!.address.toUpperCase().replace("0X", "0x")).map((c) => c.symbol)).toEqual(["BCAT"]);
    expect(searchCoins(coins, "   ")).toEqual([]);
  });
});

describe("cursors and creators", () => {
  it("round-trip and reject garbage", () => {
    expect(decodeCursor<{ o: number }>(encodeCursor({ o: 50 }))).toEqual({ o: 50 });
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(() => decodeCursor("%%%")).toThrow(HttpError);
  });

  it("group visible coins by creator", () => {
    const state = { coins } as SnapshotState;
    const [profile] = creatorProfiles(state);
    expect(profile?.coins).toHaveLength(3);
  });
});

describe("http helpers", () => {
  it("parse addresses and limits", () => {
    expect(parseAddress("0xB2000000000000000000001b03710100DD44768F")).toBe("0xb2000000000000000000001b03710100dd44768f");
    expect(() => parseAddress("0x12")).toThrow("not a valid address");
    expect(parseLimit(undefined, 50, 200)).toBe(50);
    expect(parseLimit("500", 50, 200)).toBe(200);
    expect(() => parseLimit("-1", 50, 200)).toThrow();
    expect(() => parseLimit("1.5", 50, 200)).toThrow();
  });

  it("rate limiter allows the limit per window, then says when to retry", () => {
    const limiter = new RateLimiter();
    expect(limiter.consume("k", 2, 1_000, 0).allowed).toBe(true);
    expect(limiter.consume("k", 2, 1_000, 10).allowed).toBe(true);
    expect(limiter.consume("k", 2, 1_000, 20)).toEqual({ allowed: false, retryAfterSec: 1 });
    expect(limiter.consume("k", 2, 1_000, 1_001).allowed).toBe(true);
  });

  it("normalizes origin lists", () => {
    expect([...normalizeOrigins(["localhost:3100", "https://memefun.dustswap.wtf/", "memefun.dustswap.wtf", "::bad::"])]).toEqual([
      "http://localhost:3100",
      "https://memefun.dustswap.wtf",
    ]);
  });

  it("blocks cross-site writes but not reads or origin-less calls", async () => {
    const app = new Hono();
    app.onError((error, c) => (error instanceof HttpError ? c.json(errorBody(error), error.status) : c.text("x", 500)));
    app.use("*", originGuard(new Set(["http://localhost:3100"])));
    app.all("/x", (c) => c.text("ok"));
    expect((await app.request("/x", { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await app.request("/x", { method: "POST", headers: { origin: "http://localhost:3100" } })).status).toBe(200);
    expect((await app.request("/x", { method: "POST" })).status).toBe(200);
    expect((await app.request("/x", { headers: { origin: "https://evil.example" } })).status).toBe(200);
  });

  it("answers a matching ETag with 304", async () => {
    const app = new Hono();
    app.get("/x", (c) => cachedJson(c, { a: 1 }, { maxAge: 2 }));
    const first = await app.request("/x");
    const etag = first.headers.get("etag")!;
    expect(first.headers.get("cache-control")).toBe("public, max-age=2, stale-while-revalidate=10");
    expect((await app.request("/x", { headers: { "if-none-match": etag } })).status).toBe(304);
  });
});

describe("sessions", () => {
  const sessions = createSessions("x".repeat(32));
  const address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

  it("verify their own tokens and nothing else", () => {
    const { token, expiresAt } = sessions.issue(address, 1_000);
    expect(sessions.verify(token, 2_000)).toEqual({ address, exp: expiresAt });
    expect(sessions.verify(token, expiresAt)).toBeNull();
    expect(sessions.verify(`${token}x`, 2_000)).toBeNull();
    const [payload] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ address: "0x0000000000000000000000000000000000000bad", exp: 9e15 })).toString("base64url");
    expect(sessions.verify(`${forged}.${token.split(".")[1]}`, 2_000)).toBeNull();
    expect(sessions.verify(payload, 2_000)).toBeNull();
    expect(createSessions("y".repeat(32)).verify(token, 2_000)).toBeNull();
  });

  it("need a long secret and read bearer headers", () => {
    expect(() => createSessions("short")).toThrow("at least 32");
    expect(bearerToken("Bearer abc.def")).toBe("abc.def");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe("comments", () => {
  it("collapse whitespace and enforce the limits", () => {
    expect(normalizeComment("  gm \n\t frog  ")).toBe("gm frog");
    expect(() => normalizeComment("   ")).toThrow("Write something first.");
    expect(() => normalizeComment("x".repeat(281))).toThrow("up to 280");
    expect(normalizeComment("é".repeat(280))).toHaveLength(280);
    expect(() => normalizeComment(`hi${String.fromCharCode(0x202e)}there`)).toThrow("hidden or control");
    expect(() => normalizeComment(`hi${String.fromCharCode(0)}`)).toThrow("hidden or control");
  });
});

describe("admin guard", () => {
  const app = (token: string | undefined) => {
    const a = new Hono();
    a.onError((error, c) => (error instanceof HttpError ? c.json(errorBody(error), error.status) : c.text("x", 500)));
    a.use("*", adminGuard(token));
    a.get("/a", (c) => c.text("ok"));
    return a;
  };

  it("is off without a strong token and checks the header otherwise", async () => {
    expect((await app(undefined).request("/a")).status).toBe(503);
    expect((await app("short").request("/a")).status).toBe(503);
    const token = "t".repeat(40);
    expect((await app(token).request("/a")).status).toBe(401);
    expect((await app(token).request("/a", { headers: { "x-admin-token": "nope" } })).status).toBe(401);
    expect((await app(token).request("/a", { headers: { "x-admin-token": token } })).status).toBe(200);
  });
});
