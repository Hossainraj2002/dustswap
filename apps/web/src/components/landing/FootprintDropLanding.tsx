"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { encodeFunctionData, erc20Abi, getAddress, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { createSiweMessage } from "viem/siwe";
import { useAccount, usePublicClient, useReadContract, useSignMessage, useWalletClient } from "wagmi";
import { useBaseChainSwitch } from "@/hooks/useBaseChainSwitch";
import { useWalletConnection } from "@/hooks/useWalletConnection";
import { DATA_SUFFIX } from "@/lib/builderCode";
import { emitDataInvalidation } from "@/lib/clientEvents";
import {
  claimFootprintDrop,
  lookupFootprintDrop,
  verifyFootprintFollow,
  type FootprintDropStatus,
} from "@/lib/footprintDrop";
import {
  buildBasePaymasterCapabilities,
  isPaymasterEnabled,
  isUserRejectedRequest,
} from "@/lib/paymaster";
import { applyReferralCode, clearPointsSummaryCache, fetchPointsSummary } from "@/lib/points";
import {
  clearPendingReferralCode,
  getPendingReferralCode,
  isTerminalReferralError,
  normalizeReferralCode,
  storePendingReferralCode,
} from "@/lib/referrals";
import {
  clearStoredSiweSession,
  hasStoredSiweSession,
  requestSiweNonce,
  saveStoredSiweSession,
  verifySiweSession,
} from "@/lib/siweAuth";
import { BASE_CHAIN_ID, USDC_ADDRESS } from "@/lib/tokens";
import {
  buildXAccountMessage,
  createXConnectUrl,
  fetchXAccount,
} from "@/lib/quests";

const NAV_ITEMS = [
  { href: "/profile", label: "Profile" },
  { href: "/quests", label: "Quests" },
  { href: "/swap", label: "Swap" },
  { href: "/leaderboard", label: "Leaderboard" },
] as const;

const FOLLOW_GATE_STORAGE_PREFIX = "dustswap:footprint-follow-gate";
const REFERRAL_CODE_PATTERN = /^DUST-[A-Z0-9]{5}$/;
const FOOTPRINT_FOLLOW_TARGETS = [
  {
    key: "dustswap",
    label: "Follow DustSwap on X",
    handle: "@DustswapOnBase",
    href: "https://x.com/intent/follow?screen_name=DustswapOnBase",
    description: "Follow the official DustSwap account.",
  },
] as const;

type ReferralBanner =
  | {
      tone: "info" | "success" | "warning";
      message: string;
    }
  | null;

type FootprintFollowTaskKey = (typeof FOOTPRINT_FOLLOW_TARGETS)[number]["key"];

type FootprintFollowTaskState = {
  openedAt: number | null;
  verifiedAt: number | null;
};

type FootprintFollowGateState = Record<FootprintFollowTaskKey, FootprintFollowTaskState>;

type ClaimConfig = NonNullable<FootprintDropStatus["claimConfig"]>;
type ClaimPaymentAsset = "eth" | "usdc";

type ClaimVerificationState = {
  address: string;
  asset: ClaimPaymentAsset;
  txHash: `0x${string}`;
};

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
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

function formatWhole(value: number | null | undefined) {
  return Number(value || 0).toLocaleString();
}

function getValidReferralCode(code?: string | null) {
  if (!code) {
    return null;
  }

  const normalizedCode = normalizeReferralCode(code);
  return REFERRAL_CODE_PATTERN.test(normalizedCode) ? normalizedCode : null;
}

function buildReferralApplyGuardKey(address: Address, referralCode: string) {
  return `${address.toLowerCase()}:${referralCode}`;
}

function SectionKicker({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-sky-200/80 bg-white/92 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-700 shadow-[0_6px_18px_rgba(37,99,235,0.08)]">
      {children}
    </span>
  );
}

function getErrorMessage(error: unknown) {
  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown error");

  if (
    message.toLowerCase().includes("user rejected") ||
    message.toLowerCase().includes("rejected the request") ||
    message.toLowerCase().includes("cancelled")
  ) {
    return "Wallet action was cancelled before it finished.";
  }

  return message;
}

function normalizeAddressInput(value: string) {
  return getAddress(value.trim());
}

function createEmptyFollowTaskState(): FootprintFollowTaskState {
  return {
    openedAt: null,
    verifiedAt: null,
  };
}

function createEmptyFollowGateState(): FootprintFollowGateState {
  return FOOTPRINT_FOLLOW_TARGETS.reduce(
    (state, { key }) => {
      state[key] = createEmptyFollowTaskState();
      return state;
    },
    {} as FootprintFollowGateState
  );
}

function isFollowGateStateEmpty(state: FootprintFollowGateState) {
  return Object.values(state).every(
    (taskState) =>
      !taskState.openedAt &&
      !taskState.verifiedAt
  );
}

function getFollowGateStorageKey(address: string) {
  return `${FOLLOW_GATE_STORAGE_PREFIX}:${address.toLowerCase()}`;
}

function normalizeStoredFollowTaskState(value: unknown): FootprintFollowTaskState {
  if (!value || typeof value !== "object") {
    return createEmptyFollowTaskState();
  }

  const candidate = value as {
    openedAt?: unknown;
    verifiedAt?: unknown;
  };

  return {
    openedAt: typeof candidate.openedAt === "number" ? candidate.openedAt : null,
    verifiedAt: typeof candidate.verifiedAt === "number" ? candidate.verifiedAt : null,
  };
}

function getLegacyFollowOpenedAt(opened: boolean | undefined, startedAt: number | null) {
  if (!opened) {
    return null;
  }

  return typeof startedAt === "number"
    ? startedAt
    : Date.now();
}

function readFollowGateState(address?: string): FootprintFollowGateState {
  if (typeof window === "undefined" || !address) {
    return createEmptyFollowGateState();
  }

  try {
    const raw = window.localStorage.getItem(getFollowGateStorageKey(address));
    if (!raw) {
      return createEmptyFollowGateState();
    }

    const parsed = JSON.parse(raw) as Partial<Record<FootprintFollowTaskKey, unknown>> & {
      founder?: unknown;
      dustswap?: unknown;
      founderOpened?: boolean;
      dustswapOpened?: boolean;
      startedAt?: number | null;
      verifiedAt?: number | null;
    };

    const legacyStartedAt =
      typeof parsed.startedAt === "number" ? parsed.startedAt : null;
    const legacyVerifiedAt =
      typeof parsed.verifiedAt === "number" ? parsed.verifiedAt : null;
    const nextState = createEmptyFollowGateState();

    for (const { key } of FOOTPRINT_FOLLOW_TARGETS) {
      const storedTask = parsed[key];
      nextState[key] = storedTask
        ? normalizeStoredFollowTaskState(storedTask)
        : {
            openedAt: getLegacyFollowOpenedAt(parsed.dustswapOpened, legacyStartedAt),
            verifiedAt: parsed.dustswapOpened ? legacyVerifiedAt : null,
          };
    }

    return nextState;
  } catch {
    return createEmptyFollowGateState();
  }
}

function writeFollowGateState(
  address: string,
  state: FootprintFollowGateState
) {
  if (typeof window === "undefined") {
    return;
  }

  if (isFollowGateStateEmpty(state)) {
    window.localStorage.removeItem(getFollowGateStorageKey(address));
    return;
  }

  window.localStorage.setItem(getFollowGateStorageKey(address), JSON.stringify(state));
}

function clearFollowGateState(address?: string) {
  if (typeof window === "undefined" || !address) {
    return;
  }

  window.localStorage.removeItem(getFollowGateStorageKey(address));
}

function getFollowTaskState(
  state: FootprintFollowGateState,
  taskKey: FootprintFollowTaskKey
) {
  return state[taskKey];
}

function getFollowTaskRemainingSeconds(_taskState?: FootprintFollowTaskState) {
  return 0;
}

function openExternalTask(url: string) {
  if (typeof window === "undefined") {
    return;
  }

  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) {
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.click();
  }
}

function HydratedConnectWalletButton({
  variant = "primary",
  className,
  disabled = false,
  fullWidth = false,
  labelOverride,
  onAction,
}: {
  variant?: "primary" | "secondary" | "header";
  className?: string;
  disabled?: boolean;
  fullWidth?: boolean;
  labelOverride?: string;
  onAction?: (context: {
    address?: Address;
    isConnected: boolean;
    open: (() => Promise<unknown>) | undefined;
  }) => void | Promise<void>;
}) {
  const { openWalletModal } = useWalletConnection();
  const { address, isConnected } = useAccount();

  const variantClasses = {
    primary:
      "bg-[#0066ff] text-white shadow-[0_16px_36px_rgba(0,102,255,0.22)] hover:-translate-y-0.5 hover:bg-[#0057dc]",
    secondary:
      "border border-slate-200 bg-white text-slate-900 shadow-[0_10px_24px_rgba(148,163,184,0.1)] hover:-translate-y-0.5 hover:border-sky-200 hover:bg-sky-50/70",
    header:
      "border border-slate-200/90 bg-white/90 text-slate-900 shadow-[0_10px_24px_rgba(148,163,184,0.08)] hover:-translate-y-0.5 hover:border-sky-200 hover:bg-white",
  } as const;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (disabled) {
          return;
        }

        if (onAction) {
          void onAction({
            address: address as Address | undefined,
            isConnected,
            open: openWalletModal,
          });
          return;
        }

        void openWalletModal();
      }}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-full px-5 py-3 text-sm font-semibold transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-70",
        variantClasses[variant],
        fullWidth && "w-full",
        className
      )}
    >
      <span
        className={cx(
          "h-2 w-2 rounded-full",
          isConnected ? "bg-emerald-300" : "bg-sky-200"
        )}
        aria-hidden="true"
      />
      <span>
        {labelOverride ??
          (isConnected && address ? shortAddress(address) : "Connect wallet")}
      </span>
    </button>
  );
}

function ConnectWalletButton(
  props: Parameters<typeof HydratedConnectWalletButton>[0]
) {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => setIsMounted(true), []);

  if (!isMounted) {
    const variantClasses = {
      primary: "bg-[#0066ff] text-white shadow-[0_16px_36px_rgba(0,102,255,0.22)]",
      secondary:
        "border border-slate-200 bg-white text-slate-900 shadow-[0_10px_24px_rgba(148,163,184,0.1)]",
      header:
        "border border-slate-200/90 bg-white/90 text-slate-900 shadow-[0_10px_24px_rgba(148,163,184,0.08)]",
    } as const;

    return (
      <button
        type="button"
        disabled
        className={cx(
          "inline-flex items-center justify-center gap-2 rounded-full px-5 py-3 text-sm font-semibold disabled:cursor-default",
          variantClasses[props.variant || "primary"],
          props.fullWidth && "w-full",
          props.className
        )}
      >
        <span className="h-2 w-2 rounded-full bg-sky-200" aria-hidden="true" />
        <span>Connect wallet</span>
      </button>
    );
  }

  return <HydratedConnectWalletButton {...props} />;
}

function LandingHeader({
  walletButtonLabel,
  walletButtonDisabled,
  onWalletAction,
}: {
  walletButtonLabel: string;
  walletButtonDisabled: boolean;
  onWalletAction: (context: {
    address?: Address;
    isConnected: boolean;
    open: (() => Promise<unknown>) | undefined;
  }) => void | Promise<void>;
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    document.body.style.overflow = mobileMenuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileMenuOpen]);

  return (
    <>
      <header
        className="fixed inset-x-0 top-0 z-50 border-b border-white/70 bg-white/82 backdrop-blur-xl"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <Link href="/" aria-label="DustSwap home" className="shrink-0">
            <Image
              src="/longlogo.png"
              alt="DustSwap"
              width={148}
              height={36}
              className="h-auto w-[136px] sm:w-[148px]"
              priority
            />
          </Link>

          <nav className="hidden items-center gap-1 rounded-full border border-white/80 bg-white/88 p-1 shadow-[0_10px_24px_rgba(148,163,184,0.08)] md:flex">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-full px-4 py-2 text-sm font-medium text-slate-600 transition-colors duration-200 hover:bg-sky-50 hover:text-slate-950"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="hidden md:block">
            <ConnectWalletButton
              variant="header"
              disabled={walletButtonDisabled}
              labelOverride={walletButtonLabel}
              onAction={onWalletAction}
            />
          </div>

          <button
            type="button"
            aria-label="Open navigation"
            aria-expanded={mobileMenuOpen}
            onClick={() => setMobileMenuOpen((current) => !current)}
            className="flex h-11 w-11 shrink-0 flex-col items-center justify-center gap-1.5 rounded-full border border-slate-200 bg-white text-slate-700 shadow-[0_8px_22px_rgba(148,163,184,0.08)] md:hidden"
          >
            <span
              className={cx(
                "h-[2px] w-4 bg-current transition-transform duration-200",
                mobileMenuOpen && "translate-y-[7px] rotate-45"
              )}
            />
            <span
              className={cx(
                "h-[2px] w-4 bg-current transition-opacity duration-200",
                mobileMenuOpen && "opacity-0"
              )}
            />
            <span
              className={cx(
                "h-[2px] w-4 bg-current transition-transform duration-200",
                mobileMenuOpen && "-translate-y-[7px] -rotate-45"
              )}
            />
          </button>
        </div>
      </header>

      <div
        className={cx(
          "fixed inset-0 z-40 bg-slate-950/18 backdrop-blur-sm transition-opacity duration-200 md:hidden",
          mobileMenuOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={() => setMobileMenuOpen(false)}
        aria-hidden="true"
      />

      <div
        className={cx(
          "fixed inset-x-4 z-50 rounded-[26px] border border-white/75 bg-white/96 p-4 shadow-[0_26px_54px_rgba(15,23,42,0.14)] backdrop-blur-xl transition-all duration-200 md:hidden",
          mobileMenuOpen
            ? "translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-4 opacity-0"
        )}
        style={{ top: "calc(env(safe-area-inset-top) + 72px)" }}
      >
        <div className="mb-3 border-b border-slate-100 px-2 pb-3">
          <Image
            src="/longlogo.png"
            alt="DustSwap"
            width={148}
            height={36}
            className="h-auto w-[138px]"
          />
        </div>

        <div className="space-y-1.5">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileMenuOpen(false)}
              className="flex items-center justify-between rounded-2xl px-4 py-3 text-sm font-medium text-slate-700 transition-colors hover:bg-sky-50"
            >
              <span>{item.label}</span>
            </Link>
          ))}
        </div>

        <div className="mt-4">
          <ConnectWalletButton
            variant="primary"
            fullWidth
            disabled={walletButtonDisabled}
            labelOverride={walletButtonLabel}
            onAction={async (context) => {
              setMobileMenuOpen(false);
              await onWalletAction(context);
            }}
          />
        </div>
      </div>
    </>
  );
}

function StatusMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-[16px] border border-sky-100 bg-sky-50/70 px-3 py-2.5 sm:rounded-[18px] sm:py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">
        {label}
      </p>
      <p className="mt-1.5 text-sm font-semibold text-slate-900 sm:text-[15px]">{value}</p>
    </div>
  );
}

function ClaimFollowGate({
  followGateState,
  remainingSecondsByTask,
  verifiedTasksCount,
  isVerified,
  isApplyingReferral,
  claimState,
  isXConnected,
  isConnectingX,
  onOpenTask,
  onVerifyTask,
  onConnectX,
}: {
  followGateState: FootprintFollowGateState;
  remainingSecondsByTask: Record<FootprintFollowTaskKey, number>;
  verifiedTasksCount: number;
  isVerified: boolean;
  isApplyingReferral: boolean;
  claimState: "idle" | "claiming" | "claimed";
  isXConnected: boolean;
  isConnectingX: boolean;
  onOpenTask: (taskKey: FootprintFollowTaskKey, href: string) => void;
  onVerifyTask: (taskKey: FootprintFollowTaskKey) => void | Promise<void>;
  onConnectX: () => void | Promise<void>;
}) {
  const totalTaskCount = FOOTPRINT_FOLLOW_TARGETS.length;
  const mobileStatusMessage = isVerified
    ? "Done. Claim is unlocked."
    : `${verifiedTasksCount}/${totalTaskCount} verified`;

  return (
    <>
      <div className="mt-4 max-h-[6cm] overflow-hidden rounded-[22px] border border-sky-100 bg-[linear-gradient(180deg,rgba(240,249,255,0.94),rgba(255,255,255,0.96))] p-3 sm:hidden">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-sky-700">
              Claim step
            </p>
            <h3 className="mt-1 text-[15px] font-semibold leading-5 tracking-[-0.02em] text-slate-950">
              Follow DustSwap on X
            </h3>
          </div>

          <span className="inline-flex shrink-0 items-center rounded-full border border-sky-200 bg-white/95 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-sky-700">
            {verifiedTasksCount}/{totalTaskCount}
          </span>
        </div>

        <div className="mt-2.5 space-y-2">
          {FOOTPRINT_FOLLOW_TARGETS.map((task) => {
            const taskState = getFollowTaskState(followGateState, task.key);
            const opened = Boolean(taskState.openedAt);
            const verified = Boolean(taskState.verifiedAt);
            const remainingSeconds = remainingSecondsByTask[task.key];
            const actionDisabled =
              claimState === "claiming" ||
              isApplyingReferral ||
              isConnectingX ||
              verified;
            const actionLabel = verified
              ? "Done"
              : !opened
                ? "Open"
                : !isXConnected
                  ? "Connect X"
                  : remainingSeconds > 0
                    ? `${remainingSeconds}s`
                    : "Verify";
            const shouldVerify = opened && isXConnected && remainingSeconds === 0;
            const shouldConnectX = opened && !isXConnected;

            return (
              <div
                key={task.key}
                className="flex items-center gap-2 rounded-[16px] border border-white/90 bg-white/94 px-2.5 py-2 shadow-[0_10px_24px_rgba(148,163,184,0.08)]"
              >
                <span
                  className={cx(
                    "h-2.5 w-2.5 shrink-0 rounded-full",
                    verified
                      ? "bg-emerald-500"
                      : opened
                          ? "bg-sky-500"
                          : "bg-slate-300"
                  )}
                  aria-hidden="true"
                />

                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-semibold leading-4 text-slate-950">
                    DustSwap
                  </p>
                  <p className="truncate text-[10px] leading-4 text-slate-500">
                    <span className="font-semibold">{task.handle}</span>
                    <span
                      className={cx(
                        "ml-1.5",
                        verified
                          ? "text-emerald-600"
                          : opened
                            ? "text-sky-600"
                            : "text-slate-400"
                      )}
                    >
                      {verified
                        ? "Verified"
                        : opened
                          ? !isXConnected
                            ? "Connect X"
                            : remainingSeconds > 0
                            ? `${remainingSeconds}s left`
                            : "Ready"
                          : "Pending"}
                    </span>
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() =>
                    void (verified || shouldVerify
                      ? onVerifyTask(task.key)
                      : shouldConnectX
                        ? onConnectX()
                        : onOpenTask(task.key, task.href))
                  }
                  disabled={actionDisabled}
                  className={cx(
                    "inline-flex min-w-[76px] shrink-0 items-center justify-center rounded-full border px-3 py-1.5 text-[11px] font-semibold transition-colors",
                    verified
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : opened && remainingSeconds > 0
                        ? "border-sky-200 bg-sky-50 text-sky-700"
                        : "border-slate-200 bg-white text-slate-900 hover:bg-slate-100",
                    actionDisabled && "cursor-not-allowed hover:bg-inherit"
                  )}
                >
                  {actionLabel}
                </button>
              </div>
            );
          })}
        </div>

        <div className="mt-2.5 flex items-center gap-2 rounded-[16px] border border-white/90 bg-white/94 px-2.5 py-2.5 shadow-[0_10px_24px_rgba(148,163,184,0.08)]">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">Status</p>
            <p className="mt-0.5 truncate text-[12px] font-medium leading-4 text-slate-700">
              {mobileStatusMessage}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-4 hidden rounded-[24px] border border-slate-200/70 bg-[linear-gradient(180deg,rgba(248,250,252,0.96),rgba(240,249,255,0.7))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] sm:block">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-700">
          Claim step
        </p>
        <h3 className="mt-2 text-lg font-semibold tracking-[-0.02em] text-slate-950">
          Follow DustSwap on X before claiming
        </h3>

        <div className="mt-4 grid gap-3">
          {FOOTPRINT_FOLLOW_TARGETS.map((task) => {
            const taskState = getFollowTaskState(followGateState, task.key);
            const opened = Boolean(taskState.openedAt);
            const verified = Boolean(taskState.verifiedAt);
            const remainingSeconds = remainingSecondsByTask[task.key];
            const actionDisabled =
              claimState === "claiming" ||
              isApplyingReferral ||
              isConnectingX ||
              verified;
            const actionLabel = verified
              ? "Verified"
              : !opened
                ? "Follow on X"
                : !isXConnected
                  ? "Connect X"
                  : remainingSeconds > 0
                    ? `Wait ${remainingSeconds}s`
                    : "Verify";
            const shouldVerify = opened && isXConnected && remainingSeconds === 0;
            const shouldConnectX = opened && !isXConnected;

            return (
              <div
                key={task.key}
                className="rounded-[20px] border border-white/90 bg-white/94 p-4 shadow-[0_14px_32px_rgba(15,23,42,0.06)]"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-950">{task.label}</p>
                    <p className="mt-1 text-sm leading-6 text-slate-500">
                      {task.description} <span className="font-semibold">{task.handle}</span>
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <span
                      className={cx(
                        "rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
                        verified
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : opened
                            ? "border-sky-200 bg-sky-50 text-sky-700"
                            : "border-slate-200 bg-slate-50 text-slate-500"
                      )}
                    >
                      {verified
                        ? "Verified"
                        : opened
                          ? !isXConnected
                            ? "Connect X"
                            : remainingSeconds > 0
                            ? `${remainingSeconds}s left`
                            : "Ready to verify"
                          : "Pending"}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        void (verified || shouldVerify
                          ? onVerifyTask(task.key)
                          : shouldConnectX
                            ? onConnectX()
                            : onOpenTask(task.key, task.href))
                      }
                      disabled={actionDisabled}
                      className={cx(
                        "inline-flex items-center justify-center rounded-full border px-4 py-2 text-sm font-semibold transition-colors",
                        verified
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : opened && remainingSeconds > 0
                            ? "border-sky-200 bg-sky-50 text-sky-700"
                            : shouldVerify
                              ? "border-sky-600 bg-sky-600 text-white hover:bg-sky-700"
                              : "border-slate-200 bg-white text-slate-900 hover:bg-slate-100",
                        actionDisabled && "cursor-not-allowed hover:bg-inherit"
                      )}
                    >
                      {actionLabel}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/85">
          <div
            className="h-full rounded-full bg-sky-500 transition-all duration-300"
            style={{ width: `${Math.round((verifiedTasksCount / totalTaskCount) * 100)}%` }}
          />
        </div>
      </div>
    </>
  );
}

function FootprintStatusPanel({
  status,
  connectedAddress,
  hasSiweSession,
  claimState,
  isApplyingReferral,
  claimError,
  followGateVisible,
  followGateState,
  followTaskRemainingSeconds,
  verifiedFollowTasksCount,
  isFollowGateVerified,
  isXConnected,
  isConnectingX,
  onClaim,
  onOpenFollowTask,
  onVerifyFollowTask,
  onConnectX,
  onUseConnectedWallet,
}: {
  status: FootprintDropStatus;
  connectedAddress?: string;
  hasSiweSession: boolean;
  claimState: "idle" | "claiming" | "claimed";
  isApplyingReferral: boolean;
  claimError: string | null;
  followGateVisible: boolean;
  followGateState: FootprintFollowGateState;
  followTaskRemainingSeconds: Record<FootprintFollowTaskKey, number>;
  verifiedFollowTasksCount: number;
  isFollowGateVerified: boolean;
  isXConnected: boolean;
  isConnectingX: boolean;
  onClaim: () => void | Promise<void>;
  onOpenFollowTask: (
    taskKey: FootprintFollowTaskKey,
    href: string
  ) => void | Promise<void>;
  onVerifyFollowTask: (taskKey: FootprintFollowTaskKey) => void | Promise<void>;
  onConnectX: () => void | Promise<void>;
  onUseConnectedWallet: () => void | Promise<void>;
}) {
  const matchesConnectedWallet =
    Boolean(connectedAddress) &&
    connectedAddress?.toLowerCase() === status.address.toLowerCase();

  const sourceLabel =
    status.source === "saved_leaderboard"
      ? "Baseapp Power user"
      : status.source === "blockscout"
        ? "Base onchain activity"
        : "Footprint Drop";

  const showClaimButton =
    status.claimable && matchesConnectedWallet && hasSiweSession;

  return (
    <div className="rounded-[28px] border border-white/90 bg-white p-5 shadow-[0_18px_42px_rgba(148,163,184,0.1)] sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-600">
            {status.claimed
              ? status.alreadyClaimed
                ? "Already claimed"
                : "Claimed"
              : status.eligible
                ? "Eligible reward"
                : "Check result"}
          </p>
          <p className="mt-2 text-3xl font-bold tracking-[-0.04em] text-slate-950 sm:text-4xl">
            {status.eligible || status.claimed
              ? `${formatWhole(status.rewardPoints)} PP`
              : "No tier unlocked"}
          </p>
          <p className="mt-2 text-sm leading-6 text-slate-500">{sourceLabel}</p>
        </div>

        <div className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          {shortAddress(status.address)}
        </div>
      </div>

      <div
        className={cx(
          "mt-4 grid gap-2.5 sm:mt-5 sm:gap-3",
          status.source === "saved_leaderboard" ? "grid-cols-2" : "sm:grid-cols-3"
        )}
      >
        {status.source === "saved_leaderboard" ? (
          <>
            <StatusMetric
              label="Total creator reward earned"
              value={`$${formatWhole(status.allowlistTotalUsdc)}`}
            />
            <StatusMetric label="Tier" value={status.tierLabel || "Below floor"} />
          </>
        ) : (
          <>
            <StatusMetric
              label="Transactions"
              value={formatWhole(status.transactionsCount)}
            />
            <StatusMetric
              label="Token transfers"
              value={formatWhole(status.tokenTransfersCount)}
            />
            <StatusMetric
              label="Total activity"
              value={formatWhole(status.totalActivity)}
            />
          </>
        )}
      </div>

      {status.reason && (
        <p className="mt-4 text-sm leading-6 text-slate-500">{status.reason}</p>
      )}

      {!status.claimed && status.eligible && !connectedAddress && (
        <p className="mt-4 rounded-[18px] border border-sky-100 bg-sky-50/70 px-4 py-3 text-sm font-medium text-sky-800">
          Connect your wallet to claim PP.
        </p>
      )}

      {!status.claimed && status.eligible && connectedAddress && !hasSiweSession && (
        <p className="mt-4 rounded-[18px] border border-sky-100 bg-sky-50/70 px-4 py-3 text-sm font-medium text-sky-800">
          Sign in with your wallet to claim this PP airdrop.
        </p>
      )}

      {!status.claimed && status.eligible && connectedAddress && !matchesConnectedWallet && (
        <div className="mt-4 rounded-[20px] border border-amber-100 bg-amber-50/80 p-4">
          <p className="text-sm font-medium text-amber-800">
            Claim works only for the connected wallet. Check your connected wallet to continue.
          </p>
          <button
            type="button"
            onClick={() => void onUseConnectedWallet()}
            className="mt-3 inline-flex items-center rounded-full border border-amber-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition-colors hover:bg-amber-50"
          >
            Use connected wallet
          </button>
        </div>
      )}

      {showClaimButton && (
        <div className="mt-5">
          <button
            type="button"
            disabled={
              claimState === "claiming" ||
              (followGateVisible && !isFollowGateVerified)
            }
            onClick={() => void onClaim()}
            className="inline-flex w-full items-center justify-center rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isApplyingReferral
              ? "Linking invite..."
              : claimState === "claiming"
                ? "Claiming PP..."
                : followGateVisible && !isFollowGateVerified
                  ? "Finish X task first"
                : "Claim PP"}
          </button>
        </div>
      )}

      {showClaimButton && followGateVisible && !status.claimed ? (
        <ClaimFollowGate
          followGateState={followGateState}
          remainingSecondsByTask={followTaskRemainingSeconds}
          verifiedTasksCount={verifiedFollowTasksCount}
          isVerified={isFollowGateVerified}
          isApplyingReferral={isApplyingReferral}
          claimState={claimState}
          isXConnected={isXConnected}
          isConnectingX={isConnectingX}
          onOpenTask={onOpenFollowTask}
          onVerifyTask={onVerifyFollowTask}
          onConnectX={onConnectX}
        />
      ) : null}

      {claimError && (
        <p className="mt-4 text-sm font-medium text-rose-600">{claimError}</p>
      )}

      {status.claimed && (
        <div className="mt-5 rounded-[22px] border border-emerald-100 bg-emerald-50/80 p-4">
          <p className="text-sm font-semibold text-emerald-900">
            {status.alreadyClaimed
              ? "Already claimed airdrop. Visit profile to earn more PP."
              : "PP added to your account. Invite your friend and get 20% of their airdrop too."}
          </p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/profile"
              className="inline-flex items-center justify-center rounded-full bg-emerald-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-800"
            >
              Profile
            </Link>
            <p className="text-sm leading-6 text-emerald-900/80">
              Your referral code lives on profile and the commission rate stays 20%.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default function FootprintDropLanding({
  initialReferralCode = null,
}: {
  initialReferralCode?: string | null;
}) {
  const { address, chainId, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const { signMessageAsync } = useSignMessage();
  const { isOnBase, switchToBase } = useBaseChainSwitch();
  const { supportsBaseAccountFeatures } = useWalletConnection();
  const [addressInput, setAddressInput] = useState("");
  const [status, setStatus] = useState<FootprintDropStatus | null>(null);
  const [lookupState, setLookupState] = useState<"idle" | "checking">("idle");
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [claimState, setClaimState] = useState<"idle" | "claiming" | "claimed">(
    "idle"
  );
  const [claimError, setClaimError] = useState<string | null>(null);
  const [hasSiweSession, setHasSiweSession] = useState(false);
  const [authState, setAuthState] = useState<
    "idle" | "preparing" | "waitingForWallet" | "signing" | "verifying"
  >("idle");
  const [authError, setAuthError] = useState<string | null>(null);
  const [pendingNonce, setPendingNonce] = useState<string | null>(null);
  const [pendingReferralCode, setPendingReferralCode] = useState<string | null>(null);
  const [referralBanner, setReferralBanner] = useState<ReferralBanner>(null);
  const [isApplyingReferral, setIsApplyingReferral] = useState(false);
  const [followGateVisible, setFollowGateVisible] = useState(false);
  const [followGateState, setFollowGateState] = useState<FootprintFollowGateState>(
    createEmptyFollowGateState
  );
  const [isXConnected, setIsXConnected] = useState(false);
  const [isConnectingX, setIsConnectingX] = useState(false);
  const blockedAutoLookupRef = useRef<Set<string>>(new Set());
  const lookupInFlightRef = useRef<Map<string, Promise<void>>>(new Map());
  const signInInFlightRef = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const referralApplyInFlightRef = useRef<Map<string, Promise<void>>>(new Map());
  const claimVerificationRef = useRef<ClaimVerificationState | null>(null);

  const connectedAddress = useMemo(
    () => (address ? getAddress(address) : undefined),
    [address]
  );
  const claimUsdcAddress = (status?.claimConfig?.usdcAddress || USDC_ADDRESS) as `0x${string}`;
  const { data: claimUsdcBalanceRaw } = useReadContract({
    address: claimUsdcAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [connectedAddress!],
    query: {
      enabled: !!connectedAddress && !!status?.claimConfig?.usdcAmountUnits,
    },
  });
  const claimUsdcBalance = (claimUsdcBalanceRaw as bigint | undefined) ?? 0n;
  const preferredClaimAsset = useMemo<ClaimPaymentAsset>(() => {
    if (!status?.claimConfig) {
      return "eth";
    }

    const requiredUsdc = BigInt(status.claimConfig.usdcAmountUnits);
    return requiredUsdc > 0n && claimUsdcBalance >= requiredUsdc ? "usdc" : "eth";
  }, [claimUsdcBalance, status?.claimConfig]);
  const followTaskRemainingSeconds = useMemo(
    () =>
      FOOTPRINT_FOLLOW_TARGETS.reduce(
        (remainingByTask, { key }) => {
          remainingByTask[key] = getFollowTaskRemainingSeconds(
            getFollowTaskState(followGateState, key)
          );
          return remainingByTask;
        },
        {} as Record<FootprintFollowTaskKey, number>
      ),
    [followGateState]
  );
  const verifiedFollowTasksCount = FOOTPRINT_FOLLOW_TARGETS.reduce(
    (count, { key }) => count + Number(Boolean(getFollowTaskState(followGateState, key).verifiedAt)),
    0
  );
  const serverFollowVerified =
    status?.footprintFollowVerified === true &&
    Boolean(connectedAddress) &&
    status.address.toLowerCase() === connectedAddress?.toLowerCase();
  const isFollowGateVerified =
    serverFollowVerified || verifiedFollowTasksCount === FOOTPRINT_FOLLOW_TARGETS.length;
  const clearPendingReferralState = useCallback((banner?: ReferralBanner) => {
    clearPendingReferralCode();
    setPendingReferralCode(null);
    if (banner) {
      setReferralBanner(banner);
    }
  }, []);

  useEffect(() => {
    setHasSiweSession(hasStoredSiweSession(address));
  }, [address, isConnected]);

  useEffect(() => {
    if (!connectedAddress) {
      setFollowGateState(createEmptyFollowGateState());
      setFollowGateVisible(false);
      setIsXConnected(false);
      return;
    }

    setFollowGateState(readFollowGateState(connectedAddress));
    setFollowGateVisible(false);
  }, [connectedAddress]);

  useEffect(() => {
    let cancelled = false;

    if (!connectedAddress) {
      setIsXConnected(false);
      setIsConnectingX(false);
      return;
    }

    void fetchXAccount(connectedAddress)
      .then((result) => {
        if (!cancelled) {
          setIsXConnected(result.success === true && result.account?.connected === true);
          setIsConnectingX(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIsXConnected(false);
          setIsConnectingX(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [connectedAddress]);

  useEffect(() => {
    if (!serverFollowVerified) {
      return;
    }

    setFollowGateState((current) => ({
      ...current,
      dustswap: {
        ...getFollowTaskState(current, "dustswap"),
        openedAt: getFollowTaskState(current, "dustswap").openedAt || Date.now(),
        verifiedAt: getFollowTaskState(current, "dustswap").verifiedAt || Date.now(),
      },
    }));
  }, [serverFollowVerified]);

  useEffect(() => {
    if (!connectedAddress) {
      return;
    }

    writeFollowGateState(connectedAddress, followGateState);
  }, [connectedAddress, followGateState]);

  useEffect(() => {
    setFollowGateVisible(false);
  }, [status?.address]);

  useEffect(() => {
    if (
      !connectedAddress ||
      !status?.claimed ||
      status.address.toLowerCase() !== connectedAddress.toLowerCase()
    ) {
      return;
    }

    clearFollowGateState(connectedAddress);
    setFollowGateState(createEmptyFollowGateState());
    setFollowGateVisible(false);
    claimVerificationRef.current = null;
  }, [connectedAddress, status?.address, status?.claimed]);

  useEffect(() => {
    if (
      claimVerificationRef.current &&
      (!connectedAddress ||
        claimVerificationRef.current.address !== connectedAddress.toLowerCase())
    ) {
      claimVerificationRef.current = null;
    }
  }, [connectedAddress]);

  useEffect(() => {
    const storedCode = getValidReferralCode(getPendingReferralCode());
    if (!storedCode) {
      clearPendingReferralCode();
      return;
    }

    setPendingReferralCode(storedCode);
  }, []);

  useEffect(() => {
    const normalizedCode = getValidReferralCode(initialReferralCode);
    if (!normalizedCode) {
      if (initialReferralCode) {
        clearPendingReferralState();
      }
      return;
    }

    storePendingReferralCode(normalizedCode);
    setPendingReferralCode(normalizedCode);
    setReferralBanner(null);
  }, [clearPendingReferralState, initialReferralCode]);

  useEffect(() => {
    if (!connectedAddress || !pendingReferralCode) {
      return;
    }

    let cancelled = false;

    const syncReferralLock = async () => {
      try {
        const summary = await fetchPointsSummary(connectedAddress, { force: true });
        if (cancelled || !summary.success || summary.referral?.hasReferrer !== true) {
          return;
        }

        clearPendingReferralState({
          tone: "info",
          message: "This wallet already has an invite linked. Your PP claim can continue normally.",
        });
      } catch {
        // Keep the landing flow resilient if the profile summary check fails.
      }
    };

    void syncReferralLock();

    return () => {
      cancelled = true;
    };
  }, [clearPendingReferralState, connectedAddress, pendingReferralCode]);

  const runLookup = useCallback(async (rawAddress: string, options?: { manual?: boolean }) => {
    let normalizedAddress: Address;

    try {
      normalizedAddress = normalizeAddressInput(rawAddress);
    } catch (error) {
      setStatus(null);
      setClaimState("idle");
      setLookupError(getErrorMessage(error));
      setLookupState("idle");
      return;
    }

    const lookupKey = normalizedAddress.toLowerCase();
    if (!options?.manual && blockedAutoLookupRef.current.has(lookupKey)) {
      return;
    }

    const existingLookup = lookupInFlightRef.current.get(lookupKey);
    if (existingLookup) {
      return existingLookup;
    }

    if (options?.manual) {
      blockedAutoLookupRef.current.delete(lookupKey);
    }

    const request = (async () => {
      setLookupState("checking");
      setLookupError(null);
      setClaimError(null);

      try {
        const result = await lookupFootprintDrop(normalizedAddress);
        blockedAutoLookupRef.current.delete(lookupKey);
        setStatus(result);
        setClaimState(result.claimed ? "claimed" : "idle");
        setAddressInput(normalizedAddress);
      } catch (error) {
        blockedAutoLookupRef.current.add(lookupKey);
        setStatus(null);
        setClaimState("idle");
        setLookupError(getErrorMessage(error));
      } finally {
        setLookupState("idle");
        lookupInFlightRef.current.delete(lookupKey);
      }
    })();

    lookupInFlightRef.current.set(lookupKey, request);
    return request;
  }, []);

  const syncConnectedWalletLookup = useCallback(async () => {
    if (!connectedAddress) {
      return;
    }

    await runLookup(connectedAddress, { manual: true });
  }, [connectedAddress, runLookup]);

  const completeSignIn = useCallback(
    async (nonce: string, connectedWalletAddress: Address) => {
      const signInKey = `${connectedWalletAddress.toLowerCase()}:${nonce}`;
      if (signInInFlightRef.current?.key === signInKey) {
        return signInInFlightRef.current.promise;
      }

      const request = (async () => {
        setPendingNonce(null);
        setAuthError(null);

        try {
          setAuthState("signing");
          const message = createSiweMessage({
            address: connectedWalletAddress,
            chainId: chainId ?? base.id,
            domain: window.location.host,
            issuedAt: new Date(),
            nonce,
            statement: "Sign in to DustSwap to claim the Footprint Drop.",
            uri: window.location.origin,
            version: "1",
          });
          const signature = await signMessageAsync({ message });

          setAuthState("verifying");
          const session = await verifySiweSession({
            address: connectedWalletAddress,
            message,
            signature,
          });

          saveStoredSiweSession(session);
          setHasSiweSession(true);
          setAuthState("idle");
          setAddressInput(connectedWalletAddress);
          await runLookup(connectedWalletAddress, { manual: true });
        } catch (error) {
          clearStoredSiweSession();
          setHasSiweSession(false);
          setAuthState("idle");
          setAuthError(getErrorMessage(error));
        } finally {
          if (signInInFlightRef.current?.key === signInKey) {
            signInInFlightRef.current = null;
          }
        }
      })();

      signInInFlightRef.current = { key: signInKey, promise: request };
      return request;
    },
    [chainId, runLookup, signMessageAsync]
  );

  useEffect(() => {
    if (authState === "waitingForWallet" && pendingNonce && isConnected && connectedAddress) {
      void completeSignIn(pendingNonce, connectedAddress);
    }
  }, [authState, completeSignIn, connectedAddress, isConnected, pendingNonce]);

  const handleWalletAction = useCallback(
    async ({
      address: currentAddress,
      isConnected: walletConnected,
      open,
    }: {
      address?: Address;
      isConnected: boolean;
      open: (() => Promise<unknown>) | undefined;
    }) => {
      if (
        authState === "preparing" ||
        authState === "signing" ||
        authState === "verifying"
      ) {
        return;
      }

      if (walletConnected && currentAddress && hasStoredSiweSession(currentAddress)) {
        setHasSiweSession(true);
        setAuthError(null);
        setAddressInput(currentAddress);
        await runLookup(currentAddress, { manual: true });
        return;
      }

      if (authState === "waitingForWallet") {
        if (!walletConnected) {
          setAuthError(null);
          await open?.();
        }
        return;
      }

      setAuthState("preparing");
      setAuthError(null);

      try {
        const { nonce } = await requestSiweNonce();

        if (walletConnected && currentAddress) {
          await completeSignIn(nonce, currentAddress);
          return;
        }

        setPendingNonce(nonce);
        setAuthState("waitingForWallet");
        await open?.();
      } catch (error) {
        setPendingNonce(null);
        setAuthState("idle");
        setAuthError(getErrorMessage(error));
      }
    },
    [authState, completeSignIn, runLookup]
  );

  const handleAddressCheck = useCallback(async () => {
    try {
      await runLookup(addressInput, { manual: true });
    } catch {
      // runLookup already owns the error state updates
    }
  }, [addressInput, runLookup]);

  const promptSwitchToBase = useCallback(async () => {
    if (isOnBase) {
      return true;
    }

    try {
      return await switchToBase();
    } catch (error) {
      setClaimError(getErrorMessage(error));
      return false;
    }
  }, [isOnBase, switchToBase]);

  const sendClaimPayment = useCallback(
    async (config: ClaimConfig, asset: ClaimPaymentAsset) => {
      if (!walletClient || !publicClient) {
        throw new Error("Wallet is not ready");
      }

      if (!isOnBase) {
        throw new Error("Switch your wallet to Base before sending this airdrop claim transaction");
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
              ? ((await requestClient.request?.({
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
                ([candidate]) =>
                  candidate.toLowerCase() === toHexChainId(BASE_CHAIN_ID).toLowerCase()
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

          const statusResult = await walletClient.waitForCallsStatus({
            id: callId,
            throwOnFailure: true,
            timeout: 120_000,
          });
          const hash = statusResult.receipts?.find((receipt) =>
            isTxHash(receipt?.transactionHash)
          )?.transactionHash;

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

          console.warn(
            "Paymaster sendCalls failed for Footprint claim, falling back to direct sendTransaction.",
            error
          );
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

  const applyPendingReferralIfNeeded = useCallback(
    async (normalizedAddress: Address) => {
      const referralCode = getValidReferralCode(pendingReferralCode);
      if (!referralCode) {
        if (pendingReferralCode) {
          clearPendingReferralState({
            tone: "warning",
            message: "Invite code could not be verified locally. Your PP claim can continue without it.",
          });
        }
        return;
      }

      const applyGuardKey = buildReferralApplyGuardKey(normalizedAddress, referralCode);
      const existingApply = referralApplyInFlightRef.current.get(
        applyGuardKey
      );
      if (existingApply) {
        return existingApply;
      }

      const request = (async () => {
        setIsApplyingReferral(true);

        try {
          const result = await applyReferralCode(normalizedAddress, referralCode);
          if (result.success) {
            clearPendingReferralState({
              tone: "success",
              message: `Invite code ${referralCode} linked. Both you and your inviter received 500 PP.`,
            });
            clearPointsSummaryCache(normalizedAddress);
            emitDataInvalidation(["leaderboard", "points"], "referral-applied");
            return;
          }

          if (result.deferred) {
            setReferralBanner({
              tone: "info",
              message:
                "Invite code saved. It will activate after your first onchain check-in or PP claim.",
            });
            return;
          }

          const errorMessage =
            result.error || result.message || "Referral could not be applied.";

          if (isTerminalReferralError(errorMessage)) {
            clearPointsSummaryCache(normalizedAddress);

            if (errorMessage.toLowerCase().includes("already referred")) {
              clearPendingReferralState({
                tone: "info",
                message: "This wallet already has an invite linked. Your PP claim can continue normally.",
              });
              return;
            }

            clearPendingReferralState({
              tone: "warning",
              message: `Invite code ${referralCode} could not be applied. Your PP claim can continue without it.`,
            });
            return;
          }

          setReferralBanner({
            tone: "info",
            message:
              "Your PP claim succeeded. This invite code is still saved and can activate after your first onchain check-in or PP claim.",
          });
        } catch {
          setReferralBanner({
            tone: "info",
            message:
              "Your PP claim succeeded. This invite code is still saved and can activate after your first onchain check-in or PP claim.",
          });
        } finally {
          setIsApplyingReferral(false);
          referralApplyInFlightRef.current.delete(applyGuardKey);
        }
      })();

      referralApplyInFlightRef.current.set(applyGuardKey, request);
      return request;
    },
    [clearPendingReferralState, pendingReferralCode]
  );

  const executeClaim = useCallback(async () => {
    if (!connectedAddress) {
      setClaimError("Connect your wallet to claim PP.");
      return;
    }

    if (!hasSiweSession) {
      setClaimError("Sign in with your wallet before claiming.");
      return;
    }

    if (!status || status.address.toLowerCase() !== connectedAddress.toLowerCase()) {
      setClaimError("Check your connected wallet before claiming.");
      return;
    }

    const claimConfig = status.claimConfig;
    const reusableVerification =
      claimVerificationRef.current &&
      claimVerificationRef.current.address === connectedAddress.toLowerCase()
        ? claimVerificationRef.current
        : null;

    if (!claimConfig && !reusableVerification) {
      setClaimError("Claim payment details are not ready yet. Refresh your reward check and try again.");
      return;
    }

    setClaimState("claiming");
    setClaimError(null);

    try {
      let paymentVerification = reusableVerification;
      if (!paymentVerification) {
        if (!isOnBase) {
          await promptSwitchToBase();
          setClaimState("idle");
          return;
        }

        paymentVerification = {
          address: connectedAddress.toLowerCase(),
          asset: preferredClaimAsset,
          txHash: await sendClaimPayment(claimConfig!, preferredClaimAsset),
        };
        claimVerificationRef.current = paymentVerification;
      }

      const result = await claimFootprintDrop({
        address: connectedAddress,
        asset: paymentVerification.asset,
        txHash: paymentVerification.txHash,
      });

      claimVerificationRef.current = null;
      setStatus(result);
      setClaimState("claimed");
      clearFollowGateState(connectedAddress);
      setFollowGateState(createEmptyFollowGateState());
      setFollowGateVisible(false);
      clearPointsSummaryCache(connectedAddress);
      emitDataInvalidation(["leaderboard", "points"], "footprint-drop-claimed");
      await applyPendingReferralIfNeeded(connectedAddress);
    } catch (error) {
      setClaimState("idle");
      const message = getErrorMessage(error);
      const shouldReusePayment =
        claimVerificationRef.current?.address === connectedAddress.toLowerCase();

      setClaimError(
        shouldReusePayment
          ? `${message} Retry claim to re-check the same payment without sending a new transaction.`
          : message
      );
    }
  }, [
    applyPendingReferralIfNeeded,
    connectedAddress,
    hasSiweSession,
    isOnBase,
    preferredClaimAsset,
    promptSwitchToBase,
    sendClaimPayment,
    status,
  ]);

  const handleOpenFollowTask = useCallback(
    (taskKey: FootprintFollowTaskKey, href: string) => {
      setFollowGateVisible(true);
      setClaimError(null);

      const taskState = getFollowTaskState(followGateState, taskKey);
      const nextState =
        taskState.openedAt
          ? followGateState
          : {
              ...followGateState,
              [taskKey]: {
                ...taskState,
                openedAt: taskState.openedAt ?? Date.now(),
              },
            };

      setFollowGateState(nextState);
      if (connectedAddress) {
        writeFollowGateState(connectedAddress, nextState);
      }

      openExternalTask(href);
    },
    [connectedAddress, followGateState]
  );

  const handleConnectX = useCallback(async () => {
    if (!connectedAddress) {
      setClaimError("Connect your wallet to claim PP.");
      return;
    }

    if (isConnectingX) {
      return;
    }

    setClaimError(null);
    setIsConnectingX(true);

    try {
      const messageToSign = buildXAccountMessage(connectedAddress, "connect-x");
      const signature = (await signMessageAsync({
        message: messageToSign,
      })) as Hex;
      const response = await createXConnectUrl({
        address: connectedAddress,
        message: messageToSign,
        signature,
        returnTo:
          typeof window !== "undefined"
            ? window.location.href
            : "/",
      });

      if (!response.success || !response.authUrl) {
        throw new Error(response.error || "Failed to start X connection");
      }

      window.location.assign(response.authUrl);
    } catch (error) {
      setClaimError(getErrorMessage(error));
      setIsConnectingX(false);
    }
  }, [connectedAddress, isConnectingX, signMessageAsync]);

  const handleVerifyFollowTask = useCallback(async (taskKey: FootprintFollowTaskKey) => {
    if (!connectedAddress) {
      setClaimError("Connect your wallet to claim PP.");
      return;
    }

    if (!hasSiweSession) {
      setClaimError("Sign in with your wallet before claiming.");
      return;
    }

    if (!status || status.address.toLowerCase() !== connectedAddress.toLowerCase()) {
      setClaimError("Check your connected wallet before claiming.");
      return;
    }

    if (!isXConnected) {
      await handleConnectX();
      return;
    }

    const taskState = getFollowTaskState(followGateState, taskKey);
    if (!taskState.openedAt) {
      setClaimError("Open the DustSwap follow task before verifying it.");
      return;
    }

    if (taskState.verifiedAt) {
      setClaimError(null);
      return;
    }

    try {
      const result = await verifyFootprintFollow({
        address: connectedAddress,
        taskKey,
      });

      if (!result.success || !result.verified) {
        setClaimError(result.message || result.error || "Follow DustSwap on X, then verify again.");
        return;
      }

      setClaimError(null);
      setFollowGateState((current) => ({
        ...current,
        [taskKey]: {
          ...getFollowTaskState(current, taskKey),
          verifiedAt: Date.now(),
        },
      }));
      await runLookup(connectedAddress, { manual: true });
      emitDataInvalidation(["points"], "footprint-follow-verified");
    } catch (error) {
      setClaimError(getErrorMessage(error));
    }
  }, [
    connectedAddress,
    followGateState,
    handleConnectX,
    hasSiweSession,
    isXConnected,
    runLookup,
    status,
  ]);

  const handleClaim = useCallback(async () => {
    if (!isFollowGateVerified) {
      setFollowGateVisible(true);
      setClaimError(null);
      return;
    }

    await executeClaim();
  }, [executeClaim, isFollowGateVerified]);

  useEffect(() => {
    if (!connectedAddress) {
      setHasSiweSession(false);
      if (authState !== "idle" && authState !== "waitingForWallet") {
        setAuthState("idle");
      }
      return;
    }

    if (hasSiweSession && (!status || status.address.toLowerCase() !== connectedAddress.toLowerCase())) {
      setAddressInput(connectedAddress);
      void runLookup(connectedAddress);
    }
  }, [authState, connectedAddress, hasSiweSession, runLookup, status]);

  const walletButtonLabel =
    authState === "preparing"
      ? "Preparing..."
      : authState === "waitingForWallet"
        ? "Finish connecting..."
        : authState === "signing"
          ? "Sign the message..."
          : authState === "verifying"
            ? "Verifying..."
            : isConnected && connectedAddress && hasSiweSession
              ? "Wallet ready"
              : isConnected
                ? "Sign in to claim"
                : "Connect wallet";

  const walletButtonDisabled =
    authState === "preparing" ||
    authState === "signing" ||
    authState === "verifying";

  return (
    <div className="relative min-h-screen w-full overflow-x-clip bg-[#f4f8fc] text-slate-900 selection:bg-sky-200">
      <div className="pointer-events-none fixed inset-0 z-0 bg-[radial-gradient(circle_at_top,rgba(191,219,254,0.55),transparent_42%),radial-gradient(circle_at_bottom_left,rgba(125,211,252,0.18),transparent_32%)]" />
      <div className="pointer-events-none fixed inset-x-0 top-0 z-0 h-[440px] bg-[linear-gradient(180deg,rgba(255,255,255,0.68)_0%,rgba(255,255,255,0)_100%)]" />

      <main className="relative z-10 overflow-x-clip px-4 pb-16 pt-6 sm:px-6 sm:pb-20 sm:pt-10 lg:pt-14">
        <section className="mx-auto max-w-6xl py-4 sm:py-12 lg:py-16">
          <div className="grid gap-5 sm:gap-8 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1fr)] lg:items-start lg:gap-10">
            <div className="min-w-0 max-w-[19rem] sm:max-w-xl">
              <SectionKicker>Footprint Drop</SectionKicker>
              <h1 className="mt-3 max-w-[12ch] font-syne text-[1.95rem] font-bold leading-[1.02] tracking-[-0.045em] text-slate-950 sm:mt-5 sm:text-[3.25rem] lg:text-[4.5rem]">
                Earn reward for what you do already every day.
              </h1>
              <p className="mt-3 max-w-xl text-[15px] leading-6 text-slate-600 sm:mt-5 sm:text-lg sm:leading-7">
                A PP airdrop for wallets that are already active on Base. We check your
                Baseapp Power user footprint first, then fall back to Base onchain
                activity on the backend.
              </p>
            </div>

            <div className="rounded-[28px] border border-white/90 bg-white/90 p-4 shadow-[0_24px_60px_rgba(37,99,235,0.12)] backdrop-blur sm:rounded-[30px] sm:p-6">
              <SectionKicker>Airdrop</SectionKicker>
              <h2 className="mt-3 font-syne text-[1.55rem] font-bold tracking-[-0.04em] text-slate-950 sm:mt-4 sm:text-[2.2rem]">
                Are you a power onchain user on Base?
              </h2>
              <p className="mt-2.5 text-[15px] leading-6 text-slate-600 sm:mt-3 sm:text-base sm:leading-7">
                Are you active user of Baseapp? Then check your PP airdrop.
              </p>

              {pendingReferralCode ? (
                <div className="mt-4 rounded-[22px] border border-sky-100 bg-sky-50/75 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-700">
                    Invite attached
                  </p>
                  <p className="mt-2 break-all font-mono text-sm font-semibold tracking-[0.08em] text-slate-900">
                    {pendingReferralCode}
                  </p>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    This invite code is locked and will activate when you claim your PP airdrop.
                  </p>
                </div>
              ) : referralBanner ? (
                <div
                  className={cx(
                    "mt-4 rounded-[22px] border p-4 text-sm leading-6",
                    referralBanner.tone === "success" &&
                      "border-emerald-100 bg-emerald-50/80 text-emerald-900",
                    referralBanner.tone === "warning" &&
                      "border-amber-100 bg-amber-50/80 text-amber-900",
                    referralBanner.tone === "info" &&
                      "border-sky-100 bg-sky-50/75 text-sky-900"
                  )}
                >
                  {referralBanner.message}
                </div>
              ) : null}

              <div className="mt-5 sm:mt-6">
                <label
                  htmlFor="footprint-address"
                  className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400"
                >
                  Enter your address
                </label>
                <input
                  id="footprint-address"
                  value={addressInput}
                  onChange={(event) => {
                    setAddressInput(event.target.value);
                    setLookupError(null);
                    setClaimError(null);
                  }}
                  placeholder="0x..."
                  className="mt-2 w-full rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-sky-300 focus:bg-white"
                />
              </div>

              <div className="mt-4 flex flex-col gap-2.5 sm:flex-row sm:gap-3">
                <button
                  type="button"
                  disabled={lookupState === "checking"}
                  onClick={() => void handleAddressCheck()}
                  className="inline-flex w-full items-center justify-center rounded-full border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow-[0_10px_24px_rgba(148,163,184,0.1)] transition-all duration-200 hover:-translate-y-0.5 hover:border-sky-200 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-70 sm:w-auto"
                >
                  {lookupState === "checking" ? "Checking..." : "Check reward"}
                </button>

                <ConnectWalletButton
                  variant="primary"
                  fullWidth
                  className="sm:w-auto"
                  disabled={walletButtonDisabled}
                  labelOverride={walletButtonLabel}
                  onAction={handleWalletAction}
                />
              </div>

              <Link
                href="/profile"
                className="mt-3 inline-flex w-full items-center justify-center rounded-full border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow-[0_10px_24px_rgba(148,163,184,0.1)] transition-all duration-200 hover:-translate-y-0.5 hover:border-sky-200 hover:bg-sky-50"
              >
                Visit app
              </Link>

              <p className="mt-3 text-sm leading-6 text-slate-500">
                You can paste any Base wallet to preview. Claim works only for the connected wallet after sign-in.
              </p>

              {authError && (
                <p className="mt-3 text-sm font-medium text-rose-600">{authError}</p>
              )}

              {lookupError && (
                <p className="mt-3 text-sm font-medium text-rose-600">{lookupError}</p>
              )}

              {status && (
                <div className="mt-5 sm:mt-6">
                  <FootprintStatusPanel
                    status={status}
                    connectedAddress={connectedAddress}
                    hasSiweSession={hasSiweSession}
                    claimState={claimState}
                    isApplyingReferral={isApplyingReferral}
                    claimError={claimError}
                    followGateVisible={followGateVisible}
                    followGateState={followGateState}
                    followTaskRemainingSeconds={followTaskRemainingSeconds}
                    verifiedFollowTasksCount={verifiedFollowTasksCount}
                    isFollowGateVerified={isFollowGateVerified}
                    isXConnected={isXConnected}
                    isConnectingX={isConnectingX}
                    onClaim={handleClaim}
                    onOpenFollowTask={handleOpenFollowTask}
                    onVerifyFollowTask={handleVerifyFollowTask}
                    onConnectX={handleConnectX}
                    onUseConnectedWallet={syncConnectedWalletLookup}
                  />
                </div>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
