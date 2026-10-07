// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Coin } from "@/lib/market/types";
import { SearchCommand } from "./SearchCommand";

const state = vi.hoisted(() => ({ ready: false, coins: [] as Coin[], push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/lib/market/hooks", () => ({ useCoins: () => ({ ready: state.ready, coins: state.coins }) }));
vi.mock("@/components/ui/CoinAvatar", () => ({ CoinAvatar: () => <span /> }));
vi.mock("@/components/ui/display", () => ({ ChangeText: () => <span /> }));

beforeEach(() => {
  state.ready = false;
  state.coins = [];
  state.push.mockReset();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("search palette loading", () => {
  it("shows loading for a query until the coin list has arrived, then allows an empty result", async () => {
    const view = render(<SearchCommand open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "toad" } });
    expect(screen.getByRole("status").textContent).toBe("Loading coins…");
    expect(screen.queryByText("No coins match. Try a ticker or a contract address.")).toBeNull();
    state.ready = true;
    view.rerender(<SearchCommand open onOpenChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("No coins match. Try a ticker or a contract address.")).toBeTruthy());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps navigation available while the initial coin list loads", () => {
    const close = vi.fn();
    render(<SearchCommand open onOpenChange={close} />);
    fireEvent.click(screen.getByText("Rewards"));
    expect(close).toHaveBeenCalledWith(false);
    expect(state.push).toHaveBeenCalledWith("/rewards");
  });
});
