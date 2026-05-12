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
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
      <path
        fill="currentColor"
        d="M13.2 2 4.8 13.1h6.1L9.8 22l8.8-12h-6.3L13.2 2Z"
      />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3 w-3 shrink-0 text-slate-300">
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="m6 3 5 5-5 5" />
    </svg>
  );
}

function GasIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5">
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8"
        d="M3 20V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3.5l2 1V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Zm4-10h6M7 14h4" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M12 7v5l3 3" />
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
    .slice(0, 6)
    .map((route) => {
      const token = selectedTokens.find(
        (item) => item.address.toLowerCase() === route.tokenIn.toLowerCase(),
      );
      return { token, dexName: route.dexName };
    })
    .filter((item) => item.token);

  const remainder = quote.routes.length - 6;

  return (
    <div className="overflow-hidden rounded-2xl border border-blue-200 bg-gradient-to-br from-blue-50 to-indigo-50 shadow-sm">
      {/* Top row: routing header + output */}
      <div className="flex items-start justify-between gap-4 px-4 pt-4 pb-3">
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white shadow-sm">
            <BoltIcon />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-slate-800">Smart Routing</p>
              <span className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-semibold text-blue-600 ring-1 ring-blue-200">
                {quote.routes.length}/{selectedTokens.length} assets
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
              <span className="flex items-center gap-1">
                <GasIcon />
                ~${quote.gasEstimateUSD.toFixed(2)}
              </span>
              <span className="flex items-center gap-1">
                <ClockIcon />
                ~2s
              </span>
            </div>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-base font-bold text-slate-900">
            {formatOutput(quote, tokenOut)} {tokenOut.symbol}
          </p>
          <p className="text-[11px] text-slate-500">~${quote.totalEstimatedOutUSD.toFixed(2)}</p>
        </div>
      </div>

      {/* Divider */}
      <div className="mx-4 h-px bg-blue-200/60" />

      {/* Token route path */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 px-4 py-3">
        {routedSymbols.map(({ token, dexName }, index) => (
          <div key={token!.address} className="flex items-center gap-1.5">
            {index > 0 && <ArrowIcon />}
            <div className="flex items-center gap-1 rounded-full border border-white bg-white/90 py-0.5 pl-1 pr-2 shadow-sm ring-1 ring-blue-100">
              <TokenLogo token={token!} size="sm" />
              <span className="text-[10px] font-semibold text-slate-700">{token!.symbol}</span>
            </div>
            <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-indigo-600">
              {dexName.replace(/_/g, " ")}
            </span>
          </div>
        ))}
        {remainder > 0 && (
          <span className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-medium text-slate-500 ring-1 ring-blue-100">
            +{remainder} more
          </span>
        )}
        <ArrowIcon />
        <div className="flex items-center gap-1 rounded-full border border-blue-300 bg-blue-600 py-0.5 pl-1 pr-2 shadow-sm">
          <TokenLogo token={tokenOut} size="sm" />
          <span className="text-[10px] font-semibold text-white">{tokenOut.symbol}</span>
        </div>
      </div>
    </div>
  );
}
