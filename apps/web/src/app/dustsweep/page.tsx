"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
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
import { SweepStepper } from "@/components/sweep/SweepStepper";
import { SwitchOrContinueCard } from "@/components/sweep/SwitchOrContinueCard";
import { TokenFromPanel } from "@/components/sweep/TokenFromPanel";
import { TokenSelectModal } from "@/components/sweep/TokenSelectModal";
import { TokenToPanel } from "@/components/sweep/TokenToPanel";
import { UnavailablePanel } from "@/components/sweep/UnavailablePanel";
import { WalletGateNotice } from "@/components/sweep/WalletGateModal";
import { WalletRouteStatus } from "@/components/sweep/WalletRouteStatus";
import { useDustSweep } from "@/hooks/useDustSweep";
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
function BalanceScanStatus({
  isLoading,
  message,
  discoveredCount,
  elapsedMs,
}: {
  isLoading: boolean;
  message: string;
  discoveredCount: number;
  elapsedMs?: number;
}) {
  if (!isLoading) return null;

  const seconds = elapsedMs ? Math.max(1, Math.round(elapsedMs / 1000)) : null;

  return (
    <div className="rounded-[8px] border border-blue-100 bg-white px-4 py-3 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-blue-50 text-blue-600">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <p className="truncate text-sm font-semibold text-slate-900">{message}</p>
            <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
              {discoveredCount > 0 ? `${discoveredCount} found` : "Scanning"}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full w-2/5 animate-pulse rounded-full bg-blue-500" />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Checking wallet balances, token prices, and route hints{seconds ? ` for ${seconds}s` : ""}.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function DustSweepPage() {
  const { address, isConnected } = useAccount();
  const sweep = useDustSweep();
  const walletConnection = useWalletConnection();
  const [tokenModalMode, setTokenModalMode] = useState<"multi" | "single" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [routeBContinued, setRouteBContinued] = useState(false);

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

  const buttonState = getSweepButtonState({
    selectedCount: sweep.selectedTokens.length,
    hasTokenOut: Boolean(sweep.tokenOut),
    quoteReady: Boolean(sweep.quote && sweep.quote.routes.length > 0),
    isLoading: sweep.isLoading,
    isQuoting: sweep.isQuoting,
    hasQuoteError: Boolean(sweep.quoteError),
    sweepStep: sweep.sweepStep,
    routeKind: sweep.routeKind,
  });
  const walletModeNotice =
    sweep.executionNotice ||
    (sweep.batchMode && sweep.selectedTokens.length > 0 ? sweep.walletProfile.batchNotice : null);

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
  const usesStandardWalletApprovals =
    sweep.routeKind === "batch" &&
    !isDustSweepApprovalBatchingEnabled(sweep.walletProfile.walletKey);

  return (
    <div className="theme-page min-h-screen bg-gradient-to-b from-blue-50 via-white to-slate-50 px-3 py-5 sm:px-6 sm:py-8">
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

      <div className="mx-auto max-w-[600px] pb-[calc(69px+var(--safe-area-bottom))] sm:pb-8">
        {/* ── Header ── */}
        <div className="mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Image src="/logo.png" alt="DustSwap" width={44} height={44} priority className="rounded-xl" />
            <div>
              <p className="text-base font-bold text-slate-900">Sweep</p>
              <p className="text-[11px] text-slate-400">Base dust aggregator</p>
            </div>
          </div>
          <WalletConnectButton
            connectedLabel={address ? shortAddress(address) : undefined}
            walletList={DUST_SWEEP_PRIVY_WALLET_LIST}
            showDisconnect
            className="rounded-[8px] border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 shadow-sm hover:border-blue-300 hover:bg-blue-100 hover:text-blue-800"
          />
        </div>

        {/* ── Main card ── */}
        <div className="space-y-3">
          {/* Delegation-aware route status — decided at connect, shown early. */}
          {hasConnectedWallet ? (
            isTrulyBlocked ? (
              <WalletGateNotice
                walletName={sweep.walletStatus.walletName}
                reason={sweep.walletStatus.reason}
                onSwitchWallet={() => void handleSwitchWallet()}
              />
            ) : (
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
            )
          ) : null}

          <BalanceScanStatus
            isLoading={sweep.isLoading}
            message={sweep.balanceScan.message}
            discoveredCount={sweep.balanceScan.discoveredCount}
            elapsedMs={sweep.balanceScan.elapsedMs}
          />

          {/* From panel */}
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

          {/* To panel */}
          <TokenToPanel
            tokenOut={sweep.tokenOut}
            quote={sweep.quote}
            balanceUSD={tokenOutBalanceUSD}
            onOpenSelect={() => setTokenModalMode("single")}
          />

          {/* Receiver address */}
          <div className="flex items-center justify-between rounded-[8px] bg-white px-4 py-3 shadow-sm">
            <span className="text-sm font-medium text-slate-500">Receiver address:</span>
            <span className="font-mono text-xs font-semibold text-slate-700">
              {address ? shortAddress(address) : "—"}
            </span>
          </div>

          {/* Quote/sweep errors */}
          {sweep.quoteError ? (
            <div className="flex items-center justify-between gap-3 rounded-[8px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
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
            <div className="rounded-[8px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {sweep.error}
            </div>
          ) : null}

          {/* Route section */}
          {sweep.selectedTokens.length > 0 ? (
            <div className="space-y-2">
              <p className="px-1 text-xs font-semibold uppercase tracking-wider text-slate-400">Route</p>
              {sweep.quote ? (
                <RouteDisplay
                  quote={sweep.quote}
                  tokenOut={sweep.tokenOut}
                  selectedTokens={sweep.selectedTokens}
                />
              ) : (
                <div className="flex items-center justify-center gap-2 rounded-[8px] border border-dashed border-slate-200 bg-white py-6 text-sm text-slate-400">
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
            <div className="rounded-[8px] bg-white px-4 py-3 shadow-sm">
              <SweepDetails quote={sweep.quote} slippageBps={sweep.slippageBps} />
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

          {/* High price impact warning */}
          {sweep.quote?.routes.some((route) => route.priceImpactBps > 500) ? (
            <div className="flex items-start gap-2.5 rounded-[8px] border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
              <BlueAlertIcon />
              <span>High price impact detected. Review the route carefully before sweeping.</span>
            </div>
          ) : null}

          {walletModeNotice ? (
            <div className="rounded-[8px] border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-700">
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
              approvalMode={usesStandardWalletApprovals ? "standard" : undefined}
            />
          ) : null}

          {/* Sweep button */}
          <SweepButton
            visualState={buttonState}
            onClick={() => {
              void sweep.executeSweep();
            }}
            txHash={sweep.txHash}
          />
        </div>
      </div>
    </div>
  );
}
