"use client";

import { formatUnits } from "viem";
import { TokenLogo } from "@/components/sweep/TokenLogo";
import {
  type DustSweepQuoteResponse,
  type SelectedToken,
  type Token,
} from "@/types/dustsweep";

function formatOutput(quote: DustSweepQuoteResponse, tokenOut: Token | null) {
  if (!tokenOut) return "0";
  try {
    const value = formatUnits(BigInt(quote.totalEstimatedOut), tokenOut.decimals);
    const num = Number(value);
    return Number.isFinite(num)
      ? num.toLocaleString(undefined, { maximumFractionDigits: 6 })
      : value;
  } catch {
    return "0";
  }
}

function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5">
      <path
        fill="currentColor"
        d="M13.2 2 4.8 13.1h6.1L9.8 22l8.8-12h-6.3L13.2 2Z"
      />
    </svg>
  );
}

export function RouteDisplay({
  quote,
  tokenOut,
  selectedTokens,
}: {
  quote: DustSweepQuoteResponse | null;
  tokenOut: Token | null;
  selectedTokens: SelectedToken[];
}) {
  if (!quote || !tokenOut) return null;

  const routedSymbols = quote.routes
    .slice(0, 5)
    .map((route) => {
      const token = selectedTokens.find(
        (item) => item.address.toLowerCase() === route.tokenIn.toLowerCase(),
      );
      return {
        token,
        dexName: route.dexName,
      };
    })
    .filter((item) => item.token);

  return (
    <section className="rounded-[8px] border border-blue-200 bg-blue-50 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white">
            <BoltIcon />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold text-slate-950">Smart Routing</p>
              <span className="text-sm text-slate-500">
                {quote.routes.length}/{selectedTokens.length} assets routed
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-4 text-sm text-slate-600">
              <span>Gas ~${quote.gasEstimateUSD.toFixed(2)}</span>
              <span>Time ~2s</span>
            </div>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-lg font-semibold text-slate-950">
            {formatOutput(quote, tokenOut)} {tokenOut.symbol}
          </p>
          <p className="text-sm text-slate-500">
            ~${quote.totalEstimatedOutUSD.toFixed(2)}
          </p>
        </div>
      </div>

      <div className="my-3 h-px bg-blue-200/70" />

      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {routedSymbols.map(({ token, dexName }) => (
          <div key={token!.address} className="flex items-center gap-2 text-sm text-slate-800">
            <TokenLogo token={token!} size="sm" />
            <span className="font-medium">{token!.symbol}</span>
            <span className="text-slate-400">-&gt;</span>
            <span className="rounded-full bg-white px-2 py-1 text-xs font-semibold text-blue-700 ring-1 ring-blue-200">
              {dexName.replace("_", " ")}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
