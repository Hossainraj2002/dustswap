// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemefunWallet } from "@/lib/wallet/WalletProvider";
import { WalletButton } from "./WalletButton";

const state = vi.hoisted(() => ({
  wallet: null as MemefunWallet | null,
  listQuotes: vi.fn(),
  getQuoteBalance: vi.fn(),
}));
vi.mock("@/lib/wallet/WalletProvider", () => ({ useWallet: () => state.wallet }));
vi.mock("@/lib/market/MarketProvider", () => ({
  useMarket: () => ({ market: { listQuotes: state.listQuotes, getQuoteBalance: state.getQuoteBalance }, version: 0 }),
}));
vi.mock("@/lib/hooks", () => ({ useIsRegularWidth: () => true }));
vi.mock("./ThemeSegmented", () => ({ ThemeSegmented: () => <span>Appearance options</span> }));

const native = { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", name: "Ether", usdPrice: 3_000 };
const stable = { address: "0x0000000000000000000000000000000000000001", symbol: "USDC", name: "USD Coin", usdPrice: 1 };

beforeEach(() => {
  state.wallet = {
    mode: "privy", status: "connected", address: "0x00000000000000000000000000000000000a11ce",
    chainId: 8453, onBase: true, isSwitching: false,
    connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), switchToBase: vi.fn(async () => {}),
  };
  state.listQuotes.mockReset().mockReturnValue([native, stable]);
  state.getQuoteBalance.mockReset().mockImplementation((_wallet: string, quote: string) => quote === native.address ? 2 : 25);
});
afterEach(cleanup);

describe("account balance subscriptions", () => {
  it("does not read any pair balances while the account sheet is closed", () => {
    const view = render(<WalletButton />);
    for (let i = 0; i < 5; i++) view.rerender(<WalletButton />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(state.listQuotes).not.toHaveBeenCalled();
    expect(state.getQuoteBalance).not.toHaveBeenCalled();
  });

  it("reads and displays balances when opened, then stops reading after dismissal", async () => {
    const view = render(<WalletButton />);
    fireEvent.click(screen.getByRole("button", { name: /^Account / }));
    await screen.findByRole("dialog", { name: "Account" });
    expect(state.getQuoteBalance).toHaveBeenCalledWith(state.wallet!.address, native.address);
    expect(state.getQuoteBalance).toHaveBeenCalledWith(state.wallet!.address, stable.address);
    expect(screen.getByText("ETH")).toBeTruthy();
    expect(screen.getByText("USDC")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const reads = state.getQuoteBalance.mock.calls.length;
    const quoteReads = state.listQuotes.mock.calls.length;
    view.rerender(<WalletButton />);
    expect(state.getQuoteBalance).toHaveBeenCalledTimes(reads);
    expect(state.listQuotes).toHaveBeenCalledTimes(quoteReads);
  });

  it("preserves the disconnect action inside the account sheet", async () => {
    render(<WalletButton />);
    fireEvent.click(screen.getByRole("button", { name: /^Account / }));
    await screen.findByRole("dialog", { name: "Account" });
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(state.wallet!.disconnect).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
