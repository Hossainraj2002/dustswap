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
  clearPointsSummaryCache,
  fetchPointsSummary,
  performDailyCheckIn,
  resetBrokenStreak,
  saveBrokenStreak,
  type PointsBalance,
  type PointsSummaryResponse,
  type ReferralStats,
  type UserStats,
} from "@/lib/points";
import { emitDataInvalidation } from "@/lib/clientEvents";
import {
  buildReferralLink,
  clearPendingReferralCode,
  getPendingReferralCode,
  isTerminalReferralError,
} from "@/lib/referrals";
import { BASE_CHAIN_ID, USDC_ADDRESS } from "@/lib/tokens";
import { DATA_SUFFIX } from "@/lib/builderCode";
import {
  buildBasePaymasterCapabilities,
  isPaymasterEnabled,
  isUserRejectedRequest,
} from "@/lib/paymaster";

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
const PROFILE_FALLBACK_REFRESH_MS = 180000;

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

function isTxHash(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
}

function toHexChainId(chainId: number) {
  return `0x${chainId.toString(16)}`;
}

function resolveSendCallsId(result: unknown) {
  if (typeof result === "string" && result.trim()) {
    return result;
  }

  if (result && typeof result === "object" && "id" in result) {
    const value = (result as { id?: unknown }).id;
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  if (result && typeof result === "object" && "batchId" in result) {
    const value = (result as { batchId?: unknown }).batchId;
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return "";
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

const PROFILE_FAQ_ITEMS = [
  {
    question: "What is DustSwap?",
    answers: [
      "DustSwap is a DEX and bridge built on Base, supporting 20+ networks.",
      "DustSwap also lets users sweep multiple dust tokens into ETH in a single transaction. This feature is currently under development.",
    ],
  },
  {
    question: "What is Check-In, and why should I do it?",
    answers: [
      "Check-In is DustSwap's daily attendance system for users.",
      "To help prevent abuse, Check-In includes a very small fee of $0.01.",
      "By checking in, you earn 100 base PP and a 10% daily boost.",
      "Your points grow faster as your Check-In boost increases.",
      "You can unlock up to a 300% boost on all of your self-earned PP.",
    ],
  },
  {
    question: "What are Quests, and why should I complete them?",
    answers: [
      "Quests are social and onchain tasks for DustSwap users.",
      "By completing quests, you earn PP.",
      "PP will convert into $DUST tokens after TGE.",
      "Your PP helps measure your contribution to DustSwap and may help determine your allocation.",
    ],
  },
  {
    question: "What is the Cofounder Pass?",
    answers: [
      "The Cofounder Pass is an NFT for early supporters of DustSwap.",
      "The mint will take place on OpenSea.",
      "It will be free for whitelist users and cost 0.003 ETH for the public mint.",
      "Cofounder Pass holders will share 6.9% of the total $DUST token allocation.",
      "Holding a Cofounder Pass NFT gives you a 30% boost on referral earnings.",
      "More surprise benefits are coming.",
    ],
  },
  {
    question: "How can I get whitelist access for the Cofounder Pass?",
    answers: [
      "To get whitelist access, you need to complete all tasks under the Cofounder Pass section on the Quests page.",
      "You need to complete a total of $100 swap volume on Base through /swap.",
      "You also need to finish the required social tasks on the Cofounder Pass page.",
    ],
  },
] as const;

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
  const referralLink = useMemo(
    () => (referral?.code ? buildReferralLink(referral.code) : ""),
    [referral?.code]
  );

  const applySummary = useCallback((summary: PointsSummaryResponse) => {
    setBalance(summary.balance);
    setStats(summary.stats);
    setReferral(summary.referral);
  }, []);

  const fetchProfileData = useCallback(
    async (options?: { force?: boolean; silent?: boolean }) => {
      if (!address) {
        setBalance(null);
        setStats(null);
        setReferral(null);
        setProfile(null);
        setIsLoading(false);
        return;
      }

      if (!options?.silent) {
        setIsLoading(true);
      }

      try {
        const summary = await fetchPointsSummary(address, {
          force: options?.force,
        });

        if (!summary.success) {
          throw new Error(summary.error || "Failed to load profile summary");
        }

        applySummary(summary);
      } catch (error) {
        setToast({
          kind: "error",
          message: (error as Error).message || "Failed to load your profile",
        });
      } finally {
        if (!options?.silent) {
          setIsLoading(false);
        }
      }
    },
    [address, applySummary]
  );

  const fetchNeynarProfile = useCallback(async () => {
    if (!address) {
      setProfile(null);
      return;
    }

    try {
      const response = await fetch(`/api/neynar/user?address=${address}`, {
        cache: "no-store",
      });
      const data = response.ok ? await response.json() : null;

      if (data && !data.error) {
        setProfile(data);
        return;
      }

      setProfile(null);
    } catch {
      setProfile(null);
    }
  }, [address]);

  useEffect(() => {
    setIsMounted(true);
    setPendingReferralCode(getPendingReferralCode());
  }, []);

  useEffect(() => {
    if (isConnected) {
      void fetchProfileData();
      void fetchNeynarProfile();
      return;
    }

    setBalance(null);
    setStats(null);
    setReferral(null);
    setProfile(null);
    setIsLoading(false);
  }, [fetchNeynarProfile, fetchProfileData, isConnected]);

  useEffect(() => {
    if (!address) {
      return;
    }

    const handleFocus = () => {
      void fetchProfileData({ force: true, silent: true });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void fetchProfileData({ force: true, silent: true });
      }
    };
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void fetchProfileData({ force: true, silent: true });
      }
    }, PROFILE_FALLBACK_REFRESH_MS);

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.clearInterval(interval);
    };
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
        clearPointsSummaryCache(address);
        setToast({
          kind: "success",
          message: "Referral linked successfully. Your inviter now earns 20% of your points.",
        });
        await fetchProfileData({ force: true, silent: true });
        emitDataInvalidation(["leaderboard", "points"], "referral-applied");
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

      const targetAddress =
        asset === "usdc"
          ? (config.usdcAddress as `0x${string}`)
          : (config.recipient as `0x${string}`);
      const txData =
        asset === "usdc"
          ? encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [config.recipient as `0x${string}`, BigInt(config.usdcAmountUnits)],
            })
          : undefined;
      const txValue = asset === "usdc" ? 0n : BigInt(config.ethAmountWei);
      const requestClient = walletClient as typeof walletClient & {
        account?: { address?: `0x${string}` };
        request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      };

      if (isPaymasterEnabled() && isCoinbaseWallet) {
        try {
          const capabilitiesResult =
            requestClient.account?.address
              ? ((await requestClient.request({
                  method: "wallet_getCapabilities",
                  params: [requestClient.account.address],
                })) as Record<
                  string,
                  {
                    paymasterService?: {
                      supported?: boolean;
                    };
                  }
                > | null)
              : null;
          const chainCapabilities = capabilitiesResult
            ? Object.entries(capabilitiesResult).find(
                ([candidate]) => candidate.toLowerCase() === toHexChainId(BASE_CHAIN_ID).toLowerCase()
              )?.[1]
            : null;

          if (!chainCapabilities?.paymasterService?.supported) {
            throw new Error("wallet paymasterService capability is unavailable");
          }

          const sendCallsResult = await walletClient.sendCalls({
            calls: [
              {
                to: targetAddress,
                data: txData,
                value: txValue,
                dataSuffix: DATA_SUFFIX,
              },
            ],
            capabilities: buildBasePaymasterCapabilities(),
          } as any);

          const callId = resolveSendCallsId(sendCallsResult);
          if (!callId) {
            throw new Error("wallet_sendCalls did not return an id");
          }

          const status = await walletClient.waitForCallsStatus({
            id: callId,
            throwOnFailure: true,
            timeout: 120_000,
          });
          const hash = status.receipts?.find((receipt) => isTxHash(receipt?.transactionHash))
            ?.transactionHash;

          if (!hash) {
            throw new Error("Sponsored transaction finished without a transaction hash");
          }

          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") {
            throw new Error("Transaction reverted");
          }

          return hash;
        } catch (error) {
          if (isUserRejectedRequest(error)) {
            throw error;
          }

          console.warn("Paymaster sendCalls failed for check-in, falling back to direct sendTransaction.", error);
        }
      }

      const hash = await walletClient.sendTransaction({
        to: targetAddress,
        data: txData,
        dataSuffix: DATA_SUFFIX,
        value: txValue,
      } as any);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error("Transaction reverted");
      }

      return hash;
    },
    [chainId, isCoinbaseWallet, publicClient, walletClient]
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
      clearPointsSummaryCache(address);
      setCelebration({ kind: "checkin", id: Date.now() });
      setToast({
        kind: "success",
        message:
          asset === "usdc"
            ? `Onchain check-in complete with ${balance.checkInConfig.usdcAmount} USDC.`
            : `Onchain check-in complete with $${balance.checkInConfig.usdTarget.toFixed(2)} in ETH.`,
      });
      emitDataInvalidation(["leaderboard", "points"], "check-in");
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
      clearPointsSummaryCache(address);
      setToast({
        kind: "success",
        message: result.reset
          ? "Streak reset. You can start again today."
          : "There was no broken streak to reset.",
      });
      emitDataInvalidation("points", "reset-streak");
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
      clearPointsSummaryCache(address);
      setCelebration({ kind: "save", id: Date.now() });
      setToast({
        kind: "success",
        message: "Streak Saved!",
      });
      emitDataInvalidation(["leaderboard", "points"], "save-streak");
    } catch (error) {
      console.error(error);
      const message = getErrorMessage(error);
      setToast({
        kind: "error",
        message: message || "Transaction failed. Try again to save your streak.",
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
      <div className="relative min-h-[calc(100vh-4rem)] overflow-hidden">

        {/* ── Layer 1: Blurred fake profile background ── */}
        <div
          aria-hidden="true"
          className="pointer-events-none select-none min-h-[calc(100vh-4rem)] bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.14),transparent_28%),radial-gradient(circle_at_top_right,rgba(251,191,36,0.12),transparent_22%),linear-gradient(180deg,#f8fafc,#fef7ed_45%,#eff6ff)] px-3 py-4 pb-16 sm:px-6 sm:py-8 blur-sm opacity-60"
        >
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 sm:gap-5">

            {/* Profile card skeleton */}
            <div className="rounded-[28px] border border-white/70 bg-white/82 px-4 py-3 shadow-[0_20px_70px_rgba(15,23,42,0.08)] backdrop-blur sm:px-5 sm:py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-[14px] border border-sky-200 bg-[linear-gradient(135deg,#38bdf8,#0ea5e9)] text-base font-black text-white shadow-[0_10px_28px_rgba(14,165,233,0.22)]">
                  0x
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[9px] font-black uppercase tracking-[0.32em] text-slate-500">Profile Hub</p>
                  <div className="mt-1 h-5 w-32 rounded-full bg-slate-200" />
                  <div className="mt-1 h-3 w-20 rounded-full bg-slate-100" />
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {(["sky", "amber", "sky", "emerald"] as const).map((accent, i) => {
                  const cls = {
                    sky: "border-sky-200 bg-sky-50",
                    amber: "border-amber-200 bg-amber-50",
                    emerald: "border-emerald-200 bg-emerald-50",
                  }[accent];
                  const labels = ["Total PP", "Rank", "All-Time Volume", "Total Referrals"];
                  return (
                    <div key={i} className={`rounded-[20px] border px-3 py-3 ${cls}`}>
                      <p className="text-[10px] font-black uppercase tracking-[0.22em] opacity-70">{labels[i]}</p>
                      <div className="mt-1.5 h-6 w-14 rounded-full bg-slate-200/80" />
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Daily Check-In skeleton */}
            <div className="rounded-[28px] border border-white/70 bg-white/82 px-4 py-4 shadow-[0_20px_70px_rgba(15,23,42,0.08)] sm:px-5 sm:py-5">
              <div className="h-2.5 w-24 rounded-full bg-slate-200" />
              <div className="mt-2 h-6 w-36 rounded-full bg-slate-200" />
              <div className="mt-3 grid grid-cols-3 gap-2">
                <div className="h-14 rounded-[18px] bg-sky-50 border border-sky-100" />
                <div className="h-14 rounded-[18px] bg-amber-50 border border-amber-100" />
                <div className="h-14 rounded-[18px] bg-emerald-50 border border-emerald-100" />
              </div>
              <div className="mt-3 h-11 w-full rounded-[20px] bg-slate-100" />
            </div>

            {/* Referral Vault skeleton */}
            <div className="rounded-[28px] border border-white/70 bg-white/82 px-4 py-3 shadow-[0_20px_70px_rgba(15,23,42,0.08)] sm:px-5 sm:py-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="h-2 w-16 rounded-full bg-slate-200" />
                  <div className="mt-1.5 h-4 w-44 rounded-full bg-slate-200" />
                </div>
                <div className="flex gap-2">
                  <div className="h-12 w-16 rounded-[14px] border border-sky-100 bg-sky-50" />
                  <div className="h-12 w-16 rounded-[14px] border border-emerald-100 bg-emerald-50" />
                </div>
              </div>
              <div className="mt-2.5 h-16 w-full rounded-[18px] border border-slate-200 bg-slate-50" />
            </div>

            {/* FAQ skeleton */}
            <div className="rounded-[28px] border border-white/70 bg-[linear-gradient(180deg,#fffdf8,#f8fbff)] px-4 py-3 shadow-[0_20px_70px_rgba(15,23,42,0.08)] sm:px-5 sm:py-4">
              <div className="h-2 w-8 rounded-full bg-slate-200" />
              <div className="mt-1.5 h-4 w-44 rounded-full bg-slate-200" />
              <div className="mt-2.5 space-y-2">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div key={i} className="rounded-[18px] border border-white/80 bg-white/80 px-3.5 py-3">
                    <div className={`h-3 rounded-full bg-slate-200 ${i % 2 === 0 ? "w-3/4" : "w-2/3"}`} />
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>

        {/* ── Layer 2: Glassmorphism connect overlay ── */}
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-white/20 via-slate-100/30 to-white/40 px-4 backdrop-blur-[3px]">
          <section className="flex w-full max-w-[340px] flex-col items-center rounded-[32px] border border-white/80 bg-white/78 p-8 text-center shadow-[0_32px_80px_rgba(15,23,42,0.16),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-2xl sm:p-10">
            <div className="flex h-[76px] items-center justify-center rounded-[22px] border border-white/90 bg-white/90 px-6 shadow-[0_12px_32px_rgba(148,163,184,0.14)] backdrop-blur-xl">
              <Image
                src="/longlogo.png"
                alt="DustSwap"
                width={160}
                height={38}
                priority
                className="h-auto w-full max-w-[140px] sm:max-w-[160px]"
              />
            </div>
            <h2 className="mt-7 text-xl font-black tracking-tight text-slate-950 sm:text-2xl">
              Connect your wallet to start your journey at DustSwap
            </h2>
            <p className="mt-2.5 max-w-xs text-sm leading-6 text-slate-500">
              Use <span aria-hidden="true">&bull;</span> Contribute{" "}
              <span aria-hidden="true">&bull;</span> Earn{" "}
              <span aria-hidden="true">&bull;</span> Repeat.
            </p>
            <div className="mt-7 flex origin-center justify-center scale-105 sm:scale-110">
              {/* @ts-ignore */}
              <appkit-button />
            </div>
          </section>
        </div>

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

        <section className="rounded-[28px] border border-white/70 bg-white/82 px-4 py-3 shadow-[0_20px_70px_rgba(15,23,42,0.08)] backdrop-blur sm:px-5 sm:py-4">
          <div className="flex items-center gap-3">
            {profile?.pfp_url ? (
              <img
                src={profile.pfp_url}
                alt="Profile"
                className="h-11 w-11 rounded-[14px] border border-white/70 object-cover shadow-[0_10px_28px_rgba(56,189,248,0.18)]"
              />
            ) : (
              <div className="flex h-11 w-11 items-center justify-center rounded-[14px] border border-sky-200 bg-[linear-gradient(135deg,#38bdf8,#0ea5e9)] text-base font-black text-white shadow-[0_10px_28px_rgba(14,165,233,0.22)]">
                {address?.slice(2, 4)}
              </div>
            )}

            <div className="min-w-0">
              <p className="text-[9px] font-black uppercase tracking-[0.32em] text-slate-500">
                Profile Hub
              </p>
              <h1 className="truncate text-xl font-black tracking-tight text-slate-950">
                {getDisplayName(profile, address)}
              </h1>
              <p className="truncate text-xs text-slate-600">
                {profile?.username ? `@${profile.username}` : shortAddress(address || "")}
              </p>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
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
          onCheckIn={() => void handleCheckIn()}
          onSave={() => void handleSave()}
          onReset={() => void handleReset()}
        />

        <section className="rounded-[28px] border border-white/70 bg-white/82 px-4 py-3 shadow-[0_20px_70px_rgba(15,23,42,0.08)] sm:px-5 sm:py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[9px] font-black uppercase tracking-[0.32em] text-slate-500">
                Referral Vault
              </p>
              <h2 className="text-base font-black tracking-tight text-slate-950">
                Invite friends, earn 20% of their points
              </h2>
            </div>
            <div className="flex shrink-0 gap-2">
              <div className="rounded-[14px] border border-sky-100 bg-sky-50 px-2.5 py-1.5 text-center">
                <p className="text-[9px] font-black uppercase tracking-[0.2em] text-sky-500">Friends</p>
                <p className="text-sm font-black text-sky-800">{String(referral?.friendsJoined || 0)}</p>
              </div>
              <div className="rounded-[14px] border border-emerald-100 bg-emerald-50 px-2.5 py-1.5 text-center">
                <p className="text-[9px] font-black uppercase tracking-[0.2em] text-emerald-500">Ref PP</p>
                <p className="text-sm font-black text-emerald-800">{formatNumber(referral?.pointsEarned || 0)}</p>
              </div>
            </div>
          </div>

          <div className="mt-2.5 rounded-[18px] border border-slate-200 bg-[#f8fbff] p-2.5">
            <p className="text-[9px] font-black uppercase tracking-[0.24em] text-slate-500">
              Your Link
            </p>
            <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
              <div className="flex-1 break-all rounded-[12px] border border-slate-200 bg-white px-2.5 py-2 font-mono text-[11px] font-semibold leading-5 text-sky-700">
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
                className="rounded-[12px] bg-[linear-gradient(135deg,#0ea5e9,#22c55e)] px-4 py-2 text-sm font-black text-white shadow-[0_8px_20px_rgba(14,165,233,0.18)] transition hover:-translate-y-0.5"
              >
                {isCopied ? "Copied!" : "Copy Link"}
              </button>
            </div>
          </div>
        </section>

        <section className="rounded-[28px] border border-white/70 bg-[radial-gradient(circle_at_top_right,rgba(56,189,248,0.12),transparent_28%),linear-gradient(180deg,#fffdf8,#f8fbff)] px-4 py-3 shadow-[0_20px_70px_rgba(15,23,42,0.08)] sm:px-5 sm:py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[9px] font-black uppercase tracking-[0.32em] text-slate-500">
                FAQ
              </p>
              <h2 className="text-base font-black tracking-tight text-slate-950">
                DustSwap quick answers
              </h2>
            </div>
          </div>

          <div className="mt-2.5 space-y-2">
            {PROFILE_FAQ_ITEMS.map((item) => (
              <details
                key={item.question}
                className="group rounded-[18px] border border-white/80 bg-white/80 px-3.5 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.78)]"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                  <span className="text-xs font-black tracking-tight text-slate-900 sm:text-sm">
                    {item.question}
                  </span>
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-base font-medium text-slate-500 transition-transform group-open:rotate-45">
                    +
                  </span>
                </summary>

                <ul className="mt-2.5 space-y-1.5 border-t border-slate-200/80 pt-2.5 text-xs leading-5 text-slate-600">
                  {item.answers.map((answer) => (
                    <li key={answer} className="flex gap-2">
                      <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
                      <span>{answer}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
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
