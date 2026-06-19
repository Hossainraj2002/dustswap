"use client";

import { useEffect, useState } from "react";
import {
  type DelegateIdentity,
  type DustSweepAtomicStatus,
  type DustSweepWalletKey,
  type SweepRouteKind,
} from "@/types/dustsweep";
import { isSameEip7702WalletFamily } from "@/lib/eip7702";
import { isDustSweepApprovalBatchingEnabled } from "@/lib/dustsweep-feature-flags";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function Spinner() {
  return (
    <span
      className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-blue-500 border-t-transparent motion-reduce:animate-none"
      aria-hidden="true"
    />
  );
}

function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 shrink-0">
      <path
        fill="currentColor"
        d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5z"
      />
    </svg>
  );
}

function PenIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

function SwitchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17 1l4 4-4 4" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <path d="M7 23l-4-4 4-4" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

type RouteStatusVisual = {
  icon: React.ReactNode;
  title: string;
  subtext: string;
  why: string;
  statusItems: string[];
  container: string;
  text: string;
  whyButton: string;
};

function formatDelegationStatus(delegation?: DelegateIdentity) {
  if (!delegation || delegation.state === "none") {
    return "Not delegated on Base";
  }

  if (delegation.state === "known") {
    return `Delegated to ${delegation.label}`;
  }

  return "Delegated to an unknown contract";
}

function formatAtomicStatus(status?: DustSweepAtomicStatus | string) {
  if (status === "supported") return "Batch supported";
  if (status === "ready") return "Wallet can enable batch";
  if (status === "unsupported") return "Batch unsupported";
  return "Batch status unknown";
}

function joinWalletLabels(labels?: string[]) {
  const unique = Array.from(new Set((labels || []).filter(Boolean)));
  if (unique.length === 0) return "OKX Wallet, TokenPocket Wallet, MetaMask, or Base Account";
  if (unique.length === 1) return unique[0];
  if (unique.length === 2) return `${unique[0]} or ${unique[1]}`;
  return `${unique.slice(0, -1).join(", ")}, or ${unique[unique.length - 1]}`;
}

function getVisual(args: {
  routeKind: SweepRouteKind;
  recommendedWalletLabel?: string | null;
  walletName?: string | null;
  walletKey?: DustSweepWalletKey;
  delegation?: DelegateIdentity;
  atomicStatus?: DustSweepAtomicStatus | string;
  supportedWalletLabels?: string[];
}): RouteStatusVisual {
  const walletName = args.walletName || "This wallet";
  const walletKey = args.walletKey || "unknown";
  const delegation = args.delegation;
  const showApprovalSafeMode =
    args.walletKey === "metamask" &&
    !isDustSweepApprovalBatchingEnabled(args.walletKey);
  const isOwnKnownDelegate =
    delegation?.state === "known" &&
    isSameEip7702WalletFamily(delegation.wallet, walletKey);
  const isKnownForeignDelegate =
    delegation?.state === "known" && !isOwnKnownDelegate;
  const noDelegate = !delegation || delegation.state === "none";
  const supportedWallets = joinWalletLabels(args.supportedWalletLabels);
  const statusItems = [
    `Connected: ${walletName}`,
    formatDelegationStatus(delegation),
    formatAtomicStatus(args.atomicStatus),
  ];

  if (args.routeKind === "batch") {
    if (showApprovalSafeMode) {
      return {
        icon: <BoltIcon />,
        title: "MetaMask approval-safe mode",
        subtext: "Approve tokens one by one; DustSweep sends the sweep as one transaction.",
        why: "DustSweep is configured to avoid batching ERC20 approvals in MetaMask so MetaMask's security review is easier to understand. Other supported wallets can still use approval batching.",
        statusItems: [...statusItems, "Approval batch off"],
        container:
          "border-emerald-200 bg-emerald-50 dark:border-emerald-400/20 dark:bg-emerald-400/10",
        text: "text-emerald-700 dark:text-emerald-300",
        whyButton:
          "text-emerald-700/80 hover:text-emerald-800 dark:text-emerald-300/80 dark:hover:text-emerald-200",
      };
    }

    const title = isOwnKnownDelegate
      ? `${delegation.label} one-click ready`
      : noDelegate && args.atomicStatus === "ready"
        ? `Ready to set up ${walletName}`
        : "One-click batch ready";
    const subtext = isOwnKnownDelegate
      ? "This address is already delegated to the connected wallet."
      : noDelegate && args.atomicStatus === "ready"
        ? "Your wallet can enable its official EIP-7702 setup during the sweep."
        : "Approve tokens and sweep with the connected wallet path.";
    const why = isOwnKnownDelegate
      ? `DustSweep read this address on Base and found the delegate belongs to ${delegation.label}, the wallet you are using now. This is the safest one-click route.`
      : noDelegate && args.atomicStatus === "ready"
        ? `${walletName} reports that it can enable atomic batching through its official wallet prompt. DustSweep does not write a delegation itself; the wallet handles that approval.`
        : "Your wallet can bundle the token approvals and sweep path for this account, so DustSweep can use the one-click route.";

    return {
      icon: <BoltIcon />,
      title,
      subtext,
      why,
      statusItems,
      container:
        "border-emerald-200 bg-emerald-50 dark:border-emerald-400/20 dark:bg-emerald-400/10",
      text: "text-emerald-700 dark:text-emerald-300",
      whyButton:
        "text-emerald-700/80 hover:text-emerald-800 dark:text-emerald-300/80 dark:hover:text-emerald-200",
    };
  }

  if (args.routeKind === "switch_or_permit2") {
    const wallet = args.recommendedWalletLabel || "another wallet";
    return {
      icon: <SwitchIcon />,
      title: `Set up with ${wallet}`,
      subtext: "Switch for one-click, or continue with a quick signature.",
      why: `Your wallet address was upgraded for batch transactions by ${wallet}. Only one wallet can manage that at a time, so other wallets sweep with a signature instead. Nothing is wrong with your funds.`,
      statusItems,
      container:
        "border-blue-200 bg-blue-50 dark:border-blue-400/20 dark:bg-blue-400/10",
      text: "text-blue-700 dark:text-blue-300",
      whyButton:
        "text-blue-700/80 hover:text-blue-800 dark:text-blue-300/80 dark:hover:text-blue-200",
    };
  }

  if (delegation?.state === "unknown") {
    return {
      icon: <PenIcon />,
      title: "Delegated smart account detected",
      subtext: `One-click is unavailable in ${walletName}; Sign & Sweep will still work.`,
      why: "This address is delegated on Base, but the delegate is not in DustSweep's wallet registry yet. To avoid sending a batch through the wrong wallet, DustSweep uses the fallback path.",
      statusItems,
      container:
        "border-blue-200 bg-blue-50 dark:border-blue-400/20 dark:bg-blue-400/10",
      text: "text-blue-700 dark:text-blue-300",
      whyButton:
        "text-blue-700/80 hover:text-blue-800 dark:text-blue-300/80 dark:hover:text-blue-200",
    };
  }

  if (isOwnKnownDelegate) {
    return {
      icon: <PenIcon />,
      title: `${delegation.label} setup detected`,
      subtext: "The wallet did not report batch readiness, so DustSweep will use Sign & Sweep.",
      why: `The Base delegation matches ${delegation.label}, but the connected provider did not confirm atomic batching. DustSweep keeps the account safe by falling back to a signature plus a normal sweep transaction.`,
      statusItems,
      container:
        "border-blue-200 bg-blue-50 dark:border-blue-400/20 dark:bg-blue-400/10",
      text: "text-blue-700 dark:text-blue-300",
      whyButton:
        "text-blue-700/80 hover:text-blue-800 dark:text-blue-300/80 dark:hover:text-blue-200",
    };
  }

  if (isKnownForeignDelegate) {
    return {
      icon: <PenIcon />,
      title: `${delegation.label} setup detected`,
      subtext: `${walletName} will use Sign & Sweep here.`,
      why: `This address is delegated on Base to ${delegation.label}. DustSweep only recommends switching when that wallet has verified dApp-triggered one-click support; otherwise Sign & Sweep is the reliable path.`,
      statusItems,
      container:
        "border-blue-200 bg-blue-50 dark:border-blue-400/20 dark:bg-blue-400/10",
      text: "text-blue-700 dark:text-blue-300",
      whyButton:
        "text-blue-700/80 hover:text-blue-800 dark:text-blue-300/80 dark:hover:text-blue-200",
    };
  }

  if (
    walletKey === "bitget" &&
    noDelegate &&
    (args.atomicStatus === "unsupported" || args.atomicStatus === "unknown")
  ) {
    return {
      icon: <PenIcon />,
      title: "Bind Bitget EIP-7702 in wallet",
      subtext: "Bitget requires manual EIP-7702 binding before one-click. Continue here with Sign & Sweep.",
      why: "Bitget's public docs describe binding inside the wallet app: open Bitget Wallet, go to More, choose EIP-7702, then tap Bind. DustSweep will not try an undocumented setup request.",
      statusItems,
      container:
        "border-blue-200 bg-blue-50 dark:border-blue-400/20 dark:bg-blue-400/10",
      text: "text-blue-700 dark:text-blue-300",
      whyButton:
        "text-blue-700/80 hover:text-blue-800 dark:text-blue-300/80 dark:hover:text-blue-200",
    };
  }

  if (
    walletKey === "rainbow" &&
    noDelegate &&
    (args.atomicStatus === "unsupported" || args.atomicStatus === "unknown")
  ) {
    return {
      icon: <PenIcon />,
      title: "Rainbow one-click not available",
      subtext: "Rainbow did not report Base atomic batching. Continue here with Sign & Sweep.",
      why: "DustSweep has Rainbow's known 7702 delegate saved for labeling already-delegated accounts, but this Rainbow connection did not report EIP-5792/EIP-7702 atomic readiness for Base. DustSweep will not send an undocumented upgrade request.",
      statusItems,
      container:
        "border-blue-200 bg-blue-50 dark:border-blue-400/20 dark:bg-blue-400/10",
      text: "text-blue-700 dark:text-blue-300",
      whyButton:
        "text-blue-700/80 hover:text-blue-800 dark:text-blue-300/80 dark:hover:text-blue-200",
    };
  }

  if (
    walletKey === "trust" &&
    noDelegate &&
    (args.atomicStatus === "unsupported" || args.atomicStatus === "unknown")
  ) {
    return {
      icon: <PenIcon />,
      title: "Trust Wallet one-click not available",
      subtext: "Trust Wallet did not report Base atomic batching. Continue here with Sign & Sweep.",
      why: "DustSweep has Trust Wallet's known 7702 delegate saved for labeling already-delegated accounts, but Trust's public dApp docs do not expose EIP-5792 wallet_sendCalls or wallet_getCapabilities setup for Base. DustSweep will not send an undocumented upgrade request.",
      statusItems,
      container:
        "border-blue-200 bg-blue-50 dark:border-blue-400/20 dark:bg-blue-400/10",
      text: "text-blue-700 dark:text-blue-300",
      whyButton:
        "text-blue-700/80 hover:text-blue-800 dark:text-blue-300/80 dark:hover:text-blue-200",
    };
  }

  if (noDelegate && (args.atomicStatus === "unsupported" || args.atomicStatus === "unknown")) {
    return {
      icon: <PenIcon />,
      title: `${walletName} cannot one-click sweep`,
      subtext: "This address is not delegated on Base. Continue here, or connect a one-click wallet.",
      why: `${walletName} did not report EIP-5792/EIP-7702 atomic batching for Base. For one-click sweep, use ${supportedWallets}. You can still sweep safely here with Sign & Sweep.`,
      statusItems,
      container:
        "border-blue-200 bg-blue-50 dark:border-blue-400/20 dark:bg-blue-400/10",
      text: "text-blue-700 dark:text-blue-300",
      whyButton:
        "text-blue-700/80 hover:text-blue-800 dark:text-blue-300/80 dark:hover:text-blue-200",
    };
  }

  return {
    icon: <PenIcon />,
    title: "Sign & Sweep mode",
    subtext: "Sign once, then one transaction.",
    why: "One-click batching isn't available on this wallet connection, so DustSweep sweeps with a single signature plus one transaction. This works on any wallet, whatever your account is set up with.",
    statusItems,
    container:
      "border-blue-200 bg-blue-50 dark:border-blue-400/20 dark:bg-blue-400/10",
    text: "text-blue-700 dark:text-blue-300",
    whyButton:
      "text-blue-700/80 hover:text-blue-800 dark:text-blue-300/80 dark:hover:text-blue-200",
  };
}

/**
 * Compact, props-driven route status chip with an optional "Why?" disclosure.
 * Renders the 2.2 detecting skeleton, 2.3 batch chip, 2.5 Permit2 chip, and the
 * 2.4 "Set up with {wallet}" chip. Never blocks; it only informs.
 */
export function WalletRouteStatus({
  routeKind,
  isDetecting,
  recommendedWalletLabel,
  permit2SetupCount = 0,
  delegateAddress,
  atomicStatus,
  walletName,
  walletKey,
  delegation,
  supportedWalletLabels,
}: {
  routeKind: SweepRouteKind;
  isDetecting: boolean;
  recommendedWalletLabel?: string | null;
  permit2SetupCount?: number;
  delegateAddress?: string | null;
  atomicStatus?: DustSweepAtomicStatus;
  walletName?: string | null;
  walletKey?: DustSweepWalletKey;
  delegation?: DelegateIdentity;
  supportedWalletLabels?: string[];
}) {
  const [showWhy, setShowWhy] = useState(false);
  // The raw delegate address is a diagnostic, not user-facing copy. Hide it from
  // normal users; only surface it when seeding the catalog (env flag or ?debug
  // in the URL). Resolved after mount to avoid an SSR/hydration mismatch.
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  useEffect(() => {
    try {
      const enabled =
        process.env.NEXT_PUBLIC_DUST_SWEEP_DEBUG === "1" ||
        new URLSearchParams(window.location.search).has("debug");
      setShowDiagnostics(enabled);
    } catch {
      setShowDiagnostics(false);
    }
  }, []);

  if (isDetecting) {
    return (
      <div
        aria-live="polite"
        className="flex items-center gap-2.5 rounded-[16px] border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-600 shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-300"
      >
        <Spinner />
        Checking your wallet…
      </div>
    );
  }

  const visual = getVisual({
    routeKind,
    recommendedWalletLabel,
    walletName,
    walletKey,
    delegation,
    atomicStatus,
    supportedWalletLabels,
  });
  const showSetupHint = routeKind === "permit2" && permit2SetupCount > 0;

  return (
    <div className="space-y-2" aria-live="polite">
      <div
        className={cx(
          "rounded-[16px] border px-4 py-3 shadow-[0_1px_2px_rgba(16,24,40,0.04)]",
          visual.container,
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <p className={cx("flex items-center gap-2.5 text-sm font-bold", visual.text)}>
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-white/70 dark:bg-white/10">
              {visual.icon}
            </span>
            {visual.title}
          </p>
          <button
            type="button"
            onClick={() => setShowWhy((value) => !value)}
            aria-expanded={showWhy}
            className={cx(
              "flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold transition-colors",
              visual.whyButton,
            )}
          >
            <span aria-hidden="true">ⓘ</span> Why?
          </button>
        </div>
        <p className={cx("mt-1.5 pl-[38px] text-xs leading-5 opacity-80", visual.text)}>
          {visual.subtext}
        </p>
        <div className="mt-2.5 flex flex-wrap gap-1.5 pl-[38px]">
          {visual.statusItems.map((item) => (
            <span
              key={item}
              className={cx(
                "rounded-full border border-current/15 bg-white/50 px-2.5 py-0.5 text-[10.5px] font-semibold leading-4 opacity-80 dark:bg-white/5",
                visual.text,
              )}
            >
              {item}
            </span>
          ))}
        </div>
        {showWhy ? (
          <div className={cx("mt-2 space-y-1 border-t border-current/10 pt-2", visual.text)}>
            <p className="text-xs leading-5 opacity-90">{visual.why}</p>
            {showDiagnostics && delegateAddress ? (
              <p className="break-all font-mono text-[10px] leading-4 opacity-70">
                Delegated to: {delegateAddress}
                {atomicStatus ? ` · batch: ${atomicStatus}` : ""}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {showSetupHint ? (
        <div className="rounded-[14px] border border-slate-200 bg-white px-4 py-3 text-xs leading-5 text-slate-600 shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-300">
          <p className="font-semibold text-slate-700 dark:text-slate-200">
            🔧 One-time setup for {permit2SetupCount} token
            {permit2SetupCount === 1 ? "" : "s"}
          </p>
          <p className="mt-0.5">
            A quick reusable approval each — you won&apos;t do this again for these
            tokens, anywhere.
          </p>
        </div>
      ) : null}
    </div>
  );
}
