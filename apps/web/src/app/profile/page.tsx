"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import { pay } from "@base-org/account/payment";
import { useAccount, usePublicClient, useReadContract, useWalletClient } from "wagmi";
import { encodeFunctionData, erc20Abi } from "viem";
import { DailyCheckInModule } from "@/components/profile/DailyCheckInModule";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
  applyReferralCode,
  fetchPointsBalance,
  fetchReferralStats,
  fetchUserStats,
  performDailyCheckIn,
  resetBrokenStreak,
  saveBrokenStreak,
  type PointsBalance,
  type ReferralStats,
  type UserStats,
} from "@/lib/points";
import {
  buildReferralLink,
  clearPendingReferralCode,
  getPendingReferralCode,
  isTerminalReferralError,
} from "@/lib/referrals";
import { BASE_CHAIN_ID, USDC_ADDRESS } from "@/lib/tokens";
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

type FlowStage = "idle" | "wallet" | "verifying";
type FeeConfig = NonNullable<PointsBalance["checkInConfig"]>;

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error ?? "Unknown error");
}

function isCoinbaseConnector(
  connector: {
    id?: string | null;
    name?: string | null;
  } | null | undefined
) {
  const id = connector?.id?.toLowerCase() ?? "";
  const name = connector?.name?.toLowerCase() ?? "";

  return id.includes("coinbase") || name.includes("coinbase") || name.includes("base account");
}

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

function MiniMetric({
  label,
  value,
  accent,
  isLoading,
}: {
  label: string;
  value: string;
  accent: "sky" | "amber" | "emerald";
  isLoading?: boolean;
}) {
  const accents = {
    sky: "border-sky-200 bg-sky-50 text-sky-800",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
  };

  return (
    <div className={`rounded-[20px] border px-3 py-3 ${accents[accent]}`}>
      <p className="text-[10px] font-black uppercase tracking-[0.22em] opacity-70">
        {label}
      </p>
      <p className="mt-1.5 text-lg font-black tracking-tight">
        {isLoading ? <span className="animate-pulse opacity-50">...</span> : value}
      </p>
    </div>
  );
}

function ProfilePageContent() {
  const { address, isConnected, chainId, connector } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const [isMounted, setIsMounted] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [profile, setProfile] = useState<NeynarProfile | null>(null);
  const [balance, setBalance] = useState<PointsBalance | null>(null);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [referral, setReferral] = useState<ReferralStats | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [celebration, setCelebration] = useState<CelebrationState>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [pendingReferralCode, setPendingReferralCode] = useState<string | null>(null);

  const [isCheckingIn, setIsCheckingIn] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [checkInStage, setCheckInStage] = useState<FlowStage>("idle");
  const [recoveryStage, setRecoveryStage] = useState<FlowStage>("idle");

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

  const preferredCheckInAsset = useMemo<"eth" | "usdc">(() => {
    if (!balance) {
      return "eth";
    }

    const requiredUsdc = BigInt(balance.checkInConfig.usdcAmountUnits);
    return requiredUsdc > 0n && usdcBalance >= requiredUsdc ? "usdc" : "eth";
  }, [balance, usdcBalance]);

  const preferredSaveAsset = useMemo<"eth" | "usdc">(() => {
    if (!balance) {
      return "eth";
    }

    const requiredUsdc = BigInt(balance.saveConfig.usdcAmountUnits);
    return requiredUsdc > 0n && usdcBalance >= requiredUsdc ? "usdc" : "eth";
  }, [balance, usdcBalance]);

  const isCoinbaseWallet = useMemo(() => isCoinbaseConnector(connector), [connector]);
  const usesBasePayForCheckIn =
    isCoinbaseWallet && preferredCheckInAsset === "usdc";
  const usesBasePayForSave = isCoinbaseWallet && preferredSaveAsset === "usdc";
  const displayCheckInAsset = usesBasePayForCheckIn ? "usdc" : preferredCheckInAsset;
  const displaySaveAsset = usesBasePayForSave ? "usdc" : preferredSaveAsset;
  const referralLink = useMemo(
    () => (referral?.code ? buildReferralLink(referral.code) : ""),
    [referral?.code]
  );

  const fetchProfileData = useCallback(async () => {
    if (!address) {
      setBalance(null);
      setStats(null);
      setReferral(null);
      setProfile(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);

    try {
      const [balanceData, statsData, referralData] = await Promise.all([
        fetchPointsBalance(address),
        fetchUserStats(address),
        fetchReferralStats(address),
      ]);

      if (!balanceData.success) {
        throw new Error(balanceData.error || "Failed to load check-in status");
      }

      setBalance(balanceData);
      if (statsData.success) {
        setStats(statsData);
      }
      if (referralData.success) {
        setReferral(referralData);
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
    setPendingReferralCode(getPendingReferralCode());
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
    if (!address || !pendingReferralCode) {
      return;
    }

    let cancelled = false;

    const run = async () => {
      const codeToApply = pendingReferralCode;
      setPendingReferralCode(null);

      const result = await applyReferralCode(address, codeToApply);
      if (cancelled) {
        return;
      }

      if (result.success) {
        clearPendingReferralCode();
        setToast({
          kind: "success",
          message: "Referral linked successfully. Your inviter now earns 20% of your points.",
        });
        await fetchProfileData();
        return;
      }

      if (isTerminalReferralError(result.error)) {
        clearPendingReferralCode();
      }

      setToast({
        kind: "error",
        message: result.error || "Referral could not be applied.",
      });
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [address, fetchProfileData, pendingReferralCode]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setToast(null);
    }, 4200);

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

  const updateBalanceAndStats = useCallback((nextBalance: PointsBalance) => {
    setBalance(nextBalance);
    setStats((current) =>
      current
        ? {
            ...current,
            totalPoints: nextBalance.totalPoints,
          }
        : current
    );
  }, []);

  const sendFeeTransaction = useCallback(
    async (config: FeeConfig, asset: "eth" | "usdc") => {
      if (!walletClient || !publicClient) {
        throw new Error("Wallet is not ready");
      }

      if (chainId !== BASE_CHAIN_ID) {
        throw new Error("Switch your wallet to Base before sending this check-in transaction");
      }

      const hash = await walletClient.sendTransaction({
        to:
          asset === "usdc"
            ? (config.usdcAddress as `0x${string}`)
            : (config.recipient as `0x${string}`),
        data:
          asset === "usdc"
            ? encodeFunctionData({
                abi: erc20Abi,
                functionName: "transfer",
                args: [config.recipient as `0x${string}`, BigInt(config.usdcAmountUnits)],
              })
            : undefined,
        dataSuffix: DATA_SUFFIX,
        value: asset === "usdc" ? 0n : BigInt(config.ethAmountWei),
        capabilities: process.env.NEXT_PUBLIC_PAYMASTER_URL
          ? {
              paymasterService: {
                url: process.env.NEXT_PUBLIC_PAYMASTER_URL,
              },
            }
          : undefined,
      } as any);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error("Transaction reverted");
      }

      return hash;
    },
    [chainId, publicClient, walletClient]
  );

  const sendBasePayTransaction = useCallback(async (config: FeeConfig) => {
    const payment = await pay({
      amount: config.usdcAmount,
      to: config.recipient,
      testnet: false,
      telemetry: false,
    });

    if (!payment?.id) {
      throw new Error("Base Pay did not return a payment id");
    }

    return payment.id as `0x${string}`;
  }, []);

  const sendCheckInPayment = useCallback(
    async (config: FeeConfig) => {
      if (usesBasePayForCheckIn) {
        return {
          hash: await sendBasePayTransaction(config),
          asset: "usdc" as const,
        };
      }

      return {
        hash: await sendFeeTransaction(config, preferredCheckInAsset),
        asset: preferredCheckInAsset,
      };
    },
    [
      preferredCheckInAsset,
      sendBasePayTransaction,
      sendFeeTransaction,
      usesBasePayForCheckIn,
    ]
  );

  const sendSavePayment = useCallback(
    async (config: FeeConfig) => {
      if (usesBasePayForSave) {
        return {
          hash: await sendBasePayTransaction(config),
          asset: "usdc" as const,
        };
      }

      return {
        hash: await sendFeeTransaction(config, preferredSaveAsset),
        asset: preferredSaveAsset,
      };
    },
    [preferredSaveAsset, sendBasePayTransaction, sendFeeTransaction, usesBasePayForSave]
  );

  const handleCheckIn = useCallback(async () => {
    if (!address || !balance) {
      setToast({ kind: "error", message: "Connect your wallet first." });
      return;
    }

    setIsCheckingIn(true);
    setCheckInStage("wallet");

    try {
      const { asset, hash } = await sendCheckInPayment(balance.checkInConfig);
      setCheckInStage("verifying");

      const result = await performDailyCheckIn({
        address,
        txHash: hash,
        asset,
      });

      if (!result.success) {
        throw new Error(result.error || "Onchain check-in failed");
      }

      updateBalanceAndStats(result);
      setCelebration({ kind: "checkin", id: Date.now() });
      setToast({
        kind: "success",
        message:
          asset === "usdc"
            ? `Onchain check-in complete with ${balance.checkInConfig.usdcAmount} USDC.`
            : `Onchain check-in complete with $${balance.checkInConfig.usdTarget.toFixed(2)} in ETH.`,
      });
    } catch (error) {
      console.error(error);
      setToast({
        kind: "error",
        message: usesBasePayForCheckIn
          ? getErrorMessage(error) || "Base Pay check-in failed. Try again."
          : "Check-in transaction failed. Try again.",
      });
    } finally {
      setCheckInStage("idle");
      setIsCheckingIn(false);
    }
  }, [address, balance, sendCheckInPayment, updateBalanceAndStats, usesBasePayForCheckIn]);

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
    } catch (error) {
      setToast({
        kind: "error",
        message: (error as Error).message || "Reset failed",
      });
    } finally {
      setIsResetting(false);
    }
  }, [address, updateBalanceAndStats]);

  const handleSave = useCallback(async () => {
    if (!address || !balance) {
      setToast({
        kind: "error",
        message: "Connect your wallet to save this streak.",
      });
      return;
    }

    setIsSaving(true);
    setRecoveryStage("wallet");

    try {
      const { asset, hash } = await sendSavePayment(balance.saveConfig);
      setRecoveryStage("verifying");

      const result = await saveBrokenStreak({
        address,
        txHash: hash,
        asset,
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
    } catch (error) {
      console.error(error);
      setToast({
        kind: "error",
        message: usesBasePayForSave
          ? getErrorMessage(error) || "Base Pay recovery failed. Try again."
          : "Transaction failed. Try again to save your streak.",
      });
    } finally {
      setRecoveryStage("idle");
      setIsSaving(false);
    }
  }, [address, balance, sendSavePayment, updateBalanceAndStats, usesBasePayForSave]);

  if (!isMounted) {
    return null;
  }

  if (!isConnected) {
    return (
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-2xl items-center justify-center px-4 py-8">
        <section className="flex w-full flex-col items-center justify-center rounded-[32px] border border-white/80 bg-white/60 p-8 text-center shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur-xl sm:p-12">
          <div className="flex h-[84px] items-center justify-center rounded-[24px] border border-white/90 bg-white/80 px-6 shadow-[0_14px_40px_rgba(148,163,184,0.12)] backdrop-blur-xl">
            <Image
              src="/longlogo.png"
              alt="DustSwap"
              width={170}
              height={40}
              priority
              className="h-auto w-full max-w-[150px] sm:max-w-[170px]"
            />
          </div>
          <h2 className="mt-8 text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">
            Connect your wallet to start your journey at DustSwap
          </h2>
          <p className="mt-3 max-w-md text-sm leading-6 text-slate-500 sm:text-base">
            Use <span aria-hidden="true">&bull;</span> Contribute{" "}
            <span aria-hidden="true">&bull;</span> Earn{" "}
            <span aria-hidden="true">&bull;</span> Repeat.
          </p>
          <div className="mt-8 flex justify-center origin-center scale-105 sm:scale-110">
            {/* @ts-ignore */}
            <appkit-button />
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.14),transparent_28%),radial-gradient(circle_at_top_right,rgba(251,191,36,0.12),transparent_22%),linear-gradient(180deg,#f8fafc,#fef7ed_45%,#eff6ff)] px-3 py-4 pb-16 sm:px-6 sm:py-8">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 sm:gap-5">
        {toast ? (
          <div
            className={`rounded-[18px] border px-4 py-3 text-sm shadow-[0_16px_36px_rgba(15,23,42,0.08)] ${
              toast.kind === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-rose-200 bg-rose-50 text-rose-700"
            }`}
          >
            {toast.message}
          </div>
        ) : null}

        <section className="rounded-[28px] border border-white/70 bg-white/82 p-4 shadow-[0_20px_70px_rgba(15,23,42,0.08)] backdrop-blur sm:p-6">
          <div className="flex items-center gap-3">
            {profile?.pfp_url ? (
              <img
                src={profile.pfp_url}
                alt="Profile"
                className="h-14 w-14 rounded-[18px] border border-white/70 object-cover shadow-[0_10px_28px_rgba(56,189,248,0.18)]"
              />
            ) : (
              <div className="flex h-14 w-14 items-center justify-center rounded-[18px] border border-sky-200 bg-[linear-gradient(135deg,#38bdf8,#0ea5e9)] text-lg font-black text-white shadow-[0_10px_28px_rgba(14,165,233,0.22)]">
                {address?.slice(2, 4)}
              </div>
            )}

            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-[0.32em] text-slate-500">
                Profile Hub
              </p>
              <h1 className="mt-1 truncate text-2xl font-black tracking-tight text-slate-950">
                {getDisplayName(profile, address)}
              </h1>
              <p className="mt-1 truncate text-sm text-slate-600">
                {profile?.username ? `@${profile.username}` : shortAddress(address || "")}
              </p>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2.5">
            <MiniMetric
              label="Total PP"
              value={`${formatNumber(balance?.totalPoints || 0)} PP`}
              accent="sky"
              isLoading={isLoading}
            />
            <MiniMetric
              label="Rank"
              value={`#${balance?.rank || "--"}`}
              accent="amber"
              isLoading={isLoading}
            />
            <MiniMetric
              label="All-Time Volume"
              value={`$${(stats?.swapVolume || 0).toLocaleString(undefined, {
                minimumFractionDigits: 0,
                maximumFractionDigits: 0,
              })}`}
              accent="sky"
              isLoading={isLoading}
            />
            <MiniMetric
              label="Total Referrals"
              value={String(referral?.friendsJoined || 0)}
              accent="emerald"
              isLoading={isLoading}
            />
          </div>
        </section>

        <DailyCheckInModule
          balance={balance}
          isCheckingIn={isCheckingIn}
          isSaving={isSaving}
          isResetting={isResetting}
          checkInStage={checkInStage}
          recoveryStage={recoveryStage}
          celebration={celebration}
          walletReady={Boolean(address)}
          preferredCheckInAsset={displayCheckInAsset}
          preferredSaveAsset={displaySaveAsset}
          onCheckIn={() => void handleCheckIn()}
          onSave={() => void handleSave()}
          onReset={() => void handleReset()}
        />

        <section className="rounded-[28px] border border-white/70 bg-white/82 p-4 shadow-[0_20px_70px_rgba(15,23,42,0.08)] sm:p-6">
          <p className="text-[10px] font-black uppercase tracking-[0.32em] text-slate-500">
            Referral Vault
          </p>
          <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-950">
            Invite friends and stack the network
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Share your Base App link and earn 20% of your friends&apos; self-earned points.
          </p>

          <div className="mt-4 grid grid-cols-2 gap-2.5">
            <MiniMetric
              label="Friends Joined"
              value={String(referral?.friendsJoined || 0)}
              accent="sky"
              isLoading={isLoading}
            />
            <MiniMetric
              label="Referral Points"
              value={`${formatNumber(referral?.pointsEarned || 0)} PP`}
              accent="emerald"
              isLoading={isLoading}
            />
          </div>

          <div className="mt-4 rounded-[22px] border border-slate-200 bg-[#f8fbff] p-3">
            <p className="text-[10px] font-black uppercase tracking-[0.24em] text-slate-500">
              Your Link
            </p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <div className="flex-1 break-all rounded-[16px] border border-slate-200 bg-white px-3 py-3 font-mono text-[11px] font-semibold leading-5 text-sky-700">
                {referralLink || "LOADING..."}
              </div>
              <button
                type="button"
                onClick={() => {
                  if (!referralLink) {
                    return;
                  }
                  navigator.clipboard.writeText(referralLink);
                  setIsCopied(true);
                  setToast({ kind: "success", message: "Referral link copied." });
                  window.setTimeout(() => setIsCopied(false), 1800);
                }}
                className="rounded-[16px] bg-[linear-gradient(135deg,#0ea5e9,#22c55e)] px-4 py-3 text-sm font-black text-white shadow-[0_14px_32px_rgba(14,165,233,0.18)] transition hover:-translate-y-0.5"
              >
                {isCopied ? "Copied!" : "Copy Link"}
              </button>
            </div>
          </div>
        </section>
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
