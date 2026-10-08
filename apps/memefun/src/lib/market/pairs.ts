import type { QuoteAsset, QuoteKind } from "@/core/types";

export type PairCatalogSort = "trending" | "newest" | "oldest";

/** Token addresses identify both pools and balances; a ticker is only a label. */
export const pairId = (quote: Pick<QuoteAsset, "address">): string => quote.address.toLowerCase();

/** Legacy drafts resolve a symbol only if exactly one current asset uses it. */
export function findPair(quotes: QuoteAsset[], id: string): QuoteAsset | undefined {
  if (/^0x[0-9a-f]{40}$/i.test(id)) return quotes.find(quote => pairId(quote) === id.toLowerCase());
  const matches = quotes.filter(quote => quote.symbol.toLowerCase() === id.toLowerCase());
  return matches.length === 1 ? matches[0] : undefined;
}

export function pairUnavailableReason(quote: QuoteAsset, enabledKinds?: QuoteKind[], now = Date.now()): string | undefined {
  if (quote.launchable === false || quote.registered === false || quote.enabled === false) {
    return quote.unavailableReason || (quote.registered === false ? "Not available for launch yet" : "Pair temporarily unavailable");
  }
  if (enabledKinds && !enabledKinds.includes(quote.kind)) return "New launches on this pair are disabled";
  if (!Number.isFinite(quote.usdPrice) || quote.usdPrice <= 0) return "A verified price is not available";
  if (quote.priceMaxAgeSec !== undefined && quote.priceMaxAgeSec > 0) {
    if (!quote.priceUpdatedAt || quote.priceUpdatedAt > now || now - quote.priceUpdatedAt > quote.priceMaxAgeSec * 1000) {
      return "Waiting for a fresh verified price";
    }
  }
  return undefined;
}

/** Catalog data may enrich labels, but never grant eligibility absent from the registry. */
export function mergePairCatalog(registry: QuoteAsset[], catalog: QuoteAsset[], options: { requireStockIssuer?: boolean; stockIssuerVerified?: boolean } = {}): QuoteAsset[] {
  const byAddress = new Map(catalog.map(quote => [pairId(quote), { ...quote, launchable: false } as QuoteAsset]));
  for (const quote of registry) {
    const entry = catalog.find(item => pairId(item) === pairId(quote));
    const missingIssuer = quote.kind === "stock" && options.requireStockIssuer && (!options.stockIssuerVerified || !entry || entry.launchable !== true);
    const issuerIdentity = quote.kind === "stock" && entry?.kind === "stock" && entry.source === "coinbase"
      ? { name: entry.name, symbol: entry.symbol, isin: entry.isin, source: entry.source } : {};
    byAddress.set(pairId(quote), { ...entry, ...quote, ...issuerIdentity,
      iconUrl: entry?.kind === quote.kind ? entry.iconUrl?.trim() || quote.iconUrl : quote.iconUrl,
      ...(entry?.launchable === false || missingIssuer ? { launchable: false, unavailableReason: entry?.unavailableReason || "Stock issuer availability could not be verified" } : {}) });
  }
  return [...byAddress.values()];
}
