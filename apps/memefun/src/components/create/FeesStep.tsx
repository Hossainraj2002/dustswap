"use client";

import { RadioGroup } from "radix-ui";
import { Check } from "lucide-react";
import { feeShareFractions } from "@/core/fees";
import { formatBps, formatUsd } from "@/core/format";
import type { LaunchSettings } from "@/core/settings";
import type { FeeMode } from "@/core/types";
import { cn } from "@/lib/cn";
import type { CreateDraft, DraftErrors } from "@/lib/create/draft";
import { FeeSplitBar } from "@/components/ui/FeeSplitBar";
import { MODE_META } from "@/components/ui/ModeBadge";
import { Slider } from "@/components/ui/Slider";

const EXAMPLE_VOLUME_USD = 1000;

export function FeesStep({
  draft,
  update,
  settings,
  errors,
  showErrors,
}: {
  draft: CreateDraft;
  update: (patch: Partial<CreateDraft>) => void;
  settings: LaunchSettings;
  errors: DraftErrors;
  showErrors: boolean;
}) {
  const config = { mode: draft.mode, platformShareBps: settings.platformShareBps, referralShareBps: settings.referralShareBps, creatorKeepBps: draft.mode === "creator" ? 0 : draft.creatorKeepBps };
  const shares = feeShareFractions(config, false);
  const feeUsd = (EXAMPLE_VOLUME_USD * draft.feeBps) / 10_000;
  const destinationLabel = MODE_META[draft.mode].destinationLabel.toLowerCase();

  return (
    <div className="flex flex-col gap-7">
      <section className="flex flex-col gap-2" aria-labelledby="fee-label">
        <div className="flex items-end justify-between gap-3 px-1">
          <div>
            <h3 id="fee-label" className="text-headline text-label">
              Trading fee
            </h3>
            <p className="text-footnote text-label-2">Taken from every buy and sell, in {draft.quoteSymbol}. You can lower it later, never raise it.</p>
          </div>
          <span className="mf-num text-title1 font-bold text-label">{formatBps(draft.feeBps)}</span>
        </div>
        <Slider
          label="Trading fee"
          min={settings.feeMinBps}
          max={settings.feeMaxBps}
          step={25}
          value={draft.feeBps}
          onChange={(value) => update({ feeBps: value })}
          valueText={(value) => `${value / 100} percent`}
        />
        <div className="flex justify-between px-1 text-caption1 text-label-2" aria-hidden>
          <span>{formatBps(settings.feeMinBps)}, more trades</span>
          <span>{formatBps(settings.feeMaxBps)}, more per trade</span>
        </div>
        {showErrors && errors.feeBps ? <p className="px-1 text-footnote text-down">{errors.feeBps}</p> : null}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="mode-label">
        <div className="px-1">
          <h3 id="mode-label" className="text-headline text-label">
            Where fees go
          </h3>
          <p className="text-footnote text-label-2">
            The platform keeps {formatBps(settings.platformShareBps)} of each fee. You choose where the rest goes. This can never be changed after launch.
          </p>
        </div>
        <RadioGroup.Root value={draft.mode} onValueChange={(value) => update({ mode: value as FeeMode })} aria-label="Fee destination" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(Object.keys(MODE_META) as FeeMode[]).map((mode) => {
            const meta = MODE_META[mode];
            const Icon = meta.icon;
            const enabled = settings.enabledModes.includes(mode);
            const selected = draft.mode === mode;
            return (
              <RadioGroup.Item
                key={mode}
                value={mode}
                disabled={!enabled}
                className={cn(
                  "relative flex flex-col gap-2 rounded-lg p-4 text-left transition-[box-shadow,background-color] disabled:opacity-45",
                  selected ? "bg-tint/8 shadow-[0_0_0_2px_var(--mf-tint)]" : "bg-bg-elevated shadow-[0_0_0_1px_var(--mf-separator)] hover:bg-fill-4",
                )}
              >
                <span className="flex items-center justify-between">
                  <span className="flex size-10 items-center justify-center rounded-full" style={{ backgroundColor: `color-mix(in srgb, ${meta.color} 14%, transparent)`, color: meta.color }}>
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <span className={cn("flex size-6 items-center justify-center rounded-full", selected ? "bg-tint-fill text-on-tint" : "shadow-[inset_0_0_0_1.5px_var(--mf-label-3)]")}>
                    {selected ? <Check className="size-3.5" strokeWidth={3} aria-hidden /> : null}
                  </span>
                </span>
                <span className="text-headline text-label">{meta.label}</span>
                <span className="text-footnote text-label-2">{enabled ? meta.description : "Not available right now."}</span>
              </RadioGroup.Item>
            );
          })}
        </RadioGroup.Root>
      </section>

      {draft.mode !== "creator" ? (
        <section className="flex flex-col gap-2" aria-labelledby="keep-label">
          <div className="flex items-end justify-between gap-3 px-1">
            <div>
              <h3 id="keep-label" className="text-headline text-label">
                Keep a share for yourself
              </h3>
              <p className="text-footnote text-label-2">Part of the non-platform share paid to you. The rest goes to {destinationLabel}.</p>
            </div>
            <span className="mf-num text-title2 font-bold text-label">{formatBps(draft.creatorKeepBps)}</span>
          </div>
          <Slider
            label="Creator share"
            min={0}
            max={settings.creatorKeepMaxBps}
            step={500}
            value={Math.min(draft.creatorKeepBps, settings.creatorKeepMaxBps)}
            onChange={(value) => update({ creatorKeepBps: value })}
            valueText={(value) => `${value / 100} percent`}
          />
        </section>
      ) : null}

      <section className="mf-card flex flex-col gap-4 bg-bg-elevated-2 p-4 shadow-none" aria-labelledby="split-example">
        <h3 id="split-example" className="text-headline text-label">
          On {formatUsd(EXAMPLE_VOLUME_USD)} of trading at {formatBps(draft.feeBps)}
        </h3>
        <FeeSplitBar config={config} showLegend={false} />
        <dl className="grid grid-cols-1 gap-2 text-subhead sm:grid-cols-3">
          <div className="flex justify-between gap-2 sm:flex-col">
            <dt className="text-label-2">You earn</dt>
            <dd className="mf-num font-semibold text-label">{formatUsd(feeUsd * shares.creator)}</dd>
          </div>
          {draft.mode !== "creator" ? (
            <div className="flex justify-between gap-2 sm:flex-col">
              <dt className="text-label-2">{MODE_META[draft.mode].destinationLabel}</dt>
              <dd className="mf-num font-semibold text-label">{formatUsd(feeUsd * shares.destination)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-2 sm:flex-col">
            <dt className="text-label-2">Platform</dt>
            <dd className="mf-num font-semibold text-label">{formatUsd(feeUsd * shares.platform)}</dd>
          </div>
        </dl>
        <p className="text-footnote text-label-2">
          When a trade comes from someone&apos;s referral link, they get {formatBps(settings.referralShareBps)} of the platform share. Your share is never touched.
        </p>
      </section>
    </div>
  );
}
