"use client";

import { TokenLogo } from "@/components/sweep/TokenLogo";
import { type SelectedToken } from "@/types/dustsweep";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function formatTokenAmount(value: string) {
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  if (num >= 1000) return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (num >= 1) return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return num.toLocaleString(undefined, { maximumFractionDigits: 6 });
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

export function TokenFromPanel({
  selectedTokens,
  onRemove,
  onClearAll,
  onSelectAll,
  onAddMore,
  autoMode,
  onToggleAuto,
  onOpenSettings,
}: {
  selectedTokens: SelectedToken[];
  onRemove: (address: string) => void;
  onClearAll: () => void;
  onSelectAll: () => void;
  onAddMore: () => void;
  autoMode: boolean;
  onToggleAuto: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <section className="rounded-[8px] border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-500">From</p>
          <p className="mt-1 text-xs text-slate-400">{selectedTokens.length}/50 selected</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-500 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600"
            aria-label="Open slippage settings"
            title="Settings"
          >
            <SettingsIcon />
          </button>
          <button
            type="button"
            onClick={onClearAll}
            className="rounded-full px-2 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
          >
            Clear all
          </button>
          <button
            type="button"
            onClick={onSelectAll}
            className="rounded-full px-2 text-sm font-medium text-blue-600 transition-colors hover:text-blue-800"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={onToggleAuto}
            className={cx(
              "rounded-full border px-3 text-sm font-semibold transition-colors",
              autoMode
                ? "border-blue-200 bg-blue-50 text-blue-700"
                : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
            )}
          >
            Auto
          </button>
        </div>
      </div>

      <div className="rounded-[8px] bg-slate-50 p-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {selectedTokens.map((token) => (
            <div
              key={token.address}
              className="flex min-h-[58px] items-center gap-2 rounded-[8px] border border-blue-200 bg-white px-2 py-2 shadow-[0_6px_16px_rgba(37,99,235,0.08)] transition-all duration-150"
            >
              <TokenLogo token={token} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-sm text-slate-950">
                  {formatTokenAmount(token.balanceFormatted)}
                </p>
                <p className="truncate text-[11px] text-slate-500">
                  {token.symbol} ${token.valueUSD.toFixed(2)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onRemove(token.address)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"
                aria-label={`Remove ${token.symbol}`}
              >
                &times;
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={onAddMore}
          className="mt-3 inline-flex min-h-[42px] items-center justify-center rounded-[8px] border border-slate-200 bg-white px-4 text-sm font-medium text-slate-600 shadow-sm transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
        >
          Add more assets
          <span className="ml-1 text-slate-400">v</span>
        </button>
      </div>
    </section>
  );
}
