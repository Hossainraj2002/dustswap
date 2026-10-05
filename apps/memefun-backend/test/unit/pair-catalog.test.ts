import { describe, expect, it, vi } from "vitest";
import { AbiDecodingZeroDataError, BaseError, ContractFunctionRevertedError, getAddress, type PublicClient } from "viem";
import { Hono } from "hono";
import { createPairCatalog, marketReferences, STOCK_FEEDS } from "../../lib/market/pair-catalog";
import { eligibleQuoteAsset, quoteEligibility, readableFeedRound } from "../../lib/market/readiness";
import type { QuoteRecord } from "../../lib/market/derive";
import type { LaunchSettings } from "../../shared/core/settings";
import { readRoutes, type ReadDeps } from "../../api/read/routes";
import { HttpError, errorBody } from "../../api/http";
import { createSettingsReader } from "../../api/read/settings";

const NOW = 1_790_000_000_000;
const APPLE = getAddress("0xb200000000000000000000c2e324d24d7eecd1fb");
const TOKEN = getAddress("0x1111111111111111111111111111111111111111");
const settings = { enabledQuoteKinds: ["native", "stable", "stock", "token"], launchesPaused: false } as LaunchSettings;
const apple: QuoteRecord = { address: APPLE, symbol: "AAPLc", name: "Apple", kind: 2, decimals: 8,
  priceUsdE8: 25_000_000_000n, source: 1, feed: STOCK_FEEDS[APPLE.toLowerCase()], enabled: true, maxAge: 86_400, priceUpdatedAt: NOW / 1000 - 60 };
const issuerStock = { contract_address: APPLE, name: "Apple", symbol: "AAPLc", decimals: 8, total_supply: 100, nav_price: 250,
  nav_price_updated_at: new Date(NOW - 60_000).toISOString(), multiplier: 1.2 };
const pair = (token = TOKEN) => ({ chainId: "base", baseToken: { address: token, name: "Meme", symbol: "MEME" },
  priceUsd: "0.0123", liquidity: { usd: 150_000 }, volume: { h24: 15_000 }, txns: { h24: { buys: 20, sells: 20 } }, pairCreatedAt: NOW - 86_400_000 });
const client = { multicall: vi.fn(async () => [18, "MEME", "Meme", 10n ** 25n].map((result) => ({ status: "success", result }))) } as unknown as PublicClient;
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

describe("quote readiness", () => {
  it("requires enabled registry/kind and bounded positive price freshness", () => {
    expect(quoteEligibility(apple, settings, NOW / 1000).launchable).toBe(true);
    for (const patch of [{ enabled: false }, { source: 2, maxAge: 0 }, { source: 9 }, { priceUsdE8: 0n },
      { priceUpdatedAt: NOW / 1000 + 1 }, { priceUpdatedAt: NOW / 1000 - 86_401 }, { kind: 8 }]) {
      expect(quoteEligibility({ ...apple, ...patch }, settings, NOW / 1000).launchable).toBe(false);
    }
    expect(quoteEligibility(apple, { ...settings, enabledQuoteKinds: ["native"] }, NOW / 1000).launchable).toBe(false);
    expect(quoteEligibility(apple, { ...settings, launchesPaused: true }, NOW / 1000).launchable).toBe(false);
    expect(eligibleQuoteAsset(apple, settings, NOW / 1000).priceUpdatedAt).toBe(NOW - 60_000);
  });
  it("does not renew a frozen feed or accept invalid rounds", () => {
    expect(readableFeedRound([5n, 250n, 100n, 100n, 5n], 150)).toEqual({ priceUsdE8: 250n, updatedAt: 100 });
    for (const round of [[5n, 0n, 100n, 100n, 5n], [5n, 250n, 100n, 0n, 5n], [5n, 250n, 100n, 151n, 5n], [5n, 250n, 100n, 100n, 4n]] as const) {
      expect(readableFeedRound(round, 150)).toBeNull();
    }
  });
});

describe("legacy quote-kind settings", () => {
  const legacyError = () => new BaseError("Legacy getter revert", { cause: new ContractFunctionRevertedError({ abi: [], functionName: "kindEnabled", data: "0x" }) });
  const settingsClient = (unsupportedKind: number, error = legacyError()) => ({
    readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: number[] }) => {
      if (functionName === "kindEnabled") {
        if (args?.[0] === unsupportedKind) throw error;
        return true;
      }
      if (functionName === "modeInfo") return { enabled: true, module: TOKEN };
      if (functionName === "openingFdvUsdE8") return 500_000_000_000n;
      return { creationFee: 0n, feeMinBps: 100, feeMaxBps: 1000, defaultFeeBps: 100, platformShareBps: 2000,
        referralShareBps: 0, creatorKeepMaxBps: 10000, protectionStartBps: 1000, protectionDurationSec: 60, launchesPaused: false };
    }),
  }) as unknown as PublicClient;
  it("disables an unsupported appended kind without breaking prior kinds", async () => {
    const result = await createSettingsReader(settingsClient(3), TOKEN).get();
    expect(result.enabledQuoteKinds).toEqual(["native", "stable", "stock"]);
    const abiResult = await createSettingsReader(settingsClient(3, new AbiDecodingZeroDataError()), TOKEN).get();
    expect(abiResult.enabledQuoteKinds).toEqual(["native", "stable", "stock"]);
  });
  it("continues to reject failures in prior registry reads", async () => {
    await expect(createSettingsReader(settingsClient(0), TOKEN).get()).rejects.toThrow("Legacy getter revert");
  });
  it("does not interpret a transport failure as a legacy enum", async () => {
    await expect(createSettingsReader(settingsClient(3, new BaseError("RPC unavailable")), TOKEN).get()).rejects.toThrow("RPC unavailable");
  });
});

describe("market discovery validation", () => {
  it("uses only the requested Base token, finite prices and deepest observed pool", () => {
    const rows = [pair(), { ...pair(), chainId: "ethereum" }, { ...pair(), priceUsd: "Infinity" },
      { ...pair(), baseToken: { ...pair().baseToken, address: APPLE } }, { ...pair(), liquidity: { usd: 500 } }];
    const result = marketReferences(rows, [TOKEN], NOW);
    expect(result.size).toBe(1);
    expect(result.get(TOKEN.toLowerCase())).toMatchObject({ priceUsd: 0.0123, observedAt: NOW, liquidityUsd: 150_000, qualifiesForReview: true });
    expect(marketReferences([{ ...pair(), txns: { h24: { buys: -1, sells: 1 } } }], [TOKEN], NOW).size).toBe(0);
  });
  it("bounds provider arrays before accepting a response", () => {
    expect(() => marketReferences(Array.from({ length: 1201 }, () => pair()), [TOKEN], NOW)).toThrow();
  });
});

describe("pair catalog", () => {
  function fixture({ apiKey, registered = [], stock = issuerStock, failure = false }: {
    apiKey?: string; registered?: QuoteRecord[]; stock?: typeof issuerStock & { paused_features?: number[] }; failure?: boolean;
  } = {}) {
    const requests: Array<{ url: string; key?: string }> = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); requests.push({ url, key: new Headers(init?.headers).get("x-api-key") ?? undefined });
      if (failure) return response({}, 503);
      if (url.includes("coinbase.com")) return response({ tokens: [stock] });
      if (url.includes("api.launch.o1")) return response({ data: [{ chain_id: 8453, token: { address: TOKEN, name: "Meme", symbol: "MEME", decimals: 18 },
        launch: { created_at: new Date(NOW - 100_000).toISOString() }, market_data: { price: { usd: 0.02 }, updated_at: new Date(NOW - 1000).toISOString() } }], pagination: { next_cursor: null } });
      if (url.includes("alpha-tokens")) return response([TOKEN]);
      return response([pair(), pair(APPLE)]);
    }) as typeof fetch;
    const catalog = createPairCatalog({ chainId: 8453, client, fetchFn, apiKey, clock: () => NOW,
      registry: async () => ({ quotes: registered, settings, nowSec: NOW / 1000 }) });
    return { catalog, requests, fetchFn };
  }
  it("retains full issuer inventory and never makes discovery entries launchable", async () => {
    const { catalog } = fixture(); const result = await catalog.get();
    expect(result.sources.o1).toMatchObject({ status: "alpha_fallback", complete: false, keyConfigured: false });
    expect(result.stocks[0]).toMatchObject({ address: APPLE, decimals: 8, usdPrice: 250, launchable: false, registered: false });
    expect(result.crypto[0]).toMatchObject({ address: TOKEN, decimals: 18, usdPrice: 0.0123, launchable: false, kind: "token" });
    // The issuer's already-adjusted NAV must not be multiplied by the metadata multiplier.
    expect(result.stocks[0]!.usdPrice).toBe(250);
  });
  it("coalesces concurrent provider requests and caches by bounded sort", async () => {
    const { catalog, fetchFn } = fixture();
    await Promise.all([catalog.get(), catalog.get()]); const count = vi.mocked(fetchFn).mock.calls.length;
    await catalog.get(); expect(vi.mocked(fetchFn).mock.calls.length).toBe(count);
  });
  it("uses the scoped key only at the fixed o1 origin and respects canonical launch age", async () => {
    const { catalog, requests } = fixture({ apiKey: "test-key-never-log" });
    const result = await catalog.get("oldest");
    expect(result.sources.o1.status).toBe("ok");
    expect(result.crypto[0]).toMatchObject({ createdAt: NOW - 100_000, usdPrice: 0.02, catalogGroup: "established" });
    expect(requests.filter((r) => r.key).map((r) => new URL(r.url).host)).toEqual(["api.launch.o1.exchange"]);
    expect(JSON.stringify(result)).not.toContain("test-key-never-log");
  });
  it("allows only a fresh enabled registered stock with verified units and retains disabled rows", async () => {
    expect((await fixture({ registered: [apple] }).catalog.get()).stocks[0]!.launchable).toBe(true);
    expect((await fixture({ registered: [{ ...apple, enabled: false }] }).catalog.get()).stocks[0]!.launchable).toBe(false);
    expect((await fixture({ registered: [{ ...apple, priceUpdatedAt: 1 }] }).catalog.get()).stocks[0]!.launchable).toBe(false);
    expect((await fixture({ registered: [{ ...apple, decimals: 18 }] }).catalog.get()).stocks[0]!.launchable).toBe(false);
    expect((await fixture({ registered: [apple], stock: { ...issuerStock, total_supply: 0 } }).catalog.get()).stocks[0]!.launchable).toBe(false);
    expect((await fixture({ registered: [apple], stock: { ...issuerStock, paused_features: [1] } }).catalog.get()).stocks[0]!.launchable).toBe(false);
    expect((await fixture({ registered: [{ ...apple, kind: 1 }] }).catalog.get()).stocks[0]!.launchable).toBe(false);
  });
  it("accepts a fresh owner-registered stock price beyond the published feed list, without enabling discovery", async () => {
    const stock = { ...issuerStock, contract_address: TOKEN, name: "Micron", symbol: "MUc" };
    const manual: QuoteRecord = { ...apple, address: TOKEN, symbol: "MUc", name: "Micron", source: 2, feed: null };
    expect((await fixture({ stock }).catalog.get()).stocks[0]!.launchable).toBe(false);
    expect((await fixture({ stock, registered: [manual] }).catalog.get()).stocks[0]).toMatchObject({ launchable: true, usdPrice: 250 });
    expect((await fixture({ stock, registered: [{ ...manual, priceUpdatedAt: 1 }] }).catalog.get()).stocks[0]!.launchable).toBe(false);
    expect((await fixture({ stock, registered: [{ ...manual, source: 0 }] }).catalog.get()).stocks[0]!.launchable).toBe(false);
    expect((await fixture({ stock, registered: [{ ...manual, source: 1, feed: APPLE }] }).catalog.get()).stocks[0]).toMatchObject({ launchable: true, feed: APPLE });
    expect((await fixture({ stock: { ...stock, total_supply: 0 }, registered: [manual] }).catalog.get()).stocks[0]!.launchable).toBe(false);
    expect((await fixture({ stock: { ...stock, paused_features: [1] }, registered: [manual] }).catalog.get()).stocks[0]!.launchable).toBe(false);
  });
  it("degrades to registry without inventing stale provider data", async () => {
    const result = await fixture({ registered: [apple], failure: true }).catalog.get();
    expect(result.sources.coinbase.status).toBe("unavailable");
    expect(result.sources.o1.status).toBe("unavailable");
    expect(result.stocks[0]).toMatchObject({ source: "registry", address: APPLE, usdPrice: 250, launchable: false,
      unavailableReason: "Stock issuer availability could not be verified. Try again later." });
  });
  it("does not recategorize a registered stock when issuer availability fails and o1 returns it", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("coinbase.com")) return response({}, 503);
      if (url.includes("alpha-tokens")) return response([APPLE]);
      return response([]);
    }) as typeof fetch;
    const result = await createPairCatalog({ chainId: 8453, client, fetchFn, clock: () => NOW,
      registry: async () => ({ quotes: [apple], settings, nowSec: NOW / 1000 }) }).get();
    expect(result.crypto).toEqual([]);
    expect(result.stocks).toHaveLength(1);
    expect(result.stocks[0]).toMatchObject({ address: APPLE, kind: "stock", launchable: false,
      unavailableReason: "Stock issuer availability could not be verified. Try again later." });
  });
  it("does not retain issuer eligibility after its TTL expires and a fresh fetch fails", async () => {
    let now = NOW, issuerAvailable = true;
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("coinbase.com")) return issuerAvailable ? response({ tokens: [issuerStock] }) : response({}, 503);
      return response([]);
    }) as typeof fetch;
    const catalog = createPairCatalog({ chainId: 8453, client, fetchFn, clock: () => now, ttlMs: 10_000,
      registry: async () => ({ quotes: [apple], settings, nowSec: now / 1000 }) });
    expect((await catalog.get()).stocks[0]!.launchable).toBe(true);
    now += 10_001; issuerAvailable = false;
    expect((await catalog.get()).stocks[0]).toMatchObject({ launchable: false, priceUpdatedAt: NOW - 60_000 });
  });
  it("does not import mainnet candidates onto Sepolia", async () => {
    const fetchFn = vi.fn();
    const result = await createPairCatalog({ chainId: 84532, client, fetchFn, clock: () => NOW,
      registry: async () => ({ quotes: [], settings, nowSec: NOW / 1000 }) }).get();
    expect(fetchFn).not.toHaveBeenCalled(); expect(result.quotes).toEqual([]); expect(result.sources.o1.status).toBe("not_applicable");
  });
  it("rejects oversized HTTP bodies without returning upstream payloads", async () => {
    const fetchFn = vi.fn(async () => new Response("", { headers: { "content-length": "2000001" } })) as typeof fetch;
    const result = await createPairCatalog({ chainId: 8453, client, fetchFn, clock: () => NOW,
      registry: async () => ({ quotes: [], settings, nowSec: NOW / 1000 }) }).get();
    expect(result.quotes).toEqual([]); expect(result.sources.coinbase.status).toBe("unavailable");
  });
});

describe("pair catalog HTTP boundary", () => {
  it("rejects unsupported sorts and oversized searches before querying providers", async () => {
    const get = vi.fn(); const app = new Hono();
    app.onError((error, c) => error instanceof HttpError ? c.json(errorBody(error), error.status) : c.text("error", 500));
    app.route("/", readRoutes({ pairCatalog: { get } } as unknown as ReadDeps));
    expect((await app.request("/v1/pair-catalog?sort=random")).status).toBe(400);
    expect((await app.request(`/v1/pair-catalog?q=${"a".repeat(81)}`)).status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });
});
