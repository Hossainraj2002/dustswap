"use client";

import { TokenLogo } from "@/components/sweep/TokenLogo";
import { type SelectedToken } from "@/types/dustsweep";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function formatAmount(value: string, decimals = 18) {
  const num = Number(value);
  if (!Number.isFinite(num) || num === 0) return "0";
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`;
  if (num >= 1) return num.toLocaleString(undefined, { maximumFractionDigits: 3 });
  // For very small amounts use significant figures
  if (num >= 0.001) return num.toPrecision(3);
  return num.toExponential(2);
}

function formatUSD(value: number) {
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}K`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  if (value > 0) return "<$0.01";
  return "";
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
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
}: {
  selectedTokens: SelectedToken[];
  onRemove: (address: string) => void;
  onClearAll: () => void;
  onAddMore: () => void;
  autoMode: boolean;
  onToggleAuto: () => void;
  onOpenSettings: () => void;
}) {
  // Sort by valueUSD descending so highest-value tokens appear first in the chip grid
  const sorted = [...selectedTokens].sort((a, b) => (b.valueUSD ?? 0) - (a.valueUSD ?? 0));

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* Header row */}
      <div className="flex items-center justify-between gap-2 px-4 pb-2.5 pt-3.5">
        <div className="flex items-baseline gap-2">
          <p className="text-sm font-semibold text-slate-700">From</p>
          <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600">
            {selectedTokens.length}/50
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex h-7 w-7 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            aria-label="Slippage settings"
            title="Settings"
          >
            <SettingsIcon />
          </button>
          <button
            type="button"
            onClick={onClearAll}
            disabled={selectedTokens.length === 0}
            className="rounded-full px-2.5 py-1 text-[11px] font-medium text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40"
          >
            Clear all
          </button>
          <button
            type="button"
            onClick={onToggleAuto}
            className={cx(
              "rounded-full px-3 py-1 text-[11px] font-semibold transition-all",
              autoMode
                ? "bg-blue-600 text-white shadow-sm"
                : "border border-slate-200 text-slate-500 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600",
            )}
          >
            Auto
          </button>
        </div>
      </div>

      {/* Chip grid */}
      <div className="px-3 pb-3">
        <div className="rounded-xl bg-slate-50/80 p-2">
          {sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-5 text-center">
              <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100">
                <svg viewBox="0 0 24 24" className="h-5 w-5 text-slate-300" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
              </div>
              <p className="text-xs font-medium text-slate-400">No tokens selected</p>
              <p className="mt-0.5 text-[10px] text-slate-300">Click Auto or add assets below</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-1.5">
              {sorted.map((token) => {
                const usdStr = formatUSD(token.valueUSD ?? 0);
                return (
                  <div
                    key={token.address}
                    className="group flex h-[44px] items-center gap-1.5 rounded-[10px] border border-blue-100 bg-white px-2 shadow-[0_1px_4px_rgba(37,99,235,0.06)] transition-all hover:border-blue-300 hover:shadow-[0_2px_8px_rgba(37,99,235,0.1)]"
                  >
                    <TokenLogo token={token} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] font-semibold leading-tight text-slate-800">
                        {formatAmount(token.balanceFormatted, token.decimals)}{" "}
                        <span className="text-slate-500">{token.symbol}</span>
                      </p>
                      {usdStr ? (
                        <p className="truncate text-[10px] leading-tight text-emerald-600 font-medium">
                          {usdStr}
                        </p>
                      ) : (
                        <p className="truncate text-[10px] leading-tight text-slate-300">
                          no price
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemove(token.address)}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[13px] text-slate-300 transition-colors hover:bg-red-50 hover:text-red-500 group-hover:text-slate-400"
                      aria-label={`Remove ${token.symbol}`}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <button
            type="button"
            onClick={onAddMore}
            className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-slate-200 bg-white py-2 text-[11px] font-medium text-slate-400 transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600"
          >
            Add more assets
            <ChevronDownIcon />
          </button>
        </div>
      </div>
    </section>
  );
}
