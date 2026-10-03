import { NATIVE_ETH } from "@/core/constants";
import type { QuoteAsset } from "@/core/types";

/**
 * Quote assets. ETH and USDC are real Base addresses. The stock list mirrors
 * the shape of Coinbase's tokenized-stocks API (address, symbol, decimals,
 * NAV, market session); in preview the addresses and NAVs are placeholders and
 * Phase 3 replaces them with the live registry.
 */
export const ETH: QuoteAsset = {
  address: NATIVE_ETH,
  symbol: "ETH",
  name: "Ether",
  decimals: 18,
  kind: "native",
  usdPrice: 3000,
};

export const USDC: QuoteAsset = {
  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  kind: "stable",
  usdPrice: 1,
};

const stock = (symbol: string, name: string, usdPrice: number, suffix: string, isin: string): QuoteAsset => ({
  address: `0xb200000000000000000000000000000000${suffix}` as `0x${string}`,
  symbol,
  name,
  decimals: 18,
  kind: "stock",
  usdPrice,
  marketOpen: true,
  isin,
});

export const PREVIEW_STOCKS: QuoteAsset[] = [
  stock("NVDAc", "NVIDIA tokenized stock", 182.4, "0001a1", "US67066G1040"),
  stock("AAPLc", "Apple tokenized stock", 241.1, "0002b2", "US0378331005"),
  stock("TSLAc", "Tesla tokenized stock", 455.9, "0003c3", "US88160R1014"),
  stock("MSFTc", "Microsoft tokenized stock", 512.6, "0004d4", "US5949181045"),
  stock("AMZNc", "Amazon tokenized stock", 228.3, "0005e5", "US0231351067"),
  stock("GOOGLc", "Alphabet tokenized stock", 247.8, "0006f6", "US02079K3059"),
  stock("METAc", "Meta tokenized stock", 731.2, "000707", "US30303M1027"),
  stock("COINc", "Coinbase tokenized stock", 352.4, "000818", "US19260Q1076"),
];

export const QUOTES: QuoteAsset[] = [ETH, USDC, ...PREVIEW_STOCKS];

export function quoteBySymbol(symbol: string): QuoteAsset | undefined {
  return QUOTES.find((quote) => quote.symbol.toLowerCase() === symbol.toLowerCase());
}

export function quoteByAddress(address: string): QuoteAsset | undefined {
  return QUOTES.find((quote) => quote.address.toLowerCase() === address.toLowerCase());
}
