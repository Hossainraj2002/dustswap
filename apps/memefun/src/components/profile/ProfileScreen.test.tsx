// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileScreen } from "./ProfileScreen";

const state = vi.hoisted(() => ({ ready: false }));
vi.mock("@/lib/wallet/WalletProvider", () => ({ useWallet: () => ({ address: null }) }));
vi.mock("@/lib/market/hooks", () => ({
  useCoins: () => ({ coins: [], ready: state.ready }), useCreatorProfile: () => undefined,
  usePositions: () => [], useTradesByTrader: () => [],
}));
vi.mock("@/lib/hooks", () => ({ useNow: () => 1_000 }));
vi.mock("@/components/shell/PageHeader", () => ({ PageHeader: () => <h1>Creator</h1> }));
vi.mock("@/components/coin/CoinRow", () => ({ CoinRow: () => <span /> }));

beforeEach(() => { state.ready = false; });
afterEach(cleanup);

describe("profile loading", () => {
  it("shows a created-coins loader before an empty profile can be confirmed", () => {
    const view = render(<ProfileScreen address="0x1111111111111111111111111111111111111111" />);
    expect(screen.getByLabelText("Loading created coins").getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("No coins yet")).toBeNull();
    state.ready = true;
    view.rerender(<ProfileScreen address="0x1111111111111111111111111111111111111111" />);
    expect(screen.queryByLabelText("Loading created coins")).toBeNull();
    expect(screen.getByText("No coins yet")).toBeTruthy();
  });
});
