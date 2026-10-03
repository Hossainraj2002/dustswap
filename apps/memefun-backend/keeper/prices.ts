import type { ChainSettings } from "../lib/chain";
import { optionalEnv } from "../lib/env";

/**
 * Where tokenized-stock NAVs come from, as USD with 8 decimals. The keeper only ever moves the
 * on-chain MANUAL price toward this value, at most 20% per update (the contract enforces it).
 *
 *   local : a deterministic drift around the current on-chain price, so the job runs end to end
 *   http  : STOCK_PRICE_URL with `{symbol}` / `{address}` placeholders, reading the USD value (a
 *           decimal number or string) at the dot path STOCK_PRICE_JSON_PATH (e.g. "data.nav").
 *           Phase 4 points this at the issuer's published NAV (Coinbase) once confirmed.
 */
export interface PriceSource {
  readonly kind: string;
  /** Target USD price (8 decimals), or null when no price is available right now. */
  usdE8(quote: { address: string; symbol: string; currentUsdE8: bigint; nowSec: number }): Promise<bigint | null>;
}

export function devPriceSource(): PriceSource {
  return {
    kind: "dev",
    async usdE8({ currentUsdE8, nowSec }) {
      // About +/-1% over a few hours of chain time: enough to exercise thresholds, never the cap.
      const drift = Math.round(Math.sin(nowSec / 7_200) * 100);
      return (currentUsdE8 * BigInt(10_000 + drift)) / 10_000n;
    },
  };
}

export function readJsonPath(doc: unknown, path: string): unknown {
  let value = doc;
  for (const part of path.split(".").filter(Boolean)) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** "241.104" with 8 decimals -> 24110400000n, exactly (no floating point). */
export function decimalToE8(text: string): bigint | null {
  const match = /^(\d{1,12})(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(8, "0").slice(0, 8);
  const value = BigInt(match[1]!) * 100_000_000n + BigInt(fraction || "0");
  return value > 0n ? value : null;
}

export function httpPriceSource(config: { url: string; path: string }, fetchFn: typeof fetch = fetch): PriceSource {
  return {
    kind: "http",
    async usdE8({ address, symbol }) {
      const url = config.url.replaceAll("{symbol}", encodeURIComponent(symbol)).replaceAll("{address}", address);
      const response = await fetchFn(url, { signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" } });
      if (!response.ok) return null;
      const raw = readJsonPath(await response.json(), config.path);
      if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? decimalToE8(raw.toFixed(8)) : null;
      return typeof raw === "string" ? decimalToE8(raw) : null;
    },
  };
}

export function createPriceSource(chainKey: ChainSettings["key"]): PriceSource {
  const url = optionalEnv("STOCK_PRICE_URL");
  if (url) return httpPriceSource({ url, path: optionalEnv("STOCK_PRICE_JSON_PATH") ?? "price" });
  if (chainKey === "local") return devPriceSource();
  return { kind: "none", usdE8: async () => null };
}
