"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pay } from "@base-org/account/payment";
import { useAccount, usePublicClient, useReadContract, useWalletClient } from "wagmi";
import { encodeFunctionData, erc20Abi } from "viem";
import { DailyCheckInModule } from "@/components/profile/DailyCheckInModule";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { WalletConnectButton } from "@/components/wallet/WalletConnectButton";
import { useBaseChainSwitch } from "@/hooks/useBaseChainSwitch";
import { useWalletConnection } from "@/hooks/useWalletConnection";
import {
  applyReferralCode,
  clearPointsSummaryCache,
  fetchPointsSummary,
  performDailyCheckIn,
  previewReferralCode,
  resetBrokenStreak,
  saveBrokenStreak,
  type PointsBalance,
  type PointsSummaryResponse,
  type ReferralStats,
  type UserStats,
} from "@/lib/points";
import { emitDataInvalidation, subscribeToDataInvalidation } from "@/lib/clientEvents";
import {
  buildReferralLink,
  buildReferralLandingPath,
  clearPendingReferralCode,
  getPendingReferralCode,
  isTerminalReferralError,
  storePendingReferralCode,
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

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error ?? "Unknown error");
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
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { supportsBaseAccountFeatures } = useWalletConnection();
  const { isOnBase, isSwitching: isSwitchingToBase, switchToBase } = useBaseChainSwitch();
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

  // Inline referral code entry state — profile fallback, completely separate from link-based flow
  type InlineValidation =
    | { status: "idle" }
    | { status: "validating" }
    | { status: "valid"; message: string }
    | { status: "invalid"; message: string };
  const [inlineCode, setInlineCode] = useState("");
  const [isApplyingInline, setIsApplyingInline] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [inlineInfo, setInlineInfo] = useState<string | null>(null);
  const [inlineSuccess, setInlineSuccess] = useState(false);
  const [inlineValidation, setInlineValidation] = useState<InlineValidation>({ status: "idle" });
  const inlineDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silentRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const lastSilentRefreshAtRef = useRef(0);
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

  const usesBasePayForCheckIn =
    supportsBaseAccountFeatures && preferredCheckInAsset === "usdc";
  const usesBasePayForSave = supportsBaseAccountFeatures && preferredSaveAsset === "usdc";
  const referralLink = useMemo(
    () => (referral?.code ? buildReferralLink(referral.code) : ""),
    [referral?.code]
  );
  const hasCompletedFirstCheckIn = Boolean(balance?.lastCheckIn);
  const pendingReferralLandingPath = useMemo(
    () => (pendingReferralCode ? buildReferralLandingPath(pendingReferralCode) : "/"),
    [pendingReferralCode]
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

  const refreshProfileDataSilently = useCallback(() => {
    if (!address) {
      return Promise.resolve();
    }

    if (silentRefreshPromiseRef.current) {
      return silentRefreshPromiseRef.current;
    }

    const now = Date.now();
    if (now - lastSilentRefreshAtRef.current < 250) {
      return Promise.resolve();
    }

    lastSilentRefreshAtRef.current = now;

    const request = fetchProfileData({ force: true, silent: true }).finally(() => {
      if (silentRefreshPromiseRef.current === request) {
        silentRefreshPromiseRef.current = null;
      }
    });

    silentRefreshPromiseRef.current = request;
    return request;
  }, [address, fetchProfileData]);

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
    silentRefreshPromiseRef.current = null;
    lastSilentRefreshAtRef.current = 0;
  }, [address]);

  useEffect(() => {
    if (!address) {
      return;
    }

    const handleFocus = () => {
      void refreshProfileDataSilently();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshProfileDataSilently();
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [address, refreshProfileDataSilently]);

  useEffect(() => {
    if (!address) {
      return;
    }

    const handleInvalidation = () => {
      void refreshProfileDataSilently();
    };
    const unsubscribeProfile = subscribeToDataInvalidation("profile", handleInvalidation);
    const unsubscribePoints = subscribeToDataInvalidation("points", handleInvalidation);

    return () => {
      unsubscribeProfile();
      unsubscribePoints();
    };
  }, [address, refreshProfileDataSilently]);

  useEffect(() => {
    if (!pendingReferralCode || referral?.hasReferrer !== true) {
      return;
    }

    clearPendingReferralCode();
    setPendingReferralCode(null);
    setInlineInfo(null);
  }, [pendingReferralCode, referral?.hasReferrer]);

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

  // Debounced preview for inline profile code entry
  useEffect(() => {
    if (inlineDebounceRef.current) clearTimeout(inlineDebounceRef.current);
    const trimmed = inlineCode.trim();
    if (!trimmed || trimmed.length < 4 || !address) {
      setInlineValidation({ status: "idle" });
      return;
    }
    setInlineValidation({ status: "validating" });
    inlineDebounceRef.current = setTimeout(async () => {
      try {
        const res = await previewReferralCode(address, trimmed);
        setInlineValidation(
          res.valid
            ? { status: "valid", message: res.message || "Valid code!" }
            : { status: "invalid", message: res.message || "Invalid code." }
        );
      } catch {
        setInlineValidation({ status: "idle" });
      }
    }, 600);
    return () => { if (inlineDebounceRef.current) clearTimeout(inlineDebounceRef.current); };
  }, [address, inlineCode]);

  const handleApplyInline = useCallback(async () => {
    const trimmed = inlineCode.trim();
    if (!trimmed || isApplyingInline || !address) return;
    setIsApplyingInline(true);
    setInlineError(null);
    setInlineInfo(null);
    try {
      const normalizedCode = trimmed.toUpperCase();
      const result = await applyReferralCode(address, normalizedCode);
      if (!result.success) {
        if (result.deferred) {
          storePendingReferralCode(normalizedCode);
          setPendingReferralCode(normalizedCode);
          setInlineCode("");
          setInlineInfo(
            "Invite code saved. It will activate after your first onchain check-in or PP claim."
          );
          setToast({
            kind: "success",
            message:
              "Invite code saved. It will activate after your first onchain check-in or PP claim.",
          });
          return;
        }

        setInlineError(result.error || "Could not apply code. Please try again.");
        return;
      }
      setInlineSuccess(true);
      setInlineCode("");
      setInlineInfo(null);
      clearPendingReferralCode();
      setPendingReferralCode(null);
      clearPointsSummaryCache(address);
      emitDataInvalidation(["leaderboard", "points"], "referral-applied");
      setToast({ kind: "success", message: "Referral linked! +500 PP on the way." });
      await refreshProfileDataSilently();
    } catch {
      setInlineError("Something went wrong. Please try again.");
    } finally {
      setIsApplyingInline(false);
    }
  }, [address, inlineCode, isApplyingInline, refreshProfileDataSilently]);

  const promptSwitchToBase = useCallback(async (successMessage: string) => {
    try {
      const switched = await switchToBase();

      if (switched) {
        setToast({
          kind: "success",
          message: successMessage,
        });
      }

      return switched;
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error) || "Please switch your wallet to Base to continue.",
      });
      return false;
    }
  }, [switchToBase]);

  const sendFeeTransaction = useCallback(
    async (config: FeeConfig, asset: "eth" | "usdc") => {
      if (!walletClient || !publicClient) {
        throw new Error("Wallet is not ready");
      }

      if (!isOnBase) {
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

      if (isPaymasterEnabled() && supportsBaseAccountFeatures) {
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
    [isOnBase, publicClient, supportsBaseAccountFeatures, walletClient]
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

    if (isSwitchingToBase) {
      return;
    }

    if (!isOnBase) {
      await promptSwitchToBase("Wallet switched to Base. Tap check-in again to continue.");
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

      const baseSuccessMessage =
        asset === "usdc"
          ? `Onchain check-in complete with ${balance.checkInConfig.usdcAmount} USDC.`
          : `Onchain check-in complete with $${balance.checkInConfig.usdTarget.toFixed(2)} in ETH.`;

      updateBalanceAndStats(result);
      clearPointsSummaryCache(address);
      setCelebration({ kind: "checkin", id: Date.now() });
      emitDataInvalidation(["leaderboard", "points"], "check-in");

      let successMessage = baseSuccessMessage;

      if (pendingReferralCode && referral?.hasReferrer !== true) {
        try {
          const referralResult = await applyReferralCode(address, pendingReferralCode);

          if (referralResult.success) {
            clearPendingReferralCode();
            setPendingReferralCode(null);
            setInlineInfo(null);
            clearPointsSummaryCache(address);
            emitDataInvalidation(["leaderboard", "points"], "referral-applied");
            await refreshProfileDataSilently();
            successMessage = `${baseSuccessMessage} Invite code activated.`;
          } else if (referralResult.deferred) {
            storePendingReferralCode(pendingReferralCode);
            setPendingReferralCode(pendingReferralCode);
          } else if (isTerminalReferralError(referralResult.error || referralResult.message)) {
            clearPendingReferralCode();
            setPendingReferralCode(null);
            setInlineInfo(null);
            if ((referralResult.error || referralResult.message || "").toLowerCase().includes("already referred")) {
              clearPointsSummaryCache(address);
              await refreshProfileDataSilently();
            }
          }
        } catch (referralError) {
          console.error("Referral activation after check-in failed", referralError);
        }
      }

      setToast({
        kind: "success",
        message: successMessage,
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
  }, [
    address,
    balance,
    isOnBase,
    isSwitchingToBase,
    pendingReferralCode,
    promptSwitchToBase,
    referral?.hasReferrer,
    refreshProfileDataSilently,
    sendCheckInPayment,
    updateBalanceAndStats,
    usesBasePayForCheckIn,
  ]);

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

    if (isSwitchingToBase) {
      return;
    }

    if (!isOnBase) {
      await promptSwitchToBase("Wallet switched to Base. Tap save again to continue.");
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
  }, [
    address,
    balance,
    isOnBase,
    isSwitchingToBase,
    promptSwitchToBase,
    sendSavePayment,
    updateBalanceAndStats,
    usesBasePayForSave,
  ]);

  if (!isMounted) {
    return null;
  }

  if (!isConnected) {
    return (
      <div
        className="relative overflow-hidden"
        style={{ minHeight: "calc(100dvh - 4rem)" }}
      >

        {/* ── Layer 1: Blurred fake profile background ── */}
        <div
          aria-hidden="true"
          className="pointer-events-none select-none bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.14),transparent_28%),radial-gradient(circle_at_top_right,rgba(251,191,36,0.12),transparent_22%),linear-gradient(180deg,#f8fafc,#fef7ed_45%,#eff6ff)] px-3 py-4 pb-16 sm:px-6 sm:py-8 blur-sm opacity-60"
          style={{ minHeight: "calc(100dvh - 4rem)" }}
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
              <WalletConnectButton
                className="bg-[linear-gradient(135deg,#2563eb_0%,#0ea5e9_52%,#ffffff_180%)] text-white shadow-[0_20px_40px_rgba(37,99,235,0.28)] hover:border-transparent hover:text-white"
                description="Connect your wallet to start your journey at DustSwap."
              />
            </div>
          </section>
        </div>

      </div>
    );
  }

  return (
    <div
      className="bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.14),transparent_28%),radial-gradient(circle_at_top_right,rgba(251,191,36,0.12),transparent_22%),linear-gradient(180deg,#f8fafc,#fef7ed_45%,#eff6ff)] px-3 py-4 pb-16 sm:px-6 sm:py-8"
      style={{ minHeight: "calc(100dvh - 4rem)" }}
    >
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

        {isConnected && !isOnBase ? (
          <section className="rounded-[22px] border border-amber-200 bg-amber-50/95 px-4 py-3 shadow-[0_16px_36px_rgba(245,158,11,0.12)]">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-amber-700">
                  Base Network Required
                </p>
                <p className="mt-1 text-sm leading-6 text-amber-900">
                  Daily check-in and streak save only work on Base. Switch your wallet to Base to continue on this page.
                </p>
              </div>

              <button
                type="button"
                onClick={() =>
                  void promptSwitchToBase("Wallet switched to Base. You can continue now.")
                }
                disabled={isSwitchingToBase}
                className="inline-flex shrink-0 items-center justify-center rounded-[14px] bg-[linear-gradient(135deg,#f59e0b,#f97316)] px-4 py-2.5 text-sm font-black text-white shadow-[0_12px_28px_rgba(249,115,22,0.22)] transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSwitchingToBase ? "Switching..." : "Switch to Base"}
              </button>
            </div>
          </section>
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
          walletReady={Boolean(address) && !isSwitchingToBase}
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

          {!isLoading && referral?.hasReferrer === false && pendingReferralCode && (
            <div className="mt-2.5 rounded-[18px] border border-sky-100 bg-[radial-gradient(circle_at_top_right,rgba(99,102,241,0.08),transparent_50%),linear-gradient(180deg,#f0f9ff,#eff6ff)] p-3">
              <div className="flex items-start gap-2">
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-sky-200 bg-white shadow-sm">
                  <svg className="h-3.5 w-3.5 text-sky-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-black uppercase tracking-[0.22em] text-sky-600">
                    Invite attached
                  </p>
                  <p className="mt-1 break-all font-mono text-[12px] font-bold tracking-[0.04em] text-slate-800">
                    {pendingReferralCode}
                  </p>
                  <p className="mt-1.5 text-[11px] leading-[1.6] text-slate-500">
                    This invite code is saved and will activate after your first onchain check-in or PP claim.
                  </p>
                </div>
              </div>
              <a
                href={pendingReferralLandingPath}
                className="mt-3 inline-flex w-full items-center justify-center rounded-[12px] bg-[linear-gradient(135deg,#0ea5e9,#6366f1)] px-4 py-2 text-[12px] font-black text-white shadow-[0_8px_20px_rgba(14,165,233,0.18)] transition hover:-translate-y-0.5 hover:shadow-md"
              >
                Open Airdrop Landing
              </a>
            </div>
          )}

          {/* Inline referral code entry \u2014 shown only if user has no referrer yet */}
          {!isLoading && referral?.hasReferrer === false && !pendingReferralCode && !inlineSuccess && (
            <div className="mt-2.5 rounded-[18px] border border-sky-100 bg-[radial-gradient(circle_at_top_right,rgba(99,102,241,0.08),transparent_50%),linear-gradient(180deg,#f0f9ff,#eff6ff)] p-3">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-sky-200 bg-white shadow-sm">
                  <svg className="h-3.5 w-3.5 text-sky-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                  </svg>
                </div>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.22em] text-sky-600">Enter referral code</p>
                  <p className="text-[11px] leading-[1.5] text-slate-500">
                    Get <span className="font-bold text-slate-700">500 PP</span> when you link an invite code. Both users receive the reward.
                  </p>
                </div>
              </div>
              <div className="mt-2.5 flex flex-col gap-1.5 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <input
                    type="text"
                    value={inlineCode}
                    onChange={(e) => {
                      setInlineCode(e.target.value.toUpperCase());
                      setInlineError(null);
                      setInlineInfo(null);
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") void handleApplyInline(); }}
                    placeholder="e.g. DUST-XXXXX"
                    maxLength={32}
                    disabled={isApplyingInline}
                    className={`w-full rounded-[12px] border px-3 py-2 font-mono text-[12px] font-bold tracking-[0.04em] text-slate-800 outline-none transition-all placeholder:font-normal placeholder:tracking-normal placeholder:text-slate-300 ${
                      inlineValidation.status === "valid"
                        ? "border-emerald-300 bg-emerald-50 focus:ring-2 focus:ring-emerald-200"
                        : inlineValidation.status === "invalid"
                          ? "border-rose-300 bg-rose-50 focus:ring-2 focus:ring-rose-200"
                          : "border-slate-200 bg-white focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                    }`}
                  />
                  {inlineValidation.status === "validating" && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-200 border-t-sky-500" />
                    </div>
                  )}
                  {inlineValidation.status === "valid" && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      <svg className="h-3.5 w-3.5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void handleApplyInline()}
                  disabled={!inlineCode.trim() || isApplyingInline}
                  className={`shrink-0 rounded-[12px] px-4 py-2 text-[12px] font-black text-white shadow-sm transition active:scale-[0.98] ${
                    inlineCode.trim() && !isApplyingInline
                      ? "bg-[linear-gradient(135deg,#0ea5e9,#6366f1)] hover:-translate-y-0.5 hover:shadow-md"
                      : "cursor-not-allowed bg-slate-200 text-slate-400 shadow-none"
                  }`}
                >
                  {isApplyingInline ? (
                    <span className="flex items-center gap-1.5">
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                      Applying…
                    </span>
                  ) : (
                    "Apply Code"
                  )}
                </button>
              </div>
              {(inlineValidation.status === "valid" || inlineValidation.status === "invalid") && (
                <p className={`mt-1 text-[11px] font-semibold ${inlineValidation.status === "valid" ? "text-emerald-600" : "text-rose-600"}`}>
                  {inlineValidation.status === "valid"
                    ? (inlineValidation as { status: "valid"; message: string }).message
                    : (inlineValidation as { status: "invalid"; message: string }).message}
                </p>
              )}
              {inlineInfo && <p className="mt-1 text-[11px] font-semibold text-sky-600">{inlineInfo}</p>}
              {inlineError && <p className="mt-1 text-[11px] font-semibold text-rose-600">{inlineError}</p>}
            </div>
          )}

          {/* Invite activated badge \u2014 shown when user is already referred */}
          {!isLoading && referral?.hasReferrer === true && (
            <div className="mt-2.5 flex items-center gap-2 rounded-[14px] border border-emerald-200 bg-emerald-50 px-3 py-2">
              <svg className="h-4 w-4 shrink-0 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-emerald-700">Invite activated</p>
            </div>
          )}

          {/* Inline success state */}
          {inlineSuccess && (
            <div className="mt-2.5 flex items-center gap-2 rounded-[14px] border border-emerald-200 bg-emerald-50 px-3 py-2">
              <svg className="h-4 w-4 shrink-0 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
              <p className="text-[11px] font-black text-emerald-700">Referral linked! +500 PP incoming.</p>
            </div>
          )}

          <div className="mt-2.5 rounded-[18px] border border-slate-200 bg-[#f8fbff] p-2.5">
            <p className="text-[9px] font-black uppercase tracking-[0.24em] text-slate-500">
              Your Link
            </p>
            {hasCompletedFirstCheckIn ? (
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
            ) : (
              <div className="mt-1.5 rounded-[14px] border border-amber-100 bg-amber-50 px-3 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-amber-700">
                  Referral link locked
                </p>
                <p className="mt-1.5 text-sm font-black text-amber-900">
                  Complete your first onchain check-in to unlock your invite link.
                </p>
                <p className="mt-1.5 text-[12px] leading-5 text-amber-800">
                  After your first check-in, your personal referral link will unlock here and you can invite friends to earn 20% of their points.
                </p>
                <p className="mt-1.5 text-[11px] font-semibold text-amber-700">
                  Your first check-in unlocks referrals.
                </p>
              </div>
            )}
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
