"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient, useReadContract, useWalletClient } from "wagmi";
import { encodeFunctionData, erc20Abi } from "viem";
import { DailyCheckInModule } from "@/components/profile/DailyCheckInModule";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
  fetchLeaderboard,
  fetchPointsBalance,
  fetchReferralStats,
  fetchUserStats,
  performDailyCheckIn,
  resetBrokenStreak,
  saveBrokenStreak,
  type LeaderboardEntry,
  type PointsBalance,
  type ReferralStats,
  type UserStats,
} from "@/lib/points";
import { USDC_ADDRESS } from "@/lib/tokens";
import { DATA_SUFFIX } from "@/lib/builderCode";

type NeynarProfile = {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string;
};

type ToastState =
  | {
      kind: "success" | "error";
      message: string;
    }
  | null;

type CelebrationState =
  | {
      kind: "checkin" | "save";
      id: number;
    }
  | null;

type RecoveryStage = "idle" | "wallet" | "verifying";

const SAVE_USDC_AMOUNT = 1_000_000n;

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatNumber(value: number) {
  return value.toLocaleString();
}

function getDisplayName(profile: NeynarProfile | null, address: string | undefined) {
  if (profile?.display_name) {
    return profile.display_name;
  }

  if (profile?.username) {
    return profile.username;
  }

  return address ? shortAddress(address) : "Anonymous";
}

function ProfilePageContent() {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const [isMounted, setIsMounted] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [profile, setProfile] = useState<NeynarProfile | null>(null);
  const [balance, setBalance] = useState<PointsBalance | null>(null);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [referral, setReferral] = useState<ReferralStats | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [toast, setToast] = useState<ToastState>(null);
  const [celebration, setCelebration] = useState<CelebrationState>(null);
  const [isCopied, setIsCopied] = useState(false);

  const [isCheckingIn, setIsCheckingIn] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [recoveryStage, setRecoveryStage] = useState<RecoveryStage>("idle");

  const { data: usdcBalanceRaw } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address!],
    query: {
      enabled: !!address,
    },
  });

  const usdcBalance = (usdcBalanceRaw as bigint | undefined) ?? 0n;
  const preferredSaveAsset = useMemo<"eth" | "usdc">(
    () => (usdcBalance >= SAVE_USDC_AMOUNT ? "usdc" : "eth"),
    [usdcBalance]
  );

  const refreshLeaderboard = useCallback(async () => {
    if (!address) {
      setLeaderboard([]);
      return;
    }

    const leaderboardData = await fetchLeaderboard(50);
    if (leaderboardData.success) {
      setLeaderboard(leaderboardData.data || []);
    }
  }, [address]);

  const fetchProfileData = useCallback(async () => {
    if (!address) {
      setBalance(null);
      setStats(null);
      setReferral(null);
      setLeaderboard([]);
      setProfile(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);

    try {
      const [balanceData, statsData, referralData, leaderboardData] = await Promise.all([
        fetchPointsBalance(address),
        fetchUserStats(address),
        fetchReferralStats(address),
        fetchLeaderboard(50),
      ]);

      if (balanceData.success) {
        setBalance(balanceData);
      } else {
        throw new Error(balanceData.error || "Failed to load check-in status");
      }

      if (statsData.success) {
        setStats(statsData);
      }

      if (referralData.success) {
        setReferral(referralData);
      }

      if (leaderboardData.success) {
        setLeaderboard(leaderboardData.data || []);
      }

      fetch(`/api/neynar/user?address=${address}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data && !data.error) {
            setProfile(data);
          }
        })
        .catch(() => null);
    } catch (error) {
      setToast({
        kind: "error",
        message: (error as Error).message || "Failed to load your profile",
      });
    } finally {
      setIsLoading(false);
    }
  }, [address]);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (isConnected) {
      void fetchProfileData();
      return;
    }

    setIsLoading(false);
  }, [fetchProfileData, isConnected]);

  useEffect(() => {
    if (!address) {
      return;
    }

    const interval = window.setInterval(() => {
      void fetchProfileData();
    }, 60000);

    return () => window.clearInterval(interval);
  }, [address, fetchProfileData]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setToast(null);
    }, 4500);

    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!celebration) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setCelebration(null);
    }, 2200);

    return () => window.clearTimeout(timeout);
  }, [celebration]);

  const updateBalanceAndStats = useCallback(
    (nextBalance: PointsBalance) => {
      setBalance(nextBalance);
      setStats((current) =>
        current
          ? {
              ...current,
              totalPoints: nextBalance.totalPoints,
            }
          : current
      );
    },
    []
  );

  const handleCheckIn = useCallback(async () => {
    if (!address) {
      setToast({ kind: "error", message: "Connect your wallet first." });
      return;
    }

    setIsCheckingIn(true);

    try {
      const result = await performDailyCheckIn(address);
      if (!result.success) {
        throw new Error(result.error || "Check-in failed");
      }

      updateBalanceAndStats(result);
      setCelebration({ kind: "checkin", id: Date.now() });
      setToast({
        kind: "success",
        message: `Checked in successfully. ${result.pointsAwarded} PP added.`,
      });
      void refreshLeaderboard();
    } catch (error) {
      setToast({
        kind: "error",
        message: (error as Error).message || "Check-in failed",
      });
    } finally {
      setIsCheckingIn(false);
    }
  }, [address, refreshLeaderboard, updateBalanceAndStats]);

  const handleReset = useCallback(async () => {
    if (!address) {
      setToast({ kind: "error", message: "Connect your wallet first." });
      return;
    }

    setIsResetting(true);

    try {
      const result = await resetBrokenStreak(address);
      if (!result.success) {
        throw new Error(result.error || "Reset failed");
      }

      updateBalanceAndStats(result);
      setToast({
        kind: "success",
        message: result.reset
          ? "Streak reset. You can start again today."
          : "There was no broken streak to reset.",
      });
      void refreshLeaderboard();
    } catch (error) {
      setToast({
        kind: "error",
        message: (error as Error).message || "Reset failed",
      });
    } finally {
      setIsResetting(false);
    }
  }, [address, refreshLeaderboard, updateBalanceAndStats]);

  const handleSave = useCallback(async () => {
    if (!address || !balance || !walletClient || !publicClient) {
      setToast({
        kind: "error",
        message: "Connect your wallet to save this streak.",
      });
      return;
    }

    const saveAsset = preferredSaveAsset;
    setIsSaving(true);
    setRecoveryStage("wallet");

    try {
      const hash = await walletClient.sendTransaction({
        to:
          saveAsset === "usdc"
            ? (balance.saveConfig.usdcAddress as `0x${string}`)
            : (balance.saveConfig.recipient as `0x${string}`),
        data:
          saveAsset === "usdc"
            ? encodeFunctionData({
                abi: erc20Abi,
                functionName: "transfer",
                args: [balance.saveConfig.recipient as `0x${string}`, SAVE_USDC_AMOUNT],
              })
            : undefined,
        dataSuffix: DATA_SUFFIX,
        value: saveAsset === "usdc" ? 0n : BigInt(balance.saveConfig.ethAmountWei),
        capabilities: process.env.NEXT_PUBLIC_PAYMASTER_URL
          ? {
              paymasterService: {
                url: process.env.NEXT_PUBLIC_PAYMASTER_URL,
              },
            }
          : undefined,
      } as any);

      setRecoveryStage("verifying");

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error("Recovery transaction reverted");
      }

      const result = await saveBrokenStreak({
        address,
        txHash: hash,
        asset: saveAsset,
      });

      if (!result.success) {
        throw new Error(result.error || "Failed to restore streak");
      }

      updateBalanceAndStats(result);
      setCelebration({ kind: "save", id: Date.now() });
      setToast({
        kind: "success",
        message: "Streak Saved!",
      });
      void refreshLeaderboard();
    } catch (error) {
      console.error(error);
      setToast({
        kind: "error",
        message: "Transaction failed. Try again to save your streak.",
      });
    } finally {
      setRecoveryStage("idle");
      setIsSaving(false);
    }
  }, [address, balance, preferredSaveAsset, publicClient, refreshLeaderboard, updateBalanceAndStats, walletClient]);

  if (!isMounted) {
    return null;
  }

  if (!isConnected) {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-3xl items-center justify-center px-4 py-10">
        <div className="w-full rounded-[36px] border border-white/70 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.14),transparent_34%),linear-gradient(180deg,#fffdf8,#f5fbff)] p-8 text-center shadow-[0_26px_80px_rgba(15,23,42,0.08)]">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full border border-sky-200 bg-[radial-gradient(circle,rgba(56,189,248,0.18),transparent_70%)] text-4xl">
            ✨
          </div>
          <h2 className="mt-6 text-3xl font-black tracking-tight text-slate-950">
            Connect your wallet to start the streak
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-sm leading-7 text-slate-600 sm:text-base">
            Unlock daily check-ins, protect your multiplier, and climb the leaderboard with your wallet-linked profile.
          </p>
          <div className="mt-8 flex justify-center">
            {/* @ts-ignore */}
            <appkit-button />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.16),transparent_28%),radial-gradient(circle_at_top_right,rgba(251,191,36,0.14),transparent_26%),linear-gradient(180deg,#f8fafc,#fef7ed_45%,#eff6ff)] px-4 py-6 pb-20 sm:px-6 sm:py-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
        {toast ? (
          <div
            className={`rounded-[22px] border px-4 py-3 text-sm shadow-[0_18px_40px_rgba(15,23,42,0.08)] ${
              toast.kind === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-rose-200 bg-rose-50 text-rose-700"
            }`}
          >
            {toast.message}
          </div>
        ) : null}

        <section className="rounded-[34px] border border-white/70 bg-white/80 p-5 shadow-[0_28px_90px_rgba(15,23,42,0.08)] backdrop-blur sm:p-7">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-4">
              {profile?.pfp_url ? (
                <img
                  src={profile.pfp_url}
                  alt="Profile"
                  className="h-16 w-16 rounded-[22px] border border-white/70 object-cover shadow-[0_14px_34px_rgba(56,189,248,0.18)]"
                />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-[22px] border border-sky-200 bg-[linear-gradient(135deg,#38bdf8,#0ea5e9)] text-xl font-black text-white shadow-[0_14px_34px_rgba(14,165,233,0.22)]">
                  {address?.slice(2, 4)}
                </div>
              )}

              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.34em] text-slate-500">
                  Profile Hub
                </p>
                <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">
                  {getDisplayName(profile, address)}
                </h1>
                <p className="mt-2 text-sm text-slate-600">
                  {profile?.username ? `@${profile.username}` : shortAddress(address || "")}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <MetricTile
                label="Particle Points"
                value={`${formatNumber(balance?.totalPoints || 0)} PP`}
                accent="sky"
              />
              <MetricTile
                label="Leaderboard Rank"
                value={`#${balance?.rank || "--"}`}
                accent="amber"
              />
            </div>
          </div>
        </section>

        <DailyCheckInModule
          balance={balance}
          isCheckingIn={isCheckingIn}
          isSaving={isSaving}
          isResetting={isResetting}
          recoveryStage={recoveryStage}
          celebration={celebration}
          walletReady={Boolean(address)}
          preferredSaveAsset={preferredSaveAsset}
          onCheckIn={() => void handleCheckIn()}
          onSave={() => void handleSave()}
          onReset={() => void handleReset()}
        />

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatCard
            title="Particle Points"
            value={`${formatNumber(stats?.totalPoints || 0)} PP`}
            icon="⚡"
            tone="sky"
            isLoading={isLoading}
          />
          <StatCard
            title="Dust Swept"
            value={formatNumber(stats?.dustSwept || 0)}
            icon="🧹"
            tone="emerald"
            isLoading={isLoading}
          />
          <StatCard
            title="Swap Volume"
            value={`$${(stats?.swapVolume || 0).toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}`}
            icon="💱"
            tone="amber"
            isLoading={isLoading}
          />
          <StatCard
            title="Tokens Burned"
            value={formatNumber(stats?.tokensBurned || 0)}
            icon="🔥"
            tone="rose"
            isLoading={isLoading}
          />
        </section>

        <section className="grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
          <div className="rounded-[34px] border border-white/70 bg-white/80 p-5 shadow-[0_28px_90px_rgba(15,23,42,0.08)] sm:p-7">
            <p className="text-[11px] font-black uppercase tracking-[0.34em] text-slate-500">
              Referral Loop
            </p>
            <h2 className="mt-3 text-3xl font-black tracking-tight text-slate-950">
              Bring in friends, keep your own streak climbing
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-7 text-slate-600">
              Both sides get a signup boost, but your streak multiplier still applies only to the points you earn yourself.
            </p>

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <MetricTile
                label="Friends Joined"
                value={String(referral?.friendsJoined || 0)}
                accent="sky"
              />
              <MetricTile
                label="Referral Points"
                value={`${formatNumber(referral?.pointsEarned || 0)} PP`}
                accent="emerald"
              />
            </div>

            <div className="mt-6 rounded-[26px] border border-slate-200 bg-[#f8fbff] p-4">
              <p className="text-[11px] font-black uppercase tracking-[0.28em] text-slate-500">
                Your Link
              </p>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                <div className="flex-1 rounded-[20px] border border-slate-200 bg-white px-4 py-3 font-mono text-sm font-semibold tracking-[0.18em] text-sky-700">
                  {referral?.code || "LOADING..."}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (!referral?.code) {
                      return;
                    }
                    navigator.clipboard.writeText(`https://dustswap.app/ref/${referral.code}`);
                    setIsCopied(true);
                    setToast({ kind: "success", message: "Referral link copied." });
                    window.setTimeout(() => setIsCopied(false), 1800);
                  }}
                  className="rounded-[20px] bg-[linear-gradient(135deg,#0ea5e9,#22c55e)] px-5 py-3 text-sm font-black text-white shadow-[0_16px_40px_rgba(14,165,233,0.2)] transition hover:-translate-y-0.5"
                >
                  {isCopied ? "Copied!" : "Copy Link"}
                </button>
              </div>
            </div>
          </div>

          <div className="rounded-[34px] border border-white/70 bg-white/80 p-5 shadow-[0_28px_90px_rgba(15,23,42,0.08)] sm:p-7">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.34em] text-slate-500">
                  Leaderboard
                </p>
                <h2 className="mt-3 text-3xl font-black tracking-tight text-slate-950">
                  Top 50 Wallets
                </h2>
              </div>
              <button
                type="button"
                onClick={() => void refreshLeaderboard()}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-black uppercase tracking-[0.24em] text-slate-600 transition hover:bg-slate-50"
              >
                Refresh
              </button>
            </div>

            <div className="mt-6 overflow-hidden rounded-[26px] border border-slate-200">
              <div className="grid grid-cols-[0.75fr_1.6fr_1fr_0.9fr] bg-[#f8fafc] px-4 py-3 text-[11px] font-black uppercase tracking-[0.26em] text-slate-500">
                <span>Rank</span>
                <span>User</span>
                <span className="text-right">Points</span>
                <span className="text-right">Streak</span>
              </div>

              <div className="divide-y divide-slate-200 bg-white">
                {leaderboard.length > 0 ? (
                  leaderboard.map((entry) => {
                    const isYou =
                      Boolean(address) &&
                      entry.address.toLowerCase() === address?.toLowerCase();

                    return (
                      <div
                        key={entry.address}
                        className={`grid grid-cols-[0.75fr_1.6fr_1fr_0.9fr] items-center gap-3 px-4 py-4 text-sm ${
                          isYou ? "bg-sky-50" : "bg-white"
                        }`}
                      >
                        <span className="font-black text-slate-700">
                          {entry.rank === 1
                            ? "🥇"
                            : entry.rank === 2
                              ? "🥈"
                              : entry.rank === 3
                                ? "🥉"
                                : `#${entry.rank}`}
                        </span>
                        <div className="min-w-0">
                          <p className={`truncate font-semibold ${isYou ? "text-sky-700" : "text-slate-800"}`}>
                            {isYou ? `${shortAddress(entry.address)} (You)` : shortAddress(entry.address)}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            {entry.boostPercent ? `Boost +${entry.boostPercent}%` : "Boost +0%"}
                          </p>
                        </div>
                        <span className="text-right font-black text-slate-900">
                          {formatNumber(entry.points)}
                        </span>
                        <span className="text-right font-semibold text-slate-600">
                          {entry.streak} 🔥
                        </span>
                      </div>
                    );
                  })
                ) : (
                  <div className="px-4 py-12 text-center text-sm text-slate-500">
                    No users on the leaderboard yet.
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function MetricTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: "sky" | "amber" | "emerald";
}) {
  const accents = {
    sky: "border-sky-200 bg-sky-50 text-sky-800",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
  };

  return (
    <div className={`rounded-[24px] border px-4 py-4 ${accents[accent]}`}>
      <p className="text-[11px] font-black uppercase tracking-[0.24em] opacity-70">{label}</p>
      <p className="mt-2 text-2xl font-black tracking-tight">{value}</p>
    </div>
  );
}

function StatCard({
  title,
  value,
  icon,
  tone,
  isLoading,
}: {
  title: string;
  value: string;
  icon: string;
  tone: "sky" | "emerald" | "amber" | "rose";
  isLoading: boolean;
}) {
  const tones = {
    sky: "from-sky-100 to-sky-50 border-sky-200",
    emerald: "from-emerald-100 to-emerald-50 border-emerald-200",
    amber: "from-amber-100 to-amber-50 border-amber-200",
    rose: "from-rose-100 to-rose-50 border-rose-200",
  };

  return (
    <div className={`rounded-[30px] border bg-[linear-gradient(180deg,var(--tw-gradient-from),var(--tw-gradient-to))] p-5 shadow-[0_18px_50px_rgba(15,23,42,0.06)] ${tones[tone]}`}>
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/80 text-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]">
          {icon}
        </div>
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.28em] text-slate-500">
            {title}
          </p>
          <p className="mt-2 text-2xl font-black tracking-tight text-slate-950">
            {isLoading ? <span className="animate-pulse text-slate-400">...</span> : value}
          </p>
        </div>
      </div>
    </div>
  );
}

export default function ProfilePage() {
  return (
    <ErrorBoundary>
      <ProfilePageContent />
    </ErrorBoundary>
  );
}
