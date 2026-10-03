"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { formatPercent, formatSmallNumber, formatUsd } from "@/core/format";
import { COIN_SUPPLY_HUMAN } from "@/core/constants";
import { useIsRegularWidth } from "@/lib/hooks";
import { useCandles, useTrades } from "@/lib/market/hooks";
import { CANDLE_INTERVALS, type CandleInterval, type Coin } from "@/lib/market/types";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { useTheme } from "@/components/theme/ThemeProvider";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Skeleton } from "@/components/ui/display";
import type { ChartMarker } from "./PriceChart";

const PriceChart = dynamic(() => import("./PriceChart"), {
  ssr: false,
  loading: () => <Skeleton className="h-[300px] w-full rounded-md" />,
});

export function ChartCard({ coin }: { coin: Coin }) {
  const regular = useIsRegularWidth();
  const { resolvedTheme } = useTheme();
  const wallet = useWallet();
  const [interval, setInterval] = useState<CandleInterval>(300);
  const [metric, setMetric] = useState<"price" | "mcap">("mcap");
  const candles = useCandles(coin.address, interval, metric);
  const trades = useTrades(coin.address, 400);

  const markers = useMemo<ChartMarker[]>(() => {
    const result: ChartMarker[] = [];
    const seen = new Set<string>();
    for (const trade of trades) {
      const mine = wallet.address !== null && trade.trader === wallet.address;
      if (!trade.isCreator && !mine) continue;
      const time = Math.floor(trade.ts / 1000 / interval) * interval;
      const kind = `${mine ? "you" : "dev"}-${trade.side}` as ChartMarker["kind"];
      const key = `${time}-${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ time, kind });
    }
    return result;
  }, [trades, wallet.address, interval]);

  const floorValue =
    coin.terms.mode === "floor" && coin.stats.floorPriceUsd > 0
      ? metric === "price"
        ? coin.stats.floorPriceUsd
        : coin.stats.floorPriceUsd * (COIN_SUPPLY_HUMAN - coin.stats.burnedCoins)
      : undefined;

  const last = candles[candles.length - 1];
  const first = candles[0];
  const summary = last
    ? `${metric === "price" ? "Price" : "Market cap"} chart, ${CANDLE_INTERVALS.find((entry) => entry.value === interval)?.label} candles. Latest ${
        metric === "price" ? `$${formatSmallNumber(last.close)}` : formatUsd(last.close, { compact: true })
      }${first ? `, ${formatPercent(last.close / first.open - 1, { signed: true })} over the period shown` : ""}.`
    : "No trades yet.";

  return (
    <section aria-label="Chart" className="mf-card flex flex-col gap-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          label="Chart value"
          size="sm"
          value={metric}
          onChange={setMetric}
          segments={[
            { value: "mcap", label: "Market cap" },
            { value: "price", label: "Price" },
          ]}
        />
        <SegmentedControl<string>
          label="Candle interval"
          size="sm"
          value={String(interval)}
          onChange={(value) => setInterval(Number(value) as CandleInterval)}
          segments={CANDLE_INTERVALS.map((entry) => ({ value: String(entry.value), label: entry.label }))}
        />
      </div>
      <figure className="m-0">
        <PriceChart
          candles={candles}
          metric={metric}
          markers={markers}
          floorValue={floorValue}
          height={regular ? 360 : 280}
          theme={resolvedTheme}
          viewKey={`${coin.address}-${interval}-${metric}`}
        />
        <figcaption className="sr-only">{summary}</figcaption>
      </figure>
    </section>
  );
}
