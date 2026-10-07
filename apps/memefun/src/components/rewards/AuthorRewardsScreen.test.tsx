// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Coin } from "@/lib/market/types";
import { AuthorRewardsScreen } from "./AuthorRewardsScreen";

const state = vi.hoisted(() => ({ ready: false, requested: null as string | null, requestedCoin: undefined as Coin | undefined }));
vi.mock("next/navigation", () => ({ useSearchParams: () => ({ get: () => state.requested }) }));
vi.mock("@/lib/wallet/WalletProvider", () => ({ useWallet: () => ({ address: null, status: "disconnected", connect: vi.fn() }) }));
vi.mock("@/lib/market/MarketProvider", () => ({ useMarket: () => ({ market: null }) }));
vi.mock("@/lib/market/hooks", () => ({ useCoins: () => ({ coins: [], ready: state.ready }), useCoin: () => ({ coin: state.requestedCoin }) }));
vi.mock("@/lib/hooks", () => ({ useNow: () => 1_000 }));
vi.mock("@/components/shell/PageHeader", () => ({ PageHeader: () => <h1>Post author earnings</h1> }));
vi.mock("@/components/create/TweetImportPanel", () => ({ TweetSourceCard: () => <span /> }));
vi.mock("@/components/ui/CoinAvatar", () => ({ CoinAvatar: () => <span /> }));

beforeEach(() => { state.ready = false; state.requested = null; state.requestedCoin = undefined; });
afterEach(cleanup);

describe("author coin list loading", () => {
  it("waits for the list before showing empty author guidance", () => {
    const view = render(<AuthorRewardsScreen />);
    expect(screen.getByRole("status").textContent).toBe("Loading post author coins…");
    expect(screen.queryByRole("link", { name: "Launch by tweet" })).toBeNull();
    state.ready = true;
    view.rerender(<AuthorRewardsScreen />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("link", { name: "Launch by tweet" })).toBeTruthy();
  });

  it("keeps an already loaded requested tweet coin visible while the full list loads", () => {
    state.requested = "0xb200000000000000000000000000000000000001";
    state.requestedCoin = { address: state.requested, name: "Requested post", symbol: "POST", image: "",
      tweet: { authorXUserId: "123", authorShareBps: 5_000 } } as Coin;
    render(<AuthorRewardsScreen />);
    expect(screen.getByRole("link", { name: "Requested post · $POST" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
