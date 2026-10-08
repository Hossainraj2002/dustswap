import type { QuoteAsset } from "@/core/types";
import stockLogos from "./stock-logos.json";
import tokenLogos from "./token-logos.json";

const stocks: Record<string, string> = stockLogos;
const tokens: Record<string, string> = tokenLogos;
const safeIcon = (value?: string): string | undefined => {
  if (!value || value.length > 2048) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
};

/** Logos identify addresses on a chain. A familiar ticker grants no brand or issuer identity. */
export function pairIconSources(quote: QuoteAsset, chainId: number): string[] {
  const address = quote.address.toLowerCase();
  if (address === "0x0000000000000000000000000000000000000000" && quote.kind === "native") return ["/pair-icons/eth.svg"];
  if (quote.kind === "stable" && ((chainId === 8453 && address === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")
    || (chainId === 84532 && address === "0x036cbd53842c5426634e7929541ec2318f3dcf7e"))) return ["/pair-icons/usdc.svg"];
  const supplied = safeIcon(quote.iconUrl);
  let bundled: string | undefined;
  if (chainId === 8453) {
    if (quote.kind === "stock" && quote.source === "coinbase") bundled = stocks[address];
    else if (quote.kind === "token") bundled = tokens[address];
  }
  return [...new Set([supplied, bundled].filter((url): url is string => Boolean(url)))];
}
