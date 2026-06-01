"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { WalletConnectButton } from "@/components/wallet/WalletConnectButton";
import { RouteDisplay } from "@/components/sweep/RouteDisplay";
import { SlippageSettings } from "@/components/sweep/SlippageSettings";
import { SweepButton } from "@/components/sweep/SweepButton";
import { SweepDetails } from "@/components/sweep/SweepDetails";
import { TokenFromPanel } from "@/components/sweep/TokenFromPanel";
import { TokenSelectModal } from "@/components/sweep/TokenSelectModal";
import { TokenToPanel } from "@/components/sweep/TokenToPanel";
import { UnavailablePanel } from "@/components/sweep/UnavailablePanel";
import { WalletGateModal } from "@/components/sweep/WalletGateModal";
import { useDustSweep } from "@/hooks/useDustSweep";
import { DUST_SWEEP_PRIVY_WALLET_LIST } from "@/hooks/useWalletConnection";
import { type SweepButtonVisualState } from "@/types/dustsweep";

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
}): SweepButtonVisualState {
  if (args.sweepStep === "success") return { state: "success", label: "Swept! View on Basescan" };
  if (args.sweepStep === "error") return { state: "error", label: "Try again" };
  if (args.sweepStep === "approving") return { state: "approving", label: "Approve tokens..." };
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

/* ─── Unconnected landing ───────────────────────────────────────────────── */
function DisconnectedView() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 via-white to-slate-50 px-4 py-8">
      <div className="mx-auto flex min-h-[80dvh] max-w-[400px] flex-col items-center justify-center text-center">
        {/* Logo */}
        <div className="relative mb-6">
          <div className="absolute inset-0 rounded-3xl bg-blue-200/30 blur-xl" />
          <Image
            src="/logo.png"
            alt="DustSwap"
            width={88}
            height={88}
            className="relative rounded-3xl shadow-lg"
            priority
          />
        </div>

        <h1 className="text-3xl font-bold tracking-tight text-slate-900">DustSweep</h1>
        <p className="mt-1.5 text-sm font-medium text-blue-600">Base dust aggregator</p>
        <p className="mt-4 max-w-sm text-sm leading-relaxed text-slate-500">
          Connect a wallet to find small Base token balances and sweep them into one useful asset in just two transactions.
        </p>

        {/* Feature pills */}
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {["Up to 50 tokens", "EIP-712 signing", "1 approval + 1 sweep"].map((f) => (
            <span
              key={f}
              className="rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-600"
            >
              {f}
            </span>
          ))}
        </div>

        <div className="mt-8 w-full">
          <WalletConnectButton
            connectLabel="Connect Wallet"
            description="Connect your wallet to use DustSweep."
            walletList={DUST_SWEEP_PRIVY_WALLET_LIST}
            fullWidth
            className="rounded-2xl bg-blue-600 px-6 py-3 text-sm font-bold text-white shadow-[0_8px_24px_rgba(37,99,235,0.28)] hover:border-blue-600 hover:bg-blue-700 hover:text-white"
          />
        </div>
      </div>
    </div>
  );
}

/* ─── Main connected view ───────────────────────────────────────────────── */
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
  const [tokenModalMode, setTokenModalMode] = useState<"multi" | "single" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [walletGateDismissed, setWalletGateDismissed] = useState(false);

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
  });
  const walletModeNotice =
    sweep.executionNotice ||
    (sweep.batchMode && sweep.selectedTokens.length > 0 ? sweep.walletProfile.batchNotice : null);

  const shouldShowWalletGate =
    isConnected &&
    !sweep.walletStatus.isChecking &&
    !sweep.walletStatus.isSupported &&
    !walletGateDismissed;

  if (!isConnected) {
    return <DisconnectedView />;
  }

  return (
    <div className="theme-page min-h-screen bg-gradient-to-b from-blue-50 via-white to-slate-50 px-3 py-5 sm:px-6 sm:py-8">
      <WalletGateModal
        isOpen={shouldShowWalletGate}
        walletName={sweep.walletStatus.walletName}
        reason={sweep.walletStatus.reason}
        onClose={() => setWalletGateDismissed(true)}
      />

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

      <div className="mx-auto max-w-[600px] pb-[calc(82px+env(safe-area-inset-bottom))] sm:pb-8">
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
