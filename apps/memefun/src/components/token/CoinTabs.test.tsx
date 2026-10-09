/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewMarket } from "@/lib/preview/engine";
import { ETH } from "@/lib/market/quotes";
import type { Holder, Trade } from "@/lib/market/types";
import { PLATFORM_TOKEN_LAUNCHER } from "@/lib/platform-token/config";
import { CoinTabs } from "./CoinTabs";
import { CreatorCard } from "./SideCards";

const view = vi.hoisted(() => ({ wallet: null as string | null, trades: [] as Trade[], holders: [] as Holder[] }));
vi.mock("@/lib/hooks", () => ({ useNow: () => 1_800_000_060_000 }));
vi.mock("@/lib/market/hooks", () => ({ useTrades: () => view.trades, useHolders: () => view.holders, useComments: () => [], useCreatorProfile: () => undefined }));
vi.mock("@/lib/market/MarketProvider", () => ({ useMarket: () => ({ market: null }) }));
vi.mock("@/lib/wallet/WalletProvider", () => ({ useWallet: () => ({ address: view.wallet, status: "disconnected" }) }));
vi.mock("@/lib/preview/scenario", () => ({ usePreview: () => ({ preview: true }) }));
vi.mock("@/components/shell/WalletButton", () => ({ ConnectHint: () => null }));
vi.mock("@/components/ui/Tabs", () => ({ Tabs: ({ items, value, onChange }: { items: Array<{ value: string; label: string; content: ReactNode }>; value: string; onChange: (value: string) => void }) => <>
  {items.map(item => <button key={item.value} onClick={() => onChange(item.value)}>{item.label}</button>)}
  {items.find(item => item.value === value)?.content}
</> }));

const CREATOR = PLATFORM_TOKEN_LAUNCHER;
const original = new PreviewMarket({ now: 1_800_000_000_000, seed: 1 }).listCoins()[0]!;
const coin = { ...original, quote: ETH, creator: CREATOR, devHoldsPct: 0.1, devSold: true, top10Pct: 0.85,
  terms: { ...original.terms, feeBps: 100, snipeStartBps: 9000, snipeDurationSec: 120 } };
beforeEach(() => {
  view.wallet = null;
  view.trades = [{ id: "1", coin: coin.address, ts: 1_800_000_000_000, side: "buy", trader: CREATOR,
    quoteAmount: 2.5, coinAmount: 1_000_000, marketCapUsd: 12_000, isCreator: true, inProtection: true,
    feeBps: 9000, feeQuote: 2.25, priceUsd: 0.000012, txHash: `0x${"a".repeat(64)}` }];
  view.holders = [{ address: CREATOR, balance: 100_000_000, pct: 0.1, label: "creator" }];
});
afterEach(cleanup);

describe("official platform trade and holder presentation", () => {
  it("relabels the creator neutrally without removing the trade amounts or protection fee", () => {
    const page = render(<CoinTabs coin={coin} />);
    expect(screen.getByText("Dev").className).toContain("text-warning");
    page.rerender(<CoinTabs coin={coin} official />);
    expect(screen.queryByText("Dev")).toBeNull();
    expect(screen.getByText("Platform").className).toContain("text-tint");
    const trades = screen.getByRole("list", { name: "Latest trades" });
    expect(trades.textContent).toContain("2.5 ETH");
    expect(trades.textContent).toContain("1M");
    expect(trades.textContent).toContain("$12K");
    expect(screen.getByText("paid 90% launch fee")).toBeDefined();
  });

  it("keeps You for the selected platform wallet regardless of address case", () => {
    view.wallet = CREATOR.toUpperCase().replace("0X", "0x");
    render(<CoinTabs coin={coin} official />);
    expect(screen.getByText("You")).toBeDefined();
    expect(screen.queryByText("Platform")).toBeNull();
  });

  it("shows the same creator holding percentage with neutral Platform branding", () => {
    const page = render(<CoinTabs coin={coin} />);
    fireEvent.click(screen.getByRole("button", { name: "Holders" }));
    expect(screen.getByText("Dev")).toBeDefined();
    expect(screen.getByText("10%")).toBeDefined();
    page.rerender(<CoinTabs coin={coin} official />);
    expect(screen.getByText("Platform wallet")).toBeDefined();
    expect(screen.getByText("Platform").className).toContain("text-tint");
    expect(screen.getByText("10%")).toBeDefined();
    expect(screen.queryByText("Dev")).toBeNull();
  });

  it("shows high platform holdings and sales factually with an info icon, preserving other risk signals and fees", () => {
    render(<CoinTabs coin={coin} official />);
    fireEvent.click(screen.getByRole("button", { name: "Safety" }));
    const holding = screen.getByText("Platform wallet holds").parentElement!.parentElement!;
    expect(holding.textContent).toContain("10%");
    expect(holding.textContent).toContain("The original launcher has sold or transferred tokens to a trading pool.");
    expect(holding.querySelector(".lucide-info")).not.toBeNull();
    expect(holding.querySelector(".lucide-circle-check")).toBeNull();
    expect(holding.querySelector(".lucide-circle-alert")).toBeNull();
    const top10 = screen.getByText("Top 10 holders").parentElement!.parentElement!;
    expect(top10.textContent).toContain("85%");
    expect(top10.querySelector(".lucide-circle-alert")).not.toBeNull();
    expect(screen.getByText("Trading fee is 1% and can only go down.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "About" }));
    expect(screen.getByText("1% of every trade, can only go down")).toBeDefined();
    expect(screen.getByText("90% fee at launch, normal after 120s")).toBeDefined();
  });

  it("distinguishes the current creator after transfer from the original platform wallet", () => {
    const nextCreator = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
    view.trades = [...view.trades, { ...view.trades[0]!, id: "2", trader: nextCreator }];
    view.holders = [...view.holders, { address: nextCreator, balance: 20_000_000, pct: 0.02, label: "creator" }];
    const transferred = { ...coin, creator: nextCreator, devHoldsPct: 0.02 };
    render(<CoinTabs coin={transferred} official />);
    const trades = screen.getByRole("list", { name: "Latest trades" });
    expect(trades.querySelectorAll("li")[0]!.textContent).toContain("Platform");
    expect(trades.querySelectorAll("li")[1]!.textContent).toContain("Creator");
    expect(trades.querySelectorAll("li")[1]!.textContent).not.toContain("Platform");
    fireEvent.click(screen.getByRole("button", { name: "Holders" }));
    expect(screen.getByText("Platform wallet")).toBeDefined();
    const holders = screen.getByRole("list", { name: "Top holders" });
    expect(holders.querySelectorAll("li")[1]!.textContent).toContain("Creator");
    expect(holders.querySelectorAll("li")[1]!.textContent).not.toContain("Platform");
    fireEvent.click(screen.getByRole("button", { name: "Safety" }));
    expect(screen.queryByText("Platform wallet holds")).toBeNull();
    const holding = screen.getByText("Current creator holds").parentElement!;
    expect(holding.textContent).toContain("2%");
    expect(screen.getByText("The original launcher has sold or transferred tokens to a trading pool.")).toBeDefined();
  });

  it("keeps launcher activity separate from the current creator profile after a transfer", () => {
    const nextCreator = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
    const transferred = { ...coin, creator: nextCreator };
    const page = render(<CreatorCard coin={transferred} official />);
    expect(screen.getByRole("link").getAttribute("href")).toBe(`/u/${nextCreator}`);
    expect(screen.getByText("Original launcher: sale or transfer to a trading pool recorded.")).toBeDefined();
    expect(screen.queryByText("Creator has sold")).toBeNull();
    page.rerender(<CreatorCard coin={{ ...transferred, devSold: false }} official />);
    expect(screen.getByText("No original-launcher sale or transfer to a trading pool recorded.")).toBeDefined();
  });
});
