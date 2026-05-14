"use client";

import { type DustSweepQuoteResponse } from "@/types/dustsweep";

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

  const rows = [
    {
      label: "Gross output",
      value: `~$${quote.totalEstimatedOutUSD.toFixed(2)}`,
      warn: false,
    },
    { label: "Slippage", value: `${(slippageBps / 100).toFixed(2)}%`, warn: false },
    {
      label: "Protocol fee",
      value: `~$${quote.feeAmountUSD < 0.01 ? "<0.01" : quote.feeAmountUSD.toFixed(2)} (${quote.feeBps / 100}%)`,
      warn: false,
    },
    {
      label: "Net receive",
      value: `~$${(quote.netEstimatedOutUSD ?? quote.totalEstimatedOutUSD - quote.feeAmountUSD).toFixed(2)}`,
      warn: false,
    },
    {
      label: "Price impact",
      value: `${(maxImpact / 100).toFixed(2)}%`,
      warn: maxImpact > 500,
    },
  ];

  return (
    <dl className="flex flex-col gap-2">
      {rows.map(({ label, value, warn }) => (
        <div key={label} className="flex items-center justify-between gap-3">
          <dt className="text-xs text-slate-400">{label}</dt>
          <dd className={`text-xs font-semibold ${warn ? "text-red-600" : "text-slate-700"}`}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
