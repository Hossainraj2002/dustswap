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
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[18px] w-[18px]">
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

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
      <path
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        d="M12 5v14M5 12h14"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5">
      <path
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.2"
        d="M6 6l12 12M18 6 6 18"
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
    <section className="sweep-well p-3">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-400 dark:text-slate-500">
          Sweep from
        </p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onClearAll}
            disabled={selectedTokens.length === 0}
            className="min-h-0 rounded-[9px] px-2 py-1 text-xs font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={onToggleAuto}
            className={cx(
              "min-h-0 rounded-[9px] px-2.5 py-1 text-xs font-bold transition",
              autoMode
                ? "bg-[#0052ff] text-white shadow-[0_4px_10px_-2px_rgba(0,82,255,0.5)]"
                : "text-[#0052ff] hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-400/10",
            )}
          >
            Auto
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex h-7 w-7 items-center justify-center rounded-[9px] text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white"
            aria-label="Sweep settings"
            title="Settings"
          >
            <SettingsIcon />
          </button>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="flex min-h-[64px] items-center justify-between gap-3 rounded-[14px] border border-dashed border-blue-200/70 bg-white/60 px-3.5 py-3 dark:border-blue-400/20 dark:bg-white/[0.03]">
          <div className="min-w-0">
            <p className="text-[26px] font-bold leading-none tabular-nums text-slate-900 dark:text-white">0</p>
            <p className="mt-1.5 truncate text-[13px] text-slate-500 dark:text-slate-400">
              Select tokens or use Auto
            </p>
          </div>
          <button
            type="button"
            onClick={onAddMore}
            className="sweep-select inline-flex h-11 shrink-0 items-center gap-2 px-3.5 text-sm font-semibold text-[#0052ff] dark:text-blue-300"
          >
            <PlusIcon />
            Select tokens
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {sorted.map((token) => {
            const failed = failedSet.has(token.address.toLowerCase());

            return (
              <div
                key={token.address}
                className={cx(
                  "inline-flex h-[34px] max-w-full items-center gap-1.5 rounded-[11px] pl-1.5 pr-1 text-sm",
                  failed
                    ? "border border-red-200 bg-red-50 text-red-800 dark:border-red-400/30 dark:bg-red-400/10"
                    : "sweep-chip text-slate-900 dark:text-white",
                )}
                title={failed ? `${token.symbol} has no current route` : token.symbol}
              >
                <TokenLogo token={token} size="sm" muted={failed} />
                <span className="max-w-[92px] truncate font-semibold tabular-nums">
                  {formatAmount(token.balanceFormatted)}
                </span>
                <span className="max-w-[58px] truncate text-xs font-medium text-slate-400 dark:text-slate-500">
                  {token.symbol}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(token.address)}
                  className={cx(
                    "flex h-6 w-6 items-center justify-center rounded-[8px] transition",
                    failed
                      ? "text-red-400 hover:bg-red-100 hover:text-red-700 dark:hover:bg-red-400/20"
                      : "text-slate-300 hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-white/10 dark:hover:text-white",
                  )}
                  aria-label={`Remove ${token.symbol}`}
                >
                  <CloseIcon />
                </button>
              </div>
            );
          })}
          {selectedTokens.length < routeMaxCap ? (
            <button
              type="button"
              onClick={onAddMore}
              className="inline-flex h-[34px] items-center gap-1.5 rounded-[11px] border border-dashed border-blue-200 bg-transparent px-3 text-xs font-semibold text-[#0052ff] transition hover:border-blue-300 hover:bg-blue-50/60 dark:border-blue-400/25 dark:text-blue-300 dark:hover:bg-blue-400/10"
            >
              Add more
              <ChevronDownIcon />
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
