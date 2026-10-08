import { describe, expect, it } from "vitest";
import { ETH, USDC } from "./quotes";
import { findPair, mergePairCatalog, pairUnavailableReason } from "./pairs";

describe("pair eligibility", () => {
  it("never lets discovery grant launch rights to an unregistered address", () => {
    const discovery = { ...USDC, launchable: true, registered: true };
    expect(mergePairCatalog([ETH], [discovery]).find(quote => quote.address === USDC.address)?.launchable).toBe(false);
    expect(mergePairCatalog([{ ...USDC, enabled: false }], [discovery])[0]?.enabled).toBe(false);
  });
  it("keeps disabled canonical entries visible with their actual reason", () => {
    const entry = { ...USDC, launchable: false, unavailableReason: "No supply" };
    const merged = mergePairCatalog([ETH], [entry]);
    expect(merged).toHaveLength(2);
    expect(pairUnavailableReason(merged[0]!)).toBe("No supply");
  });
  it("requires verified issuer inventory for mainnet stocks without changing test-stock compatibility", () => {
    const stock = { ...USDC, kind: "stock" as const, symbol: "AAPL", launchable: true };
    const required = { requireStockIssuer: true, stockIssuerVerified: true };
    expect(mergePairCatalog([stock], [], required)[0]?.launchable).toBe(false);
    expect(mergePairCatalog([stock], [stock], { ...required, stockIssuerVerified: false })[0]?.launchable).toBe(false);
    expect(mergePairCatalog([stock], [{ ...stock, launchable: false, unavailableReason: "Issuer paused" }], required)[0]?.unavailableReason).toBe("Issuer paused");
    expect(mergePairCatalog([stock], [stock], required)[0]?.launchable).toBe(true);
    expect(mergePairCatalog([stock], [])[0]?.launchable).toBe(true);
  });
  it("checks age and rejects future timestamps, while fixed or preview prices stay usable", () => {
    expect(pairUnavailableReason({ ...USDC, priceUpdatedAt: 1000, priceMaxAgeSec: 60 }, undefined, 62000)).toMatch(/fresh/);
    expect(pairUnavailableReason({ ...USDC, priceUpdatedAt: 63000, priceMaxAgeSec: 60 }, undefined, 62000)).toMatch(/fresh/);
    expect(pairUnavailableReason({ ...USDC, priceUpdatedAt: 2000, priceMaxAgeSec: 60 }, undefined, 62000)).toBeUndefined();
    expect(pairUnavailableReason(ETH)).toBeUndefined();
  });
  it("resolves addresses regardless of case and rejects ambiguous symbols", () => {
    const same = { ...ETH, symbol: USDC.symbol };
    expect(findPair([USDC, same], "USDC")).toBeUndefined();
    expect(findPair([USDC, same], USDC.address.toUpperCase())).toBe(USDC);
  });
});

describe("pair catalog identity", () => {
  it("retains issuer labels and logos while registry controls prices and eligibility", () => {
    const registry = { ...USDC, kind: "stock" as const, name: "Old label", symbol: "OLD", iconUrl: undefined, usdPrice: 12, launchable: true };
    const issuer = { ...registry, name: "Apple Inc.", symbol: "AAPLc", source: "coinbase" as const, iconUrl: "https://metadata.coinbase.com/equity_icons/AAPL.png", usdPrice: 99 };
    expect(mergePairCatalog([registry], [issuer])[0]).toMatchObject({ name: issuer.name, symbol: issuer.symbol, iconUrl: issuer.iconUrl, source: "coinbase", usdPrice: 12 });
    expect(mergePairCatalog([{ ...registry, iconUrl: "  " }], [issuer])[0]?.iconUrl).toBe(issuer.iconUrl);
  });
  it("does not apply stock identity or logos to a differently categorized registry asset", () => {
    const issuer = { ...USDC, kind: "stock" as const, source: "coinbase" as const, symbol: "FAKEc", iconUrl: "https://example.com/stock.png" };
    const merged = mergePairCatalog([USDC], [issuer])[0]!;
    expect(merged.symbol).toBe(USDC.symbol); expect(merged.iconUrl).toBe(USDC.iconUrl);
  });
});
