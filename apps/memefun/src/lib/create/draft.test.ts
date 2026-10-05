import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/core/settings";
import { ETH, USDC } from "@/lib/market/quotes";
import { EMPTY_DRAFT, migrateDraft, reconcileDraftSettings, selectedQuoteSymbols, validatePairs } from "./draft";

describe("saved launch drafts", () => {
  it("migrates a legacy USDC draft without changing its first buy", () => {
    const draft = migrateDraft({ quoteSymbol: "USDC", firstBuy: "12.345678" });
    expect(draft.launchMode).toBe("single");
    expect(selectedQuoteSymbols(draft)).toEqual(["USDC"]);
    expect(draft.firstBuyQuoteSymbol).toBe("USDC");
    expect(draft.firstBuy).toBe("12.345678");
  });
  it("removes duplicate saved pools and moves a removed first buy to the primary", () => {
    const draft = migrateDraft({ launchMode: "multi", quoteSymbols: ["USDC", "ETH", "USDC"], firstBuyQuoteSymbol: "REMOVED" });
    expect(draft.quoteSymbols).toEqual(["USDC", "ETH"]);
    expect(draft.quoteSymbol).toBe("USDC");
    expect(draft.firstBuyQuoteSymbol).toBe("USDC");
  });
  it("reconciles the stored value used by labels, slider and transaction with new limits", () => {
    const draft = reconcileDraftSettings({ ...EMPTY_DRAFT, feeBps: 900, creatorKeepBps: 5000 }, { ...DEFAULT_SETTINGS, feeMaxBps: 300, creatorKeepMaxBps: 2000 });
    expect(draft.feeBps).toBe(300);
    expect(draft.creatorKeepBps).toBe(2000);
  });
});

describe("listed pair validation", () => {
  it("accepts listed distinct quotes, rejecting duplicate addresses and unavailable assets", () => {
    const draft = { ...EMPTY_DRAFT, launchMode: "multi" as const, quoteSymbols: ["ETH", "USDC"] };
    expect(validatePairs(draft, [ETH, USDC], DEFAULT_SETTINGS, false)).toEqual({});
    expect(validatePairs(draft, [ETH, { ...USDC, address: ETH.address }], DEFAULT_SETTINGS, false).quoteSymbol).toBeTruthy();
    expect(validatePairs(draft, [ETH], DEFAULT_SETTINGS, false).quoteSymbol).toBeTruthy();
    expect(validatePairs(draft, [ETH, USDC], { ...DEFAULT_SETTINGS, enabledQuoteKinds: ["native"] }, false).quoteSymbol).toBeTruthy();
  });
});
