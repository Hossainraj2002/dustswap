// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCoins } from "./hooks";

const state = vi.hoisted(() => ({
  market: null as null | { listCoins: () => []; isCoinsReady?: () => boolean },
  version: 0,
}));
vi.mock("./MarketProvider", () => ({ useMarket: () => state }));
vi.mock("@/lib/wallet/WalletProvider", () => ({ useWallet: () => ({ address: null }) }));

beforeEach(() => { state.market = null; state.version = 0; });
afterEach(cleanup);

describe("coin list readiness", () => {
  it("starts the read and waits for the first live coin response", () => {
    let loaded = false;
    const listCoins = vi.fn(() => [] as []);
    state.market = { listCoins, isCoinsReady: () => loaded };
    const view = renderHook(() => useCoins());
    expect(listCoins).toHaveBeenCalledOnce();
    expect(view.result.current).toEqual({ ready: false, coins: [] });
    loaded = true;
    state.version += 1;
    view.rerender();
    expect(view.result.current).toEqual({ ready: true, coins: [] });
  });

  it("keeps synchronous preview adapters ready and waits for a market to exist", () => {
    const view = renderHook(() => useCoins());
    expect(view.result.current.ready).toBe(false);
    state.market = { listCoins: () => [] };
    view.rerender();
    expect(view.result.current.ready).toBe(true);
  });
});
