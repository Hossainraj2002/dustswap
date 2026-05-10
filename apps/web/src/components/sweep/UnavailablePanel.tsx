"use client";

import { TokenLogo } from "@/components/sweep/TokenLogo";
import { type UnavailableToken } from "@/types/dustsweep";

function reasonText(reason: UnavailableToken["reason"]) {
  if (reason === "NO_LIQUIDITY") return "No liquidity";
  if (reason === "NOT_WHITELISTED") return "Not whitelisted";
  if (reason === "BALANCE_CHANGED") return "Balance changed";
  if (reason === "QUOTE_FAILED") return "Quote failed";
  return "Below threshold";
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
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-medium text-slate-500">Unavailable for sweep</h3>
        <button
          type="button"
          onClick={onClearAll}
          className="rounded-full px-2 text-sm font-semibold text-blue-600 transition-colors hover:bg-blue-50"
        >
          Clear All
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {tokens.map((token) => (
          <div
            key={token.address}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-[8px] bg-slate-100 px-2.5 text-sm text-slate-600"
            title={reasonText(token.reason)}
          >
            <TokenLogo token={token} size="sm" muted />
            <span className="font-medium">{token.symbol}</span>
            <span className="flex h-5 w-5 items-center justify-center rounded-full border border-red-200 text-xs font-semibold text-red-600">
              i
            </span>
            <span className="text-slate-400">&times;</span>
          </div>
        ))}
      </div>
    </section>
  );
}
