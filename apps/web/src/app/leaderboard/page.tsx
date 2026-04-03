"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useAccount } from "wagmi";
import { InteractiveLeaderboardBackground } from "@/components/leaderboard/InteractiveLeaderboardBackground";
import { subscribeToDataInvalidation } from "@/lib/clientEvents";
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

const BOARD_PAGE_SIZE = 10;
const LEADERBOARD_FALLBACK_REFRESH_MS = 300000;

const BOARD_OPTIONS: Array<{
  id: LeaderboardBoardType;
  label: string;
}> = [
  { id: "particle_points", label: "Particle Point" },
  { id: "referral", label: "Referral" },
  { id: "volume", label: "Volume" },
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

function getViewerName(
  liveProfile: NeynarProfile | null,
  cachedProfile: CachedLeaderboardProfile | null,
  address?: string
) {
  if (liveProfile?.display_name) {
    return liveProfile.display_name;
  }

  if (liveProfile?.username) {
    return liveProfile.username;
  }

  if (cachedProfile?.displayName) {
    return cachedProfile.displayName;
  }

  if (cachedProfile?.username) {
    return cachedProfile.username;
  }

  return address ? shortAddress(address) : "Wallet not connected";
}

function getViewerSubtitle(
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

  return address ? shortAddress(address) : "No wallet linked";
}

function getViewerAvatar(
  liveProfile: NeynarProfile | null,
  cachedProfile: CachedLeaderboardProfile | null
) {
  return liveProfile?.pfp_url || cachedProfile?.pfpUrl || "";
}

function getRowUsername(profile: CachedLeaderboardProfile | null, address: string) {
  if (profile?.username) {
    return `@${profile.username}`;
  }

  return shortAddress(address);
}

function getInitials(label: string) {
  const letters = label
    .replace(/@/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return letters || "DS";
}

function getBoardColumns(type: LeaderboardBoardType): CSSProperties {
  if (type === "referral") {
    return {
      gridTemplateColumns: "42px minmax(0,1fr) 60px 64px",
    };
  }

  if (type === "volume") {
    return {
      gridTemplateColumns: "42px minmax(0,1fr) 84px",
    };
  }

  return {
    gridTemplateColumns: "42px minmax(0,1fr) 72px",
  };
}

function getBoardHeaders(type: LeaderboardBoardType) {
  if (type === "referral") {
    return ["Rank", "User", "Refs", "PP"];
  }

  if (type === "volume") {
    return ["Rank", "User", "Volume"];
  }

  return ["Rank", "User", "Total PP"];
}

function getVisiblePages(currentPage: number, totalPages: number) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const visiblePages: Array<number | "ellipsis"> = [1];
  const start = Math.max(2, currentPage - 1);
  const end = Math.min(totalPages - 1, currentPage + 1);

  if (start > 2) {
    visiblePages.push("ellipsis");
  }

  for (let page = start; page <= end; page += 1) {
    visiblePages.push(page);
  }

  if (end < totalPages - 1) {
    visiblePages.push("ellipsis");
  }

  visiblePages.push(totalPages);

  return visiblePages;
}

function Avatar({
  src,
  label,
  sizeClass = "h-9 w-9",
  textClass = "text-[11px]",
}: {
  src?: string;
  label: string;
  sizeClass?: string;
  textClass?: string;
}) {
  if (src) {
    return (
      <img
        src={src}
        alt={label}
        className={`${sizeClass} rounded-full object-cover ring-1 ring-white/90`}
        referrerPolicy="no-referrer"
      />
    );
  }

  return (
    <div
      className={`flex ${sizeClass} items-center justify-center rounded-full bg-[radial-gradient(circle_at_30%_30%,#ffffff_0%,#dbeafe_46%,#cbd5e1_100%)] font-semibold text-slate-700 ring-1 ring-white/90 ${textClass}`}
    >
      {getInitials(label)}
    </div>
  );
}

function CompactStatCard({
  label,
  value,
  isLoading,
}: {
  label: string;
  value: string;
  isLoading?: boolean;
}) {
  return (
    <div className="flex h-[84px] flex-col justify-between rounded-[22px] border border-white/90 bg-white/84 px-3 py-3 shadow-[0_14px_40px_rgba(148,163,184,0.10)] backdrop-blur-xl">
      <p className="text-[9px] font-semibold uppercase tracking-[0.22em] text-slate-400">
        {label}
      </p>
      <p className="text-lg font-semibold tracking-[-0.05em] text-slate-950 sm:text-[1.35rem]">
        {isLoading ? <span className="animate-pulse text-slate-300">...</span> : value}
      </p>
    </div>
  );
}

function SkeletonTable({ type }: { type: LeaderboardBoardType }) {
  const columns = getBoardColumns(type);

  return (
    <div className="space-y-1.5">
      {Array.from({ length: 6 }).map((_, index) => (
        <div
          key={index}
          className="grid h-10 items-center rounded-[14px] border border-white/90 bg-white/80 px-3"
          style={columns}
        >
          <div className="h-3 w-7 animate-pulse rounded-full bg-slate-200" />
          <div className="h-3 w-20 animate-pulse rounded-full bg-slate-200" />
          <div className="ml-auto h-3 w-12 animate-pulse rounded-full bg-slate-200" />
          {type === "referral" ? (
            <div className="ml-auto h-3 w-10 animate-pulse rounded-full bg-slate-200" />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function TableCellValue({
  type,
  entry,
}: {
  type: LeaderboardBoardType;
  entry: LeaderboardHubEntry;
}) {
  if (type === "referral") {
    return (
      <>
        <div className="truncate text-right text-[11px] font-semibold text-slate-700">
          {formatWhole(entry.referredUsers)}
        </div>
        <div className="truncate text-right text-[11px] font-semibold text-slate-950">
          {formatWhole(entry.referralPoints)}
        </div>
      </>
    );
  }

  if (type === "volume") {
    return (
      <div className="truncate text-right text-[11px] font-semibold text-slate-950">
        {formatUsd(entry.swapVolume)}
      </div>
    );
  }

  return (
    <div className="truncate text-right text-[11px] font-semibold text-slate-950">
      {formatWhole(entry.totalPoints)}
    </div>
  );
}

export default function LeaderboardPage() {
  const { address } = useAccount();
  const [selectedBoard, setSelectedBoard] = useState<LeaderboardBoardType>("particle_points");
  const [currentPage, setCurrentPage] = useState(1);
  const [leaderboard, setLeaderboard] = useState<LeaderboardHubResponse | null>(null);
  const [profile, setProfile] = useState<NeynarProfile | null>(null);
  const [isLoadingBoard, setIsLoadingBoard] = useState(true);
  const [isLoadingProfile, setIsLoadingProfile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  const normalizedAddress = address?.toLowerCase();
  const viewer = leaderboard?.viewer ?? null;
  const viewerProfile = viewer?.profile ?? null;
  const viewerName = getViewerName(profile, viewerProfile, address);
  const viewerSubtitle = getViewerSubtitle(profile, viewerProfile, address);
  const viewerAvatar = getViewerAvatar(profile, viewerProfile);
  const boardColumns = getBoardColumns(selectedBoard);
  const boardHeaders = getBoardHeaders(selectedBoard);
  const tableEntries = leaderboard?.entries ?? [];
  const totalPages = leaderboard?.totalPages ?? 1;
  const visiblePages = getVisiblePages(currentPage, totalPages);

  const loadLeaderboard = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false;

      if (!silent) {
        setIsLoadingBoard(true);
      }
      setError(null);

      try {
        const response = await fetchLeaderboardHub(selectedBoard, {
          page: currentPage,
          pageSize: BOARD_PAGE_SIZE,
          viewerAddress: normalizedAddress,
        });

        if (!response.success) {
          throw new Error(response.error || "Failed to load leaderboard");
        }

        if (isMountedRef.current) {
          setLeaderboard(response);
          setCurrentPage(response.page);
        }
      } catch (loadError) {
        if (isMountedRef.current && !silent) {
          setError((loadError as Error).message || "Failed to load leaderboard");
          setLeaderboard(null);
        }
      } finally {
        if (isMountedRef.current && !silent) {
          setIsLoadingBoard(false);
        }
      }
    },
    [currentPage, normalizedAddress, selectedBoard]
  );

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

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
    const unsubscribe = subscribeToDataInvalidation("leaderboard", () => {
      void loadLeaderboard({ silent: true });
    });
    const handleFocus = () => {
      void loadLeaderboard({ silent: true });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void loadLeaderboard({ silent: true });
      }
    };
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadLeaderboard({ silent: true });
      }
    }, LEADERBOARD_FALLBACK_REFRESH_MS);

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      unsubscribe();
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.clearInterval(intervalId);
    };
  }, [loadLeaderboard]);

  return (
    <main className="min-h-screen bg-[#f3f7fb] px-3 py-3 sm:px-4 sm:py-4 md:px-8 md:py-8">
      <section className="relative mx-auto flex min-h-[calc(100vh-1.5rem)] max-w-6xl flex-col overflow-hidden rounded-[30px] border border-white/85 bg-white/58 shadow-[0_28px_90px_rgba(148,163,184,0.18)] backdrop-blur-xl">
        <InteractiveLeaderboardBackground />

        <div className="relative z-10 flex min-h-[calc(100vh-1.5rem)] flex-col gap-3 px-3 py-3 sm:gap-4 sm:px-4 sm:py-4 md:px-8 md:py-8">
          <div className="grid grid-cols-[132px_minmax(0,1fr)] gap-2 sm:grid-cols-[164px_minmax(0,1fr)]">
            <div className="flex h-[84px] items-center rounded-[22px] border border-white/90 bg-white/84 px-3 shadow-[0_14px_40px_rgba(148,163,184,0.10)] backdrop-blur-xl">
              <Image
                src="/longlogo.png"
                alt="DustSwap"
                width={170}
                height={40}
                priority
                className="h-auto w-full max-w-[128px] sm:max-w-[150px]"
              />
            </div>

            <div className="flex h-[84px] items-center justify-between gap-2 rounded-[22px] border border-white/90 bg-white/84 px-3 shadow-[0_14px_40px_rgba(148,163,184,0.10)] backdrop-blur-xl">
              {normalizedAddress ? (
                <div className="flex min-w-0 items-center gap-2.5">
                  <Avatar src={viewerAvatar} label={viewerName} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold tracking-[-0.04em] text-slate-950">
                      {viewerName}
                    </p>
                    <p className="truncate text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      {isLoadingProfile ? "Loading" : viewerSubtitle}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="min-w-0">
                  <p className="text-[9px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                    Wallet
                  </p>
                  <p className="mt-1 truncate text-[11px] font-semibold text-slate-900">
                    Connect to load your profile
                  </p>
                  <div className="mt-1.5 origin-left scale-[0.78] sm:scale-[0.84]">
                    {/* @ts-ignore */}
                    <appkit-button />
                  </div>
                </div>
              )}

              <div className="shrink-0 text-right">
                <p className="text-[9px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                  Total Earned
                </p>
                <p className="mt-1 text-base font-semibold tracking-[-0.05em] text-slate-950 sm:text-lg">
                  {formatWhole(viewer?.totalPoints || 0)} PP
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <CompactStatCard
              label="Total Particle Points"
              value={`${formatWhole(leaderboard?.totalParticlePoints || 0)} PP`}
              isLoading={isLoadingBoard}
            />
            <CompactStatCard
              label="Total Users"
              value={formatWhole(leaderboard?.totalUserCount || 0)}
              isLoading={isLoadingBoard}
            />
          </div>

          <div className="relative overflow-hidden rounded-[20px] border border-white/90 bg-[linear-gradient(135deg,rgba(255,255,255,0.86),rgba(239,246,255,0.9),rgba(248,250,252,0.96))] px-3 py-3 shadow-[0_14px_36px_rgba(148,163,184,0.10)] backdrop-blur-xl">
            <div
              className="absolute inset-y-0 left-[-45%] w-[55%] bg-[linear-gradient(90deg,rgba(255,255,255,0),rgba(96,165,250,0.7),rgba(255,255,255,0))] blur-[16px]"
              style={{ animation: "leaderboard-beam 7s linear infinite" }}
            />
            <div className="relative z-10 h-3 overflow-hidden rounded-full bg-white/80 ring-1 ring-sky-100">
              <div
                className="h-full w-[38%] rounded-full bg-[linear-gradient(90deg,#7dd3fc_0%,#38bdf8_34%,#60a5fa_100%)] shadow-[0_0_28px_rgba(96,165,250,0.45)]"
                style={{ animation: "leaderboard-beam 9s linear infinite" }}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2">
            {BOARD_OPTIONS.map((option) => {
              const active = option.id === selectedBoard;

              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    setSelectedBoard(option.id);
                    setCurrentPage(1);
                  }}
                  className={`flex h-8 items-center justify-center rounded-full border px-3 text-[11px] font-semibold transition-all duration-200 ${
                    active
                      ? "border-slate-900 bg-slate-950 text-white shadow-[0_12px_28px_rgba(15,23,42,0.16)]"
                      : "border-slate-200/90 bg-white/88 text-slate-600 shadow-[0_8px_22px_rgba(148,163,184,0.08)] hover:border-slate-300 hover:text-slate-900"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          <div className="rounded-[22px] border border-white/90 bg-white/72 p-2.5 shadow-[0_16px_48px_rgba(148,163,184,0.12)] backdrop-blur-xl sm:p-3">
            <div className="flex items-center justify-between gap-2 px-1 pb-2">
              <div>
                <p className="text-[9px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                  Leaderboard
                </p>
                <p className="mt-1 text-sm font-semibold tracking-[-0.03em] text-slate-950">
                  {BOARD_OPTIONS.find((option) => option.id === selectedBoard)?.label}
                </p>
              </div>
              <div className="rounded-full border border-sky-100 bg-sky-50/90 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-sky-700">
                Page {leaderboard?.page ?? currentPage}/{totalPages}
              </div>
            </div>

            <div
              className="grid h-9 items-center rounded-[14px] border border-slate-200/80 bg-white/86 px-3"
              style={boardColumns}
            >
              {boardHeaders.map((header, index) => (
                <div
                  key={header}
                  className={`truncate text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400 ${
                    index === 0 ? "" : index === 1 ? "" : "text-right"
                  }`}
                >
                  {header}
                </div>
              ))}
            </div>

            <div className="mt-1.5">
              {isLoadingBoard ? <SkeletonTable type={selectedBoard} /> : null}

              {!isLoadingBoard && error ? (
                <div className="rounded-[14px] border border-rose-100 bg-rose-50/90 px-3 py-3 text-sm text-rose-700">
                  {error}
                </div>
              ) : null}

              {!isLoadingBoard && !error && !tableEntries.length ? (
                <div className="rounded-[14px] border border-slate-200/80 bg-white/84 px-3 py-4 text-center text-sm text-slate-500">
                  No leaderboard data yet.
                </div>
              ) : null}

              {!isLoadingBoard && !error && tableEntries.length ? (
                <div className="space-y-1.5">
                  {tableEntries.map((entry, index) => {
                    const isViewer =
                      Boolean(normalizedAddress) &&
                      entry.address.toLowerCase() === normalizedAddress;

                    return (
                      <div
                        key={`${selectedBoard}-${entry.userId}-${entry.rank}-${index}`}
                        className={`grid h-10 items-center rounded-[14px] border px-3 ${
                          isViewer
                            ? "border-sky-200 bg-[linear-gradient(135deg,rgba(255,255,255,0.96),rgba(239,246,255,0.94))]"
                            : "border-white/90 bg-white/82"
                        }`}
                        style={{
                          ...boardColumns,
                          animation:
                            "leaderboard-row-in 480ms cubic-bezier(0.22,1,0.36,1) both",
                          animationDelay: `${index * 40}ms`,
                        }}
                      >
                        <div className="truncate text-[11px] font-semibold text-slate-700">
                          #{entry.rank}
                        </div>
                        <div className="flex min-w-0 items-center gap-2">
                          <Avatar
                            src={entry.profile?.pfpUrl || ""}
                            label={getRowUsername(entry.profile, entry.address)}
                            sizeClass="h-[22px] w-[22px]"
                            textClass="text-[8px]"
                          />
                          <div className="truncate text-[11px] font-semibold text-slate-950">
                            {getRowUsername(entry.profile, entry.address)}
                          </div>
                        </div>
                        <TableCellValue type={selectedBoard} entry={entry} />
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>

            {!isLoadingBoard && !error && totalPages > 1 ? (
              <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                  disabled={currentPage <= 1}
                  className="flex h-8 items-center justify-center rounded-full border border-slate-200/90 bg-white/88 px-3 text-[11px] font-semibold text-slate-700 shadow-[0_8px_22px_rgba(148,163,184,0.08)] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  Prev
                </button>

                {visiblePages.map((page, index) =>
                  page === "ellipsis" ? (
                    <span
                      key={`ellipsis-${index}`}
                      className="flex h-8 w-8 items-center justify-center text-[11px] font-semibold text-slate-400"
                    >
                      ...
                    </span>
                  ) : (
                    <button
                      key={page}
                      type="button"
                      onClick={() => setCurrentPage(page)}
                      className={`flex h-8 w-8 items-center justify-center rounded-full border text-[11px] font-semibold ${
                        page === currentPage
                          ? "border-slate-900 bg-slate-950 text-white shadow-[0_12px_28px_rgba(15,23,42,0.16)]"
                          : "border-slate-200/90 bg-white/88 text-slate-700 shadow-[0_8px_22px_rgba(148,163,184,0.08)]"
                      }`}
                    >
                      {page}
                    </button>
                  )
                )}

                <button
                  type="button"
                  onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                  disabled={currentPage >= totalPages}
                  className="flex h-8 items-center justify-center rounded-full border border-slate-200/90 bg-white/88 px-3 text-[11px] font-semibold text-slate-700 shadow-[0_8px_22px_rgba(148,163,184,0.08)] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  Next
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}
