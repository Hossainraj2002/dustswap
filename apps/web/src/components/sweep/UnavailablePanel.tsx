"use client";

import { TokenLogo } from "@/components/sweep/TokenLogo";
import { type UnavailableToken } from "@/types/dustsweep";

function reasonBadge(reason: UnavailableToken["reason"]) {
  if (reason === "NO_LIQUIDITY") return "No liquidity";
  if (reason === "NOT_WHITELISTED") return "Not listed";
  if (reason === "BALANCE_CHANGED") return "Balance changed";
  if (reason === "QUOTE_FAILED") return "No route";
  return "Too small";
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3 w-3 shrink-0">
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
    <div className="rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
          </svg>
          Not Sweepable
        </h3>
        <button
          type="button"
          onClick={onClearAll}
          className="rounded-full px-2 py-0.5 text-[11px] font-semibold text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-600"
        >
          Clear
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {tokens.map((token) => (
          <div
            key={token.address}
            title={reasonBadge(token.reason)}
            className="group inline-flex h-7 items-center gap-1 rounded-full border border-slate-200 bg-white px-2 text-[10px] font-medium text-slate-500 shadow-sm"
          >
            <TokenLogo token={token} size="sm" muted />
            <span className="font-semibold text-slate-600">{token.symbol}</span>
            <span className="text-slate-300">
              <InfoIcon />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
