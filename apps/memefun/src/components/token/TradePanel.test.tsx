/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PreviewMarket } from "@/lib/preview/engine";
import type { MarketQuote } from "@/lib/market/Market";
import { formatBps, formatQuoteAmount } from "@/core/format";
import { TradePanel } from "./TradePanel";

const view = vi.hoisted(() => ({
  now: 1_800_000_000_000, trades: [] as { ts: number; priceUsd: number }[],
  quote: null as MarketQuote | null, quoteCall: vi.fn(), trade: vi.fn(),
  error: vi.fn(),
  wallet: { status: "connected", address: "0x00000000000000000000000000000000000000aa" as string | null,
    onBase: true, isSwitching: false, connect: vi.fn(), switchToBase: vi.fn() },
}));
vi.mock("@/lib/hooks", () => ({ useNow: () => view.now, useAnimationNow: () => view.now }));
vi.mock("@/lib/market/hooks", () => ({ useCoinBalance: () => 1000, useQuoteBalance: () => 10, useTrades: () => view.trades }));
vi.mock("@/lib/market/MarketProvider", () => {
  const market = { kind: "live", quote: (...args: unknown[]) => view.quoteCall(...args) ?? view.quote, trade: (...args: unknown[]) => view.trade(...args) };
  return { useMarket: () => ({ market, version: view.quote }) };
});
vi.mock("@/lib/wallet/WalletProvider", () => ({ useWallet: () => view.wallet }));
vi.mock("@/lib/preview/scenario", () => ({ usePreview: () => ({ preview: true, stocksRestricted: false, txOutcome: "success" }) }));
vi.mock("@/lib/referrals", () => ({ useReferrer: () => undefined }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: (...args: unknown[]) => view.error(...args) }) }));

const seed = new PreviewMarket({ now: view.now, seed: 1 }).listCoins()[0]!;
const coin = { ...seed, symbol: "TEST", createdAt: view.now - 3_600_000, liquidityUsd: 500_000,
  quote: { ...seed.quote, symbol: "ETH", kind: "native" as const, decimals: 18 } };
const quoted: MarketQuote = { side: "buy", amountIn: 0.1, amountOut: 100, amountOutRaw: "100000000000000000000",
  feeBps: 100, feeQuote: 0.001, priceImpact: 0.01, priceAfterUsd: 1, marketCapAfterUsd: 1, ok: true };
const fill = { coinAmount: 100, quoteAmount: 0.1, txHash: `0x${"1".repeat(64)}` };
const enterAmount = () => fireEvent.change(screen.getByLabelText("You pay"), { target: { value: "0.1" } });
const openSettings = () => fireEvent.click(screen.getByRole("button", { name: /^Slippage/ }));
beforeEach(() => {
  view.now = 1_800_000_000_000; view.quote = { ...quoted }; view.trades = []; view.quoteCall.mockReset();
  view.trade.mockReset(); view.trade.mockResolvedValue(fill);
  view.wallet.status = "connected"; view.wallet.address = "0x00000000000000000000000000000000000000aa";
  view.wallet.onBase = true; view.wallet.isSwitching = false;
  view.wallet.connect.mockReset(); view.wallet.connect.mockResolvedValue(undefined);
  view.wallet.switchToBase.mockReset(); view.wallet.switchToBase.mockResolvedValue(true);
  view.error.mockClear();
});
afterEach(cleanup);

describe("trade slippage execution", () => {
  it("defaults to Auto, freezes its displayed raw floor and percentage while pending", async () => {
    let complete!: (value: typeof fill) => void;
    view.trade.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const onPendingChange = vi.fn();
    const page = render(<TradePanel coin={coin} onPendingChange={onPendingChange} />);
    expect(screen.getByRole("button", { name: "Slippage Auto (5%). Change" })).toBeDefined();
    expect(screen.queryByText(/^Fee is/)).toBeNull();
    expect(screen.queryByText("Platform")).toBeNull();
    enterAmount();
    expect(screen.getByText("95 TEST")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Buy TEST" }));
    expect(view.trade.mock.calls[0]![4]).toBe(95);
    expect(view.trade.mock.calls[0]![5]).toMatchObject({ slippageBps: 500, minAmountOutRaw: "95000000000000000000" });
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("radio", { name: "Sell" }).matches(":disabled")).toBe(true);
    expect(screen.getByLabelText("You pay").matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Pay 0.01 ETH" }).matches(":disabled")).toBe(true);
    view.trades = [30_000, 20_000, 1000].map(offset => ({ ts: view.now - offset, priceUsd: 1 }));
    view.quote = { ...quoted, amountOut: 200, amountOutRaw: "200000000000000000000" };
    page.rerender(<TradePanel coin={coin} onPendingChange={onPendingChange} />);
    expect(screen.getByText("95 TEST")).toBeDefined();
    expect((screen.getByRole("button", { name: "Slippage Auto (5%). Change" }) as HTMLButtonElement).disabled).toBe(true);
    complete(fill);
    await waitFor(() => expect(screen.getByRole("button", { name: "Slippage Auto (1%). Change" })).toBeDefined());
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
  });

  it("applies a custom percentage exactly and disables an invalid edit instead of using the previous value", async () => {
    render(<TradePanel coin={coin} />); enterAmount(); openSettings();
    const custom = screen.getByLabelText("Custom slippage percentage");
    fireEvent.change(custom, { target: { value: "7.5" } });
    expect(screen.getByText("92.5 TEST")).toBeDefined();
    fireEvent.change(custom, { target: { value: "51" } });
    expect((screen.getByRole("button", { name: "Set valid slippage" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Set valid slippage" }));
    expect(view.trade).not.toHaveBeenCalled();
    fireEvent.change(custom, { target: { value: "" } });
    expect((screen.getByRole("button", { name: "Set valid slippage" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(custom, { target: { value: "7.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Buy TEST" }));
    await waitFor(() => expect(view.trade).toHaveBeenCalledTimes(1));
    expect(view.trade.mock.calls[0]![5]).toMatchObject({ slippageBps: 750, minAmountOutRaw: "92500000000000000000" });
  });

  it("lets a preset or Auto replace invalid custom text", () => {
    render(<TradePanel coin={coin} />); enterAmount(); openSettings();
    fireEvent.change(screen.getByLabelText("Custom slippage percentage"), { target: { value: "." } });
    fireEvent.click(screen.getByRole("button", { name: "10%" }));
    expect(screen.getByText("90 TEST")).toBeDefined();
    expect((screen.getByRole("button", { name: "Buy TEST" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Auto · 5%" }));
    expect(screen.getByText("95 TEST")).toBeDefined();
  });

  it("blocks an amount whose exact minimum rounds to zero", () => {
    view.quote = { ...quoted, amountOut: 1e-18, amountOutRaw: "1" };
    render(<TradePanel coin={coin} />); enterAmount();
    expect((screen.getByRole("button", { name: "Amount too small" }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.trade).not.toHaveBeenCalled();
  });

  it("blocks a second panel while the same screen has a trade pending", () => {
    render(<TradePanel coin={coin} locked />); enterAmount();
    const button = screen.getByRole("button", { name: "Buy TEST" });
    expect(button.matches(":disabled")).toBe(true);
    fireEvent.click(button);
    expect(view.trade).not.toHaveBeenCalled();
  });

  it("clears a previous wallet's Max sell before trading with another wallet", () => {
    const page = render(<TradePanel coin={coin} initialSide="sell" />);
    fireEvent.click(screen.getByRole("button", { name: "Max, sell your whole balance" }));
    expect((screen.getByLabelText("You pay") as HTMLInputElement).value).toBe("1000");
    view.wallet.address = "0x00000000000000000000000000000000000000bb";
    page.rerender(<TradePanel coin={coin} initialSide="sell" />);
    expect((screen.getByLabelText("You pay") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Enter an amount" }));
    expect(view.trade).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("You pay"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Sell TEST" }));
    expect(view.trade.mock.calls[0]![5]).toMatchObject({ max: false, amountText: "12" });
  });

  it("clears the amount when another coin has no explicit pool selection", () => {
    const page = render(<TradePanel coin={{ ...coin, selectedPoolId: undefined }} />); enterAmount();
    page.rerender(<TradePanel coin={{ ...coin, address: "0x00000000000000000000000000000000000000cc", selectedPoolId: undefined }} />);
    expect((screen.getByLabelText("You pay") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Enter an amount" }).matches(":disabled")).toBe(true);
  });

  it("keeps network switching disabled while the selected wallet is switching", () => {
    view.wallet.onBase = false; view.wallet.isSwitching = true;
    render(<TradePanel coin={coin} />);
    const button = screen.getByRole("button", { name: /^Switch/ });
    expect(button.matches(":disabled")).toBe(true);
    fireEvent.click(button);
    expect(view.wallet.switchToBase).not.toHaveBeenCalled();
  });

  it("prevents duplicate connection requests before wallet state updates", async () => {
    view.wallet.status = "disconnected"; view.wallet.address = null;
    let complete!: () => void;
    view.wallet.connect.mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
    render(<TradePanel coin={coin} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    const button = screen.getByRole("button", { name: "Connecting" });
    expect(button.matches(":disabled")).toBe(true);
    fireEvent.click(button);
    expect(view.wallet.connect).toHaveBeenCalledTimes(1);
    await act(async () => complete());
  });

  it("reports a connection failure and lets the user try again", async () => {
    view.wallet.status = "disconnected"; view.wallet.address = null;
    view.wallet.connect.mockRejectedValueOnce(new Error("Wallet initialization did not finish"));
    render(<TradePanel coin={coin} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Connect wallet" })));
    expect(view.error).toHaveBeenCalledWith("Wallet initialization did not finish");
    expect(screen.getByRole("button", { name: "Connect wallet" }).matches(":disabled")).toBe(false);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Connect wallet" })));
    expect(view.wallet.connect).toHaveBeenCalledTimes(2);
  });

  it("shows an existing SDK connection attempt instead of opening another", () => {
    view.wallet.status = "connecting"; view.wallet.address = null;
    render(<TradePanel coin={coin} />);
    const button = screen.getByRole("button", { name: "Connecting" });
    expect(button.matches(":disabled")).toBe(true);
    fireEvent.click(button);
    expect(view.wallet.connect).not.toHaveBeenCalled();
  });

  it("blocks another switch request until the current one settles", async () => {
    view.wallet.onBase = false;
    let fail!: (reason: Error) => void;
    view.wallet.switchToBase.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    render(<TradePanel coin={coin} />);
    fireEvent.click(screen.getByRole("button", { name: /^Switch to/ }));
    const button = screen.getByRole("button", { name: /^Switching to/ });
    expect(button.matches(":disabled")).toBe(true);
    fireEvent.click(button);
    expect(view.wallet.switchToBase).toHaveBeenCalledTimes(1);
    await act(async () => fail(new Error("Network switch rejected")));
    expect(view.error).toHaveBeenCalledWith("Network switch rejected");
    expect(screen.getByRole("button", { name: /^Switch to/ }).matches(":disabled")).toBe(false);
  });

  it("refreshes a decaying launch fee quote as time passes without a market update", () => {
    const market = new PreviewMarket({ now: view.now, seed: 1, protectionDemo: true });
    const protectedCoin = market.listCoins().find(entry => entry.createdAt === view.now - 5000)!;
    expect(protectedCoin).toBeDefined();
    view.quoteCall.mockImplementation((address: string, side: "buy" | "sell", amount: number, now: number) => market.quote(address, side, amount, now));
    const feeText = (now: number) => {
      const quote = market.quote(protectedCoin.address, "buy", 0.1, now);
      return `${formatBps(quote.feeBps)} (${formatQuoteAmount(quote.feeQuote, protectedCoin.quote.symbol)})`;
    };
    const initialFee = feeText(view.now);
    const page = render(<TradePanel coin={protectedCoin} />); enterAmount();
    expect(screen.getByText(initialFee)).toBeDefined();
    expect(view.quoteCall).toHaveBeenCalledTimes(1);
    view.now += 1000;
    page.rerender(<TradePanel coin={protectedCoin} />);
    expect(feeText(view.now)).not.toBe(initialFee);
    expect(screen.queryByText(initialFee)).toBeNull();
    expect(screen.getByText(feeText(view.now))).toBeDefined();
    expect(view.quoteCall).toHaveBeenCalledTimes(2);
    expect(view.quoteCall.mock.calls[1]![3]).toBe(view.now);
  });
});
