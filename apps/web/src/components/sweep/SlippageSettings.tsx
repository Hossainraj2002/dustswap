"use client";

import { useMemo, useState } from "react";

const PRESETS = [
  { label: "0.1%", value: 10 },
  { label: "0.5%", value: 50 },
  { label: "1%", value: 100 },
] as const;

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function SlippageSettings({
  isOpen,
  slippageBps,
  onChange,
  onClose,
}: {
  isOpen: boolean;
  slippageBps: number;
  onChange: (value: number) => void;
  onClose: () => void;
}) {
  const [customValue, setCustomValue] = useState((slippageBps / 100).toString());
  const isCustom = useMemo(
    () => !PRESETS.some((preset) => preset.value === slippageBps),
    [slippageBps],
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[95] flex items-end justify-center bg-slate-950/45 px-0 backdrop-blur-sm sm:items-center sm:px-4">
      <div className="w-full max-w-[420px] rounded-t-[8px] bg-white p-5 shadow-[0_30px_80px_rgba(15,23,42,0.22)] sm:rounded-[8px]">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-950">Slippage</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-full text-2xl font-light text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close slippage settings"
          >
            &times;
          </button>
        </div>

        <div className="mt-5 grid grid-cols-4 gap-2">
          {PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              onClick={() => {
                onChange(preset.value);
                setCustomValue((preset.value / 100).toString());
              }}
              className={cx(
                "rounded-[8px] border px-3 py-2 text-sm font-semibold transition-colors",
                slippageBps === preset.value
                  ? "border-blue-300 bg-blue-50 text-blue-700"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
              )}
            >
              {preset.label}
            </button>
          ))}
          <button
            type="button"
            className={cx(
              "rounded-[8px] border px-3 py-2 text-sm font-semibold transition-colors",
              isCustom
                ? "border-blue-300 bg-blue-50 text-blue-700"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
            )}
          >
            Custom
          </button>
        </div>

        <label className="mt-4 block text-sm font-medium text-slate-500">
          Custom slippage
          <div className="mt-2 flex items-center rounded-[8px] border border-slate-200 bg-slate-50 px-3 focus-within:border-blue-300 focus-within:bg-white">
            <input
              value={customValue}
              onChange={(event) => {
                const next = event.target.value;
                setCustomValue(next);
                const parsed = Number(next);
                if (Number.isFinite(parsed) && parsed >= 0) {
                  onChange(Math.round(parsed * 100));
                }
              }}
              inputMode="decimal"
              className="h-11 min-w-0 flex-1 bg-transparent text-base text-slate-950 outline-none"
            />
            <span className="text-slate-500">%</span>
          </div>
        </label>

        {slippageBps > 300 ? (
          <div className="mt-4 rounded-[8px] border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            High slippage. Possible front-run risk.
          </div>
        ) : null}

        <button
          type="button"
          onClick={onClose}
          className="mt-5 flex min-h-[46px] w-full items-center justify-center rounded-[8px] bg-blue-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
        >
          Done
        </button>
      </div>
    </div>
  );
}
