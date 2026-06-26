"use client";

import { formatUnits } from "viem";
import { type DustSweepQuoteResponse, type Token } from "@/types/dustsweep";

function formatUsd(value: number) {
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

// The `minAmountOut` the API returns is the router's per-batch revert floor — for
// the V3 best-effort lane that's the single SMALLEST leg, so one refunded dust
// route can't revert the whole sweep. That floor is a tiny fraction of what the
// user actually receives, so surfacing it as "Minimum receive" is misleading
// (e.g. 0.0002 ETH against a 0.0089 ETH output). Instead, sum every route's own
// per-leg slippage floor and net out the protocol fee, mirroring the (net)
// "Receive" amount's basis so the two numbers are consistent.
function getMinimumReceiveRaw(quote: DustSweepQuoteResponse): string | null {
  if (quote.routes.length === 0) return null;
  try {
    const grossMin = quote.routes.reduce(
      (sum, route) => sum + BigInt(route.amountOutMin),
      0n,
    );
    if (grossMin <= 0n) return null;
    const feeBps = BigInt(Math.max(0, Math.round(quote.feeBps ?? 0)));
    const netMin = grossMin - (grossMin * feeBps) / 10_000n;
    return netMin.toString();
  } catch {
    return null;
  }
}

// Format a raw on-chain amount into a human token amount, mirroring the
// RouteDisplay output formatting so the numbers line up across the card.
function formatTokenAmount(raw: string | undefined | null, tokenOut: Token | null) {
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

  const minimumReceive = formatTokenAmount(getMinimumReceiveRaw(quote), tokenOut);

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
