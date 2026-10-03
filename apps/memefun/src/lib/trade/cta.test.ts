import { describe, expect, it } from "vitest";
import { impactLevel, tradeCta, type TradeCtaInput } from "./cta";

const base: TradeCtaInput = {
  connected: true,
  onBase: true,
  side: "buy",
  amount: 0.05,
  balance: 1,
  payingSymbol: "ETH",
  coinSymbol: "TOAD",
  restricted: false,
  pending: false,
  quoteOk: true,
};

describe("tradeCta", () => {
  it("walks the states in priority order", () => {
    expect(tradeCta({ ...base, connected: false, onBase: false, amount: 0 })).toMatchObject({ kind: "connect", enabled: true });
    expect(tradeCta({ ...base, restricted: true, onBase: false })).toMatchObject({ kind: "restricted", enabled: false });
    expect(tradeCta({ ...base, onBase: false })).toMatchObject({ kind: "switch", label: "Switch to Base", enabled: true });
    expect(tradeCta({ ...base, pending: true })).toMatchObject({ kind: "pending", enabled: false });
    expect(tradeCta({ ...base, amount: 0 })).toMatchObject({ kind: "enter-amount", enabled: false });
    expect(tradeCta({ ...base, amount: 2 })).toMatchObject({ kind: "insufficient", label: "Not enough ETH", enabled: false });
    expect(tradeCta({ ...base, quoteOk: false, quoteLoading: true })).toMatchObject({ kind: "loading", enabled: false });
    expect(tradeCta({ ...base, quoteOk: false })).toMatchObject({ kind: "no-liquidity", enabled: false });
    expect(tradeCta(base)).toEqual({ kind: "ready", label: "Buy TOAD", enabled: true });
    expect(tradeCta({ ...base, side: "sell", payingSymbol: "TOAD" })).toEqual({ kind: "ready", label: "Sell TOAD", enabled: true });
  });

  it("names the network to switch to", () => {
    expect(tradeCta({ ...base, onBase: false, chainName: "Base Sepolia" }).label).toBe("Switch to Base Sepolia");
  });

  it("treats NaN and negative amounts as empty", () => {
    expect(tradeCta({ ...base, amount: Number.NaN }).kind).toBe("enter-amount");
    expect(tradeCta({ ...base, amount: -1 }).kind).toBe("enter-amount");
  });

  it("allows spending the exact balance", () => {
    expect(tradeCta({ ...base, amount: 1, balance: 1 }).kind).toBe("ready");
  });
});

describe("impactLevel", () => {
  it("grades price impact", () => {
    expect(impactLevel(0.01)).toBe("none");
    expect(impactLevel(0.05)).toBe("notice");
    expect(impactLevel(0.2)).toBe("high");
  });
});
