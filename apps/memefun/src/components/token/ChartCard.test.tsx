/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PreviewMarket } from "@/lib/preview/engine";
import { ChartCard } from "./ChartCard";

const view = vi.hoisted(() => ({ address: null as string | null, trades: [] as {
  trader: string; ts: number; side: "buy" | "sell"; isCreator: boolean;
}[] }));
vi.mock("next/dynamic", () => ({ default: () => ({ markers }: { markers: unknown }) => <output data-testid="markers">{JSON.stringify(markers)}</output> }));
vi.mock("@/lib/hooks", () => ({ useIsRegularWidth: () => true }));
vi.mock("@/lib/market/hooks", () => ({ useCandles: () => [], useTrades: () => view.trades }));
vi.mock("@/lib/wallet/WalletProvider", () => ({ useWallet: () => ({ address: view.address }) }));
vi.mock("@/components/theme/ThemeProvider", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));

const coin = new PreviewMarket({ now: 1_800_000_000_000, seed: 1 }).listCoins()[0]!;
beforeEach(() => { view.address = null; view.trades = []; });
afterEach(cleanup);

describe("trade chart markers", () => {
  it("recognizes the selected wallet regardless of address capitalization", () => {
    view.address = "0xF113b1dBd848F44684f8543CcDf63C90f9535F57";
    view.trades = [{ trader: view.address.toLowerCase(), ts: 1_800_000_000_000, side: "buy", isCreator: false }];
    render(<ChartCard coin={coin} />);
    expect(JSON.parse(screen.getByTestId("markers").textContent!)).toEqual([{ time: 1_800_000_000, kind: "you-buy" }]);
  });

  it("keeps creator markers distinct and removes own markers on a wallet change", () => {
    view.address = "0x00000000000000000000000000000000000000aa";
    view.trades = [
      { trader: view.address, ts: 1_800_000_000_000, side: "sell", isCreator: true },
      { trader: "0x00000000000000000000000000000000000000bb", ts: 1_800_000_000_000, side: "buy", isCreator: false },
    ];
    const page = render(<ChartCard coin={coin} />);
    expect(JSON.parse(screen.getByTestId("markers").textContent!)).toEqual([{ time: 1_800_000_000, kind: "you-sell" }]);
    view.address = null; page.rerender(<ChartCard coin={coin} />);
    expect(JSON.parse(screen.getByTestId("markers").textContent!)).toEqual([{ time: 1_800_000_000, kind: "dev-sell" }]);
  });

  it("relabels official creator buys and sells while keeping the viewer's own marker", () => {
    view.address = "0x00000000000000000000000000000000000000aa";
    view.trades = [
      { trader: "0x00000000000000000000000000000000000000bb", ts: 1_800_000_000_000, side: "buy", isCreator: true },
      { trader: "0x00000000000000000000000000000000000000bb", ts: 1_800_000_000_000, side: "sell", isCreator: true },
      { trader: view.address, ts: 1_800_000_000_000, side: "buy", isCreator: false },
    ];
    const page = render(<ChartCard coin={coin} />);
    expect(JSON.parse(screen.getByTestId("markers").textContent!).map((marker: { kind: string }) => marker.kind)).toEqual(["dev-buy", "dev-sell", "you-buy"]);
    page.rerender(<ChartCard coin={coin} official />);
    expect(JSON.parse(screen.getByTestId("markers").textContent!).map((marker: { kind: string }) => marker.kind)).toEqual(["platform-buy", "platform-sell", "you-buy"]);
  });
});
