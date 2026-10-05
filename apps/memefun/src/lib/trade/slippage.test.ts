import { describe, expect, it } from "vitest";
import { autoSlippageBps, parseSlippagePercent, resolveSlippageBps } from "./slippage";

const now = 1_800_000_000_000;
const calm = [30_000, 20_000, 1_000].map(offset => ({ ts: now - offset, priceUsd: 1 }));
const base = { createdAt: now - 3_600_000, liquidityUsd: 500_000, now, trades: calm };

describe("bounded Auto slippage", () => {
  it("gives new/thin pools 5%, and established calm pools 1% or 3%", () => {
    expect(autoSlippageBps({ ...base, createdAt: now - 599_999 })).toBe(500);
    expect(autoSlippageBps({ ...base, liquidityUsd: 49_999 })).toBe(500);
    expect(autoSlippageBps({ ...base, liquidityUsd: 50_000 })).toBe(300);
    expect(autoSlippageBps({ ...base, liquidityUsd: 250_000 })).toBe(100);
  });
  it("uses recent observed price moves, rounds upward, and never exceeds 5%", () => {
    const trades = calm.map((trade, i) => ({ ...trade, priceUsd: i === 0 ? 1 : 1.01 }));
    expect(autoSlippageBps({ ...base, trades })).toBeGreaterThanOrEqual(250);
    expect(autoSlippageBps({ ...base, trades: trades.map((trade, i) => ({ ...trade, priceUsd: i === 0 ? 1 : 2 })) })).toBe(500);
    expect(autoSlippageBps({ ...base, trades: [...calm].reverse() })).toBe(100);
  });
  it("does not treat sparse, stale, future or invalid history as a calm market", () => {
    for (const trades of [[], calm.slice(0, 2), calm.map(t => ({ ...t, ts: now - 60_001 })), calm.map(t => ({ ...t, ts: now + 1 })), calm.map(t => ({ ...t, priceUsd: NaN }))]) {
      expect(autoSlippageBps({ ...base, trades })).toBe(500);
    }
    expect(autoSlippageBps({ ...base, liquidityUsd: NaN })).toBe(500);
    expect(autoSlippageBps({ ...base, now: NaN })).toBe(500);
  });
});

describe("custom slippage", () => {
  it.each([["0.01", 1], [".5", 50], ["1.01", 101], ["7.5", 750], ["50", 5000], [" 3.25 ", 325]])("parses %s as exact integer bps", (text, bps) => {
    expect(parseSlippagePercent(text as string)).toBe(bps);
  });
  it.each(["", ".", "0", "0.001", "1.999", "50.01", "51", "1e1", "-2", "NaN", "5%", "9".repeat(100)])("rejects %s instead of using an old limit", text => {
    expect(resolveSlippageBps({ mode: "custom", text }, 500)).toBeNull();
  });
  it("separates Auto's cap from an explicit manual choice", () => {
    expect(resolveSlippageBps({ mode: "auto" }, 501)).toBeNull();
    expect(resolveSlippageBps({ mode: "preset", bps: 1000 }, 500)).toBe(1000);
    expect(resolveSlippageBps({ mode: "preset", bps: 0 }, 500)).toBeNull();
    expect(resolveSlippageBps({ mode: "preset", bps: 100.5 }, 500)).toBeNull();
  });
});
