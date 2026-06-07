"use client";

import { useEffect, useState } from "react";
import { type SweepRouteKind } from "@/types/dustsweep";

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
  container: string;
  text: string;
  whyButton: string;
};

function getVisual(args: {
  routeKind: SweepRouteKind;
  recommendedWalletLabel?: string | null;
}): RouteStatusVisual {
  if (args.routeKind === "batch") {
    return {
      icon: <BoltIcon />,
      title: "One-click batch ready",
      subtext: "Approve up to 50 tokens + sweep in one tap.",
      why: "Your wallet can bundle every token approval and the sweep into a single atomic transaction, so you only confirm once.",
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
}: {
  routeKind: SweepRouteKind;
  isDetecting: boolean;
  recommendedWalletLabel?: string | null;
  permit2SetupCount?: number;
  delegateAddress?: string | null;
  atomicStatus?: string;
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
        className="flex items-center gap-2.5 rounded-[8px] border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 shadow-sm dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-300"
      >
        <Spinner />
        Checking your wallet…
      </div>
    );
  }

  const visual = getVisual({ routeKind, recommendedWalletLabel });
  const showSetupHint = routeKind === "permit2" && permit2SetupCount > 0;

  return (
    <div className="space-y-2" aria-live="polite">
      <div
        className={cx(
          "rounded-[8px] border px-4 py-2.5 shadow-sm",
          visual.container,
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <p className={cx("flex items-center gap-2 text-sm font-semibold", visual.text)}>
            {visual.icon}
            {visual.title}
          </p>
          <button
            type="button"
            onClick={() => setShowWhy((value) => !value)}
            aria-expanded={showWhy}
            className={cx(
              "flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium transition-colors",
              visual.whyButton,
            )}
          >
            <span aria-hidden="true">ⓘ</span> Why?
          </button>
        </div>
        <p className={cx("mt-1 text-xs leading-5 opacity-80", visual.text)}>
          {visual.subtext}
        </p>
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
        <div className="rounded-[8px] border border-slate-200 bg-white px-4 py-2.5 text-xs leading-5 text-slate-600 shadow-sm dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-300">
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
