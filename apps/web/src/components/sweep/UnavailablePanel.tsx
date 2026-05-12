"use client";

import { TokenLogo } from "@/components/sweep/TokenLogo";
import { type UnavailableToken } from "@/types/dustsweep";

function reasonText(reason: UnavailableToken["reason"]) {
  if (reason === "NO_LIQUIDITY") return "No liquidity";
  if (reason === "NOT_WHITELISTED") return "Not listed";
  if (reason === "BALANCE_CHANGED") return "Balance changed";
  if (reason === "QUOTE_FAILED") return "Quote failed";
  return "Below threshold";
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 shrink-0">
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path fill="currentColor" d="M7.25 6.5h1.5v5h-1.5zM7.25 4.5h1.5v1.5h-1.5z" />
    </svg>
  );
}

export function UnavailablePanel({
  tokens,
  onClearAll,
}: {
  tokens: UnavailableToken[];
  onClearAll: () => void;
}) {
  if (tokens.length === 0) return null;

  return (
    <div className="rounded-2xl border border-red-100 bg-red-50/60 px-4 py-3">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-red-400">
          Unavailable for sweep
        </h3>
        <button
          type="button"
          onClick={onClearAll}
          className="rounded-full px-2 py-0.5 text-[11px] font-semibold text-red-400 transition-colors hover:bg-red-100 hover:text-red-600"
        >
          Clear All
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {tokens.map((token) => (
          <div
            key={token.address}
            title={reasonText(token.reason)}
            className="group inline-flex h-8 items-center gap-1.5 rounded-full border border-red-200 bg-white px-2.5 text-[11px] font-medium text-slate-600 shadow-sm transition-all hover:border-red-300"
          >
            <TokenLogo token={token} size="sm" muted />
            <span className="font-semibold text-slate-700">{token.symbol}</span>
            <span className="text-red-400">
              <InfoIcon />
            </span>
            <span className="text-slate-300">×</span>
          </div>
        ))}
      </div>
    </div>
  );
}
