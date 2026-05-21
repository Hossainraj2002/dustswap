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
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5 text-slate-500">
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
  const estimatedUsd = quote ? quote.netEstimatedOutUSD ?? quote.totalEstimatedOutUSD : null;

  return (
    <section className="rounded-[8px] border border-slate-200 bg-white px-3 py-3 shadow-sm">
      <p className="mb-2 text-sm font-medium text-slate-600">To:</p>
      <div className="rounded-[8px] bg-slate-50 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-mono text-[28px] font-semibold leading-none text-slate-950">
              {output || "0"}
            </p>
            <p className="mt-2 truncate text-sm text-slate-500">
              {estimatedUsd == null ? "Waiting for route" : `~$${estimatedUsd.toFixed(2)} estimated`}
            </p>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <button
              type="button"
              onClick={onOpenSelect}
              className="inline-flex h-9 items-center gap-1.5 rounded-[7px] border border-yellow-300 bg-yellow-50 px-2 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-yellow-100"
            >
              {tokenOut ? <TokenLogo token={tokenOut} size="sm" /> : null}
              <span>{tokenOut?.symbol || "Select"}</span>
              <ChevronDownIcon />
            </button>
            <span className="text-xs text-slate-500">${balanceUSD.toFixed(2)}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
