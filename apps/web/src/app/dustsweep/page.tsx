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
import { type SweepButtonVisualState } from "@/types/dustsweep";

function shortAddress(address: string) {
  return `${address.slice(0, 4)}...${address.slice(-6)}`;
}

function getSweepButtonState(args: {
  selectedCount: number;
  hasTokenOut: boolean;
  quoteReady: boolean;
  isLoading: boolean;
  isQuoting: boolean;
  sweepStep: ReturnType<typeof useDustSweep>["sweepStep"];
}): SweepButtonVisualState {
  if (args.sweepStep === "success") return { state: "success", label: "Swept! View on Basescan" };
  if (args.sweepStep === "error") return { state: "error", label: "Try again" };
  if (args.sweepStep === "signing") return { state: "signing", label: "Sign in wallet..." };
  if (args.sweepStep === "pending") return { state: "pending", label: "Sweeping..." };
  if (args.selectedCount === 0) return { state: "disabled", label: "Select tokens" };
  if (!args.hasTokenOut) return { state: "disabled", label: "Select output token" };
  if (args.isLoading || args.isQuoting || !args.quoteReady) {
    return { state: "loading", label: "Getting best route..." };
  }
  return { state: "ready", label: "Sweep Now" };
}

export default function DustSweepPage() {
  const { address, isConnected } = useAccount();
  const sweep = useDustSweep();
  const [tokenModalMode, setTokenModalMode] = useState<"multi" | "single" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [walletGateDismissed, setWalletGateDismissed] = useState(false);

  const tokenOutBalanceUSD = useMemo(() => {
    if (!sweep.tokenOut) return 0;
    const token = [...sweep.swappableTokens, ...sweep.unavailableTokens].find(
      (item) => item.address.toLowerCase() === sweep.tokenOut?.address.toLowerCase(),
    );
    return token?.valueUSD ?? 0;
  }, [sweep.swappableTokens, sweep.tokenOut, sweep.unavailableTokens]);

  const buttonState = getSweepButtonState({
    selectedCount: sweep.selectedTokens.length,
    hasTokenOut: Boolean(sweep.tokenOut),
    quoteReady: Boolean(sweep.quote && sweep.quote.routes.length > 0),
    isLoading: sweep.isLoading,
    isQuoting: sweep.isQuoting,
    sweepStep: sweep.sweepStep,
  });

  const shouldShowWalletGate =
    isConnected &&
    !sweep.walletStatus.isChecking &&
    !sweep.walletStatus.isSupported &&
    !walletGateDismissed;

  if (!isConnected) {
    return (
      <div className="min-h-screen bg-[#eef3f8] px-4 py-8">
        <div className="mx-auto flex min-h-[70dvh] max-w-[460px] flex-col items-center justify-center text-center">
          <Image src="/logo.png" alt="DustSwap" width={84} height={84} className="mb-5" priority />
          <h1 className="text-3xl font-semibold tracking-[-0.02em] text-slate-950">DustSweep</h1>
          <p className="mt-3 max-w-sm text-sm leading-6 text-slate-600">
            Connect a supported wallet to find small Base token balances and sweep them into one useful asset.
          </p>
          <div className="mt-7 w-full">
            <WalletConnectButton
              connectLabel="Connect Wallet"
              description="Connect your wallet to use DustSweep."
              fullWidth
              className="bg-blue-600 text-white hover:border-blue-600 hover:bg-blue-700 hover:text-white"
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#eef3f8] px-3 py-5 sm:px-6 sm:py-8">
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
        onSelectToken={sweep.addToken}
        onSelectOutputToken={sweep.setTokenOut}
        onClose={() => setTokenModalMode(null)}
      />

      <SlippageSettings
        isOpen={settingsOpen}
        slippageBps={sweep.slippageBps}
        onChange={sweep.setSlippageBps}
        onClose={() => setSettingsOpen(false)}
      />

      <div className="mx-auto max-w-[520px] pb-[calc(82px+env(safe-area-inset-bottom))] sm:pb-8">
        <div className="mb-5 flex items-center justify-between">
          <Image src="/logo.png" alt="DustSwap" width={58} height={58} priority />
          <div className="text-center">
            <p className="text-lg font-semibold text-slate-950">Sweep</p>
            <p className="text-xs text-slate-500">Base dust aggregator</p>
          </div>
          <WalletConnectButton
            connectedLabel={address ? shortAddress(address) : undefined}
            showDisconnect
            className="rounded-[8px] bg-white px-3 text-xs"
          />
        </div>

        <div className="mb-5 rounded-[8px] border border-blue-100 bg-white/90 px-4 py-3 text-sm leading-6 text-slate-700 shadow-sm">
          Sweep small token balances into one output token with a single route and one wallet signature.
        </div>

        <main className="space-y-4 rounded-[8px] border border-slate-200 bg-white/85 p-3 shadow-[0_18px_48px_rgba(15,23,42,0.08)] backdrop-blur sm:p-4">
          <TokenFromPanel
            selectedTokens={sweep.selectedTokens}
            onRemove={sweep.removeToken}
            onClearAll={sweep.clearSelectedTokens}
            onAddMore={() => setTokenModalMode("multi")}
            autoMode={sweep.autoMode}
            onToggleAuto={() => sweep.setAutoMode(!sweep.autoMode)}
            onOpenSettings={() => setSettingsOpen(true)}
          />

          <TokenToPanel
            tokenOut={sweep.tokenOut}
            quote={sweep.quote}
            balanceUSD={tokenOutBalanceUSD}
            onOpenSelect={() => setTokenModalMode("single")}
          />

          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="text-slate-500">Receiver address</span>
            <span className="font-mono text-slate-950">
              {address ? shortAddress(address) : "-"}
            </span>
          </div>

          {sweep.quoteError ? (
            <div className="rounded-[8px] border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              Could not get quote.{" "}
              <button
                type="button"
                onClick={() => void sweep.refreshQuote()}
                className="font-semibold underline"
              >
                Retry
              </button>
            </div>
          ) : null}

          {sweep.error ? (
            <div className="rounded-[8px] border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {sweep.error}
            </div>
          ) : null}

          <div className="space-y-3">
            <p className="text-sm font-medium text-slate-500">Route</p>
            <RouteDisplay
              quote={sweep.quote}
              tokenOut={sweep.tokenOut}
              selectedTokens={sweep.selectedTokens}
            />
            {!sweep.quote && sweep.selectedTokens.length > 0 ? (
              <div className="rounded-[8px] border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-center text-sm text-slate-500">
                {sweep.isQuoting ? "Finding the best route..." : "Route appears after quote"}
              </div>
            ) : null}
          </div>

          <SweepDetails quote={sweep.quote} slippageBps={sweep.slippageBps} />

          <UnavailablePanel
            tokens={sweep.unavailableTokens}
            onClearAll={sweep.clearUnavailableTokens}
          />

          {sweep.quote?.routes.some((route) => route.priceImpactBps > 500) ? (
            <div className="rounded-[8px] border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              High price impact. Review the route before sweeping.
            </div>
          ) : null}

          <div className="hidden sm:block">
            <SweepButton
              visualState={buttonState}
              onClick={() => void sweep.executeSweep()}
              txHash={sweep.txHash}
            />
          </div>
        </main>

        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 p-3 pb-[calc(12px+env(safe-area-inset-bottom))] shadow-[0_-18px_44px_rgba(148,163,184,0.18)] backdrop-blur sm:hidden">
          <div className="mx-auto max-w-[520px]">
            <SweepButton
              visualState={buttonState}
              onClick={() => void sweep.executeSweep()}
              txHash={sweep.txHash}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
