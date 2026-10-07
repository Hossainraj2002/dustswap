import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/core/settings";
import { ETH, USDC } from "@/lib/market/quotes";
import type { QuoteAsset } from "@/core/types";
import { EMPTY_DRAFT, migrateDraft, previewFirstBuy, reconcileDraftQuotes, reconcileDraftSettings, selectedQuoteIds, validateFirstBuyStep, validatePairs } from "./draft";
import { mergePairCatalog } from "@/lib/market/pairs";

describe("saved launch drafts", () => {
  it("migrates a legacy USDC draft without changing its first buy", () => {
    const draft = reconcileDraftQuotes(migrateDraft({ quoteSymbol: "USDC", firstBuy: "12.345678" }), [ETH, USDC]);
    expect(draft.launchMode).toBe("single");
    expect(selectedQuoteIds(draft)).toEqual([USDC.address.toLowerCase()]);
    expect(draft.firstBuyQuoteId).toBe(USDC.address.toLowerCase());
    expect(draft.firstBuy).toBe("12.345678");
  });
  it("removes duplicate saved pools and moves a removed first buy to the primary", () => {
    const draft = reconcileDraftQuotes(migrateDraft({ launchMode: "multi", quoteSymbols: ["USDC", "ETH", "USDC"], firstBuyQuoteSymbol: "REMOVED" }), [ETH, USDC]);
    expect(draft.quoteIds).toEqual([USDC.address.toLowerCase(), ETH.address]);
    expect(draft.quoteId).toBe(USDC.address.toLowerCase());
    expect(draft.firstBuyQuoteId).toBe(USDC.address.toLowerCase());
  });
  it("reconciles the stored value used by labels, slider and transaction with new limits", () => {
    const draft = reconcileDraftSettings({ ...EMPTY_DRAFT, feeBps: 900, creatorKeepBps: 5000 }, { ...DEFAULT_SETTINGS, feeMaxBps: 300, creatorKeepMaxBps: 2000 });
    expect(draft.feeBps).toBe(300);
    expect(draft.creatorKeepBps).toBe(2000);
  });
});

describe("listed pair validation", () => {
  it("accepts listed distinct quotes, rejecting duplicate addresses and unavailable assets", () => {
    const draft = { ...EMPTY_DRAFT, launchMode: "multi" as const, quoteIds: [ETH.address, USDC.address] };
    expect(validatePairs(draft, [ETH, USDC], DEFAULT_SETTINGS, false)).toEqual({});
    expect(validatePairs(draft, [ETH, { ...USDC, address: ETH.address }], DEFAULT_SETTINGS, false).quoteId).toBeTruthy();
    expect(validatePairs(draft, [ETH], DEFAULT_SETTINGS, false).quoteId).toBeTruthy();
    expect(validatePairs(draft, [ETH, USDC], { ...DEFAULT_SETTINGS, enabledQuoteKinds: ["native"] }, false).quoteId).toBeTruthy();
  });
  const tokens: QuoteAsset[] = [1, 2].map(i => ({ address: `0x${i.toString().padStart(40, "0")}` as const, symbol: "SAME", name: `Token ${i}`, kind: "token", decimals: 18, usdPrice: 1 }));
  it("keeps two same-ticker tokens and their first buys separate by address", () => {
    const saved = migrateDraft({ launchMode: "multi", quoteIds: tokens.map(token => token.address), firstBuyQuoteId: tokens[1]!.address, firstBuy: "123" });
    const draft = reconcileDraftQuotes(saved, tokens);
    expect(validatePairs(draft, tokens, DEFAULT_SETTINGS, false)).toEqual({});
    expect(draft.quoteIds).toEqual(tokens.map(token => token.address));
    expect(draft.firstBuyQuoteId).toBe(tokens[1]!.address);
    expect(draft.firstBuy).toBe("123");
  });
  it("does not guess which same-ticker token a legacy draft meant", () => {
    const draft = reconcileDraftQuotes(migrateDraft({ quoteSymbol: "SAME", firstBuy: "500" }), [ETH, ...tokens]);
    expect(draft.quoteId).toBe(ETH.address);
    expect(draft.firstBuy).toBe("");
  });
  it("rejects disabled, unregistered and newly stale selections before review", () => {
    const draft = { ...EMPTY_DRAFT, quoteId: tokens[0]!.address };
    for (const blocked of [{ ...tokens[0]!, enabled: false }, { ...tokens[0]!, registered: false }, { ...tokens[0]!, priceUpdatedAt: Date.now() - 61_000, priceMaxAgeSec: 60 }]) {
      expect(validatePairs(draft, [blocked], DEFAULT_SETTINGS, false).quoteId).toBeTruthy();
    }
  });
  it("blocks a restored stock draft when its issuer is paused despite a valid registry price", () => {
    const stock = { ...tokens[0]!, kind: "stock" as const, symbol: "AAPL", launchable: true, registered: true, enabled: true };
    const draft = reconcileDraftQuotes(migrateDraft({ quoteSymbol: "AAPL", firstBuy: "0.1" }), [stock]);
    const assets = mergePairCatalog([stock], [{ ...stock, launchable: false, unavailableReason: "Issuer paused" }]);
    expect(draft.quoteId).toBe(stock.address);
    expect(validatePairs(draft, assets, DEFAULT_SETTINGS, false).quoteId).toBe("Issuer paused");
  });
  it("does not calculate a first-buy preview when a selected pair loses its verified price", () => {
    for (const usdPrice of [0, -1, NaN, Infinity]) expect(previewFirstBuy("1", { ...tokens[0]!, usdPrice }, 100, 5000)).toBeNull();
    expect(previewFirstBuy("1", tokens[0]!, 100, 5000)).not.toBeNull();
  });
});

describe("optional first-buy validation", () => {
  it("accepts no buy, zero and exact quote units", () => {
    for (const firstBuy of ["", "0", "0.", ".000001", "1.234567", "1.23456700"]) {
      expect(validateFirstBuyStep({ ...EMPTY_DRAFT, firstBuy }, USDC, 2)).toEqual({});
    }
    expect(validateFirstBuyStep({ ...EMPTY_DRAFT, firstBuy: "0.000000000000000001" }, ETH)).toEqual({});
  });
  it("rejects invalid saved text and amounts that would be silently truncated", () => {
    for (const firstBuy of [".", "-1", "Infinity", "NaN", "1e3", "0x10", "1,2"]) {
      expect(validateFirstBuyStep({ ...EMPTY_DRAFT, firstBuy }, USDC).firstBuy).toBe("Enter a valid amount.");
    }
    for (const firstBuy of ["0.0000001", "1.2345678"]) {
      expect(validateFirstBuyStep({ ...EMPTY_DRAFT, firstBuy }, USDC).firstBuy).toBe("USDC supports up to 6 decimal places.");
    }
  });
  it("uses the current balance while allowing disconnected preparation", () => {
    const draft = { ...EMPTY_DRAFT, firstBuy: "2" };
    expect(validateFirstBuyStep(draft, USDC)).toEqual({});
    expect(validateFirstBuyStep(draft, USDC, 2)).toEqual({});
    expect(validateFirstBuyStep(draft, USDC, 1).firstBuy).toBe("Not enough USDC.");
  });
});
