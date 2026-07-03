"use client";

import { formatUnits } from "viem";
import { TokenLogo } from "@/components/sweep/TokenLogo";
import { type DustSweepQuoteResponse, type Token } from "@/types/dustsweep";

function formatOutput(quote: DustSweepQuoteResponse | null, token: Token | null) {
  if (!quote || !token) return "";
  try {
    // Router totals deliberately exclude the WETH→ETH unwrap (1:1, fee-free) — add it back
    // for the receive amount the user reads.
    const routerOut = BigInt(quote.netEstimatedOut || quote.totalEstimatedOut || "0");
    const unwrapOut = quote.wethUnwrap ? BigInt(quote.wethUnwrap.amount) : 0n;
    const formatted = formatUnits(routerOut + unwrapOut, token.decimals);
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
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 text-slate-400">
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
  const estimatedUsd = quote
    ? (quote.netEstimatedOutUSD ?? quote.totalEstimatedOutUSD) + (quote.wethUnwrap?.valueUSD ?? 0)
    : null;

  return (
    <section className="sweep-well p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-400 dark:text-slate-500">
          Receive
        </p>
        {balanceUSD > 0 ? (
          <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500">
            Balance ${balanceUSD.toFixed(2)}
          </span>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[30px] font-bold leading-none tracking-[-0.02em] tabular-nums text-slate-900 dark:text-white">
            {output || "0"}
          </p>
          <p
            className={
              estimatedUsd == null
                ? "mt-2 truncate text-[13px] font-medium text-slate-400 dark:text-slate-500"
                : "mt-2 truncate text-[13px] font-semibold text-emerald-600 dark:text-emerald-300"
            }
          >
            {estimatedUsd == null ? "Waiting for route" : `≈ $${estimatedUsd.toFixed(2)} estimated`}
          </p>
        </div>

        <button
          type="button"
          onClick={onOpenSelect}
          className="sweep-select inline-flex h-11 shrink-0 items-center gap-2 px-3 text-[15px] font-bold text-slate-900 dark:text-white"
        >
          {tokenOut ? (
            <TokenLogo token={tokenOut} size="sm" />
          ) : (
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 text-slate-400 dark:bg-white/10">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
              </svg>
            </span>
          )}
          <span>{tokenOut?.symbol || "Select"}</span>
          <ChevronDownIcon />
        </button>
      </div>
    </section>
  );
}
