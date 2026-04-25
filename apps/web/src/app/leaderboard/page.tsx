"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useAccount } from "wagmi";
import { WalletConnectButton } from "@/components/wallet/WalletConnectButton";
import { subscribeToDataInvalidation } from "@/lib/clientEvents";
import {
  fetchLeaderboardHub,
  fetchPointsSummary,
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

function isEnabledFlag(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

const VOLUME_LEADERBOARD_ENABLED =
  isEnabledFlag(process.env.NEXT_PUBLIC_VOLUME_LEADERBOARD_ENABLED);

const BOARD_OPTIONS: Array<{
  id: LeaderboardBoardType;
  label: string;
}> = [
  { id: "particle_points", label: "Particle Points" },
  { id: "referral", label: "Referrals" },
  { id: "volume", label: "Volume" },
];
const VISIBLE_BOARD_OPTIONS = BOARD_OPTIONS.filter(
  (option) => VOLUME_LEADERBOARD_ENABLED || option.id !== "volume"
);

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
  if (cachedProfile?.displayName) {
    return cachedProfile.displayName;
  }

  if (cachedProfile?.username) {
    return cachedProfile.username;
  }

  if (liveProfile?.display_name) {
    return liveProfile.display_name;
  }

  if (liveProfile?.username) {
    return liveProfile.username;
  }

  return address ? shortAddress(address) : "Wallet not connected";
}

function getViewerAvatar(
  liveProfile: NeynarProfile | null,
  cachedProfile: CachedLeaderboardProfile | null
) {
  return cachedProfile?.pfpUrl || liveProfile?.pfp_url || "";
}

function getRowUsername(profile: CachedLeaderboardProfile | null, address: string) {
  if (profile?.username) {
    return `@${profile.username}`;
  }

  return shortAddress(address);
}

function getInitials(label: string) {
  const compactLabel = label.trim();

  if (compactLabel.toLowerCase().startsWith("0x")) {
    return "0x";
  }

  const letters = label
    .replace(/@/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return letters && letters !== "0" ? letters : "0x";
}

function getBoardColumns(type: LeaderboardBoardType): CSSProperties {
  if (type === "referral") {
    return {
      gridTemplateColumns: "44px minmax(0,1fr) 44px 70px",
    };
  }

  if (type === "volume") {
    return {
      gridTemplateColumns: "44px minmax(0,1fr) 84px",
    };
  }

  return {
    gridTemplateColumns: "44px minmax(0,1fr) 86px",
  };
}

function getBoardHeaders(type: LeaderboardBoardType) {
  if (type === "referral") {
    return ["Rank", "User", "Refs", "PP"];
  }

  if (type === "volume") {
    return ["Rank", "User", "Volume"];
  }

  return ["Rank", "User", "PP"];
}

function getViewerScoreDisplay(type: LeaderboardBoardType, entry: LeaderboardHubEntry | null) {
  if (!entry) {
    return type === "volume" ? formatUsd(0) : type === "referral" ? "0 referrals" : "0 PP";
  }

  if (type === "referral") {
    return `${formatWhole(entry.referredUsers)} referral${entry.referredUsers === 1 ? "" : "s"}`;
  }

  if (type === "volume") {
    return formatUsd(entry.swapVolume);
  }

  return `${formatWhole(entry.totalPoints)} PP`;
}

function getViewerScoreDetail(type: LeaderboardBoardType, entry: LeaderboardHubEntry | null) {
  if (!entry) {
    return type === "referral" ? "0 PP" : null;
  }

  if (type === "referral") {
    return `${formatWhole(entry.referralPoints)} PP`;
  }

  return null;
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
        className={`${sizeClass} rounded-full border border-white object-cover shadow-sm`}
        referrerPolicy="no-referrer"
      />
    );
  }

  return (
    <div
      className={`flex ${sizeClass} items-center justify-center rounded-full border border-sky-100 bg-[linear-gradient(135deg,#eff6ff,#ffffff)] font-semibold text-sky-700 shadow-sm ${textClass}`}
    >
      {getInitials(label)}
    </div>
  );
}

function OverviewMetric({
  label,
  value,
  isLoading,
  tone = "white",
}: {
  label: string;
  value: string;
  isLoading?: boolean;
  tone?: "white" | "blue" | "gold" | "mint";
}) {
  const tones = {
    white: "border-white/80 bg-white/90 text-slate-950",
    blue: "border-sky-100 bg-sky-50/90 text-sky-950",
    gold: "border-amber-100 bg-amber-50/90 text-amber-950",
    mint: "border-emerald-100 bg-emerald-50/90 text-emerald-950",
  };

  return (
    <div className={`min-w-0 rounded-lg border px-2 py-1 shadow-[0_8px_22px_rgba(15,23,42,0.045)] ${tones[tone]}`}>
      <p className="truncate text-[8px] font-semibold uppercase leading-none text-slate-500">
        {label}
      </p>
      <p className="mt-1 truncate text-[12px] font-bold leading-none">
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
          className="grid h-[34px] items-center rounded-lg border border-slate-200 bg-white px-2"
          style={columns}
        >
          <div className="h-3 w-8 animate-pulse rounded-full bg-slate-200" />
          <div className="h-6 w-24 animate-pulse rounded-full bg-slate-200" />
          <div className="ml-auto h-3 w-14 animate-pulse rounded-full bg-slate-200" />
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
        <div className="truncate text-right text-xs font-semibold leading-none text-slate-800">
          {formatWhole(entry.referredUsers)}
        </div>
        <div className="truncate text-right text-xs font-semibold leading-none text-slate-950">
          {formatWhole(entry.referralPoints)} PP
        </div>
      </>
    );
  }

  if (type === "volume") {
    return (
      <div className="truncate text-right text-xs font-semibold text-slate-950">
        {formatUsd(entry.swapVolume)}
      </div>
    );
  }

  return (
    <div className="truncate text-right text-xs font-semibold text-slate-950">
      {formatWhole(entry.totalPoints)} PP
    </div>
  );
}

function LeaderboardRow({
  type,
  entry,
  columns,
  label,
  avatarSrc,
  isViewer,
  badge,
  animationDelayMs = 0,
}: {
  type: LeaderboardBoardType;
  entry: LeaderboardHubEntry;
  columns: CSSProperties;
  label: string;
  avatarSrc?: string;
  isViewer?: boolean;
  badge?: string;
  animationDelayMs?: number;
}) {
  return (
    <div
      className={`grid h-[34px] items-center rounded-lg border px-2 transition-colors ${
        isViewer
          ? "border-sky-200 bg-sky-50/80"
          : "border-slate-200 bg-white hover:border-slate-300"
      }`}
      style={{
        ...columns,
        animation: "leaderboard-row-in 480ms cubic-bezier(0.22,1,0.36,1) both",
        animationDelay: `${animationDelayMs}ms`,
      }}
    >
      <div className="truncate text-xs font-semibold text-slate-700">#{entry.rank}</div>
      <div className="flex min-w-0 items-center gap-2">
        <Avatar
          src={avatarSrc || ""}
          label={label}
          sizeClass="h-6 w-6"
          textClass="text-[9px]"
        />
        <div className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-950">
          {label}
        </div>
        {badge ? (
          <span className="rounded-full border border-sky-200 bg-white px-1.5 py-0 text-[9px] font-semibold text-sky-700">
            {badge}
          </span>
        ) : null}
      </div>
      <TableCellValue type={type} entry={entry} />
    </div>
  );
}

export default function LeaderboardPage() {
  const { address } = useAccount();
  const [selectedBoard, setSelectedBoard] = useState<LeaderboardBoardType>("particle_points");
  const [currentPage, setCurrentPage] = useState(1);
  const [leaderboard, setLeaderboard] = useState<LeaderboardHubResponse | null>(null);
  const [profile, setProfile] = useState<NeynarProfile | null>(null);
  const [isCheckingAccess, setIsCheckingAccess] = useState(true);
  const [hasLeaderboardAccess, setHasLeaderboardAccess] = useState(false);
  const [isLoadingBoard, setIsLoadingBoard] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const leaderboardRef = useRef<LeaderboardHubResponse | null>(null);
  const autoRefreshPausedRef = useRef(false);
  const loadRequestIdRef = useRef(0);

  const normalizedAddress = address?.toLowerCase();
  const visibleLeaderboard =
    leaderboard?.type === selectedBoard && leaderboard?.page === currentPage
      ? leaderboard
      : null;
  const viewer = visibleLeaderboard?.viewer ?? null;
  const viewerProfile = viewer?.profile ?? null;
  const viewerName = getViewerName(profile, viewerProfile, address);
  const viewerAvatar = getViewerAvatar(profile, viewerProfile);
  const boardColumns = getBoardColumns(selectedBoard);
  const boardHeaders = getBoardHeaders(selectedBoard);
  const tableEntries = visibleLeaderboard?.entries ?? [];
  const pinnedViewerEntry = normalizedAddress && viewer ? viewer : null;
  const displayEntries = pinnedViewerEntry
    ? tableEntries.filter((entry) => entry.address.toLowerCase() !== normalizedAddress)
    : tableEntries;
  const hasVisibleEntries = Boolean(pinnedViewerEntry) || displayEntries.length > 0;
  const totalPages = visibleLeaderboard?.totalPages ?? 1;
  const visiblePages = getVisiblePages(currentPage, totalPages);
  const shouldShowBoardSkeleton = hasLeaderboardAccess && isLoadingBoard && !visibleLeaderboard;

  useEffect(() => {
    if (!VISIBLE_BOARD_OPTIONS.some((option) => option.id === selectedBoard)) {
      setSelectedBoard("particle_points");
      setCurrentPage(1);
    }
  }, [selectedBoard]);

  const loadLeaderboard = useCallback(
    async (options?: { manual?: boolean; silent?: boolean }) => {
      if (!normalizedAddress || !hasLeaderboardAccess) {
        if (!(options?.silent ?? false)) {
          setIsLoadingBoard(false);
        }
        return;
      }

      const silent = options?.silent ?? false;
      const manual = options?.manual ?? false;

      if (silent && autoRefreshPausedRef.current) {
        return;
      }

      if (manual) {
        autoRefreshPausedRef.current = false;
      }

      const requestId = loadRequestIdRef.current + 1;
      loadRequestIdRef.current = requestId;

      if (!silent) {
        setIsLoadingBoard(true);
      }

      if (!silent || manual) {
        setError(null);
        setRefreshNotice(null);
      }

      try {
        const response = await fetchLeaderboardHub(selectedBoard, {
          page: currentPage,
          pageSize: BOARD_PAGE_SIZE,
          viewerAddress: normalizedAddress,
        });

        if (!response.success) {
          throw new Error(response.error || "Failed to load leaderboard");
        }

        if (isMountedRef.current && loadRequestIdRef.current === requestId) {
          autoRefreshPausedRef.current = false;
          setError(null);
          setRefreshNotice(null);
          setLeaderboard(response);
          setCurrentPage(response.page);
        }
      } catch (loadError) {
        if (isMountedRef.current && loadRequestIdRef.current === requestId) {
          const message = (loadError as Error).message || "Failed to load leaderboard";
          const currentLeaderboard = leaderboardRef.current;
          const hasCompatibleLeaderboard =
            currentLeaderboard?.type === selectedBoard &&
            currentLeaderboard?.page === currentPage;

          autoRefreshPausedRef.current = true;

          if (hasCompatibleLeaderboard) {
            setRefreshNotice(
              "Leaderboard refresh paused after a server error. Retry manually when ready."
            );
          } else {
            setError(message);
          }
        }
      } finally {
        if (isMountedRef.current && loadRequestIdRef.current === requestId && !silent) {
          setIsLoadingBoard(false);
        }
      }
    },
    [currentPage, hasLeaderboardAccess, normalizedAddress, selectedBoard]
  );

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    leaderboardRef.current = leaderboard;
  }, [leaderboard]);

  useEffect(() => {
    let cancelled = false;

    if (!normalizedAddress) {
      setIsCheckingAccess(false);
      setHasLeaderboardAccess(false);
      setLeaderboard(null);
      setError(null);
      setRefreshNotice(null);
      setIsLoadingBoard(false);
      return () => {
        cancelled = true;
      };
    }

    setIsCheckingAccess(true);

    void fetchPointsSummary(normalizedAddress, { force: true })
      .then((summary) => {
        if (cancelled) {
          return;
        }

        const hasAccess = Boolean(summary.success && summary.balance?.lastCheckIn);
        setHasLeaderboardAccess(hasAccess);

        if (!hasAccess) {
          setLeaderboard(null);
          setError(null);
          setRefreshNotice(null);
          setIsLoadingBoard(false);
        }
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setHasLeaderboardAccess(false);
        setLeaderboard(null);
        setError(null);
        setRefreshNotice(null);
        setIsLoadingBoard(false);
      })
      .finally(() => {
        if (!cancelled) {
          setIsCheckingAccess(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [normalizedAddress]);

  useEffect(() => {
    if (!normalizedAddress || !hasLeaderboardAccess) {
      setLeaderboard(null);
      setError(null);
      setRefreshNotice(null);
      setIsLoadingBoard(false);
      return;
    }

    void loadLeaderboard();
  }, [hasLeaderboardAccess, loadLeaderboard, normalizedAddress]);

  useEffect(() => {
    if (!normalizedAddress || !hasLeaderboardAccess) {
      setProfile(null);
      return;
    }

    let cancelled = false;

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
      });

    return () => {
      cancelled = true;
    };
  }, [hasLeaderboardAccess, normalizedAddress]);

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

  const selectedBoardLabel =
    VISIBLE_BOARD_OPTIONS.find((option) => option.id === selectedBoard)?.label ?? "Particle Points";
  const viewerRankLabel = viewer?.rank ? `#${formatWhole(viewer.rank)}` : "--";
  const viewerScoreDisplay = getViewerScoreDisplay(selectedBoard, viewer);
  const viewerScoreDetail = getViewerScoreDetail(selectedBoard, viewer);
  const viewerScoreLabel = viewerScoreDetail
    ? `${viewerScoreDisplay} / ${viewerScoreDetail}`
    : viewerScoreDisplay;
  const viewerAddressLabel = normalizedAddress ? shortAddress(normalizedAddress) : "Connect wallet";

  return (
    <main
      className="min-h-[100dvh] bg-[#f6f8fb] px-3 pb-[calc(8rem+env(safe-area-inset-bottom))] pt-4 sm:px-5 sm:pb-16 sm:pt-6 md:px-8 md:pt-8"
      style={{ minHeight: "100dvh" }}
    >
      <section
        className="mx-auto flex w-full max-w-5xl flex-col"
      >
        <div className="flex flex-col gap-3">
          <section className="overflow-hidden rounded-[18px] border border-white/80 bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.16),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(245,158,11,0.18),transparent_32%),linear-gradient(135deg,#ffffff_0%,#f7fbff_48%,#fff7ed_100%)] p-2.5 shadow-[0_18px_55px_rgba(15,23,42,0.08)]">
            <div className="flex items-center justify-between gap-3">
              <img
                src="/longlogo.png"
                alt="DustSwap"
                className="h-7 w-auto min-w-0 max-w-[170px] object-contain sm:h-8 sm:max-w-[220px]"
              />

              <div className="flex min-w-0 shrink-0 items-center gap-2 rounded-full border border-white/80 bg-white/90 px-2 py-1 shadow-[0_10px_28px_rgba(15,23,42,0.08)]">
                <Avatar
                  src={viewerAvatar}
                  label={viewerName}
                  sizeClass="h-8 w-8"
                  textClass="text-[10px]"
                />
                <p className="max-w-[116px] truncate font-mono text-[11px] font-bold text-slate-800 sm:max-w-[170px]">
                  {viewerAddressLabel}
                </p>
              </div>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              <OverviewMetric
                label="Rank"
                value={viewerRankLabel}
                tone="gold"
                isLoading={shouldShowBoardSkeleton}
              />
              <OverviewMetric
                label="Score"
                value={viewerScoreLabel}
                tone="blue"
                isLoading={shouldShowBoardSkeleton}
              />
              <OverviewMetric
                label="Total PP"
                value={`${formatWhole(visibleLeaderboard?.totalParticlePoints || 0)} PP`}
                tone="mint"
                isLoading={shouldShowBoardSkeleton}
              />
              <OverviewMetric
                label="Users"
                value={formatWhole(visibleLeaderboard?.totalUserCount || 0)}
                isLoading={shouldShowBoardSkeleton}
              />
            </div>
          </section>

          <div className="flex gap-2 overflow-x-auto pb-1">
            {VISIBLE_BOARD_OPTIONS.map((option) => {
              const active = option.id === selectedBoard;

              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    setSelectedBoard(option.id);
                    setCurrentPage(1);
                  }}
                  className={`flex h-[30px] max-h-[30px] shrink-0 items-center justify-center rounded-full border px-3 text-xs font-semibold transition-colors ${
                    active
                      ? "border-[#0052ff] bg-[#0052ff] text-white"
                      : "border-slate-200 bg-white text-slate-700 hover:border-sky-200 hover:text-slate-950"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          {isCheckingAccess ? (
            <div className="rounded-lg border border-slate-200 bg-white p-6 text-center shadow-[0_12px_30px_rgba(15,23,42,0.05)] sm:p-7">
              <p className="text-sm font-medium text-slate-500">
                Checking access
              </p>
              <p className="mt-2 text-sm font-semibold text-slate-900">
                Verifying your first onchain check-in before loading the leaderboard.
              </p>
            </div>
          ) : !normalizedAddress ? (
            <div className="rounded-lg border border-slate-200 bg-white p-6 text-center shadow-[0_12px_30px_rgba(15,23,42,0.05)] sm:p-7">
              <p className="text-sm font-medium text-slate-500">
                Connect wallet
              </p>
              <h2 className="mt-2 text-xl font-semibold text-slate-950">
                Connect your wallet, then complete one check-in to unlock the leaderboard.
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Leaderboard access starts after your first onchain check-in.
              </p>
              <div className="mt-4 flex justify-center">
                <WalletConnectButton
                  className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-slate-200 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-[0_8px_20px_rgba(15,23,42,0.06)] transition-colors hover:border-sky-200 hover:bg-sky-50 hover:text-slate-900"
                  description="Connect your wallet, then complete one check-in to unlock the leaderboard."
                />
              </div>
            </div>
          ) : !hasLeaderboardAccess ? (
            <div className="rounded-lg border border-slate-200 bg-white p-6 text-center shadow-[0_12px_30px_rgba(15,23,42,0.05)] sm:p-7">
              <p className="text-sm font-medium text-slate-500">
                Leaderboard locked
              </p>
              <h2 className="mt-2 text-xl font-semibold text-slate-950">
                Complete your first onchain check-in to unlock leaderboard access.
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                After your first check-in, you&apos;ll be able to view Particle Points and Referrals rankings.
              </p>
              <div className="mt-4 flex justify-center">
                <Link
                  href="/profile"
                  className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-sky-200 bg-sky-50 px-5 py-2.5 text-sm font-semibold text-sky-800 transition-colors hover:bg-sky-100"
                >
                  Go to Profile Check-In
                </Link>
              </div>
            </div>
          ) : (
            <section className="overflow-hidden rounded-[16px] border border-sky-200/80 bg-white shadow-[0_18px_48px_rgba(0,82,255,0.08)]">
              <div className="flex items-center justify-between gap-3 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.22),transparent_34%),linear-gradient(135deg,#0052ff_0%,#0ea5e9_58%,#38bdf8_100%)] px-3 py-2 sm:px-4">
                <div>
                  <p className="text-sm font-bold text-white">
                    {selectedBoardLabel}
                  </p>
                  <p className="text-[11px] font-medium text-sky-50/90">
                    Live rank and score
                  </p>
                </div>
                <div className="rounded-full border border-white/25 bg-white/15 px-2.5 py-1 text-[11px] font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.16)]">
                  Page {visibleLeaderboard?.page ?? currentPage}/{totalPages}
                </div>
              </div>

              <div
                className="grid h-[30px] items-center border-y border-sky-100 bg-[linear-gradient(90deg,#eff6ff,#f0f9ff)] px-2 sm:px-3"
                style={boardColumns}
              >
                {boardHeaders.map((header, index) => (
                  <div
                    key={header}
                    className={`truncate text-[11px] font-bold uppercase text-slate-500 ${
                      index === 0 ? "" : index === 1 ? "" : "text-right"
                    }`}
                  >
                    {header}
                  </div>
                ))}
              </div>

              <div className="p-2 sm:p-3">
                {refreshNotice ? (
                  <div className="mb-3 flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-800 sm:flex-row sm:items-center sm:justify-between">
                    <span>{refreshNotice}</span>
                    <button
                      type="button"
                      onClick={() => void loadLeaderboard({ manual: true })}
                      className="inline-flex items-center justify-center rounded-full border border-amber-200 bg-white px-3 py-1.5 text-xs font-semibold text-amber-800 transition-colors hover:bg-amber-100"
                    >
                      Retry
                    </button>
                  </div>
                ) : null}

                {shouldShowBoardSkeleton ? <SkeletonTable type={selectedBoard} /> : null}

                {!shouldShowBoardSkeleton && error ? (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-700">
                    <p>{error}</p>
                    <button
                      type="button"
                      onClick={() => void loadLeaderboard({ manual: true })}
                      className="mt-3 inline-flex items-center justify-center rounded-full border border-rose-200 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 transition-colors hover:bg-rose-100"
                    >
                      Retry leaderboard
                    </button>
                  </div>
                ) : null}

                {!shouldShowBoardSkeleton && !error && !hasVisibleEntries ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-5 text-center text-sm text-slate-500">
                    No leaderboard data yet.
                  </div>
                ) : null}

                {!shouldShowBoardSkeleton && !error && hasVisibleEntries ? (
                  <div className="space-y-1.5">
                    {pinnedViewerEntry ? (
                      <LeaderboardRow
                        type={selectedBoard}
                        entry={pinnedViewerEntry}
                        columns={boardColumns}
                        label={getRowUsername(viewerProfile, pinnedViewerEntry.address)}
                        avatarSrc={viewerAvatar || pinnedViewerEntry.profile?.pfpUrl || ""}
                        isViewer
                        badge="You"
                      />
                    ) : null}

                    {displayEntries.map((entry, index) => {
                      const isViewer =
                        Boolean(normalizedAddress) &&
                        entry.address.toLowerCase() === normalizedAddress;

                      return (
                        <LeaderboardRow
                          key={`${selectedBoard}-${entry.userId}-${entry.rank}-${index}`}
                          type={selectedBoard}
                          entry={entry}
                          columns={boardColumns}
                          label={getRowUsername(entry.profile, entry.address)}
                          avatarSrc={entry.profile?.pfpUrl || ""}
                          isViewer={isViewer}
                          badge={isViewer ? "You" : undefined}
                          animationDelayMs={index * 40}
                        />
                      );
                    })}
                  </div>
                ) : null}
              </div>

              {!shouldShowBoardSkeleton && !error && totalPages > 1 ? (
                <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5 px-3 pb-3 sm:px-4">
                  <button
                    type="button"
                    onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                    disabled={currentPage <= 1}
                    className="flex h-[30px] max-h-[30px] items-center justify-center rounded-full border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 transition-colors hover:border-sky-200 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    Prev
                  </button>

                  {visiblePages.map((page, index) =>
                    page === "ellipsis" ? (
                      <span
                        key={`ellipsis-${index}`}
                        className="flex h-[30px] w-[30px] max-h-[30px] items-center justify-center text-xs font-semibold text-slate-400"
                      >
                        ...
                      </span>
                    ) : (
                      <button
                        key={page}
                        type="button"
                        onClick={() => setCurrentPage(page)}
                        className={`flex h-[30px] max-h-[30px] w-[30px] items-center justify-center rounded-full border text-xs font-semibold transition-colors ${
                          page === currentPage
                            ? "border-[#0052ff] bg-[#0052ff] text-white"
                            : "border-slate-200 bg-white text-slate-700 hover:border-sky-200 hover:text-slate-950"
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
                    className="flex h-[30px] max-h-[30px] items-center justify-center rounded-full border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 transition-colors hover:border-sky-200 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    Next
                  </button>
                </div>
              ) : null}
            </section>
          )}
        </div>
      </section>
    </main>
  );
}
