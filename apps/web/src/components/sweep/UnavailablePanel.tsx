"use client";

import { TokenLogo } from "@/components/sweep/TokenLogo";
import { type UnavailableToken } from "@/types/dustsweep";

function reasonBadge(reason: UnavailableToken["reason"]) {
  if (reason === "NO_LIQUIDITY") return "No liquidity";
  if (reason === "NOT_WHITELISTED") return "Not listed";
  if (reason === "BALANCE_CHANGED") return "Balance changed";
  if (reason === "QUOTE_FAILED") return "No route";
  if (reason === "NATIVE_WRAP_REQUIRED") return "Wrap to WETH";
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
    <div className="rounded-[8px] bg-white px-3 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-slate-600">Unavailable for sweep:</h3>
        <button
          type="button"
          onClick={onClearAll}
          className="min-h-0 rounded-[6px] px-1.5 py-1 text-sm font-medium text-blue-700 transition hover:bg-blue-50"
        >
          Clear All
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {tokens.map((token) => (
          <div
            key={token.address}
            title={reasonBadge(token.reason)}
            className="inline-flex h-[30px] items-center gap-1.5 rounded-[7px] border border-slate-200 bg-slate-50 px-1.5 text-sm text-slate-600 shadow-sm"
          >
            <TokenLogo token={token} size="sm" muted />
            <span className="font-semibold">{token.symbol}</span>
            <span className="text-red-400">
              <InfoIcon />
            </span>
            <button
              type="button"
              onClick={() => onRemove(token.address)}
              className="flex h-6 w-6 items-center justify-center rounded-[6px] text-lg leading-none text-slate-500 transition hover:bg-slate-200 hover:text-slate-900"
              aria-label={`Remove unavailable ${token.symbol}`}
            >
              &times;
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
