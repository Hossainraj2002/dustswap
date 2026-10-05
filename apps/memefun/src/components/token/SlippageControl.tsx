"use client";

import { useId } from "react";
import { Settings2 } from "lucide-react";
import { formatBps } from "@/core/format";
import { cn } from "@/lib/cn";
import { CUSTOM_SLIPPAGE_ERROR, resolveSlippageBps, SLIPPAGE_PRESETS_BPS, type SlippageSetting } from "@/lib/trade/slippage";
import { Popover } from "@/components/ui/Popover";

export function SlippageControl({ value, autoBps, onChange, disabled = false }: {
  value: SlippageSetting;
  autoBps: number;
  onChange: (value: SlippageSetting) => void;
  disabled?: boolean;
}) {
  const errorId = useId();
  const bps = resolveSlippageBps(value, autoBps);
  const label = value.mode === "auto" ? "Auto" : bps === null ? "Custom" : formatBps(bps);
  const buttonClass = (selected: boolean) => cn("h-9 rounded-[10px] text-footnote font-semibold transition-colors disabled:opacity-50", selected ? "bg-tint-fill text-on-tint" : "bg-fill-3 text-label hover:bg-fill-2");
  return (
    <Popover label="Slippage" align="end" trigger={
      <button type="button" disabled={disabled} aria-label={`Slippage ${label}${value.mode === "auto" ? ` (${formatBps(autoBps)})` : ""}. Change`}
        className="relative inline-flex h-9 shrink-0 items-center gap-1 rounded-[10px] bg-fill-3 px-2.5 text-footnote font-semibold text-label-2 transition-colors hover:text-label disabled:opacity-50 before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']">
        <Settings2 className="size-4" aria-hidden />{label}
      </button>
    }>
      <div className="flex flex-col gap-3">
        <div>
          <p className="text-headline text-label">Slippage</p>
          <p className="text-footnote text-label-2">The most your received amount can fall below the quote. Below this minimum, the swap reverts; network fees may still apply.</p>
        </div>
        <button type="button" disabled={disabled} aria-pressed={value.mode === "auto"} onClick={() => onChange({ mode: "auto" })} className={buttonClass(value.mode === "auto")}>Auto · {formatBps(autoBps)}</button>
        <p className="text-footnote text-label-2">Auto uses pool liquidity and recent price moves, up to 5%. New pools use 5%.</p>
        <div className="grid grid-cols-4 gap-1.5">
          {SLIPPAGE_PRESETS_BPS.map(preset => <button key={preset} type="button" disabled={disabled}
            aria-pressed={value.mode === "preset" && value.bps === preset} onClick={() => onChange({ mode: "preset", bps: preset })}
            className={buttonClass(value.mode === "preset" && value.bps === preset)}>{formatBps(preset)}</button>)}
        </div>
        <label className="flex items-center gap-2 text-footnote text-label-2">
          Custom
          <input aria-label="Custom slippage percentage" inputMode="decimal" maxLength={8} disabled={disabled}
            value={value.mode === "custom" ? value.text : ""} placeholder="e.g. 7.5"
            aria-invalid={bps === null} aria-describedby={bps === null ? errorId : undefined}
            onFocus={() => { if (value.mode !== "custom") onChange({ mode: "custom", text: "" }); }}
            onChange={event => onChange({ mode: "custom", text: event.target.value })}
            className="mf-num h-9 w-24 rounded-[10px] bg-fill-3 px-2 text-subhead text-label outline-none focus:shadow-[0_0_0_2px_var(--mf-tint)]" />%
        </label>
        {bps === null ? <p id={errorId} role="alert" className="text-footnote text-down">{CUSTOM_SLIPPAGE_ERROR}</p> : null}
        {bps !== null && bps >= 500 ? <p className="text-footnote text-warning">Higher slippage allows a worse fill and increases sandwich risk. Check the minimum you receive.</p> : null}
      </div>
    </Popover>
  );
}
