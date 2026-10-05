/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PreviewMarket } from "@/lib/preview/engine";
import type { MarketQuote } from "@/lib/market/Market";
import { TradePanel } from "./TradePanel";

const view = vi.hoisted(() => ({
  now: 1_800_000_000_000, trades: [] as { ts: number; priceUsd: number }[],
  quote: null as MarketQuote | null, trade: vi.fn(),
}));
vi.mock("@/lib/hooks", () => ({ useNow: () => view.now, useAnimationNow: () => view.now }));
vi.mock("@/lib/market/hooks", () => ({ useCoinBalance: () => 1000, useQuoteBalance: () => 10, useTrades: () => view.trades }));
vi.mock("@/lib/market/MarketProvider", () => {
  const market = { kind: "live", quote: () => view.quote, trade: (...args: unknown[]) => view.trade(...args) };
  return { useMarket: () => ({ market, version: view.quote }) };
});
vi.mock("@/lib/wallet/WalletProvider", () => ({ useWallet: () => ({ status: "connected", address: "0x00000000000000000000000000000000000000aa", onBase: true }) }));
vi.mock("@/lib/preview/scenario", () => ({ usePreview: () => ({ preview: true, stocksRestricted: false, txOutcome: "success" }) }));
vi.mock("@/lib/referrals", () => ({ useReferrer: () => undefined }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const seed = new PreviewMarket({ now: view.now, seed: 1 }).listCoins()[0]!;
const coin = { ...seed, symbol: "TEST", createdAt: view.now - 3_600_000, liquidityUsd: 500_000,
  quote: { ...seed.quote, symbol: "ETH", kind: "native" as const, decimals: 18 } };
const quoted: MarketQuote = { side: "buy", amountIn: 0.1, amountOut: 100, amountOutRaw: "100000000000000000000",
  feeBps: 100, feeQuote: 0.001, priceImpact: 0.01, priceAfterUsd: 1, marketCapAfterUsd: 1, ok: true };
const fill = { coinAmount: 100, quoteAmount: 0.1, txHash: `0x${"1".repeat(64)}` };
const enterAmount = () => fireEvent.change(screen.getByLabelText("You pay"), { target: { value: "0.1" } });
const openSettings = () => fireEvent.click(screen.getByRole("button", { name: /^Slippage/ }));
beforeEach(() => { view.quote = { ...quoted }; view.trades = []; view.trade.mockReset(); view.trade.mockResolvedValue(fill); });
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
});
