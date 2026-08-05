"use client";

import { getCampaignDaysLeft, type CampaignStatus } from "@/lib/sweepCampaign";

function daysUntil(iso: string) {
  return Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / (24 * 60 * 60 * 1000)));
}

// Slim (~1.2cm) campaign strip that sits above the sweep card. The whole bar
// is a button that opens the campaign popup.
export function SweepCampaignBar({
  status,
  isLoading,
  isConnected,
  onOpen,
}: {
  status: CampaignStatus | null;
  isLoading: boolean;
  isConnected: boolean;
  onOpen: () => void;
}) {
  if (isLoading && !status) {
    return (
      <div className="sweep-skel mb-3 h-[1.2cm] w-full rounded-[16px] border border-slate-200/80 bg-white/70 dark:border-white/10 dark:bg-white/[0.04]" />
    );
  }

  const campaign = status?.campaign;
  if (!status || !campaign) return null;

  const phase = status.phase ?? "closed";
  if (phase === "closed") return null;

  const viewer = status.viewer;
  const capUsd = campaign.volumeCapUsd || 500;
  const cappedVolume = Math.min(viewer?.cappedVolumeUsd ?? 0, capUsd);
  const progressPercent = Math.max(0, Math.min(100, (cappedVolume / capUsd) * 100));
  const claimableUsdc = viewer?.totalClaimableUsdc ?? 0;
  const daysLeft = getCampaignDaysLeft(campaign.endsAt);
  const tierCount = campaign.tiers.length || 5;

  // Before the start date nothing is being tracked yet, so the bar is a pure
  // teaser — no progress track, no totals that would imply sweeps are counting.
  const isUpcoming = phase === "upcoming";

  const rightSlot = isUpcoming ? (
    <span className="shrink-0 text-[11px] font-bold text-slate-500 dark:text-slate-400">
      Starts in {daysUntil(campaign.startsAt)}d
    </span>
  ) : !isConnected ? (
    <span className="hidden text-[11px] font-semibold text-slate-400 dark:text-slate-500 sm:block">
      Connect to track
    </span>
  ) : claimableUsdc > 0 && status.payoutsAvailable === false ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-bold text-amber-700 dark:bg-amber-400/15 dark:text-amber-400">
      Opening soon
    </span>
  ) : claimableUsdc > 0 ? (
    <span className="inline-flex shrink-0 animate-pulse items-center gap-1 rounded-full bg-emerald-500 px-2.5 py-1 text-[11px] font-black text-white shadow-[0_4px_12px_rgba(16,185,129,0.45)]">
      Claim ${claimableUsdc.toFixed(0)}
    </span>
  ) : (
    <span className="shrink-0 font-mono text-[12px] font-bold tabular-nums text-slate-700 dark:text-slate-200">
      ${cappedVolume.toFixed(0)}
      <span className="text-slate-400 dark:text-slate-500">/${capUsd.toFixed(0)}</span>
    </span>
  );

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group mb-3 flex min-h-[1.2cm] w-full items-center gap-3 rounded-[16px] border border-[#0052ff]/25 bg-gradient-to-r from-blue-50/90 via-white to-sky-50/90 px-3.5 py-2 text-left transition hover:border-[#0052ff]/50 dark:border-[#3b82f6]/30 dark:from-[#0b1220] dark:via-[#0d1526] dark:to-[#0b1220] dark:hover:border-[#3b82f6]/60 sm:px-4"
      style={{ boxShadow: "0 10px 30px -12px rgba(0,82,255,0.25)" }}
      aria-label="Open the Sweep $500 rewards campaign"
    >
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[10px] font-black uppercase tracking-[0.18em] text-[#0052ff] dark:text-[#60a5fa] sm:tracking-[0.24em]">
            Sweep $500, earn $10 USDC
          </span>
        </span>
        {/* Segmented progress track: one segment per $100 tier. */}
        <span
          className={`flex w-full max-w-[220px] items-center gap-1 ${isUpcoming ? "hidden" : ""}`}
        >
          {Array.from({ length: tierCount }, (_, index) => {
            const segmentStart = (index / tierCount) * 100;
            const segmentFill = Math.max(
              0,
              Math.min(1, (progressPercent - segmentStart) / (100 / tierCount))
            );
            return (
              <span
                key={index}
                className="h-[5px] flex-1 overflow-hidden rounded-full bg-slate-200/90 dark:bg-white/10"
              >
                <span
                  className={`block h-full rounded-full transition-all duration-500 ${
                    claimableUsdc > 0
                      ? "bg-gradient-to-r from-emerald-500 to-emerald-400"
                      : "bg-gradient-to-r from-[#0052ff] to-[#38bdf8]"
                  }`}
                  style={{ width: `${segmentFill * 100}%` }}
                />
              </span>
            );
          })}
        </span>
      </span>

      <span className="ml-auto flex shrink-0 items-center gap-2">
        {isUpcoming ? null : phase === "grace" ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-400/15 dark:text-amber-300">
            Claim window
          </span>
        ) : (
          <span className="hidden rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500 dark:bg-white/10 dark:text-slate-300 sm:inline-flex">
            {daysLeft}d left
          </span>
        )}
        {rightSlot}
        <span
          aria-hidden="true"
          className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-[#0052ff] dark:text-slate-600 dark:group-hover:text-[#60a5fa]"
        >
          ›
        </span>
      </span>
    </button>
  );
}
