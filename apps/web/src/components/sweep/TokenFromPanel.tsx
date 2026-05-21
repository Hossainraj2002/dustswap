"use client";

import { TokenLogo } from "@/components/sweep/TokenLogo";
import { type SelectedToken } from "@/types/dustsweep";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function formatAmount(value: string) {
  const num = Number(value);
  if (!Number.isFinite(num) || num === 0) return "0";
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 10_000) return num.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (num >= 1) return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (num >= 0.001) return num.toPrecision(4);
  return num.toExponential(2);
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5">
      <path
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
        d="M12 8.3a3.7 3.7 0 1 1 0 7.4 3.7 3.7 0 0 1 0-7.4Zm7.2 4.9a7.8 7.8 0 0 0 .05-1.2l2-1.55-2-3.46-2.42.98a8.2 8.2 0 0 0-1.04-.6L15.43 4h-4l-.36 3.36c-.37.17-.72.37-1.05.6L7.6 6.99l-2 3.46L7.6 12a8.03 8.03 0 0 0 0 1.2l-2 1.55 2 3.46 2.42-.98c.33.23.68.43 1.05.6l.36 3.36h4l.36-3.36c.36-.17.71-.37 1.04-.6l2.42.98 2-3.46-2.05-1.55Z"
      />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5">
      <path
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        d="m6 9 6 6 6-6"
      />
    </svg>
  );
}

export function TokenFromPanel({
  selectedTokens,
  onRemove,
  onClearAll,
  onAddMore,
  autoMode,
  onToggleAuto,
  onOpenSettings,
  routeMaxCap,
  failedTokenAddresses,
}: {
  selectedTokens: SelectedToken[];
  onRemove: (address: string) => void;
  onClearAll: () => void;
  onAddMore: () => void;
  autoMode: boolean;
  onToggleAuto: () => void;
  onOpenSettings: () => void;
  routeMaxCap: number;
  failedTokenAddresses: string[];
}) {
  const failedSet = new Set(failedTokenAddresses.map((address) => address.toLowerCase()));
  const sorted = [...selectedTokens].sort((a, b) => (b.valueUSD ?? 0) - (a.valueUSD ?? 0));

  return (
    <section className="rounded-[8px] border border-slate-200 bg-white px-3 py-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-slate-600">From:</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClearAll}
            disabled={selectedTokens.length === 0}
            className="min-h-0 rounded-[6px] px-1.5 py-1 text-sm font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40"
          >
            Clear all
          </button>
          <button
            type="button"
            onClick={onToggleAuto}
            className={cx(
              "min-h-0 rounded-[6px] px-1.5 py-1 text-sm font-semibold transition",
              autoMode ? "bg-yellow-200 text-slate-950" : "text-yellow-700 hover:bg-yellow-50",
            )}
          >
            Auto
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-slate-400 transition hover:bg-slate-100 hover:text-slate-800"
            aria-label="Sweep settings"
            title="Settings"
          >
            <SettingsIcon />
          </button>
        </div>
      </div>

      <div className="min-h-[100px] rounded-[8px] bg-slate-50 p-2">
        {sorted.length === 0 ? (
          <div className="flex min-h-[58px] items-center justify-center rounded-[6px] border border-dashed border-slate-200 text-sm text-slate-400">
            Select tokens or use Auto
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {sorted.map((token) => {
              const failed = failedSet.has(token.address.toLowerCase());

              return (
                <div
                  key={token.address}
                  className={cx(
                    "inline-flex h-[30px] max-w-full items-center gap-1.5 rounded-[7px] border px-1.5 text-sm shadow-sm",
                    failed
                      ? "border-red-200 bg-red-50 text-red-800"
                      : "border-yellow-200 bg-yellow-50 text-slate-900",
                  )}
                  title={failed ? `${token.symbol} has no current route` : token.symbol}
                >
                  <TokenLogo token={token} size="sm" muted={failed} />
                  <span className="max-w-[92px] truncate font-medium">
                    {formatAmount(token.balanceFormatted)}
                  </span>
                  <span className="max-w-[58px] truncate text-xs text-slate-500">{token.symbol}</span>
                  <button
                    type="button"
                    onClick={() => onRemove(token.address)}
                    className={cx(
                      "flex h-6 w-6 items-center justify-center rounded-[6px] text-lg leading-none transition",
                      failed ? "text-red-400 hover:bg-red-100 hover:text-red-700" : "text-yellow-700 hover:bg-yellow-100",
                    )}
                    aria-label={`Remove ${token.symbol}`}
                  >
                    &times;
                  </button>
                </div>
              );
            })}
            {selectedTokens.length < routeMaxCap ? (
              <button
                type="button"
                onClick={onAddMore}
                className="inline-flex h-[30px] items-center gap-1.5 rounded-[7px] bg-white px-3 text-xs font-medium text-slate-500 shadow-sm ring-1 ring-slate-200 transition hover:bg-yellow-50 hover:text-slate-900 hover:ring-yellow-200"
              >
                Add more assets
                <ChevronDownIcon />
              </button>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
