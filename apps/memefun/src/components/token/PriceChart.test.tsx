/** @vitest-environment jsdom */
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import PriceChart from "./PriceChart";

const chart = vi.hoisted(() => ({ ranges: [] as ReturnType<typeof vi.fn>[] }));
vi.mock("lightweight-charts", () => ({
  CandlestickSeries: "candles", HistogramSeries: "volume", CrosshairMode: { Magnet: 1 }, LineStyle: { Dashed: 1 },
  createSeriesMarkers: () => ({ setMarkers: vi.fn() }),
  createChart: () => {
    const range = vi.fn(); chart.ranges.push(range);
    return { remove: vi.fn(), applyOptions: vi.fn(), priceScale: () => ({ applyOptions: vi.fn() }),
      addSeries: () => ({ applyOptions: vi.fn(), setData: vi.fn(), createPriceLine: vi.fn(), removePriceLine: vi.fn() }),
      timeScale: () => ({ setVisibleLogicalRange: range }) };
  },
}));
const candles = Array.from({ length: 150 }, (_, index) => ({ time: 1_800_000_000 + index * 300, open: 1, high: 2, low: 1, close: 2, volume: 1 }));
const props = { candles, metric: "price" as const, markers: [], height: 280, theme: "dark" as const, viewKey: "coin-pool-300-price" };
beforeEach(() => { chart.ranges = []; });
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
});
