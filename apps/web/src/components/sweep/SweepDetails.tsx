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
  try {
    // WETH→ETH unwrap is exact 1:1 with no fee or slippage — it adds directly to the floor.
    const unwrapMin = quote.wethUnwrap ? BigInt(quote.wethUnwrap.amount) : 0n;
    if (quote.routes.length === 0) {
      return unwrapMin > 0n ? unwrapMin.toString() : null;
    }
    const grossMin = quote.routes.reduce(
      (sum, route) => sum + BigInt(route.amountOutMin),
      0n,
    );
    if (grossMin <= 0n && unwrapMin <= 0n) return null;
    const feeBps = BigInt(Math.max(0, Math.round(quote.feeBps ?? 0)));
    const netMin = grossMin - (grossMin * feeBps) / 10_000n;
    return (netMin + unwrapMin).toString();
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

  // Worst route impact, counting only routes whose impact was actually computed against a
  // market reference price. When none was, say "Unknown" instead of pretending it's ~0%.
  const maxImpact =
    quote.maxPriceImpactBps ??
    quote.routes.reduce(
      (max, route) => (route.priceImpactKnown === false ? max : Math.max(max, route.priceImpactBps)),
      0,
    );
  const impactUnknown =
    quote.routes.length > 0 &&
    quote.routes.every((route) => route.priceImpactKnown === false);
  // Dollar loss vs market value: out = expected × (1 - impact) → loss = out × impact / (1 - impact).
  const outUsd = quote.netEstimatedOutUSD ?? quote.totalEstimatedOutUSD;
  const impactUsd = maxImpact < 10_000 ? (outUsd * maxImpact) / (10_000 - maxImpact) : outUsd;

  const minimumReceive = formatTokenAmount(getMinimumReceiveRaw(quote), tokenOut);

  const rows = [
    { label: "Slippage:", value: `${(slippageBps / 100).toFixed(1)}%`, warn: false },
    { label: "Estimated gas fees:", value: `~${formatUsd(quote.gasEstimateUSD)}`, warn: false },
    {
      label: "Price impact:",
      value: impactUnknown
        ? "Unknown"
        : `~${formatUsd(impactUsd)} (${(maxImpact / 100).toFixed(2)}%)`,
      warn: !impactUnknown && maxImpact > 500,
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
