"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { getAddress, type Address } from "viem";
import { base } from "viem/chains";
import { createSiweMessage } from "viem/siwe";
import { useAccount, useSignMessage } from "wagmi";
import { useWalletConnection } from "@/hooks/useWalletConnection";
import { emitDataInvalidation } from "@/lib/clientEvents";
import { claimFootprintDrop, lookupFootprintDrop, type FootprintDropStatus } from "@/lib/footprintDrop";
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

const NAV_ITEMS = [
  { href: "/profile", label: "Profile" },
  { href: "/quests", label: "Quests" },
  { href: "/swap", label: "Swap" },
  { href: "/leaderboard", label: "Leaderboard" },
] as const;

const FOLLOW_VERIFY_DELAY_MS = 20_000;
const FOLLOW_GATE_STORAGE_PREFIX = "dustswap:footprint-follow-gate";
const FOOTPRINT_FOLLOW_TARGETS = [
  {
    key: "founder",
    label: "Follow founder on X",
    handle: "@akbarX402",
    href: "https://x.com/akbarX402",
    description: "Follow the DustSwap founder account.",
  },
  {
    key: "dustswap",
    label: "Follow DustSwap on X",
    handle: "@dustswaponbase",
    href: "https://x.com/dustswaponbase",
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

type FootprintFollowGateState = {
  founderOpened: boolean;
  dustswapOpened: boolean;
  startedAt: number | null;
  verifiedAt: number | null;
};

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatWhole(value: number | null | undefined) {
  return Number(value || 0).toLocaleString();
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

function createEmptyFollowGateState(): FootprintFollowGateState {
  return {
    founderOpened: false,
    dustswapOpened: false,
    startedAt: null,
    verifiedAt: null,
  };
}

function isFollowGateStateEmpty(state: FootprintFollowGateState) {
  return (
    !state.founderOpened &&
    !state.dustswapOpened &&
    !state.startedAt &&
    !state.verifiedAt
  );
}

function getFollowGateStorageKey(address: string) {
  return `${FOLLOW_GATE_STORAGE_PREFIX}:${address.toLowerCase()}`;
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

    const parsed = JSON.parse(raw) as Partial<FootprintFollowGateState>;
    return {
      founderOpened: parsed.founderOpened === true,
      dustswapOpened: parsed.dustswapOpened === true,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : null,
      verifiedAt: typeof parsed.verifiedAt === "number" ? parsed.verifiedAt : null,
    };
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

function openExternalTask(url: string) {
  if (typeof window === "undefined") {
    return;
  }

  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) {
    window.location.assign(url);
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
              className="h-auto w-[122px] sm:w-[138px]"
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
  remainingSeconds,
  isVerified,
  isApplyingReferral,
  claimState,
  onOpenTask,
  onVerify,
}: {
  followGateState: FootprintFollowGateState;
  remainingSeconds: number;
  isVerified: boolean;
  isApplyingReferral: boolean;
  claimState: "idle" | "claiming" | "claimed";
  onOpenTask: (taskKey: FootprintFollowTaskKey, href: string) => void;
  onVerify: () => void | Promise<void>;
}) {
  const allTasksOpened =
    followGateState.founderOpened && followGateState.dustswapOpened;
  const verifyDisabled =
    claimState === "claiming" ||
    isVerified ||
    !allTasksOpened ||
    remainingSeconds > 0;

  return (
    <div className="mt-4 rounded-[24px] border border-sky-100 bg-sky-50/70 p-4 sm:p-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-700">
        Claim step
      </p>
      <h3 className="mt-2 text-lg font-semibold tracking-[-0.02em] text-slate-950">
        Follow both X accounts before claiming
      </h3>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        These tasks stay hidden until you tap claim. Follow both accounts on X,
        then wait 20 seconds before verifying this step.
      </p>

      <div className="mt-4 grid gap-3">
        {FOOTPRINT_FOLLOW_TARGETS.map((task) => {
          const opened =
            task.key === "founder"
              ? followGateState.founderOpened
              : followGateState.dustswapOpened;

          return (
            <div
              key={task.key}
              className="rounded-[20px] border border-white/90 bg-white/90 p-4 shadow-[0_12px_28px_rgba(148,163,184,0.08)]"
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
                      opened
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : "border-slate-200 bg-slate-50 text-slate-500"
                    )}
                  >
                    {opened ? "Opened" : "Pending"}
                  </span>
                  <button
                    type="button"
                    onClick={() => onOpenTask(task.key, task.href)}
                    className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition-colors hover:bg-slate-100"
                  >
                    {opened ? "Open Again" : "Follow on X"}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 rounded-[20px] border border-white/90 bg-white/90 p-4 shadow-[0_12px_28px_rgba(148,163,184,0.08)]">
        <p className="text-sm font-medium text-slate-700">
          {isVerified
            ? "Follow step verified. Your claim button is unlocked now."
            : !allTasksOpened
              ? "Open both follow tasks to start the 20 second verify timer."
              : remainingSeconds > 0
                ? `Verify unlocks in ${remainingSeconds}s.`
                : "You can verify this step now."}
        </p>
        <button
          type="button"
          onClick={() => void onVerify()}
          disabled={verifyDisabled}
          className="mt-3 inline-flex w-full items-center justify-center rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isApplyingReferral || claimState === "claiming"
            ? "Claiming PP..."
            : isVerified
              ? "Verified"
              : remainingSeconds > 0
                ? `Verify in ${remainingSeconds}s`
                : "Verify follows"}
        </button>
      </div>
    </div>
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
  followGateRemainingSeconds,
  isFollowGateVerified,
  onClaim,
  onOpenFollowTask,
  onVerifyFollowGate,
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
  followGateRemainingSeconds: number;
  isFollowGateVerified: boolean;
  onClaim: () => void | Promise<void>;
  onOpenFollowTask: (
    taskKey: FootprintFollowTaskKey,
    href: string
  ) => void | Promise<void>;
  onVerifyFollowGate: () => void | Promise<void>;
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
                  ? "Finish X tasks first"
                : "Claim PP"}
          </button>
        </div>
      )}

      {showClaimButton && followGateVisible && !status.claimed ? (
        <ClaimFollowGate
          followGateState={followGateState}
          remainingSeconds={followGateRemainingSeconds}
          isVerified={isFollowGateVerified}
          isApplyingReferral={isApplyingReferral}
          claimState={claimState}
          onOpenTask={onOpenFollowTask}
          onVerify={onVerifyFollowGate}
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
  const { signMessageAsync } = useSignMessage();
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
  const [followGateTick, setFollowGateTick] = useState(0);

  const connectedAddress = useMemo(
    () => (address ? getAddress(address) : undefined),
    [address]
  );
  const areFollowTasksOpened =
    followGateState.founderOpened && followGateState.dustswapOpened;
  const followGateRemainingSeconds = useMemo(() => {
    if (!areFollowTasksOpened || !followGateState.startedAt || followGateState.verifiedAt) {
      return 0;
    }

    const remainingMs =
      followGateState.startedAt + FOLLOW_VERIFY_DELAY_MS - Date.now();
    return Math.max(0, Math.ceil(remainingMs / 1000));
  }, [areFollowTasksOpened, followGateState.startedAt, followGateState.verifiedAt, followGateTick]);
  const isFollowGateVerified = Boolean(followGateState.verifiedAt);

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
      return;
    }

    setFollowGateState(readFollowGateState(connectedAddress));
    setFollowGateVisible(false);
  }, [connectedAddress]);

  useEffect(() => {
    if (!connectedAddress) {
      return;
    }

    writeFollowGateState(connectedAddress, followGateState);
  }, [connectedAddress, followGateState]);

  useEffect(() => {
    if (!followGateVisible || isFollowGateVerified || !followGateState.startedAt) {
      return;
    }

    const interval = window.setInterval(() => {
      setFollowGateTick((current) => current + 1);
    }, 1000);

    return () => window.clearInterval(interval);
  }, [followGateVisible, isFollowGateVerified, followGateState.startedAt]);

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
  }, [connectedAddress, status?.address, status?.claimed]);

  useEffect(() => {
    const storedCode = getPendingReferralCode();
    if (!storedCode) {
      return;
    }

    setPendingReferralCode(storedCode);
  }, []);

  useEffect(() => {
    if (!initialReferralCode) {
      return;
    }

    const normalizedCode = normalizeReferralCode(initialReferralCode);
    if (!normalizedCode) {
      return;
    }

    storePendingReferralCode(normalizedCode);
    setPendingReferralCode(normalizedCode);
    setReferralBanner(null);
  }, [initialReferralCode]);

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

  const runLookup = useCallback(async (rawAddress: string) => {
    try {
      const normalizedAddress = normalizeAddressInput(rawAddress);
      setLookupState("checking");
      setLookupError(null);
      setClaimError(null);
      const result = await lookupFootprintDrop(normalizedAddress);
      setStatus(result);
      setClaimState(result.claimed ? "claimed" : "idle");
      setAddressInput(normalizedAddress);
    } catch (error) {
      setStatus(null);
      setClaimState("idle");
      setLookupError(getErrorMessage(error));
    } finally {
      setLookupState("idle");
    }
  }, []);

  const syncConnectedWalletLookup = useCallback(async () => {
    if (!connectedAddress) {
      return;
    }

    await runLookup(connectedAddress);
  }, [connectedAddress, runLookup]);

  const completeSignIn = useCallback(
    async (nonce: string, connectedWalletAddress: Address) => {
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
        await runLookup(connectedWalletAddress);
      } catch (error) {
        clearStoredSiweSession();
        setHasSiweSession(false);
        setAuthState("idle");
        setAuthError(getErrorMessage(error));
      }
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
      if (authState === "signing" || authState === "verifying") {
        return;
      }

      if (walletConnected && currentAddress && hasStoredSiweSession(currentAddress)) {
        setHasSiweSession(true);
        setAuthError(null);
        setAddressInput(currentAddress);
        await runLookup(currentAddress);
        return;
      }

      if (authState === "waitingForWallet" && !walletConnected) {
        setAuthError(null);
        await open?.();
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
      await runLookup(addressInput);
    } catch {
      // runLookup already owns the error state updates
    }
  }, [addressInput, runLookup]);

  const applyPendingReferralIfNeeded = useCallback(
    async (normalizedAddress: Address) => {
      if (!pendingReferralCode) {
        return;
      }

      setIsApplyingReferral(true);

      try {
        const result = await applyReferralCode(normalizedAddress, pendingReferralCode);
        if (result.success) {
          clearPendingReferralState({
            tone: "success",
            message: `Invite code ${pendingReferralCode} linked. Both you and your inviter received 500 PP.`,
          });
          clearPointsSummaryCache(normalizedAddress);
          emitDataInvalidation(["leaderboard", "points"], "referral-applied");
          return;
        }

        const errorMessage = result.error || "Referral could not be applied.";
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
            message: `Invite code ${pendingReferralCode} could not be applied. Your PP claim can continue without it.`,
          });
          return;
        }

        throw new Error(errorMessage);
      } finally {
        setIsApplyingReferral(false);
      }
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

    setClaimState("claiming");
    setClaimError(null);

    try {
      await applyPendingReferralIfNeeded(connectedAddress);
      const result = await claimFootprintDrop(connectedAddress);
      setStatus(result);
      setClaimState("claimed");
      clearFollowGateState(connectedAddress);
      setFollowGateState(createEmptyFollowGateState());
      setFollowGateVisible(false);
      clearPointsSummaryCache(connectedAddress);
      emitDataInvalidation(["leaderboard", "points"], "footprint-drop-claimed");
    } catch (error) {
      setClaimState("idle");
      setClaimError(getErrorMessage(error));
    }
  }, [applyPendingReferralIfNeeded, connectedAddress, hasSiweSession, status]);

  const handleOpenFollowTask = useCallback(
    (taskKey: FootprintFollowTaskKey, href: string) => {
      setFollowGateVisible(true);
      setClaimError(null);
      openExternalTask(href);
      setFollowGateState((current) => {
        const next = {
          ...current,
          founderOpened:
            taskKey === "founder" ? true : current.founderOpened,
          dustswapOpened:
            taskKey === "dustswap" ? true : current.dustswapOpened,
        };

        if (next.founderOpened && next.dustswapOpened && !next.startedAt) {
          next.startedAt = Date.now();
        }

        return next;
      });
    },
    []
  );

  const handleVerifyFollowGate = useCallback(async () => {
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

    if (!areFollowTasksOpened) {
      setClaimError("Follow both X accounts before verifying.");
      return;
    }

    if (followGateRemainingSeconds > 0) {
      setClaimError(`Please wait ${followGateRemainingSeconds}s more before verifying.`);
      return;
    }

    setClaimError(null);
    setFollowGateState((current) => ({
      ...current,
      verifiedAt: current.verifiedAt || Date.now(),
    }));
  }, [
    areFollowTasksOpened,
    connectedAddress,
    followGateRemainingSeconds,
    hasSiweSession,
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

      <LandingHeader
        walletButtonLabel={walletButtonLabel}
        walletButtonDisabled={walletButtonDisabled}
        onWalletAction={handleWalletAction}
      />

      <main className="relative z-10 overflow-x-clip px-4 pb-16 pt-[92px] sm:px-6 sm:pb-20 sm:pt-[102px]">
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
                Are you active user of Baseapp?
              </h2>
              <p className="mt-2.5 text-[15px] leading-6 text-slate-600 sm:mt-3 sm:text-base sm:leading-7">
                Are you a power onchain user on Base? Then check your PP airdrop.
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
                    followGateRemainingSeconds={followGateRemainingSeconds}
                    isFollowGateVerified={isFollowGateVerified}
                    onClaim={handleClaim}
                    onOpenFollowTask={handleOpenFollowTask}
                    onVerifyFollowGate={handleVerifyFollowGate}
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
