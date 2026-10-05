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
