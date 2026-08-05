"use client";

import { useState } from "react";
import {
  formatCampaignPp,
  formatCampaignUsd,
  getCampaignDaysLeft,
  type CampaignLeaderboard,
  type CampaignLeaderboardEntry,
} from "@/lib/sweepCampaign";

const COLLAPSED_ROWS = 10;

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

const MEDAL_RANK_CLASSES: Record<number, string> = {
  1: "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-400",
  2: "bg-slate-200 text-slate-600 dark:bg-white/10 dark:text-slate-300",
  3: "bg-orange-100 text-orange-700 dark:bg-orange-400/15 dark:text-orange-400",
};

function LeaderboardRow({
  entry,
  isViewer,
}: {
  entry: CampaignLeaderboardEntry;
  isViewer: boolean;
}) {
  const medalClass = MEDAL_RANK_CLASSES[entry.rank];

  return (
    <div
      className={`grid h-[38px] items-center gap-2 border-b border-slate-100 px-3 text-[12px] last:border-b-0 dark:border-white/[0.06] ${
        isViewer
          ? "bg-sky-50/80 dark:bg-sky-400/[0.08]"
          : "bg-white dark:bg-transparent"
      }`}
      style={{ gridTemplateColumns: "44px minmax(0,1fr) 76px 92px" }}
    >
      <span className="font-mono font-bold tabular-nums text-slate-500 dark:text-slate-400">
        {medalClass ? (
          <span
            className={`inline-flex h-[22px] w-[22px] items-center justify-center rounded-full text-[11px] font-black ${medalClass}`}
          >
            {entry.rank}
          </span>
        ) : (
          `#${entry.rank}`
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-mono font-semibold text-slate-800 dark:text-slate-200">
          {shortAddress(entry.address)}
        </span>
        {isViewer ? (
          <span className="shrink-0 rounded-full bg-[#0052ff] px-1.5 py-0.5 text-[9px] font-black uppercase text-white">
            You
          </span>
        ) : null}
      </span>
      <span className="text-right font-mono font-bold tabular-nums text-slate-900 dark:text-white">
        {formatCampaignUsd(entry.volumeUsd)}
      </span>
      <span className="text-right">
        {entry.prizeUsdc ? (
          <span className="inline-flex flex-col items-end leading-tight">
            <span className="font-bold text-emerald-600 dark:text-emerald-400">
              {formatCampaignUsd(entry.prizeUsdc)}
            </span>
            {entry.prizePp ? (
              <span className="text-[9px] font-semibold text-amber-600 dark:text-amber-400">
                +{formatCampaignPp(entry.prizePp)}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-slate-300 dark:text-slate-600">&nbsp;</span>
        )}
      </span>
    </div>
  );
}

export function SweepCampaignLeaderboard({
  leaderboard,
  isLoading,
}: {
  leaderboard: CampaignLeaderboard | null;
  isLoading: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (isLoading && !leaderboard) {
    return (
      <div className="sweep-skel mt-4 h-[180px] w-full rounded-[16px] border border-slate-200/80 bg-white/70 dark:border-white/10 dark:bg-white/[0.04]" />
    );
  }

  // The board only exists once the campaign is running. Before the start date
  // there is no volume to rank, so showing an empty board would misrepresent
  // the challenge as already live.
  const phase = leaderboard?.phase ?? "closed";
  if (!leaderboard?.campaign || phase === "closed" || phase === "upcoming") {
    return null;
  }

  const entries = leaderboard.entries;
  const viewer = leaderboard.viewer;
  const prizes = leaderboard.prizes ?? [];
  const topPrize = prizes.find((prize) => prize.rankFrom === 1);
  const daysLeft = getCampaignDaysLeft(leaderboard.campaign.endsAt);
  const isLive = phase === "live";
  const visibleEntries = expanded ? entries : entries.slice(0, COLLAPSED_ROWS);
  // Pin the viewer's own row on top when they aren't in the visible slice.
  const viewerPinned =
    viewer && !visibleEntries.some((entry) => entry.rank === viewer.rank) ? viewer : null;

  return (
    <div
      className="mt-4 overflow-hidden rounded-[16px] border border-sky-200/80 bg-white dark:border-white/10 dark:bg-[#0b1220]"
      style={{ boxShadow: "0 18px 48px rgba(0,82,255,0.08)" }}
    >
      {/* Gradient header */}
      <div className="bg-[linear-gradient(135deg,#0052ff,#0ea5e9,#38bdf8)] px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/70">
              2-week challenge
            </p>
            <h3 className="text-[15px] font-bold text-white">Sweep Challenge Top 50</h3>
          </div>
          <span className="shrink-0 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-bold text-white backdrop-blur">
            {isLive ? `${daysLeft}d left` : "Final results"}
          </span>
        </div>
        {topPrize ? (
          <p className="mt-1.5 text-[11px] font-semibold text-white/85">
            1st place {formatCampaignUsd(topPrize.prizeUsdc)} + {formatCampaignPp(topPrize.prizePp)}.
            Every rank in the top 50 earns USDC and PP, paid out once the challenge ends.
          </p>
        ) : null}
      </div>

      {/* Column header */}
      <div
        className="grid h-[30px] items-center gap-2 border-b border-slate-100 bg-[linear-gradient(90deg,#eff6ff,#f0f9ff)] px-3 text-[10px] font-black uppercase tracking-[0.12em] text-slate-400 dark:border-white/[0.06] dark:bg-white/[0.03] dark:text-slate-500"
        style={{ gridTemplateColumns: "44px minmax(0,1fr) 76px 92px" }}
      >
        <span>Rank</span>
        <span>Sweeper</span>
        <span className="text-right">Volume</span>
        <span className="text-right">Prize</span>
      </div>

      {viewerPinned ? <LeaderboardRow entry={viewerPinned} isViewer /> : null}

      {visibleEntries.length === 0 ? (
        <p className="px-4 py-6 text-center text-[12px] font-semibold text-slate-400 dark:text-slate-500">
          No verified sweeps yet. The first sweep of the challenge takes rank 1.
        </p>
      ) : (
        visibleEntries.map((entry) => (
          <LeaderboardRow
            key={entry.rank}
            entry={entry}
            isViewer={viewer?.rank === entry.rank}
          />
        ))
      )}

      {entries.length > COLLAPSED_ROWS ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex h-[38px] w-full items-center justify-center gap-1 border-t border-slate-100 text-[12px] font-bold text-[#0052ff] transition hover:bg-blue-50/60 dark:border-white/[0.06] dark:text-[#60a5fa] dark:hover:bg-white/[0.04]"
        >
          {expanded ? "Show top 10" : `Show all ${entries.length}`}
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
          >
            <path
              d="m6 9 6 6 6-6"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2.5"
            />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
