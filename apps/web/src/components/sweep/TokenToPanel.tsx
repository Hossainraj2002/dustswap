"use client";

import { formatUnits } from "viem";
import { TokenLogo } from "@/components/sweep/TokenLogo";
import { type DustSweepQuoteResponse, type Token } from "@/types/dustsweep";

function formatOutput(quote: DustSweepQuoteResponse | null, token: Token | null) {
  if (!quote || !token) return "";
  try {
    const formatted = formatUnits(BigInt(quote.netEstimatedOut || quote.totalEstimatedOut || "0"), token.decimals);
    const num = Number(formatted);
    if (!Number.isFinite(num)) return formatted;
    return num.toLocaleString(undefined, {
      maximumFractionDigits: token.decimals === 6 ? 6 : 8,
    });
  } catch {
    return "0";
  }
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5 text-slate-400">
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function TokenToPanel({
  tokenOut,
  quote,
  balanceUSD,
  onOpenSelect,
}: {
  tokenOut: Token | null;
  quote: DustSweepQuoteResponse | null;
  balanceUSD: number;
  onOpenSelect: () => void;
}) {
  const output = formatOutput(quote, tokenOut);

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="px-4 pb-3 pt-3.5">
        <p className="mb-2.5 text-sm font-semibold text-slate-700">To</p>
        <div className="rounded-xl bg-slate-50/80 px-3.5 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-mono text-3xl font-bold tracking-tight text-slate-900">
                {output || "0"}
              </p>
              <p className="mt-1 text-xs">
                {quote ? (
                  <span className="font-medium text-emerald-600">
                    ~${(quote.netEstimatedOutUSD ?? quote.totalEstimatedOutUSD).toFixed(2)} net estimated
                  </span>
                ) : (
                  <span className="text-slate-400">Quote appears here</span>
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={onOpenSelect}
              className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-blue-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-800 shadow-sm transition-all hover:border-blue-400 hover:bg-blue-50 hover:shadow-md"
            >
              {tokenOut ? <TokenLogo token={tokenOut} size="sm" /> : null}
              <span>{tokenOut?.symbol || "Select"}</span>
              <ChevronDownIcon />
            </button>
          </div>
          <div className="mt-2.5 flex items-center justify-end gap-1 text-xs text-slate-400">
            <span>${balanceUSD.toFixed(2)} balance</span>
          </div>
        </div>
      </div>
    </section>
  );
}
