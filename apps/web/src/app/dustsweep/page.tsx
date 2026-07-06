"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { type WalletListEntry } from "@privy-io/react-auth";
import {
  buildOkxInAppBrowserLink,
  buildTokenPocketInAppBrowserLink,
  shouldOfferOkxAppDeepLink,
  shouldOfferTokenPocketAppDeepLink,
} from "@/lib/ethereumProviders";
import { getOneClickSweepWalletLabels } from "@/lib/eip7702";
import { isDustSweepApprovalBatchingEnabled } from "@/lib/dustsweep-feature-flags";
import { WalletConnectButton } from "@/components/wallet/WalletConnectButton";
import { RouteDisplay } from "@/components/sweep/RouteDisplay";
import { SlippageSettings } from "@/components/sweep/SlippageSettings";
import { SweepButton } from "@/components/sweep/SweepButton";
import { SweepDetails } from "@/components/sweep/SweepDetails";
import { SweepGuideModal } from "@/components/sweep/SweepGuideModal";
import { SweepStepper } from "@/components/sweep/SweepStepper";
import { SweepSuccessModal } from "@/components/sweep/SweepSuccessModal";
import { SwitchOrContinueCard } from "@/components/sweep/SwitchOrContinueCard";
import { TokenFromPanel } from "@/components/sweep/TokenFromPanel";
import { TokenSelectModal } from "@/components/sweep/TokenSelectModal";
import { TokenToPanel } from "@/components/sweep/TokenToPanel";
import { UnavailablePanel } from "@/components/sweep/UnavailablePanel";
import { WalletGateNotice } from "@/components/sweep/WalletGateModal";
import { WalletRouteStatus } from "@/components/sweep/WalletRouteStatus";
import { useDustSweep } from "@/hooks/useDustSweep";
import {
  BASE_CHAIN_ID,
  getEnabledSweepChains,
  getGasWarnRatio,
} from "@/config/sweepChainConfig";
import {
  DUST_SWEEP_PRIVY_WALLET_LIST,
  useWalletConnection,
} from "@/hooks/useWalletConnection";
import {
  type DustSweepWalletKey,
  type SweepButtonVisualState,
  type SweepRouteKind,
} from "@/types/dustsweep";

// Maps our internal wallet key to the Privy modal entry so Route B can
// prioritize the matched wallet when the user chooses "Switch to {wallet}".
const WALLET_KEY_TO_PRIVY: Partial<Record<DustSweepWalletKey, WalletListEntry>> = {
  okx: "okx_wallet",
  tokenpocket: "detected_ethereum_wallets",
  metamask: "metamask",
  coinbase: "coinbase_wallet",
  base_account: "base_account",
  rainbow: "rainbow",
  phantom: "phantom",
  zerion: "zerion",
  bitget: "bitget_wallet",
  safe: "safe",
  uniswap: "uniswap",
  cryptocom: "cryptocom",
};

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function shortAddress(address: string) {
  return `${address.slice(0, 4)}...${address.slice(-6)}`;
}

function BlueAlertIcon() {
  return (
    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[12px] font-bold text-white">
      !
    </span>
  );
}

function MergeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-[18px] w-[18px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 5v14M6 13l6 6 6-6" />
    </svg>
  );
}

function getSweepButtonState(args: {
  selectedCount: number;
  hasTokenOut: boolean;
  quoteReady: boolean;
  isLoading: boolean;
  isQuoting: boolean;
  hasQuoteError: boolean;
  sweepStep: ReturnType<typeof useDustSweep>["sweepStep"];
  routeKind: SweepRouteKind;
}): SweepButtonVisualState {
  if (args.sweepStep === "success") return { state: "success", label: "Swept! View on Basescan" };
  if (args.sweepStep === "error") return { state: "error", label: "Try again" };
  if (args.sweepStep === "approving") {
    return args.routeKind === "batch"
      ? { state: "approving", label: "Approve tokens..." }
      : { state: "setup", label: "Approve setup..." };
  }
  if (args.sweepStep === "signing") return { state: "signing", label: "Sign in wallet..." };
  if (args.sweepStep === "pending") return { state: "pending", label: "Sweeping..." };
  if (args.isLoading && args.selectedCount === 0) return { state: "loading", label: "Finding balances..." };
  if (args.selectedCount === 0) return { state: "disabled", label: "Select tokens" };
  if (!args.hasTokenOut) return { state: "disabled", label: "Select output token" };
  if (args.isQuoting) return { state: "loading", label: "Finding route..." };
  if (args.quoteReady) return { state: "ready", label: "Sweep" };
  if (args.hasQuoteError) return { state: "disabled", label: "No route available" };
  return { state: "loading", label: "Finding route..." };
}

/* ─── Main sweep view ───────────────────────────────────────────────── */
function CheckMiniIcon({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

// Three discovery phases that map to the real scan timers in useTokenBalances
// (balances → prices → routes). The active phase is derived from elapsed time,
// so each step advances because the backend actually moved on — not theatre.
function ScanPhaseStepper({ stage }: { stage: number }) {
  const phases = ["Balances", "Pricing", "Routes"];
  return (
    <div className="flex items-center gap-1.5">
      {phases.map((label, index) => {
        const done = index < stage;
        const active = index === stage;
        return (
          <div key={label} className="flex flex-1 items-center gap-1.5">
            <span
              className={cx(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold transition-colors",
                done
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-400/10 dark:text-emerald-300"
                  : active
                    ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-400/25 dark:bg-blue-400/10 dark:text-blue-300"
                    : "border-slate-200 bg-slate-50 text-slate-400 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-500",
              )}
            >
              {done ? (
                <CheckMiniIcon className="h-2.5 w-2.5" />
              ) : active ? (
                <span className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
              )}
              {label}
            </span>
            {index < phases.length - 1 ? (
              <span className={cx("h-px flex-1", done ? "bg-emerald-200 dark:bg-emerald-400/20" : "bg-slate-200 dark:bg-white/10")} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function BalanceScanStatus({
  isLoading,
  message,
  discoveredCount,
  elapsedMs,
  sweepableCount,
}: {
  isLoading: boolean;
  message: string;
  discoveredCount: number;
  elapsedMs?: number;
  sweepableCount: number;
}) {
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [showDone, setShowDone] = useState(false);
  const startRef = useRef<number | null>(null);
  const wasLoadingRef = useRef(false);

  useEffect(() => {
    if (isLoading) {
      setShowDone(false);
      startRef.current = Date.now();
      wasLoadingRef.current = true;
      const tick = () => {
        const seconds = (Date.now() - (startRef.current ?? Date.now())) / 1000;
        setElapsed(seconds);
        // Time-estimated trickle: eases toward 92%, snaps to 100% on completion.
        setProgress(Math.min(92, 92 * (1 - Math.exp(-seconds / 4.5))));
      };
      tick();
      const interval = window.setInterval(tick, 120);
      return () => window.clearInterval(interval);
    }
    if (wasLoadingRef.current) {
      wasLoadingRef.current = false;
      startRef.current = null;
      setProgress(100);
      setShowDone(true);
      const timer = window.setTimeout(() => setShowDone(false), 2400);
      return () => window.clearTimeout(timer);
    }
    return;
  }, [isLoading]);

  if (!isLoading) {
    if (!showDone || (discoveredCount <= 0 && sweepableCount <= 0)) return null;
    return (
      <div className="flex items-center justify-between gap-3 rounded-[16px] border border-emerald-200 bg-emerald-50 px-4 py-3 shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:border-emerald-400/20 dark:bg-emerald-400/10">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-emerald-500 text-white">
            <CheckMiniIcon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-bold text-emerald-800 dark:text-emerald-200">Scan complete</p>
            <p className="truncate text-xs text-emerald-700 dark:text-emerald-300">
              {discoveredCount} balance{discoveredCount === 1 ? "" : "s"} scanned
              {sweepableCount > 0 ? ` · ${sweepableCount} sweepable` : ""}
            </p>
          </div>
        </div>
        {elapsedMs ? (
          <span className="shrink-0 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
            {(elapsedMs / 1000).toFixed(1)}s
          </span>
        ) : null}
      </div>
    );
  }

  const stage = elapsed < 3.5 ? 0 : elapsed < 8 ? 1 : 2;
  const seconds = Math.max(1, Math.round(elapsed));

  return (
    <div className="rounded-[16px] border border-blue-100 bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:border-blue-400/20 dark:bg-white/[0.04]">
      <div className="flex items-center gap-3">
        <span className="sweep-radar flex h-10 w-10 shrink-0 items-center justify-center">
          <span className="relative z-[1] h-1.5 w-1.5 rounded-full bg-[#0052ff] dark:bg-blue-300" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <p className="truncate text-sm font-bold text-slate-900 dark:text-white">Scanning your wallet</p>
            <span className="shrink-0 text-xs font-bold tabular-nums text-[#0052ff] dark:text-blue-300">
              {Math.round(progress)}%
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{message}</p>
        </div>
      </div>

      <div className="mt-3">
        <ScanPhaseStepper stage={stage} />
      </div>

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-blue-100 dark:bg-white/10">
        <div
          className="sweep-bar-shimmer h-full rounded-full bg-gradient-to-r from-blue-600 to-[#0052ff] transition-[width] duration-200 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        {elapsed > 6
          ? "Large wallets take a few seconds — your funds aren't touched while we scan."
          : `Checking balances, prices, and routes · ${seconds}s`}
      </p>
    </div>
  );
}

export default function DustSweepPage() {
  const { address, isConnected } = useAccount();
  // Active sweep chain. Persisted per-session; defaults to Base. The selector below is only
  // rendered when more than one chain is enabled, so with the flag off the page is unchanged.
  const enabledSweepChains = useMemo(() => getEnabledSweepChains(), []);
  const [sweepChainId, setSweepChainId] = useState<number>(() => {
    if (typeof window === "undefined") return BASE_CHAIN_ID;
    const stored = Number(window.sessionStorage.getItem("dustsweep:chainId"));
    return enabledSweepChains.some((chain) => chain.id === stored) ? stored : BASE_CHAIN_ID;
  });
  const sweep = useDustSweep({ chainId: sweepChainId });
  const walletConnection = useWalletConnection();
  const showChainSelector = enabledSweepChains.length > 1;
  useEffect(() => {
    try {
      window.sessionStorage.setItem("dustsweep:chainId", String(sweepChainId));
    } catch {
      // sessionStorage may be unavailable (private mode) — non-fatal.
    }
  }, [sweepChainId]);
  const [tokenModalMode, setTokenModalMode] = useState<"multi" | "single" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [routeBContinued, setRouteBContinued] = useState(false);
  // Price-impact UI (row, banners, confirm gate) is parked for now — the server still computes
  // impact and uses it for aggregator rescue routing. Revisit later.

  // Internal diagnostics (the wallet route-status card + batch notice) are hidden
  // from the public. Append ?dev (or ?=dev) to the URL to reveal them. Resolved
  // after mount so the default production render never includes these blocks.
  const [isDevView, setIsDevView] = useState(false);
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      setIsDevView(params.has("dev") || Array.from(params.values()).includes("dev"));
    } catch {
      setIsDevView(false);
    }
  }, []);

  // Persist the user's "continue with current wallet" choice per address for the
  // session so Route B never nags on every quote refresh (2.4).
  useEffect(() => {
    if (!address) {
      setRouteBContinued(false);
      return;
    }
    try {
      setRouteBContinued(
        sessionStorage.getItem(`dustsweep:routeb-continue:${address.toLowerCase()}`) === "1",
      );
    } catch {
      setRouteBContinued(false);
    }
  }, [address]);

  const handleContinueWithCurrent = () => {
    if (address) {
      try {
        sessionStorage.setItem(`dustsweep:routeb-continue:${address.toLowerCase()}`, "1");
      } catch {
        // sessionStorage may be unavailable (private mode); the in-memory flag still applies.
      }
    }
    setRouteBContinued(true);
  };

  const handleSwitchWallet = async () => {
    const key = sweep.recommendedWallet?.key;
    // On a plain mobile browser, route OKX through its in-app browser deep link
    // (native injected connect) rather than the flaky WalletConnect relay.
    if (key === "okx" && shouldOfferOkxAppDeepLink()) {
      window.location.href = buildOkxInAppBrowserLink();
      return;
    }
    if (key === "tokenpocket" && shouldOfferTokenPocketAppDeepLink()) {
      window.location.href = buildTokenPocketInAppBrowserLink();
      return;
    }
    try {
      await walletConnection.disconnectWallet();
    } catch {
      // Ignore — reopening the modal lets the user pick a wallet regardless.
    }
    const entry = key ? WALLET_KEY_TO_PRIVY[key] : undefined;
    const list: WalletListEntry[] = entry
      ? [entry, ...DUST_SWEEP_PRIVY_WALLET_LIST.filter((wallet) => wallet !== entry)]
      : DUST_SWEEP_PRIVY_WALLET_LIST;
    await walletConnection.openWalletModal(
      sweep.recommendedWallet
        ? `Connect ${sweep.recommendedWallet.label} for one-click batching.`
        : "Connect a wallet to sweep.",
      list,
    );
  };

  const tokenOutBalanceUSD = useMemo(() => {
    if (!sweep.tokenOut) return 0;
    const token = [...sweep.outputTokens, ...sweep.swappableTokens].find(
      (item) => item.address.toLowerCase() === sweep.tokenOut?.address.toLowerCase(),
    );
    return token?.valueUSD ?? 0;
  }, [sweep.outputTokens, sweep.swappableTokens, sweep.tokenOut]);

  const baseButtonState = getSweepButtonState({
    selectedCount: sweep.selectedTokens.length,
    hasTokenOut: Boolean(sweep.tokenOut),
    // A WETH→ETH unwrap-only quote has zero router routes but is still sweepable.
    quoteReady: Boolean(
      sweep.quote && (sweep.quote.routes.length > 0 || sweep.quote.wethUnwrap),
    ),
    isLoading: sweep.isLoading,
    isQuoting: sweep.isQuoting,
    hasQuoteError: Boolean(sweep.quoteError),
    sweepStep: sweep.sweepStep,
    routeKind: sweep.routeKind,
  });

  const buttonState: SweepButtonVisualState = baseButtonState;
  const walletModeNotice =
    sweep.executionNotice ||
    (isDevView && sweep.batchMode && sweep.selectedTokens.length > 0
      ? sweep.walletProfile.batchNotice
      : null);

  // Truly-blocked = the wallet can't sign typed data at all (no Permit2, no
  // batch). This is the only remaining hard-stop; everything else has a route.
  const hasConnectedWallet = Boolean(isConnected && address);
  const isTrulyBlocked =
    hasConnectedWallet && !sweep.walletStatus.isChecking && !sweep.walletStatus.isSupported;

  // Route B card shows only while delegated-elsewhere AND the user hasn't opted
  // to continue on the current wallet for this session.
  const showSwitchCard =
    hasConnectedWallet &&
    !isTrulyBlocked &&
    sweep.routeKind === "switch_or_permit2" &&
    !routeBContinued &&
    Boolean(sweep.recommendedWallet);

  // The chip reflects the path the user will actually take: once they continue
  // past Route B, surface the Permit2 (Sign & Sweep) status instead.
  const chipRouteKind: SweepRouteKind =
    sweep.routeKind === "switch_or_permit2" && routeBContinued
      ? "permit2"
      : sweep.routeKind;

  const isExecuting =
    sweep.sweepStep === "approving" ||
    sweep.sweepStep === "signing" ||
    sweep.sweepStep === "pending" ||
    sweep.sweepStep === "success";
  const usesStandardMetaMaskApprovals =
    sweep.routeKind === "batch" &&
    sweep.walletProfile.walletKey === "metamask" &&
    !isDustSweepApprovalBatchingEnabled(sweep.walletProfile.walletKey);

  return (
    <div className="theme-page relative flex min-h-screen flex-col bg-gradient-to-b from-blue-50 via-white to-slate-50 px-3 py-5 sm:px-6 sm:py-8">
      {/* Ambient brand glow — subtle depth behind the centered widget */}
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute left-1/2 top-[16%] h-[480px] w-[480px] -translate-x-1/2 rounded-full bg-[#0052ff]/[0.07] blur-[130px] dark:bg-[#3b82f6]/[0.10]" />
      </div>

      <SweepGuideModal />

      <TokenSelectModal
        isOpen={tokenModalMode !== null}
        mode={tokenModalMode || "multi"}
        title={tokenModalMode === "single" ? "Select a token" : "Select tokens"}
        swappableTokens={sweep.swappableTokens}
        unavailableTokens={sweep.unavailableTokens}
        selectedTokens={sweep.selectedTokens}
        outputTokens={sweep.outputTokens}
        selectedOutputToken={sweep.tokenOut}
        discoveredCount={sweep.balanceScan.discoveredCount}
        isScanning={sweep.isLoading}
        onSelectToken={sweep.addToken}
        onRemoveToken={sweep.removeToken}
        onSelectOutputToken={sweep.setTokenOut}
        onSelectAll={sweep.selectAllTokens}
        onClose={() => setTokenModalMode(null)}
        routeMaxCap={sweep.routeMaxCap}
      />

      <SlippageSettings
        isOpen={settingsOpen}
        slippageBps={sweep.slippageBps}
        onChange={sweep.setSlippageBps}
        batchMode={sweep.batchMode}
        onBatchModeChange={sweep.setBatchMode}
        smartRouting={sweep.smartRouting}
        onSmartRoutingChange={sweep.setSmartRouting}
        autoSelectionUsd={sweep.autoSelectionUsd}
        onAutoSelectionUsdChange={sweep.setAutoSelectionUsd}
        removeFailedTokens={sweep.removeFailedTokens}
        onRemoveFailedTokensChange={sweep.setRemoveFailedTokens}
        onClose={() => setSettingsOpen(false)}
      />

      <SweepSuccessModal
        summary={sweep.completionSummary}
        onClose={sweep.dismissCompletionSummary}
      />

      <div className="relative z-10 mx-auto flex w-full max-w-[600px] flex-1 flex-col pb-[calc(69px+var(--safe-area-bottom))] sm:pb-8">
        {/* ── Header ── */}
        <div className="mb-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Image
              src="/logo.png"
              alt="DustSwap"
              width={40}
              height={40}
              priority
              className="rounded-[13px] shadow-[0_8px_18px_-6px_rgba(37,99,235,0.45)]"
            />
            <span className="text-[22px] font-bold tracking-[-0.02em] text-slate-900 dark:text-white">
              Sweep
            </span>
          </div>
          <WalletConnectButton
            connectedLabel={address ? shortAddress(address) : undefined}
            walletList={DUST_SWEEP_PRIVY_WALLET_LIST}
            showDisconnect
            className="rounded-full border-slate-200/80 bg-white/80 px-3.5 py-2 text-[13px] font-semibold text-slate-700 shadow-[0_1px_2px_rgba(16,24,40,0.05)] backdrop-blur hover:border-slate-300 hover:bg-white dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-200 dark:hover:bg-white/10"
          />
        </div>

        {/* ── Main card ── */}
        <div className="my-auto w-full space-y-3">
          {/* Delegation-aware route status — decided at connect, shown early. */}
          {hasConnectedWallet ? (
            isTrulyBlocked ? (
              <WalletGateNotice
                walletName={sweep.walletStatus.walletName}
                reason={sweep.walletStatus.reason}
                onSwitchWallet={() => void handleSwitchWallet()}
              />
            ) : isDevView ? (
              <WalletRouteStatus
                routeKind={chipRouteKind}
                isDetecting={sweep.isDetectingRoute}
                recommendedWalletLabel={sweep.recommendedWallet?.label}
                permit2SetupCount={sweep.permit2SetupCount}
                delegateAddress={sweep.delegation.address}
                atomicStatus={sweep.walletProfile.atomicStatus}
                walletName={sweep.walletProfile.walletName}
                walletKey={sweep.walletProfile.walletKey}
                delegation={sweep.delegation.info}
                supportedWalletLabels={getOneClickSweepWalletLabels()}
              />
            ) : null
          ) : null}

          <BalanceScanStatus
            isLoading={sweep.isLoading}
            message={sweep.balanceScan.message}
            discoveredCount={sweep.balanceScan.discoveredCount}
            elapsedMs={sweep.balanceScan.elapsedMs}
            sweepableCount={sweep.swappableTokens.length}
          />

          {/* Chain selector — only shown when more than one sweep chain is enabled. */}
          {showChainSelector ? (
            <div className="mb-2 flex items-center gap-2">
              <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">Network</span>
              <div className="flex gap-1 rounded-[12px] bg-gray-100 p-1 dark:bg-white/5">
                {enabledSweepChains.map((chainOption) => {
                  const active = chainOption.id === sweepChainId;
                  return (
                    <button
                      key={chainOption.id}
                      type="button"
                      onClick={() => setSweepChainId(chainOption.id)}
                      disabled={sweep.isSweeping}
                      className={
                        active
                          ? "rounded-[9px] bg-white px-3 py-1 text-sm font-bold text-[#0052ff] shadow-sm dark:bg-white/15 dark:text-blue-300"
                          : "rounded-[9px] px-3 py-1 text-sm font-semibold text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                      }
                    >
                      {chainOption.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* Unified trade card: From → merge → To → receiver */}
          <div className="sweep-card space-y-1.5 p-2.5">
            <TokenFromPanel
              selectedTokens={sweep.selectedTokens}
              onRemove={sweep.removeToken}
              onClearAll={sweep.clearSelectedTokens}
              onAddMore={() => setTokenModalMode("multi")}
              autoMode={sweep.autoMode}
              onToggleAuto={() => sweep.setAutoMode(!sweep.autoMode)}
              onOpenSettings={() => setSettingsOpen(true)}
              routeMaxCap={sweep.routeMaxCap}
              failedTokenAddresses={sweep.quoteFailedTokenAddresses}
            />

            <div className="relative z-10 -my-3.5 flex justify-center" aria-hidden="true">
              <span className="sweep-merge flex h-9 w-9 items-center justify-center rounded-[12px]">
                <MergeIcon />
              </span>
            </div>

            <TokenToPanel
              tokenOut={sweep.tokenOut}
              quote={sweep.quote}
              balanceUSD={tokenOutBalanceUSD}
              onOpenSelect={() => setTokenModalMode("single")}
            />

            {/* Receiver address */}
            <div className="flex items-center justify-between border-t border-slate-100/80 px-2 pb-1 pt-3 dark:border-white/5">
              <span className="text-[12.5px] text-slate-400 dark:text-slate-500">Receiver</span>
              <span className="inline-flex items-center gap-1.5 font-mono text-[12.5px] font-semibold tabular-nums text-slate-600 dark:text-slate-300">
                {address ? shortAddress(address) : "—"}
              </span>
            </div>
          </div>

          {/* Quote/sweep errors */}
          {sweep.quoteError ? (
            <div className="flex items-center justify-between gap-3 rounded-[14px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <span>Could not get quote.</span>
              <button
                type="button"
                onClick={() => void sweep.refreshQuote()}
                className="shrink-0 font-semibold underline underline-offset-2"
              >
                Retry
              </button>
            </div>
          ) : null}

          {sweep.error ? (
            <div className="rounded-[14px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {sweep.error}
            </div>
          ) : null}

          {/* Route section */}
          {sweep.selectedTokens.length > 0 ? (
            <div className="space-y-2">
              <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-400 dark:text-slate-500">
                Route
              </p>
              {sweep.quote ? (
                <RouteDisplay
                  quote={sweep.quote}
                  tokenOut={sweep.tokenOut}
                  selectedTokens={sweep.selectedTokens}
                />
              ) : (
                <div className="flex items-center justify-center gap-2 rounded-[16px] border border-dashed border-slate-200 bg-white py-6 text-sm text-slate-400 dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-500">
                  {sweep.isQuoting ? (
                    <>
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
                      Finding the best route...
                    </>
                  ) : (
                    "Route will appear after quote"
                  )}
                </div>
              )}
            </div>
          ) : null}

          {/* Slippage / Fee / Price Impact */}
          {sweep.quote ? (
            <div className="rounded-[16px] border border-slate-200/70 bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:border-white/10 dark:bg-white/[0.04]">
              <SweepDetails
                quote={sweep.quote}
                slippageBps={sweep.slippageBps}
                tokenOut={sweep.tokenOut}
              />
            </div>
          ) : null}

          {/* Unavailable tokens */}
          {sweep.unavailableTokens.length > 0 ? (
            <UnavailablePanel
              tokens={sweep.unavailableTokens}
              onClearAll={sweep.clearUnavailableTokens}
              onRemove={sweep.removeUnavailableToken}
            />
          ) : null}

          {/* Price-impact banners/gate parked for now (server still computes impact for
              aggregator rescue routing). Revisit later. */}

          {walletModeNotice ? (
            <div className="rounded-[14px] border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-700">
              {walletModeNotice}
            </div>
          ) : null}

          {/* Route B — calm, inline switch/continue card (never blocks). */}
          {showSwitchCard && sweep.recommendedWallet ? (
            <SwitchOrContinueCard
              walletLabel={sweep.recommendedWallet.label}
              currentWalletName={sweep.walletProfile.walletName}
              onSwitch={() => void handleSwitchWallet()}
              onContinue={handleContinueWithCurrent}
            />
          ) : null}

          {/* Honest, route-aware step indicator during execution. */}
          {isExecuting ? (
            <SweepStepper
              routeKind={sweep.routeKind === "batch" ? "batch" : "permit2"}
              sweepStep={sweep.sweepStep}
              hasSetup={sweep.permit2SetupCount > 0 || sweep.sweepStep === "approving"}
              approvalMode={usesStandardMetaMaskApprovals ? "standard" : undefined}
            />
          ) : null}

          {/* Gas-vs-basket warning — only on non-Base chains (Base gas is negligible, so this
              preserves the existing Base UX). Mainnet gas can dwarf a small dust basket. */}
          {sweep.chainId !== BASE_CHAIN_ID &&
          sweep.quote &&
          sweep.quote.gasEstimateUSD > 0 &&
          (sweep.quote.gasToBasketRatio ?? 0) >= getGasWarnRatio() ? (
            <div className="mb-2 rounded-[12px] border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-300">
              Network fee ≈ ${sweep.quote.gasEstimateUSD.toFixed(2)} (~
              {Math.round((sweep.quote.gasToBasketRatio ?? 0) * 100)}% of your basket). Gas can
              exceed the value of small dust — consider sweeping fewer, higher-value tokens.
            </div>
          ) : null}

          {/* Sweep button */}
          <SweepButton
            visualState={buttonState}
            onClick={() => {
              void sweep.executeSweep();
            }}
            txHash={sweep.txHash}
            chainId={sweep.chainId}
          />
        </div>
      </div>
    </div>
  );
}
