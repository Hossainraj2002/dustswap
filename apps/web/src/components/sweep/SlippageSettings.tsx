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
    <div className="grid h-10 w-[150px] grid-cols-2 rounded-[8px] bg-yellow-50 p-1">
      <button
        type="button"
        onClick={() => onChange(false)}
        className={cx(
          "min-h-0 rounded-[7px] text-sm font-medium transition",
          !value ? "bg-yellow-300 text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-900",
        )}
      >
        Off
      </button>
      <button
        type="button"
        onClick={() => onChange(true)}
        className={cx(
          "min-h-0 rounded-[7px] text-sm font-medium transition",
          value ? "bg-yellow-300 text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-900",
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
      className="inline-flex h-4 w-4 items-center justify-center rounded-full text-xs text-slate-400 ring-1 ring-slate-300"
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
    <div className="flex min-h-[42px] items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-base text-slate-900">{label}</span>
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
  autoSelectionUsd: number;
  onAutoSelectionUsdChange: (value: number) => void;
  removeFailedTokens: boolean;
  onRemoveFailedTokensChange: (value: boolean) => void;
  onClose: () => void;
}) {
  const [customValue, setCustomValue] = useState((slippageBps / 100).toString());
  const [autoValue, setAutoValue] = useState(`$${autoSelectionUsd}`);

  useEffect(() => {
    setCustomValue((slippageBps / 100).toString());
  }, [slippageBps]);

  useEffect(() => {
    setAutoValue(`$${autoSelectionUsd}`);
  }, [autoSelectionUsd]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[95] flex items-end justify-center bg-slate-950/45 px-0 backdrop-blur-sm sm:items-center sm:px-4">
      <div className="w-full max-w-[380px] rounded-t-[8px] bg-white p-5 shadow-[0_30px_80px_rgba(15,23,42,0.22)] sm:rounded-[8px]">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-slate-950">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-[8px] text-2xl font-light text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close settings"
          >
            &times;
          </button>
        </div>

        <div className="space-y-4">
          <SettingRow label="Slippage" info="Maximum accepted price movement before the sweep reverts.">
            <div className="flex h-10 w-[150px] items-center rounded-[8px] bg-yellow-50 p-1">
              <button
                type="button"
                onClick={() => onChange(50)}
                className={cx(
                  "min-h-0 h-8 rounded-[7px] px-3 text-sm font-medium transition",
                  slippageBps === 50 ? "bg-yellow-300 text-slate-950 shadow-sm" : "text-slate-600",
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
                className="h-8 min-w-0 flex-1 bg-transparent px-2 text-center text-sm text-slate-950 outline-none"
              />
              <span className="px-1 text-sm text-slate-600">%</span>
            </div>
          </SettingRow>

          <SettingRow label="Batch mode" info="When available, approvals and the sweep are sent together through wallet batch calls.">
            <Toggle value={batchMode} onChange={onBatchModeChange} />
          </SettingRow>

          <SettingRow label="Smart routing" info="Quote every selected asset through the best available Base route.">
            <Toggle value={smartRouting} onChange={onSmartRoutingChange} />
          </SettingRow>

          <SettingRow label="Auto selection" info="Auto adds assets with a wallet value at or below this amount.">
            <input
              value={autoValue}
              onChange={(event) => {
                const next = event.target.value;
                setAutoValue(next);
                const parsed = Number(next.replace(/[^\d.]/g, ""));
                if (Number.isFinite(parsed) && parsed >= 0) {
                  onAutoSelectionUsdChange(parsed);
                }
              }}
              className="h-10 w-[150px] rounded-[8px] bg-yellow-50 px-3 text-center text-sm font-medium text-slate-950 outline-none ring-1 ring-transparent transition focus:ring-yellow-300"
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
