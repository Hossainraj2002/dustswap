"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { encodeFunctionData } from "viem";
import { HistoryIcon } from "@/components/NavIcons";
import { SpinWheel } from "@/components/spin/SpinWheel";
import { WalletConnectButton } from "@/components/wallet/WalletConnectButton";
import { useBaseChainSwitch } from "@/hooks/useBaseChainSwitch";
import { useWalletConnection } from "@/hooks/useWalletConnection";
import { emitDataInvalidation, subscribeToDataInvalidation } from "@/lib/clientEvents";
import { explorerTxUrl } from "@/lib/contracts";
import {
  clearPointsSummaryCache,
  fetchPointsSummary,
  fetchSpinHistory,
  performSpin,
  type PointsBalance,
  type SpinHistoryEntry,
  type SpinReward,
} from "@/lib/points";
import { DATA_SUFFIX } from "@/lib/builderCode";
import {
  buildBasePaymasterCapabilities,
  isPaymasterEnabled,
  isUserRejectedRequest,
} from "@/lib/paymaster";
import {
  SPIN_CONTRACT_ADDRESS,
  SPIN_TRIGGER_ABI,
  SPIN_WHEEL_DURATION_MS,
  formatTicketLabel,
  getSpinTargetRotation,
  shortTxHash,
} from "@/lib/spin";
import { BASE_CHAIN_ID } from "@/lib/tokens";

type ToastState =
  | {
      kind: "success" | "error";
      message: string;
    }
  | null;

type FlowStage = "idle" | "wallet" | "verifying" | "spinning";

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error ?? "Unknown error");
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

function getTicketMessage(isConnected: boolean, ticketCount: number) {
  if (!isConnected) {
    return "Connect your wallet to view tickets and unlock the spin wheel.";
  }

  if (ticketCount <= 0) {
    return "You didn't have any Ticket, get 3 Ticket daily by check in.";
  }

  return `You have "${ticketCount}" Ticket${ticketCount === 1 ? "" : "s"}, you can spin "${ticketCount}" times for free.`;
}

function getRewardToastMessage(reward: SpinReward) {
  if (reward.type === "usdc") {
    return `You won ${reward.amount} USDC.`;
  }

  return `You won ${reward.pointsAwarded} PP.`;
}

function getInlineRewardTitle(reward: SpinReward) {
  if (reward.type === "usdc") {
    return `You won ${reward.amount} USDC`;
  }

  return `You won ${reward.pointsAwarded} PP`;
}

function getInlineRewardDescription(reward: SpinReward) {
  if (reward.type === "usdc") {
    return "Reward confirmed onchain.";
  }

  return "Added to your DustSwap balance.";
}

function SpinHistoryDrawer({
  open,
  onClose,
  history,
  isLoading,
}: {
  open: boolean;
  onClose: () => void;
  history: SpinHistoryEntry[];
  isLoading: boolean;
}) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[70] flex justify-end bg-slate-950/35 backdrop-blur-sm">
      <button
        type="button"
        aria-label="Close history"
        className="absolute inset-0"
        onClick={onClose}
      />

      <aside className="relative flex h-full w-full max-w-md flex-col border-l border-white/70 bg-[linear-gradient(180deg,#f8fbff,#eef6ff)] shadow-[-24px_0_60px_rgba(15,23,42,0.16)]">
        <div className="flex items-center justify-between border-b border-sky-100 px-5 py-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.28em] text-sky-600">
              Spin History
            </p>
            <h2 className="mt-1 text-xl font-black tracking-tight text-slate-950">
              Your spin earnings
            </h2>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-sky-100 bg-white/90 px-3 py-2 text-sm font-semibold text-slate-600 transition hover:text-slate-950"
          >
            Close
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, index) => (
                <div
                  key={index}
                  className="h-24 animate-pulse rounded-[24px] border border-white/70 bg-white/85"
                />
              ))}
            </div>
          ) : history.length ? (
            <div className="space-y-3">
              {history.map((entry) => (
                <article
                  key={entry.id}
                  className="rounded-[24px] border border-white/80 bg-white/92 p-4 shadow-[0_18px_40px_rgba(148,163,184,0.12)]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-[0.24em] text-sky-600">
                        {entry.reward.type === "usdc" ? "USDC Reward" : "PP Reward"}
                      </p>
                      <h3 className="mt-1 text-lg font-black tracking-tight text-slate-950">
                        {entry.reward.label}
                      </h3>
                    </div>

                    <div className="rounded-full border border-sky-100 bg-sky-50 px-3 py-1 text-[11px] font-black uppercase tracking-[0.22em] text-sky-700">
                      {entry.executionType === "smart_wallet" ? "Smart Wallet" : "Wallet"}
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-3 text-sm text-slate-500">
                    <span>{entry.createdAt ? new Date(entry.createdAt).toLocaleString() : "--"}</span>
                    <span>{shortTxHash(entry.txHash)}</span>
                  </div>

                  <div className="mt-4 flex items-center justify-between gap-3">
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-600">
                      {entry.ticketCost} Ticket
                    </span>

                    <a
                      href={explorerTxUrl(entry.txHash)}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-full border border-sky-100 bg-white px-3 py-1.5 text-sm font-semibold text-sky-700 transition hover:border-sky-200 hover:text-sky-900"
                    >
                      View tx
                    </a>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="rounded-[28px] border border-dashed border-sky-200 bg-white/88 px-5 py-8 text-center">
              <p className="text-lg font-black tracking-tight text-slate-950">No spin history yet</p>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                Your confirmed wheel rewards will appear here after each successful spin.
              </p>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

export default function SpinPage() {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { supportsBaseAccountFeatures } = useWalletConnection();
  const { isOnBase, isSwitching: isSwitchingToBase, switchToBase } = useBaseChainSwitch();
  const publicClient = usePublicClient();

  const [isMounted, setIsMounted] = useState(false);
  const [balance, setBalance] = useState<PointsBalance | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [toast, setToast] = useState<ToastState>(null);
  const [flowStage, setFlowStage] = useState<FlowStage>("idle");
  const [wheelRotation, setWheelRotation] = useState(0);
  const [latestReward, setLatestReward] = useState<SpinReward | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [history, setHistory] = useState<SpinHistoryEntry[]>([]);

  const ticketCount = balance?.spinTickets ?? 0;
  const hasTicket = ticketCount > 0;
  const isBusy = flowStage !== "idle";
  const spinDisabled =
    !isConnected ||
    !hasTicket ||
    !SPIN_CONTRACT_ADDRESS ||
    !walletClient ||
    !publicClient ||
    isSwitchingToBase ||
    isBusy;

  const loadBalance = useCallback(
    async (options?: { force?: boolean; silent?: boolean }) => {
      if (!address) {
        setBalance(null);
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
          throw new Error(summary.error || "Failed to load spin balance");
        }

        setBalance(summary.balance);
      } catch (error) {
        setToast({
          kind: "error",
          message: getErrorMessage(error) || "Failed to load spin balance.",
        });
      } finally {
        if (!options?.silent) {
          setIsLoading(false);
        }
      }
    },
    [address]
  );

  const loadHistory = useCallback(async () => {
    if (!address) {
      setHistory([]);
      return;
    }

    setHistoryLoading(true);
    try {
      const response = await fetchSpinHistory(address);
      if (!response.success) {
        throw new Error(response.error || "Failed to load spin history");
      }

      setHistory(response.history || []);
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error) || "Failed to load spin history.",
      });
    } finally {
      setHistoryLoading(false);
    }
  }, [address]);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!isConnected) {
      setBalance(null);
      setIsLoading(false);
      return;
    }

    void loadBalance();
  }, [isConnected, loadBalance]);

  useEffect(() => {
    if (!address) {
      return;
    }

    const unsubscribe = subscribeToDataInvalidation("points", () => {
      void loadBalance({ force: true, silent: true });
      if (historyOpen) {
        void loadHistory();
      }
    });

    return () => {
      unsubscribe();
    };
  }, [address, historyOpen, loadBalance, loadHistory]);

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
    if (historyOpen) {
      void loadHistory();
    }
  }, [historyOpen, loadHistory]);

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

  const sendSpinTransaction = useCallback(async () => {
    if (!walletClient || !publicClient || !SPIN_CONTRACT_ADDRESS) {
      throw new Error("Spin contract is not ready yet");
    }

    if (!isOnBase) {
      throw new Error("Switch your wallet to Base before spinning");
    }

    const txData = encodeFunctionData({
      abi: SPIN_TRIGGER_ABI,
      functionName: "spin",
    });
    const requestClient = walletClient as typeof walletClient & {
      account?: { address?: `0x${string}` };
      request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
    const requiresSponsoredSmartWallet =
      isPaymasterEnabled() && supportsBaseAccountFeatures;

    if (isPaymasterEnabled()) {
      try {
        const smartWalletAddress =
          requestClient.account?.address ?? (address as `0x${string}` | undefined);
        const request = requestClient.request;
        const capabilitiesResult =
          smartWalletAddress && request
            ? ((await request({
                method: "wallet_getCapabilities",
                params: [smartWalletAddress],
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
              to: SPIN_CONTRACT_ADDRESS,
              data: txData,
              value: 0n,
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
          throw new Error("Sponsored spin finished without a transaction hash");
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

        if (requiresSponsoredSmartWallet) {
          throw new Error(
            "Smart wallet sponsorship is unavailable on this connection. Disconnect and reconnect using Base Account, then try the spin again."
          );
        }

        console.warn("Paymaster sendCalls failed for spin, falling back to direct sendTransaction.", error);
      }
    }

    const hash = await walletClient.sendTransaction({
      to: SPIN_CONTRACT_ADDRESS,
      data: txData,
      dataSuffix: DATA_SUFFIX,
      value: 0n,
    } as any);

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error("Transaction reverted");
    }

    return hash;
  }, [address, isOnBase, publicClient, supportsBaseAccountFeatures, walletClient]);

  const handleSpin = useCallback(async () => {
    if (!address || !balance) {
      setToast({ kind: "error", message: "Connect your wallet first." });
      return;
    }

    if (balance.spinTickets <= 0) {
      setToast({ kind: "error", message: "You don't have any ticket to spin right now." });
      return;
    }

    if (isSwitchingToBase) {
      return;
    }

    if (!isOnBase) {
      await promptSwitchToBase("Wallet switched to Base. Tap spin again to continue.");
      return;
    }

    setFlowStage("wallet");

    try {
      const hash = await sendSpinTransaction();
      setFlowStage("verifying");

      const result = await performSpin({
        address,
        txHash: hash,
      });

      if (!result.success) {
        throw new Error(result.error || "Spin verification failed");
      }

      clearPointsSummaryCache(address);
      setBalance(result);
      setLatestReward(result.reward);
      setWheelRotation((currentRotation) =>
        getSpinTargetRotation(currentRotation, result.reward.key)
      );
      setFlowStage("spinning");
      emitDataInvalidation(["leaderboard", "points"], "spin");

      window.setTimeout(() => {
        setFlowStage("idle");
        setToast({
          kind: "success",
          message: getRewardToastMessage(result.reward),
        });

        if (historyOpen) {
          void loadHistory();
        }
      }, SPIN_WHEEL_DURATION_MS);
    } catch (error) {
      console.error(error);
      setFlowStage("idle");
      setToast({
        kind: "error",
        message: getErrorMessage(error) || "Spin transaction failed. Try again.",
      });
    }
  }, [
    address,
    balance,
    historyOpen,
    isOnBase,
    isSwitchingToBase,
    loadHistory,
    promptSwitchToBase,
    sendSpinTransaction,
  ]);

  if (!isMounted) {
    return null;
  }

  const messageTone = hasTicket
    ? "border-sky-200 bg-[linear-gradient(135deg,#f8fbff,#dbeafe)] text-slate-800"
    : "border-slate-200 bg-[linear-gradient(135deg,#ffffff,#f8fafc)] text-slate-700";

  const actionButtonClass =
    "flex w-full items-center justify-center rounded-[20px] border border-transparent px-5 py-3.5 text-base font-black tracking-tight transition duration-200";
  const showInlineReward = latestReward && flowStage === "idle";

  const renderActionButton = () =>
    hasTicket ? (
      <button
        type="button"
        onClick={() => void handleSpin()}
        disabled={spinDisabled}
        className={`${actionButtonClass} bg-[linear-gradient(135deg,#2563eb_0%,#0ea5e9_52%,#ffffff_180%)] text-white shadow-[0_20px_40px_rgba(37,99,235,0.28)] hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-55`}
      >
        {flowStage === "wallet"
          ? "Confirm Spin in Wallet..."
          : flowStage === "verifying"
            ? "Verifying Spin Onchain..."
            : flowStage === "spinning"
              ? "Wheel Spinning..."
              : "Spin"}
      </button>
    ) : (
      <Link
        href="/profile"
        className={`${actionButtonClass} bg-white text-sky-700 shadow-[0_18px_34px_rgba(148,163,184,0.16)] hover:-translate-y-0.5`}
      >
        Get ticket by check in
      </Link>
    );

  return (
    <>
      <div
        className="theme-page bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.16),transparent_26%),radial-gradient(circle_at_top_right,rgba(191,219,254,0.52),transparent_30%),linear-gradient(180deg,#f7fbff,#eef5ff_48%,#f8fbff)] px-3 py-4 pb-24 sm:px-6 sm:py-8 sm:pb-28"
        style={{ minHeight: "calc(100dvh - 4rem)" }}
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 sm:gap-5">
          {toast ? (
            <div
              className={`rounded-[20px] border px-4 py-3 text-sm shadow-[0_16px_36px_rgba(15,23,42,0.08)] ${
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
                    Spinning only works on Base. Switch your wallet to Base before using the wheel on this page.
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

          <section className="overflow-hidden rounded-[30px] border border-white/80 bg-white/82 px-4 py-4 shadow-[0_24px_80px_rgba(148,163,184,0.16)] backdrop-blur-xl sm:px-6 sm:py-6">
            <div className="flex items-start justify-between gap-3">
              <Image
                src="/longlogo.png"
                alt="DustSwap"
                width={178}
                height={42}
                priority
                className="h-auto w-[136px] sm:w-[178px]"
              />

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setHistoryOpen(true)}
                  aria-label="Open spin history"
                  className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-sky-100 bg-white/92 text-sky-700 shadow-[0_12px_24px_rgba(148,163,184,0.12)] transition hover:-translate-y-0.5 hover:text-sky-900"
                >
                  <HistoryIcon className="h-4 w-4" />
                </button>

                <div className="rounded-full border border-sky-100 bg-[linear-gradient(135deg,#eff6ff,#dbeafe)] px-4 py-2 text-right shadow-[0_12px_26px_rgba(59,130,246,0.12)]">
                  <p className="text-[10px] font-black uppercase tracking-[0.24em] text-sky-600">
                    Tickets
                  </p>
                  <p className="mt-1 text-sm font-black tracking-tight text-slate-950">
                    {isLoading ? "Loading..." : formatTicketLabel(ticketCount)}
                  </p>
                </div>
              </div>
            </div>

            <div className={`mt-5 rounded-[28px] border px-4 py-4 sm:px-5 sm:py-5 ${messageTone}`}>
              <p className="text-[10px] font-black uppercase tracking-[0.28em] text-sky-600">
                Daily Ticket Flow
              </p>
              <h1 className="mt-2 text-[1.9rem] font-black tracking-tight text-slate-950 sm:text-[2.4rem]">
                Spin the reward wheel
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">
                {getTicketMessage(isConnected, ticketCount)}
              </p>

              {!SPIN_CONTRACT_ADDRESS && isConnected ? (
                <div className="mt-4 rounded-[18px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  Spin contract address is not configured yet. Add it to the env to enable spins.
                </div>
              ) : null}

              {!isConnected ? (
                <div className="mt-5 rounded-[22px] border border-dashed border-sky-200 bg-white/78 px-4 py-5 text-center">
                  <p className="text-sm font-semibold text-slate-600">
                    Connect your wallet to see your tickets and start spinning.
                  </p>
                  <div className="mt-4 flex justify-center">
                    <WalletConnectButton
                      className="bg-[linear-gradient(135deg,#2563eb_0%,#0ea5e9_52%,#ffffff_180%)] text-white shadow-[0_20px_40px_rgba(37,99,235,0.28)] hover:border-transparent hover:text-white"
                      description="Connect your wallet to view tickets and spin."
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </section>

          <section className="rounded-[30px] border border-white/80 bg-white/78 px-4 py-6 shadow-[0_24px_80px_rgba(148,163,184,0.14)] backdrop-blur-xl sm:px-6 sm:py-8">
            <div className="mx-auto max-w-[480px]">
              <SpinWheel
                rotation={wheelRotation}
                activeRewardKey={latestReward?.key || null}
                isSpinning={flowStage === "spinning"}
              />

              {showInlineReward ? (
                <div className="mx-auto mt-6 max-w-sm rounded-[22px] border border-sky-100 bg-white px-4 py-4 text-center shadow-[0_16px_34px_rgba(37,99,235,0.10)]">
                  <p className="text-[10px] font-black uppercase tracking-[0.24em] text-sky-600">
                    Reward confirmed
                  </p>
                  <p className="mt-2 text-xl font-black tracking-tight text-slate-950">
                    {getInlineRewardTitle(latestReward)}
                  </p>
                  <p className="mt-1 text-sm font-semibold leading-5 text-slate-500">
                    {getInlineRewardDescription(latestReward)}
                  </p>
                </div>
              ) : null}

              <div className="mx-auto mt-6 max-w-sm">
                {renderActionButton()}
              </div>

              {flowStage === "wallet" || flowStage === "verifying" || flowStage === "spinning" ? (
                <p className="mt-4 text-center text-sm font-semibold text-sky-700">
                  {flowStage === "wallet"
                    ? "Confirm spin in wallet."
                    : flowStage === "verifying"
                      ? "Verifying spin transaction onchain."
                      : "Wheel is spinning."}
                </p>
              ) : null}
            </div>
          </section>
        </div>
      </div>

      <SpinHistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        history={history}
        isLoading={historyLoading}
      />
    </>
  );
}
