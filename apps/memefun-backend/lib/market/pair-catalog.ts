import { erc20Abi, getAddress, type Address, type PublicClient } from "viem";
import { z } from "zod";
import type { LaunchSettings } from "../../shared/core/settings";
import type { QuoteAsset } from "../../shared/core/types";
import type { QuoteRecord } from "./derive";
import { eligibleQuoteAsset, quoteEligibility } from "./readiness";

// Source: https://docs.base.org/build-on-base/integrate-defi/list-tokenized-stocks
// Coinbase feeds already include the multiplier; never apply it a second time.
export const STOCK_FEEDS: Record<string, Address> = {
  "0xb200000000000000000000c2e324d24d7eecd1fb": "0x787f13dEa48Db0897CbCDD985de77809D837F988",
  "0xb200000000000000000000d9192b6b456483c2e8": "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295",
  "0xb2000000000000000000002d0ba3164cc74f58b7": "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2",
  "0xb2000000000000000000008bc8786b856e61707c": "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D",
  "0xb200000000000000000000ab99cfa739e253872b": "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c",
  "0xb2000000000000000000004884b426556b92883d": "0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a",
  "0xb20000000000000000000078ee7ce2fe4908108c": "0x04689a41629776563E6822F76f2e57D148d28513",
  "0xb200000000000000000000397293cb8cda9a10c5": "0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA",
  "0xb2000000000000000000007b9fcbd005511acbd5": "0x6A634B235903C4ad6376892180d6fF8612e3Fa68",
  "0xb2000000000000000000001e800a7f5189430cd0": "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4",
};

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => getAddress(s.toLowerCase()));
const nonnegative = z.number().finite().nonnegative().max(1e18);
const label = z.string().trim().min(1).max(120).refine((s) =>
  [...s].every((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127));
const safeIcon = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
};
const time = (value: unknown, now: number): number | undefined => {
  const result = typeof value === "string" ? Date.parse(value) : value;
  return typeof result === "number" && Number.isFinite(result) && result > 0 && result <= now ? result : undefined;
};
const stockSchema = z.object({ contract_address: address, symbol: label, name: label, decimals: z.number().int().min(0).max(18),
  total_supply: nonnegative.optional(), nav_price: nonnegative.optional(), nav_price_updated_at: z.string().max(64).optional(),
  icon_url: z.string().max(2048).optional(), isin: z.string().max(32).optional(), paused_features: z.array(z.number().int()).max(32).optional() });
const stocksSchema = z.object({ tokens: z.array(stockSchema).max(200) });
const o1Schema = z.object({ data: z.array(z.object({ chain_id: z.literal(8453), token: z.object({ address, symbol: label,
  name: label, decimals: z.number().int().min(0).max(18), image_url: z.string().max(2048).optional() }),
  launch: z.object({ created_at: z.string().max(64) }), market_data: z.unknown().optional() })).max(100),
  pagination: z.object({ next_cursor: z.string().max(4096).nullable().optional() }).optional() });
type Stock = z.infer<typeof stockSchema>;
type O1Token = z.infer<typeof o1Schema>["data"][number];
export type CatalogSort = "trending" | "newest" | "oldest";
export interface PairCatalogEntry extends QuoteAsset {
  registered: boolean; ready: boolean; enabled: boolean; launchable: boolean; reason?: string; unavailableReason?: string;
  source: "coinbase" | "o1" | "registry"; feed?: Address; priceUpdatedAt?: number; priceMaxAgeSec?: number;
  marketCapUsd?: number; liquidityUsd?: number; volume24hUsd?: number; createdAt?: number; rank?: number;
  catalogGroup?: "trending" | "recent" | "established"; supply?: string;
  /** A discovery market reference is not a safe settlement oracle or an executable price. */
  marketReference?: { priceUsd: number; observedAt: number; liquidityUsd: number; volume24hUsd: number; transactions24h: number; qualifiesForReview: boolean };
}
export interface PairCatalog {
  chainId: number; asOf: number; fetchedAt: number; quotes: PairCatalogEntry[]; stocks: PairCatalogEntry[]; crypto: PairCatalogEntry[];
  sources: { coinbase: { status: "ok" | "unavailable" | "not_applicable"; count: number }; o1: {
    status: "ok" | "alpha_fallback" | "unavailable" | "not_applicable"; complete: boolean; keyConfigured: boolean; message?: string;
  } };
}

/** Bound bytes before parsing. URLs are constants, redirects are refused, credentials stay in headers. */
async function json(fetchFn: typeof fetch, url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(8_000), redirect: "error", headers: { accept: "application/json", ...headers } });
  if (!response.ok) throw new Error("Catalog source unavailable");
  if (Number(response.headers.get("content-length")) > 2_000_000) throw new Error("Catalog source exceeded bounds");
  if (!response.body) throw new Error("Catalog source returned no data");
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length;
      if (length > 2_000_000) throw new Error("Catalog source exceeded bounds"); parts.push(part.value); }
  } finally { await reader.cancel().catch(() => undefined); }
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const positive = (value: unknown): number | undefined => { const n = typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 1e18 ? n : undefined; };

export function marketReferences(raw: unknown, requested: Address[], now: number): Map<string, NonNullable<PairCatalogEntry["marketReference"]> & { name?: string; symbol?: string; iconUrl?: string; createdAt?: number }> {
  const rows = z.array(z.unknown()).max(1200).parse(raw); const allowed = new Set(requested.map((a) => a.toLowerCase()));
  const references = new Map<string, NonNullable<PairCatalogEntry["marketReference"]> & { name?: string; symbol?: string; iconUrl?: string; createdAt?: number }>();
  for (const rawPair of rows) {
    const pair = object(rawPair), base = object(pair.baseToken); const parsed = address.safeParse(base.address);
    if (pair.chainId !== "base" || !parsed.success || !allowed.has(parsed.data.toLowerCase())) continue;
    const priceUsd = positive(pair.priceUsd), liquidityUsd = positive(object(pair.liquidity).usd), volume24hUsd = positive(object(pair.volume).h24) ?? 0;
    if (!priceUsd || !liquidityUsd) continue;
    const activity = object(object(pair.txns).h24); const buys = activity.buys, sells = activity.sells;
    if (typeof buys !== "number" || typeof sells !== "number" || !Number.isSafeInteger(buys) || !Number.isSafeInteger(sells) || buys < 0 || sells < 0) continue;
    const key = parsed.data.toLowerCase(); if ((references.get(key)?.liquidityUsd ?? 0) >= liquidityUsd) continue;
    const name = label.safeParse(base.name), symbol = label.safeParse(base.symbol);
    references.set(key, { priceUsd, liquidityUsd, volume24hUsd, transactions24h: buys + sells, observedAt: now,
      qualifiesForReview: liquidityUsd >= 100_000 && volume24hUsd >= 5_000 && buys + sells >= 20,
      name: name.success ? name.data : undefined, symbol: symbol.success ? symbol.data : undefined,
      iconUrl: safeIcon(object(pair.info).imageUrl), createdAt: time(pair.pairCreatedAt, now) });
  }
  return references;
}

function cached<T>(load: () => Promise<T>, clock: () => number, ttl: number) {
  let value: { at: number; data: T } | undefined; let pending: Promise<T> | undefined;
  return () => { if (value && clock() - value.at < ttl) return Promise.resolve(value.data);
    return pending ??= load().then((data) => { value = { at: clock(), data }; return data; }).finally(() => { pending = undefined; }); };
}

export function createPairCatalog(options: { chainId: number; client: PublicClient; registry: () => Promise<{ quotes: QuoteRecord[]; settings: LaunchSettings; nowSec: number }>;
  apiKey?: string; fetchFn?: typeof fetch; clock?: () => number; ttlMs?: number }) {
  const fetchFn = options.fetchFn ?? fetch, clock = options.clock ?? Date.now, ttl = options.ttlMs ?? 300_000;
  const references = async (addresses: Address[]) => {
    const map = new Map<string, ReturnType<typeof marketReferences> extends Map<string, infer V> ? V : never>();
    for (let offset = 0; offset < addresses.length; offset += 30) {
      const batch = addresses.slice(offset, offset + 30);
      try { const rows = marketReferences(await json(fetchFn, `https://api.dexscreener.com/tokens/v1/base/${batch.join(",")}`), batch, clock());
        for (const [key, value] of rows) map.set(key, value); } catch { /* No unverified or stale fallback prices. */ }
    }
    return map;
  };
  const stocks = cached(async () => {
    try { const parsed = stocksSchema.parse(await json(fetchFn, "https://api.coinbase.com/v1/tokenized-stocks"));
      const records = [...new Map(parsed.tokens.map((t) => [t.contract_address.toLowerCase(), t])).values()];
      return { records, references: await references(records.filter((t) => (t.total_supply ?? 0) > 0).map((t) => t.contract_address)), ok: true };
    } catch { return { records: [] as Stock[], references: new Map(), ok: false }; }
  }, clock, ttl);
  const o1 = (sort: CatalogSort) => cached(async () => {
    let records: O1Token[] = [], status: PairCatalog["sources"]["o1"]["status"] = "unavailable", complete = false;
    if (options.apiKey) {
      try { const result = o1Schema.parse(await json(fetchFn, `https://api.launch.o1.exchange/v1/tokens?chain_id=8453&market=all&sort=${sort}&limit=50`, { "x-api-key": options.apiKey }));
        records = result.data; status = "ok"; complete = !result.pagination?.next_cursor;
      } catch { /* Do not expose upstream bodies, request headers, or API keys. */ }
    }
    let candidates = records.map((r) => r.token.address);
    if (status !== "ok") {
      try { candidates = z.array(address).max(1000).parse(await json(fetchFn, "https://api.o1.exchange/api/v1/alpha-tokens?networkId=8453")).slice(0, 90);
        status = "alpha_fallback"; } catch { candidates = []; }
    }
    candidates = [...new Set(candidates)]; const prices = await references(candidates);
    const identities = new Map<string, { decimals: number; symbol: string; name: string; supply: string }>();
    for (let offset = 0; offset < candidates.length; offset += 15) {
      const batch = candidates.slice(offset, offset + 15);
      try {
        const results = await options.client.multicall({ allowFailure: true, contracts: batch.flatMap((token) => [
          { address: token, abi: erc20Abi, functionName: "decimals" as const }, { address: token, abi: erc20Abi, functionName: "symbol" as const },
          { address: token, abi: erc20Abi, functionName: "name" as const }, { address: token, abi: erc20Abi, functionName: "totalSupply" as const },
        ]) });
        for (let i = 0; i < batch.length; i++) {
          const fields = results.slice(i * 4, i * 4 + 4); if (fields.some((f) => f.status !== "success")) continue;
          const values = fields.map((f) => f.result); const decimals = z.number().int().min(0).max(18).safeParse(values[0]);
          const symbol = label.safeParse(values[1]), name = label.safeParse(values[2]);
          if (decimals.success && symbol.success && name.success && typeof values[3] === "bigint" && values[3] > 0n) {
            identities.set(batch[i]!.toLowerCase(), { decimals: decimals.data, symbol: symbol.data, name: name.data, supply: values[3].toString() });
          }
        }
      } catch { /* Incomplete chain metadata remains unavailable. */ }
    }
    // A response with omitted chain identities is not a complete launch inventory.
    if (identities.size < candidates.length) complete = false;
    return { records, candidates, prices, identities, status, complete };
  }, clock, ttl);
  const tokenLoaders = { trending: o1("trending"), newest: o1("newest"), oldest: o1("oldest") };
  return {
    async get(sort: CatalogSort = "trending"): Promise<PairCatalog> {
      const registry = await options.registry(); const registered = new Map(registry.quotes.map((q) => [q.address.toLowerCase(), q]));
      const native = registry.quotes.filter((q) => q.kind <= 1).map((q): PairCatalogEntry => {
        const value = eligibleQuoteAsset(q, registry.settings, registry.nowSec);
        return { ...value, registered: true, ready: value.launchable, enabled: q.enabled === true, reason: value.unavailableReason, source: "registry" };
      });
      const finish = (asset: PairCatalogEntry): PairCatalogEntry => {
        const q = registered.get(asset.address.toLowerCase());
        if (!q) return { ...asset, registered: false, ready: false, launchable: false, enabled: false,
          unavailableReason: asset.reason ?? "This pair has not been registered for launches.", reason: asset.reason ?? "This pair has not been registered for launches." };
        const value = eligibleQuoteAsset(q, registry.settings, registry.nowSec);
        // Issuer pauses, missing supply and unit conflicts override registry selection.
        const expectedKind = { native: 0, stable: 1, stock: 2, token: 3 }[asset.kind];
        const blocked = asset.reason ?? (q.decimals !== asset.decimals || q.kind !== expectedKind
          ? "The pair's token units or category could not be verified." : value.unavailableReason);
        return { ...asset, ...value, registered: true, enabled: q.enabled === true, ready: value.launchable && !blocked,
          launchable: value.launchable && !blocked, reason: blocked, unavailableReason: blocked };
      };
      if (options.chainId !== 8453) return { chainId: options.chainId, asOf: registry.nowSec * 1000, fetchedAt: clock(),
        stocks: [], crypto: [], quotes: [...native, ...registry.quotes.filter((q) => q.kind > 1).map((q) => finish({ ...eligibleQuoteAsset(q, registry.settings, registry.nowSec),
          registered: true, ready: false, enabled: q.enabled === true, source: "registry" }))],
        sources: { coinbase: { status: "not_applicable", count: 0 }, o1: { status: "not_applicable", complete: false, keyConfigured: false } } };
      const [stockResult, tokenResult] = await Promise.all([stocks(), tokenLoaders[sort]()]);
      const stockEntries = stockResult.records.map((stock): PairCatalogEntry => {
        const key = stock.contract_address.toLowerCase(), indexed = registered.get(key);
        // The current owner-configured registry can add legitimate feeds or fresh manual prices
        // beyond the issuer's documented feed inventory. Discovery alone never enables them.
        const configuredPrice = indexed && [1, 2].includes(indexed.source ?? -1)
          && quoteEligibility(indexed, registry.settings, registry.nowSec).launchable;
        const configuredFeed = indexed?.source === 1 ? address.safeParse(indexed.feed) : undefined;
        const feed = configuredFeed?.success ? configuredFeed.data : STOCK_FEEDS[key], reference = stockResult.references.get(key);
        const reason = stock.paused_features?.length ? "This stock has paused token features." : !(stock.total_supply && stock.total_supply > 0)
          ? "The issuer has not reported circulating supply for this stock." : !feed && !configuredPrice
            ? "A verified launch oracle is not configured for this stock." : undefined;
        return finish({ address: stock.contract_address, symbol: stock.symbol, name: stock.name, decimals: stock.decimals, kind: "stock",
          usdPrice: stock.nav_price ?? reference?.priceUsd ?? 0, feed, priceUpdatedAt: time(stock.nav_price_updated_at, clock()), iconUrl: safeIcon(stock.icon_url),
          isin: stock.isin, supply: stock.total_supply?.toString(), marketReference: reference, source: "coinbase", reason,
          ready: false, launchable: false, enabled: false, registered: false });
      });
      const stockAddresses = new Set(stockEntries.map((q) => q.address.toLowerCase()));
      const tokenEntries = tokenResult.candidates.flatMap((token, index): PairCatalogEntry[] => {
        const key = token.toLowerCase(), identity = tokenResult.identities.get(key), configured = registered.get(key);
        // Provider discovery cannot recategorize an owner-registered native/stable/stock asset.
        if (!identity || stockAddresses.has(key) || (configured && configured.kind !== 3)) return [];
        const summary = tokenResult.records.find((r) => r.token.address.toLowerCase() === key), data = object(summary?.market_data);
        const reference = tokenResult.prices.get(key); const price = positive(object(data.price).usd) ?? reference?.priceUsd ?? 0;
        return [finish({ address: token, symbol: identity.symbol, name: identity.name, decimals: identity.decimals, supply: identity.supply,
          kind: "token", usdPrice: price, iconUrl: safeIcon(summary?.token.image_url) ?? reference?.iconUrl,
          // A pool's first trade is not proof of the token's launch date.
          createdAt: time(summary?.launch.created_at, clock()), priceUpdatedAt: time(data.updated_at, clock()),
          rank: index + 1, catalogGroup: sort === "newest" ? "recent" : sort === "oldest" ? "established" : "trending",
          marketCapUsd: positive(object(data.market_cap).usd), liquidityUsd: positive(object(data.liquidity).usd) ?? reference?.liquidityUsd,
          volume24hUsd: reference?.volume24hUsd,
          marketReference: reference, ready: false, launchable: false, enabled: false, registered: false, source: "o1" })];
      });
      // Registered assets stay visible even when a provider omits them or is unavailable.
      const known = new Set([...stockEntries, ...tokenEntries, ...native].map((q) => q.address.toLowerCase()));
      const other = registry.quotes.filter((q) => !known.has(q.address.toLowerCase())).map((q) => finish({ ...eligibleQuoteAsset(q, registry.settings, registry.nowSec),
        registered: true, ready: false, enabled: q.enabled === true, source: "registry" as const,
        ...(q.kind === 2 ? { reason: stockResult.ok
          ? "This stock is not in the issuer's current verified inventory."
          : "Stock issuer availability could not be verified. Try again later." } : {}) }));
      const allStocks = [...stockEntries, ...other.filter((q) => q.kind === "stock")], crypto = [...tokenEntries, ...other.filter((q) => q.kind === "token")];
      return { chainId: options.chainId, asOf: registry.nowSec * 1000, fetchedAt: clock(), quotes: [...native, ...allStocks, ...crypto], stocks: allStocks, crypto,
        sources: { coinbase: { status: stockResult.ok ? "ok" : "unavailable", count: stockEntries.length }, o1: { status: tokenResult.status,
          complete: tokenResult.complete, keyConfigured: Boolean(options.apiKey), message: tokenResult.status === "alpha_fallback"
            ? "Showing the limited o1 Alpha list. An o1 tokens:read API key is required for recent and older launch browsing." : undefined } } };
    },
  };
}
export type PairCatalogReader = ReturnType<typeof createPairCatalog>;
