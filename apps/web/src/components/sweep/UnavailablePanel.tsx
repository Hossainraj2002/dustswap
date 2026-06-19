"use client";

import { TokenLogo } from "@/components/sweep/TokenLogo";
import { type UnavailableToken } from "@/types/dustsweep";

function reasonBadge(reason: UnavailableToken["reason"]) {
  if (reason === "NO_LIQUIDITY") return "No liquidity";
  if (reason === "NOT_WHITELISTED") return "Not listed";
  if (reason === "BALANCE_CHANGED") return "Balance changed";
  if (reason === "QUOTE_FAILED") return "No route";
  if (reason === "NATIVE_WRAP_REQUIRED") return "Wrap to WETH";
  if (reason === "OUTPUT_ASSET") return "Output asset";
  if (reason === "UNKNOWN_PRICE") return "No price";
  if (reason === "SPAM_OR_DENYLISTED") return "Blocked";
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
  onRemove,
}: {
  tokens: UnavailableToken[];
  onClearAll: () => void;
  onRemove: (address: string) => void;
}) {
  if (tokens.length === 0) return null;

  return (
    <div className="rounded-[16px] border border-slate-200/70 bg-white px-3.5 py-3 shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:border-white/10 dark:bg-white/[0.04]">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-semibold text-slate-600 dark:text-slate-300">Hidden or unavailable</h3>
        <button
          type="button"
          onClick={onClearAll}
          className="min-h-0 rounded-[9px] px-2 py-1 text-sm font-semibold text-[#0052ff] transition hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-400/10"
        >
          Clear all
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {tokens.map((token) => (
          <div
            key={token.address}
            title={reasonBadge(token.reason)}
            className="inline-flex h-[32px] items-center gap-1.5 rounded-[10px] border border-slate-200 bg-slate-50 pl-1.5 pr-1 text-sm text-slate-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300"
          >
            <TokenLogo token={token} size="sm" muted />
            <span className="font-semibold">{token.symbol}</span>
            <span className="text-red-400">
              <InfoIcon />
            </span>
            <button
              type="button"
              onClick={() => onRemove(token.address)}
              className="flex h-6 w-6 items-center justify-center rounded-[8px] text-slate-400 transition hover:bg-slate-200 hover:text-slate-900 dark:hover:bg-white/10 dark:hover:text-white"
              aria-label={`Remove unavailable ${token.symbol}`}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
