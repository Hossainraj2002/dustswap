"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { formatCompact, formatSmallNumber } from "@/core/format";
import type { Candle } from "@/lib/market/types";

export interface ChartMarker {
  time: number;
  kind: "dev-buy" | "dev-sell" | "you-buy" | "you-sell";
}

interface PriceChartProps {
  candles: Candle[];
  metric: "price" | "mcap";
  markers: ChartMarker[];
  /** Floor-mode coins: the price (or market cap) the floor supports. */
  floorValue?: number;
  height: number;
  theme: "light" | "dark";
  /** Changes when the interval or coin changes, to re-fit the view. */
  viewKey: string;
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The chart library parses colors itself, so translucency is applied here. */
function withAlpha(color: string, alpha: number) {
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (!hex?.[1]) return color;
  const n = Number.parseInt(hex[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function formatValue(value: number, metric: "price" | "mcap") {
  if (!Number.isFinite(value)) return "";
  return metric === "price" ? `$${formatSmallNumber(value)}` : `$${formatCompact(value)}`;
}

function minMoveFor(candles: Candle[], metric: "price" | "mcap") {
  if (metric === "mcap") return 1;
  const smallest = candles.reduce((min, candle) => (candle.low > 0 ? Math.min(min, candle.low) : min), Infinity);
  if (!Number.isFinite(smallest)) return 1e-12;
  return 10 ** (Math.floor(Math.log10(smallest)) - 4);
}

export default function PriceChart({ candles, metric, markers, floorValue, height, theme, viewKey }: PriceChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const floorRef = useRef<IPriceLine | null>(null);
  const fittedKey = useRef<string>("");

  // Create once.
  useEffect(() => {
    if (!container.current) return;
    const chart = createChart(container.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, attributionLogo: true, fontFamily: getComputedStyle(document.body).fontFamily, fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { visible: true } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { mode: CrosshairMode.Magnet },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, { borderVisible: false, priceLineVisible: true });
    const volumeSeries = chart.addSeries(HistogramSeries, { priceScaleId: "volume", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chartRef.current = chart;
    fittedKey.current = "";
    candleRef.current = candleSeries;
    volumeRef.current = volumeSeries;
    markersRef.current = createSeriesMarkers(candleSeries, []);
    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      markersRef.current = null;
      floorRef.current = null;
    };
  }, []);

  // Theme colors come from the design tokens.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !candleRef.current) return;
    const up = cssVar("--mf-up-fill");
    const down = cssVar("--mf-down-fill");
    chart.applyOptions({
      layout: { textColor: cssVar("--mf-label-2") },
      grid: { horzLines: { color: cssVar("--mf-separator") } },
      crosshair: { vertLine: { color: cssVar("--mf-label-3"), labelBackgroundColor: cssVar("--mf-tint-fill") }, horzLine: { color: cssVar("--mf-label-3"), labelBackgroundColor: cssVar("--mf-tint-fill") } },
    });
    candleRef.current.applyOptions({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down });
  }, [theme]);

  // Data.
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleRef.current;
    const volumeSeries = volumeRef.current;
    if (!chart || !candleSeries || !volumeSeries) return;
    candleSeries.applyOptions({
      priceFormat: { type: "custom", minMove: minMoveFor(candles, metric), formatter: (value: number) => formatValue(value, metric) },
    });
    const up = cssVar("--mf-up-fill");
    const down = cssVar("--mf-down-fill");
    candleSeries.setData(
      candles.map((candle) => ({ time: candle.time as UTCTimestamp, open: candle.open, high: candle.high, low: candle.low, close: candle.close })),
    );
    volumeSeries.setData(
      candles.map((candle) => ({
        time: candle.time as UTCTimestamp,
        value: candle.volume,
        color: withAlpha(candle.close >= candle.open ? up : down, 0.38),
      })),
    );
    if (fittedKey.current !== viewKey && candles.length > 0) {
      fittedKey.current = viewKey;
      const visible = Math.min(candles.length, 120);
      chart.timeScale().setVisibleLogicalRange({ from: candles.length - visible - 0.5, to: candles.length + 3 });
    }
  }, [candles, metric, viewKey]);

  // Markers for creator and own trades.
  useEffect(() => {
    if (!markersRef.current) return;
    const items: SeriesMarker<Time>[] = markers
      .slice()
      .sort((a, b) => a.time - b.time)
      .map((marker) => {
        const buy = marker.kind.endsWith("buy");
        const you = marker.kind.startsWith("you");
        return {
          time: marker.time as UTCTimestamp,
          position: buy ? "belowBar" : "aboveBar",
          shape: buy ? "arrowUp" : "arrowDown",
          color: you ? cssVar("--mf-tint") : cssVar("--mf-warning"),
          text: you ? "You" : buy ? "Dev buy" : "Dev sell",
        };
      });
    markersRef.current.setMarkers(items);
  }, [markers, theme]);

  // Floor line.
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    if (floorRef.current) {
      series.removePriceLine(floorRef.current);
      floorRef.current = null;
    }
    if (floorValue && floorValue > 0) {
      floorRef.current = series.createPriceLine({
        price: floorValue,
        color: cssVar("--mf-mode-floor"),
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "Floor",
      });
    }
  }, [floorValue, theme]);

  return <div ref={container} style={{ height }} className="w-full" />;
}
