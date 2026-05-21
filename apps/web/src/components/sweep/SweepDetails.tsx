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
    <dl className="flex flex-col gap-1.5">
      {rows.map(({ label, value, warn }) => (
        <div key={label} className="flex items-center justify-between gap-3">
          <dt className="text-sm text-slate-500">{label}</dt>
          <dd className={`text-sm font-medium ${warn ? "text-red-600" : "text-slate-900"}`}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
