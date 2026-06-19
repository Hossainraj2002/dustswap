"use client";

import { type DustSweepQuoteResponse } from "@/types/dustsweep";

function formatUsd(value: number) {
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

export function SweepDetails({
  quote,
  slippageBps,
}: {
  quote: DustSweepQuoteResponse | null;
  slippageBps: number;
}) {
  if (!quote) return null;

  const maxImpact = quote.routes.reduce(
    (max, route) => Math.max(max, route.priceImpactBps),
    0,
  );
  const impactUsd = ((quote.netEstimatedOutUSD ?? quote.totalEstimatedOutUSD) * maxImpact) / 10_000;

  const rows = [
    { label: "Slippage:", value: `${(slippageBps / 100).toFixed(1)}%`, warn: false },
    { label: "Fee:", value: `~${formatUsd(quote.feeAmountUSD)}`, warn: false },
    {
      label: "Price impact:",
      value: `~${formatUsd(impactUsd)} (${(maxImpact / 100).toFixed(2)}%)`,
      warn: maxImpact > 500,
    },
  ];

  return (
    <dl className="flex flex-col gap-2">
      {rows.map(({ label, value, warn }) => (
        <div key={label} className="flex items-center justify-between gap-3">
          <dt className="text-[13px] text-slate-500 dark:text-slate-400">{label}</dt>
          <dd
            className={`text-[13px] font-semibold tabular-nums ${
              warn ? "text-red-600 dark:text-red-300" : "text-slate-900 dark:text-white"
            }`}
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
