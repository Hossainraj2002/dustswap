"use client";

import { formatUnits } from "viem";
import { TokenLogo } from "@/components/sweep/TokenLogo";
import { type DustSweepQuoteResponse, type Token } from "@/types/dustsweep";

function formatOutput(quote: DustSweepQuoteResponse | null, token: Token | null) {
  if (!quote || !token) return "";
  try {
    const formatted = formatUnits(BigInt(quote.totalEstimatedOut || "0"), token.decimals);
    const num = Number(formatted);
    if (!Number.isFinite(num)) return formatted;
    return num.toLocaleString(undefined, {
      maximumFractionDigits: token.decimals === 6 ? 6 : 8,
    });
  } catch {
    return "0";
  }
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
    <section className="rounded-[8px] border border-slate-200 bg-white p-4 shadow-sm">
      <p className="mb-3 text-sm font-medium text-slate-500">To</p>
      <div className="rounded-[8px] bg-slate-50 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-mono text-3xl text-slate-950">
              {output || "0"}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              {quote ? `~$${quote.totalEstimatedOutUSD.toFixed(2)} estimated` : "Quote appears here"}
            </p>
          </div>

          <button
            type="button"
            onClick={onOpenSelect}
            className="inline-flex min-h-[44px] shrink-0 items-center gap-2 rounded-[8px] border border-blue-200 bg-white px-3 text-sm font-semibold text-slate-950 shadow-sm transition-colors hover:border-blue-300 hover:bg-blue-50"
          >
            {tokenOut ? <TokenLogo token={tokenOut} size="sm" /> : null}
            {tokenOut?.symbol || "Select"}
            <span className="text-slate-400">v</span>
          </button>
        </div>

        <div className="mt-2 flex justify-end text-sm text-slate-500">
          ${balanceUSD.toFixed(2)} balance
        </div>
      </div>
    </section>
  );
}
