import { describe, expect, it, vi } from "vitest";
import type { KeeperContext } from "../../keeper/context";
import { runStockPrices } from "../../keeper/jobs/stockPrices";

function context(kind: string, manual = false) {
  const quote = "0x0000000000000000000000000000000000000001";
  const index = { query: vi.fn(async () => ({ rows: manual ? [{ address: quote, symbol: "AAPLc" }] : [] })) };
  const readContract = vi.fn(async () => ({ priceUsdE8: 10_000n, priceUpdatedAt: 1_000n }));
  const usdE8 = vi.fn(async () => 10_000n);
  const chainNow = vi.fn(async () => 1_060);
  const ctx = { index, client: { readContract }, prices: { kind, usdE8 }, chainNow, deployment: { config: quote } } as unknown as KeeperContext;
  return { ctx, index, readContract, usdE8, chainNow };
}

describe("disabled manual stock-price polling", () => {
  it("does not read the database or RPC when the configured source is none", async () => {
    const f = context("none", true);
    await expect(runStockPrices(f.ctx)).resolves.toEqual({ updated: 0 });
    expect(f.index.query).not.toHaveBeenCalled();
    expect(f.chainNow).not.toHaveBeenCalled();
    expect(f.readContract).not.toHaveBeenCalled();
    expect(f.usdE8).not.toHaveBeenCalled();
  });

  it.each(["http", "dev"])("still checks configured %s prices and the normal update threshold", async kind => {
    const f = context(kind, true);
    await expect(runStockPrices(f.ctx)).resolves.toEqual({ updated: 0 });
    expect(f.index.query).toHaveBeenCalledOnce();
    expect(f.chainNow).toHaveBeenCalledOnce();
    expect(f.readContract).toHaveBeenCalledOnce();
    expect(f.usdE8).toHaveBeenCalledWith({ address: "0x0000000000000000000000000000000000000001", symbol: "AAPLc", currentUsdE8: 10_000n, nowSec: 1_060 });
  });
});
