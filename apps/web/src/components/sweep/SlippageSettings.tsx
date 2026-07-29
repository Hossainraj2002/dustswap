"use client";

import { type ReactNode, useEffect, useState } from "react";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function Toggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="grid h-10 w-[150px] grid-cols-2 rounded-[12px] bg-slate-100 p-1 dark:bg-white/[0.06]">
      <button
        type="button"
        onClick={() => onChange(false)}
        className={cx(
          "min-h-0 rounded-[9px] text-sm font-semibold transition",
          !value
            ? "bg-white text-slate-900 shadow-[0_1px_2px_rgba(16,24,40,0.08)] dark:bg-white/15 dark:text-white"
            : "text-slate-500 hover:text-slate-800 dark:text-slate-400",
        )}
      >
        Off
      </button>
      <button
        type="button"
        onClick={() => onChange(true)}
        className={cx(
          "min-h-0 rounded-[9px] text-sm font-semibold transition",
          value
            ? "bg-[#0052ff] text-white shadow-[0_4px_10px_-2px_rgba(0,82,255,0.5)]"
            : "text-slate-500 hover:text-slate-800 dark:text-slate-400",
        )}
      >
        On
      </button>
    </div>
  );
}

function InfoIcon({ title }: { title: string }) {
  return (
    <span
      title={title}
      className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full text-[11px] font-semibold text-slate-400 ring-1 ring-slate-300 dark:ring-white/20"
    >
      i
    </span>
  );
}

function SettingRow({
  label,
  info,
  children,
}: {
  label: string;
  info: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-[15px] font-medium text-slate-900 dark:text-white">{label}</span>
        <InfoIcon title={info} />
      </div>
      {children}
    </div>
  );
}

export function SlippageSettings({
  isOpen,
  slippageBps,
  onChange,
  batchMode,
  onBatchModeChange,
  smartRouting,
  onSmartRoutingChange,
  autoSelectionUsd,
  onAutoSelectionUsdChange,
  removeFailedTokens,
  onRemoveFailedTokensChange,
  onClose,
}: {
  isOpen: boolean;
  slippageBps: number;
  onChange: (value: number) => void;
  batchMode: boolean;
  onBatchModeChange: (value: boolean) => void;
  smartRouting: boolean;
  onSmartRoutingChange: (value: boolean) => void;
  /** null = no ceiling; the field renders blank until the user types an amount. */
  autoSelectionUsd: number | null;
  onAutoSelectionUsdChange: (value: number | null) => void;
  removeFailedTokens: boolean;
  onRemoveFailedTokensChange: (value: boolean) => void;
  onClose: () => void;
}) {
  const [customValue, setCustomValue] = useState((slippageBps / 100).toString());
  const [autoValue, setAutoValue] = useState(
    autoSelectionUsd === null ? "" : `$${autoSelectionUsd}`,
  );

  useEffect(() => {
    setCustomValue((slippageBps / 100).toString());
  }, [slippageBps]);

  useEffect(() => {
    setAutoValue(autoSelectionUsd === null ? "" : `$${autoSelectionUsd}`);
  }, [autoSelectionUsd]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[95] flex items-end justify-center bg-slate-950/45 px-0 backdrop-blur-sm sm:items-center sm:px-4">
      <div className="w-full max-w-[400px] rounded-t-[24px] bg-white p-5 shadow-[0_30px_90px_rgba(15,23,42,0.28)] dark:bg-[#0b1220] sm:rounded-[24px]">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-xl font-bold tracking-[-0.01em] text-slate-950 dark:text-white">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-[11px] text-slate-400 transition hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-white/10 dark:hover:text-white"
            aria-label="Close settings"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <div className="space-y-3.5">
          <SettingRow label="Slippage" info="Maximum accepted price movement before the sweep reverts.">
            <div className="flex h-10 w-[150px] items-center rounded-[12px] bg-slate-100 p-1 dark:bg-white/[0.06]">
              <button
                type="button"
                onClick={() => onChange(50)}
                className={cx(
                  "min-h-0 h-8 rounded-[9px] px-3 text-sm font-semibold transition",
                  slippageBps === 50
                    ? "bg-[#0052ff] text-white shadow-[0_4px_10px_-2px_rgba(0,82,255,0.5)]"
                    : "text-slate-600 dark:text-slate-300",
                )}
              >
                Auto
              </button>
              <input
                value={customValue}
                onChange={(event) => {
                  const next = event.target.value.replace(/[^\d.]/g, "");
                  setCustomValue(next);
                  const parsed = Number(next);
                  if (Number.isFinite(parsed) && parsed >= 0) {
                    onChange(Math.round(parsed * 100));
                  }
                }}
                inputMode="decimal"
                className="h-8 min-w-0 flex-1 bg-transparent px-2 text-center text-sm font-semibold text-slate-950 outline-none dark:text-white"
              />
              <span className="px-1 text-sm text-slate-500 dark:text-slate-400">%</span>
            </div>
          </SettingRow>

          <SettingRow label="Batch mode" info="When available, approvals and the sweep are sent together through wallet batch calls.">
            <Toggle value={batchMode} onChange={onBatchModeChange} />
          </SettingRow>

          <SettingRow label="Smart routing" info="Quote every selected asset through the best available Base route.">
            <Toggle value={smartRouting} onChange={onSmartRoutingChange} />
          </SettingRow>

          <SettingRow
            label="Auto selection"
            info="Auto adds assets with a wallet value at or below this amount. Leave blank for no limit."
          >
            <input
              value={autoValue}
              placeholder="No limit"
              inputMode="decimal"
              onChange={(event) => {
                const next = event.target.value;
                setAutoValue(next);
                const digits = next.replace(/[^\d.]/g, "");
                // Empty (or just "$") clears the ceiling instead of collapsing to 0, which would
                // otherwise make Auto select nothing.
                if (digits === "") {
                  onAutoSelectionUsdChange(null);
                  return;
                }
                const parsed = Number(digits);
                if (Number.isFinite(parsed) && parsed >= 0) {
                  onAutoSelectionUsdChange(parsed);
                }
              }}
              className="h-10 w-[150px] rounded-[12px] bg-slate-100 px-3 text-center text-sm font-semibold text-slate-950 outline-none ring-1 ring-transparent transition focus:bg-white focus:ring-blue-400 dark:bg-white/[0.06] dark:text-white"
            />
          </SettingRow>

          <SettingRow label="Remove failed tokens" info="When on, tokens without a route are removed from From after quoting.">
            <Toggle value={removeFailedTokens} onChange={onRemoveFailedTokensChange} />
          </SettingRow>
        </div>
      </div>
    </div>
  );
}
