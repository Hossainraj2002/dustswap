"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { InteractiveLeaderboardBackground } from "@/components/leaderboard/InteractiveLeaderboardBackground";
import {
  fetchLeaderboardHub,
  type CachedLeaderboardProfile,
  type LeaderboardBoardType,
  type LeaderboardHubEntry,
  type LeaderboardHubResponse,
} from "@/lib/points";

type NeynarProfile = {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string;
};

const BOARD_LIMIT = 50;
const BOARD_OPTIONS: Array<{
  id: LeaderboardBoardType;
  label: string;
  accent: string;
}> = [
  {
    id: "particle_points",
    label: "Particle Point",
    accent: "from-sky-500/20 via-sky-300/15 to-white",
  },
  {
    id: "referral",
    label: "Referral",
    accent: "from-slate-300/45 via-sky-100/40 to-white",
  },
  {
    id: "volume",
    label: "Volume",
    accent: "from-cyan-300/25 via-sky-200/20 to-white",
  },
];

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatWhole(value: number) {
  return Math.round(Number(value || 0)).toLocaleString();
}

function formatUsd(value: number) {
  return `$${Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: value > 0 && value < 100 ? 2 : 0,
    maximumFractionDigits: value > 0 && value < 100 ? 2 : 0,
  })}`;
}

function getProfileName(
  liveProfile: NeynarProfile | null,
  cachedProfile: CachedLeaderboardProfile | null,
  address?: string
) {
  if (liveProfile?.display_name) {
    return liveProfile.display_name;
  }

  if (cachedProfile?.displayName) {
    return cachedProfile.displayName;
  }

  if (liveProfile?.username) {
    return liveProfile.username;
  }

  if (cachedProfile?.username) {
    return cachedProfile.username;
  }

  return address ? shortAddress(address) : "Anonymous";
}

function getProfileHandle(
  liveProfile: NeynarProfile | null,
  cachedProfile: CachedLeaderboardProfile | null,
  address?: string
) {
  if (liveProfile?.username) {
    return `@${liveProfile.username}`;
  }

  if (cachedProfile?.username) {
    return `@${cachedProfile.username}`;
  }

  return address ? shortAddress(address) : "Wallet not connected";
}

function getAvatarUrl(
  liveProfile: NeynarProfile | null,
  cachedProfile: CachedLeaderboardProfile | null
) {
  return liveProfile?.pfp_url || cachedProfile?.pfpUrl || "";
}

function getInitials(label: string) {
  const normalized = label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((chunk) => chunk[0]?.toUpperCase() ?? "")
    .join("");

  return normalized || "DS";
}

function Avatar({
  src,
  label,
  size = 48,
}: {
  src?: string;
  label: string;
  size?: number;
}) {
  if (src) {
    return (
      <img
        src={src}
        alt={label}
        className="rounded-full object-cover ring-1 ring-white/80"
        style={{ width: size, height: size }}
        referrerPolicy="no-referrer"
      />
    );
  }

  return (
    <div
      className="flex items-center justify-center rounded-full bg-[radial-gradient(circle_at_30%_30%,#ffffff_0%,#dbeafe_48%,#cbd5e1_100%)] text-sm font-semibold text-slate-700 ring-1 ring-white/80"
      style={{ width: size, height: size }}
    >
      {getInitials(label)}
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  const tone =
    rank === 1
      ? "border-amber-200 bg-amber-50 text-amber-700"
      : rank === 2
        ? "border-slate-200 bg-slate-100 text-slate-700"
        : rank === 3
          ? "border-orange-200 bg-orange-50 text-orange-700"
          : "border-slate-200 bg-white text-slate-600";

  return (
    <div
      className={`flex h-12 w-12 items-center justify-center rounded-2xl border text-sm font-semibold shadow-[0_12px_24px_rgba(148,163,184,0.08)] ${tone}`}
    >
      {rank <= 3 ? rank : `#${rank}`}
    </div>
  );
}

function StatCard({
  label,
  value,
  detail,
  isLoading,
}: {
  label: string;
  value: string;
  detail: string;
  isLoading?: boolean;
}) {
  return (
    <div className="rounded-[28px] border border-white/90 bg-white/82 px-5 py-5 shadow-[0_16px_50px_rgba(148,163,184,0.12)] backdrop-blur-xl">
      <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-400">
        {label}
      </p>
      <p className="mt-3 text-3xl font-semibold tracking-[-0.05em] text-slate-950">
        {isLoading ? <span className="animate-pulse text-slate-300">...</span> : value}
      </p>
      <p className="mt-2 text-sm text-slate-500">{detail}</p>
    </div>
  );
}

function RowValue({
  type,
  entry,
}: {
  type: LeaderboardBoardType;
  entry: LeaderboardHubEntry;
}) {
  if (type === "referral") {
    return (
      <div className="text-right">
        <p className="text-sm font-semibold text-slate-900">
          {formatWhole(entry.referredUsers)} users
        </p>
        <p className="mt-1 text-xs font-medium uppercase tracking-[0.18em] text-sky-600">
          {formatWhole(entry.referralPoints)} PP
        </p>
      </div>
    );
  }

  if (type === "volume") {
    return (
      <div className="text-right">
        <p className="text-sm font-semibold text-slate-900">{formatUsd(entry.swapVolume)}</p>
        <p className="mt-1 text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
          swap volume
        </p>
      </div>
    );
  }

  return (
    <div className="text-right">
      <p className="text-sm font-semibold text-slate-900">{formatWhole(entry.totalPoints)} PP</p>
      <p className="mt-1 text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
        total earned
      </p>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, index) => (
        <div
          key={index}
          className="grid grid-cols-[56px_minmax(0,1fr)_auto] items-center gap-3 rounded-[26px] border border-white/90 bg-white/72 px-4 py-4 shadow-[0_14px_36px_rgba(148,163,184,0.08)]"
        >
          <div className="h-12 w-12 animate-pulse rounded-2xl bg-slate-200/80" />
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 animate-pulse rounded-full bg-slate-200/80" />
            <div className="min-w-0 flex-1">
              <div className="h-4 w-32 animate-pulse rounded-full bg-slate-200/80" />
              <div className="mt-2 h-3 w-20 animate-pulse rounded-full bg-slate-100" />
            </div>
          </div>
          <div className="w-20">
            <div className="ml-auto h-4 w-16 animate-pulse rounded-full bg-slate-200/80" />
            <div className="mt-2 ml-auto h-3 w-12 animate-pulse rounded-full bg-slate-100" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function LeaderboardPage() {
  const { address } = useAccount();
  const [selectedBoard, setSelectedBoard] = useState<LeaderboardBoardType>("particle_points");
  const [leaderboard, setLeaderboard] = useState<LeaderboardHubResponse | null>(null);
  const [profile, setProfile] = useState<NeynarProfile | null>(null);
  const [isLoadingBoard, setIsLoadingBoard] = useState(true);
  const [isLoadingProfile, setIsLoadingProfile] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalizedAddress = address?.toLowerCase();
  const viewer = leaderboard?.viewer ?? null;
  const viewerProfile = viewer?.profile ?? null;
  const viewerName = normalizedAddress
    ? getProfileName(profile, viewerProfile, address)
    : "Wallet not connected";
  const viewerHandle = normalizedAddress
    ? getProfileHandle(profile, viewerProfile, address)
    : "Connect to see your rank";
  const viewerAvatar = getAvatarUrl(profile, viewerProfile);

  const boardMeta = useMemo(
    () => BOARD_OPTIONS.find((option) => option.id === selectedBoard) ?? BOARD_OPTIONS[0],
    [selectedBoard]
  );

  const loadLeaderboard = useCallback(async () => {
    setIsLoadingBoard(true);
    setError(null);

    try {
      const response = await fetchLeaderboardHub(selectedBoard, BOARD_LIMIT, normalizedAddress);
      if (!response.success) {
        throw new Error(response.error || "Failed to load leaderboard");
      }

      setLeaderboard(response);
    } catch (loadError) {
      setError((loadError as Error).message || "Failed to load leaderboard");
    } finally {
      setIsLoadingBoard(false);
    }
  }, [normalizedAddress, selectedBoard]);

  useEffect(() => {
    void loadLeaderboard();
  }, [loadLeaderboard]);

  useEffect(() => {
    if (!normalizedAddress) {
      setProfile(null);
      setIsLoadingProfile(false);
      return;
    }

    let cancelled = false;
    setIsLoadingProfile(true);

    fetch(`/api/neynar/user?address=${normalizedAddress}`, {
      cache: "no-store",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled) {
          setProfile(data && !data.error ? (data as NeynarProfile) : null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProfile(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingProfile(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [normalizedAddress]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void loadLeaderboard();
    }, 60000);

    return () => window.clearInterval(intervalId);
  }, [loadLeaderboard]);

  return (
    <main className="min-h-screen bg-[#f3f7fb] px-4 py-4 md:px-8 md:py-8">
      <section className="relative mx-auto flex min-h-[calc(100vh-2rem)] max-w-7xl flex-col overflow-hidden rounded-[32px] border border-white/80 bg-white/55 shadow-[0_30px_90px_rgba(148,163,184,0.20)] backdrop-blur-xl">
        <InteractiveLeaderboardBackground />

        <div className="relative z-10 flex min-h-[calc(100vh-2rem)] flex-col gap-5 px-4 py-4 sm:px-6 sm:py-6 lg:px-10 lg:py-8">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="rounded-[28px] border border-white/90 bg-white/82 px-5 py-4 shadow-[0_16px_50px_rgba(148,163,184,0.10)] backdrop-blur-xl">
              <Image
                src="/longlogo.png"
                alt="DustSwap"
                width={182}
                height={42}
                priority
                className="h-auto w-[150px] sm:w-[182px]"
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-[28px] border border-white/90 bg-white/84 px-4 py-4 shadow-[0_16px_50px_rgba(148,163,184,0.12)] backdrop-blur-xl sm:px-5">
              <div className="flex min-w-0 items-center gap-3">
                <Avatar src={viewerAvatar} label={viewerName} size={52} />
                <div className="min-w-0">
                  <p className="truncate text-base font-semibold tracking-[-0.03em] text-slate-950">
                    {viewerName}
                  </p>
                  <p className="truncate text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
                    {isLoadingProfile && normalizedAddress ? "Loading profile" : viewerHandle}
                  </p>
                </div>
              </div>

              <div className="text-right">
                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                  Total Earned
                </p>
                <p className="mt-2 text-xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-2xl">
                  {formatWhole(viewer?.totalPoints || 0)} PP
                </p>
              </div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <StatCard
              label="Your Particle Points"
              value={`${formatWhole(viewer?.totalPoints || 0)} PP`}
              detail={normalizedAddress ? "Total PP earned by this wallet" : "Connect wallet to see your total"}
              isLoading={isLoadingBoard}
            />
            <StatCard
              label="Total Users"
              value={formatWhole(leaderboard?.totalUserCount || 0)}
              detail="Wallets tracked across DustSwap"
              isLoading={isLoadingBoard}
            />
          </div>

          <div className="relative overflow-hidden rounded-[30px] border border-white/90 bg-[linear-gradient(135deg,rgba(255,255,255,0.86),rgba(239,246,255,0.88),rgba(248,250,252,0.95))] p-4 shadow-[0_16px_50px_rgba(148,163,184,0.10)] backdrop-blur-xl">
            <div className="absolute inset-y-0 left-[-35%] w-[45%] bg-[linear-gradient(90deg,rgba(255,255,255,0),rgba(125,211,252,0.72),rgba(255,255,255,0))] blur-[18px]" style={{ animation: "leaderboard-beam 7s linear infinite" }} />
            <div className="relative z-10">
              <div className="h-3 overflow-hidden rounded-full bg-white/80 ring-1 ring-sky-100">
                <div
                  className="h-full w-[34%] rounded-full bg-[linear-gradient(90deg,#38bdf8_0%,#60a5fa_48%,#bfdbfe_100%)] shadow-[0_0_28px_rgba(96,165,250,0.55)]"
                  style={{ animation: "leaderboard-beam 9s linear infinite" }}
                />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 overflow-x-auto pb-1">
            <div className="shrink-0 rounded-full border border-slate-200/90 bg-white/88 px-4 py-2 text-sm font-semibold text-slate-700 shadow-[0_10px_30px_rgba(148,163,184,0.08)]">
              {normalizedAddress ? `#${viewer?.rank || "--"}` : "Connect wallet"}
            </div>

            {BOARD_OPTIONS.map((option) => {
              const isActive = option.id === selectedBoard;

              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setSelectedBoard(option.id)}
                  className={`relative shrink-0 overflow-hidden rounded-full border px-4 py-2.5 text-sm font-semibold transition-all duration-200 ${
                    isActive
                      ? "border-slate-900 bg-slate-950 text-white shadow-[0_16px_38px_rgba(15,23,42,0.18)]"
                      : "border-slate-200/90 bg-white/86 text-slate-600 shadow-[0_10px_30px_rgba(148,163,184,0.08)] hover:border-slate-300 hover:text-slate-900"
                  }`}
                >
                  {!isActive ? (
                    <span className={`absolute inset-0 bg-gradient-to-r ${option.accent} opacity-90`} />
                  ) : null}
                  <span className="relative z-10">{option.label}</span>
                </button>
              );
            })}
          </div>

          <div className="rounded-[30px] border border-white/90 bg-white/72 p-3 shadow-[0_18px_60px_rgba(148,163,184,0.14)] backdrop-blur-xl sm:p-4">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200/70 px-2 pb-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                  {boardMeta.label}
                </p>
                <p className="mt-2 text-sm font-medium text-slate-500">
                  {selectedBoard === "referral"
                    ? "Rank, Base App user, total referred, referral PP"
                    : selectedBoard === "volume"
                      ? "Rank, Base App user, total swap volume"
                      : "Rank, Base App user, total particle points"}
                </p>
              </div>
              <div className="rounded-full border border-sky-100 bg-sky-50/90 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">
                Live
              </div>
            </div>

            <div className="mt-4">
              {isLoadingBoard ? <SkeletonRows /> : null}

              {!isLoadingBoard && error ? (
                <div className="rounded-[26px] border border-rose-100 bg-rose-50/90 px-4 py-5 text-sm text-rose-700">
                  {error}
                </div>
              ) : null}

              {!isLoadingBoard && !error && !(leaderboard?.entries.length) ? (
                <div className="rounded-[26px] border border-slate-200/80 bg-white/84 px-4 py-8 text-center text-sm text-slate-500">
                  No leaderboard data yet for this category.
                </div>
              ) : null}

              {!isLoadingBoard && !error && leaderboard?.entries.length ? (
                <div className="space-y-3">
                  {leaderboard.entries.map((entry, index) => {
                    const isViewer =
                      Boolean(normalizedAddress) &&
                      entry.address.toLowerCase() === normalizedAddress;
                    const rowName = getProfileName(null, entry.profile, entry.address);
                    const rowHandle = getProfileHandle(null, entry.profile, entry.address);

                    return (
                      <div
                        key={`${selectedBoard}-${entry.userId}-${entry.rank}`}
                        className={`grid grid-cols-[56px_minmax(0,1fr)_auto] items-center gap-3 rounded-[26px] border px-4 py-4 shadow-[0_14px_36px_rgba(148,163,184,0.08)] backdrop-blur-xl ${
                          isViewer
                            ? "border-sky-200 bg-[linear-gradient(135deg,rgba(255,255,255,0.96),rgba(239,246,255,0.92))]"
                            : "border-white/90 bg-white/82"
                        }`}
                        style={{
                          animation: "leaderboard-row-in 520ms cubic-bezier(0.22,1,0.36,1) both",
                          animationDelay: `${index * 45}ms`,
                        }}
                      >
                        <RankBadge rank={entry.rank} />

                        <div className="flex min-w-0 items-center gap-3">
                          <Avatar
                            src={entry.profile?.pfpUrl || ""}
                            label={rowName}
                            size={48}
                          />
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-slate-950 sm:text-base">
                              {rowName}
                            </p>
                            <p className="truncate text-xs font-medium uppercase tracking-[0.16em] text-slate-400">
                              {rowHandle}
                            </p>
                          </div>
                        </div>

                        <RowValue type={selectedBoard} entry={entry} />
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
