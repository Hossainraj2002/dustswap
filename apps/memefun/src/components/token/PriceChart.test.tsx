/** @vitest-environment jsdom */
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import PriceChart from "./PriceChart";

const chart = vi.hoisted(() => ({ ranges: [] as ReturnType<typeof vi.fn>[], markers: vi.fn() }));
vi.mock("lightweight-charts", () => ({
  CandlestickSeries: "candles", HistogramSeries: "volume", CrosshairMode: { Magnet: 1 }, LineStyle: { Dashed: 1 },
  createSeriesMarkers: () => ({ setMarkers: chart.markers }),
  createChart: () => {
    const range = vi.fn(); chart.ranges.push(range);
    return { remove: vi.fn(), applyOptions: vi.fn(), priceScale: () => ({ applyOptions: vi.fn() }),
      addSeries: () => ({ applyOptions: vi.fn(), setData: vi.fn(), createPriceLine: vi.fn(), removePriceLine: vi.fn() }),
      timeScale: () => ({ setVisibleLogicalRange: range }) };
  },
}));
const candles = Array.from({ length: 150 }, (_, index) => ({ time: 1_800_000_000 + index * 300, open: 1, high: 2, low: 1, close: 2, volume: 1 }));
const props = { candles, metric: "price" as const, markers: [], height: 280, theme: "dark" as const, viewKey: "coin-pool-300-price" };
beforeEach(() => { chart.ranges = []; chart.markers.mockReset(); });
afterEach(cleanup);

describe("chart view fitting", () => {
  it("fits every recreated chart under StrictMode", () => {
    render(<StrictMode><PriceChart {...props} /></StrictMode>);
    expect(chart.ranges).toHaveLength(2);
    for (const range of chart.ranges) expect(range).toHaveBeenCalledWith({ from: 29.5, to: 153 });
  });

  it("keeps the user's zoom on data refresh and fits once on a market change", () => {
    const page = render(<PriceChart {...props} />);
    const range = chart.ranges[0]!;
    expect(range).toHaveBeenCalledTimes(1);
    page.rerender(<PriceChart {...props} candles={[...candles, { ...candles[149]!, time: 1_800_000_000 + 150 * 300 }]} />);
    expect(range).toHaveBeenCalledTimes(1);
    page.rerender(<PriceChart {...props} viewKey="another-market" />);
    expect(range).toHaveBeenCalledTimes(2);
  });

  it("uses neutral platform markers without changing buy/sell direction or ordinary developer markers", () => {
    document.documentElement.style.setProperty("--mf-tint", "#0052ff");
    document.documentElement.style.setProperty("--mf-warning", "#b22e00");
    render(<PriceChart {...props} markers={[
      { time: 3, kind: "platform-sell" }, { time: 1, kind: "platform-buy" },
      { time: 2, kind: "dev-buy" }, { time: 4, kind: "you-sell" },
      { time: 5, kind: "creator-buy" },
    ]} />);
    expect(chart.markers).toHaveBeenLastCalledWith([
      expect.objectContaining({ time: 1, text: "Platform buy", color: "#0052ff", position: "belowBar", shape: "arrowUp" }),
      expect.objectContaining({ time: 2, text: "Dev buy", color: "#b22e00" }),
      expect.objectContaining({ time: 3, text: "Platform sell", color: "#0052ff", position: "aboveBar", shape: "arrowDown" }),
      expect.objectContaining({ time: 4, text: "You", color: "#0052ff" }),
      expect.objectContaining({ time: 5, text: "Creator buy", color: "#0052ff", position: "belowBar", shape: "arrowUp" }),
    ]);
  });
});
