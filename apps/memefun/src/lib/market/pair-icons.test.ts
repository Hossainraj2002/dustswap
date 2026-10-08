import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ETH, USDC } from "./quotes";
import { pairIconSources } from "./pair-icons";
import stockLogos from "./stock-logos.json";
import tokenLogos from "./token-logos.json";

describe("address-specific authentic pair logos", () => {
  it("uses the official native and Base USDC assets without relying on tickers", () => {
    expect(pairIconSources(ETH, 8453)).toEqual(["/pair-icons/eth.svg"]);
    expect(pairIconSources(USDC, 8453)).toEqual(["/pair-icons/usdc.svg"]);
    expect(pairIconSources({ ...USDC, address: "0x1111111111111111111111111111111111111111" }, 8453)).toEqual([]);
    expect(pairIconSources(USDC, 84532)).toEqual([]);
    expect(pairIconSources({ ...USDC, kind: "token" }, 8453)).toEqual([]);
  });
  it("uses bundled stock fallbacks only for verified issuer addresses on Base", () => {
    const address = "0xb200000000000000000000c2e324d24d7eecd1fb";
    const stock = { ...USDC, address: address as `0x${string}`, kind: "stock" as const, source: "coinbase" as const, iconUrl: "https://example.com/current.png" };
    expect(pairIconSources(stock, 8453)).toEqual([stock.iconUrl, stockLogos[address]]);
    expect(pairIconSources({ ...stock, source: "registry" }, 8453)).toEqual([stock.iconUrl]);
    expect(pairIconSources(stock, 84532)).toEqual([stock.iconUrl]);
    expect(pairIconSources({ ...stock, iconUrl: "javascript:alert(1)" }, 8453)).toEqual([stockLogos[address]]);
  });
  it("ships every inventoried stock image with address-matched source provenance", () => {
    const directory = fileURLToPath(new URL("../../../public", import.meta.url));
    const manifest = JSON.parse(readFileSync(directory + "/pair-icons/SOURCES.json", "utf8")) as { stocks: Array<{ address: string; file: string; source: string }> };
    expect(Object.keys(stockLogos).length).toBeGreaterThanOrEqual(92);
    expect(manifest.stocks).toHaveLength(Object.keys(stockLogos).length);
    expect(new Set(manifest.stocks.map(item => item.address)).size).toBe(manifest.stocks.length);
    for (const item of manifest.stocks) {
      expect((stockLogos as Record<string,string>)[item.address]).toBe(item.file);
      expect(existsSync(directory + item.file)).toBe(true);
      expect(new URL(item.source).protocol).toBe("https:");
    }
  });
  it("uses meme-token fallbacks only for matching Base addresses and token categories", () => {
    const address = Object.keys(tokenLogos)[0]! as `0x${string}`;
    const file = (tokenLogos as Record<string, string>)[address]!;
    const token = { ...USDC, address, kind: "token" as const, symbol: "USDC", iconUrl: "https://example.com/current.png" };
    expect(pairIconSources(token, 8453)).toEqual([token.iconUrl, file]);
    expect(pairIconSources(token, 84532)).toEqual([token.iconUrl]);
    expect(pairIconSources({ ...token, kind: "stock", source: "coinbase" }, 8453)).toEqual([token.iconUrl]);
    expect(pairIconSources({ ...token, address: "0x1111111111111111111111111111111111111111" }, 8453)).toEqual([token.iconUrl]);
    expect(pairIconSources({ ...token, iconUrl: "https://user:password@example.com/image.png" }, 8453)).toEqual([file]);
  });
  it("ships every bundled meme image with its address-matched source provenance", () => {
    const directory = fileURLToPath(new URL("../../../public", import.meta.url));
    const manifest = JSON.parse(readFileSync(directory + "/pair-icons/TOKEN-SOURCES.json", "utf8")) as { tokens: Array<{ address: string; file: string; source: string }> };
    expect(Object.keys(tokenLogos).length).toBeGreaterThan(0);
    expect(manifest.tokens).toHaveLength(Object.keys(tokenLogos).length);
    expect(new Set(manifest.tokens.map(item => item.address)).size).toBe(manifest.tokens.length);
    for (const item of manifest.tokens) {
      expect((tokenLogos as Record<string, string>)[item.address]).toBe(item.file);
      expect(existsSync(directory + item.file)).toBe(true);
      expect(new URL(item.source).protocol).toBe("https:");
    }
  });
});
