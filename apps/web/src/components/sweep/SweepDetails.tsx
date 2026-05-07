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

  return (
    <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
      <div className="flex justify-between gap-3 sm:block">
        <dt className="text-slate-500">Slippage</dt>
        <dd className="font-medium text-slate-950">{(slippageBps / 100).toFixed(2)}%</dd>
      </div>
      <div className="flex justify-between gap-3 sm:block">
        <dt className="text-slate-500">Fee</dt>
        <dd className="font-medium text-slate-950">
          ~${quote.feeAmountUSD < 0.01 ? "<0.01" : quote.feeAmountUSD.toFixed(2)} ({quote.feeBps / 100}%)
        </dd>
      </div>
      <div className="flex justify-between gap-3 sm:block">
        <dt className="text-slate-500">Price impact</dt>
        <dd className={maxImpact > 500 ? "font-medium text-red-600" : "font-medium text-slate-950"}>
          {(maxImpact / 100).toFixed(2)}%
        </dd>
      </div>
    </dl>
  );
}
