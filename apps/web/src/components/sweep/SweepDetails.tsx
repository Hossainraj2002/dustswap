"use client";

import { formatUnits } from "viem";
import { type DustSweepQuoteResponse, type Token } from "@/types/dustsweep";

function formatUsd(value: number) {
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

// Format a raw on-chain amount into a human token amount, mirroring the
// RouteDisplay output formatting so the numbers line up across the card.
function formatTokenAmount(raw: string | undefined, tokenOut: Token | null) {
  if (!raw || !tokenOut) return null;
  try {
    const value = formatUnits(BigInt(raw), tokenOut.decimals);
    const num = Number(value);
    // Match the "Receive" panel precision so the two amounts line up: 6-decimal
    // tokens (USDC) show 6 places, everything else (e.g. ETH) shows 8.
    const display = Number.isFinite(num)
      ? num.toLocaleString(undefined, {
          maximumFractionDigits: tokenOut.decimals === 6 ? 6 : 8,
        })
      : value;
    return `${display} ${tokenOut.symbol}`;
  } catch {
    return null;
  }
}

export function SweepDetails({
  quote,
  slippageBps,
  tokenOut,
}: {
  quote: DustSweepQuoteResponse | null;
  slippageBps: number;
  tokenOut: Token | null;
}) {
  if (!quote) return null;

  const maxImpact = quote.routes.reduce(
    (max, route) => Math.max(max, route.priceImpactBps),
    0,
  );
  const impactUsd = ((quote.netEstimatedOutUSD ?? quote.totalEstimatedOutUSD) * maxImpact) / 10_000;

  const minimumReceive = formatTokenAmount(quote.minAmountOut, tokenOut);

  const rows = [
    { label: "Slippage:", value: `${(slippageBps / 100).toFixed(1)}%`, warn: false },
    { label: "Estimated gas fees:", value: `~${formatUsd(quote.gasEstimateUSD)}`, warn: false },
    {
      label: "Price impact:",
      value: `~${formatUsd(impactUsd)} (${(maxImpact / 100).toFixed(2)}%)`,
      warn: maxImpact > 500,
    },
    ...(minimumReceive
      ? [{ label: "Minimum receive:", value: minimumReceive, warn: false }]
      : []),
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
