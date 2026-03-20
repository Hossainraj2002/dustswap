"use client";

import type { WalletMenuOpenArgs } from "@lifi/wallet-management";
import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { WidgetSkeleton } from "@lifi/widget";
import { useConnect } from "wagmi";
import { LifiEvmChainSync } from "@/components/LifiEvmChainSync";
import { LifiRouteDebugPanel } from "@/components/LifiRouteDebugPanel";
import { createWidgetConfig, LIFI_INTEGRATOR } from "@/config/widget";

const LiFiWidget = dynamic(
  () => import("@lifi/widget").then((mod) => mod.LiFiWidget),
  {
    ssr: false,
    loading: () => <WidgetSkeleton />,
  }
);

function getConnectorPriority(connectorId: string, connectorName: string) {
  const normalizedName = connectorName.toLowerCase();

  if (connectorId === "metaMask" || normalizedName.includes("metamask")) {
    return 0;
  }

  if (connectorId === "injected") {
    return 1;
  }

  if (connectorId === "walletConnect") {
    return 2;
  }

  if (connectorId === "coinbaseWallet" || normalizedName.includes("coinbase")) {
    return 3;
  }

  return 4;
}

export function SwapBridgeWidget() {
  const { connectAsync, connectors, error, isPending } = useConnect();
  const [isWalletModalOpen, setIsWalletModalOpen] = useState(false);
  const [walletMenuArgs, setWalletMenuArgs] = useState<
    WalletMenuOpenArgs | undefined
  >();

  const availableConnectors = useMemo(
    () =>
      [...connectors]
        .filter((connector) => connector.ready || connector.id === "walletConnect")
        .sort((left, right) => {
          const priorityDiff =
            getConnectorPriority(left.id, left.name) -
            getConnectorPriority(right.id, right.name);

          if (priorityDiff !== 0) {
            return priorityDiff;
          }

          return left.name.localeCompare(right.name);
        }),
    [connectors]
  );

  const openWalletModal = useCallback((args?: WalletMenuOpenArgs) => {
    setWalletMenuArgs(args);
    setIsWalletModalOpen(true);
  }, []);

  const closeWalletModal = useCallback(() => {
    setIsWalletModalOpen(false);
  }, []);

  const handleConnect = useCallback(
    async (connectorUid: string) => {
      const connector = availableConnectors.find(
        (item) => item.uid === connectorUid
      );

      if (!connector) {
        return;
      }

      await connectAsync({ connector });

      closeWalletModal();
    },
    [availableConnectors, closeWalletModal, connectAsync]
  );

  useEffect(() => {
    if (!isWalletModalOpen) {
      setWalletMenuArgs(undefined);
    }
  }, [isWalletModalOpen]);

  const widgetConfig = useMemo(
    () =>
      createWidgetConfig({
        onConnect: openWalletModal,
      }),
    [openWalletModal]
  );

  return (
    <div className="w-full max-w-[980px] mx-auto">
      <LifiEvmChainSync />
      <LiFiWidget integrator={LIFI_INTEGRATOR} config={widgetConfig} />
      <LifiRouteDebugPanel />

      {isWalletModalOpen ? (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0b1020] p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-white">
                  Connect a wallet
                </h3>
                <p className="mt-1 text-sm text-gray-400">
                  Choose the wallet you want to use with LI.FI.
                </p>
              </div>
              <button
                type="button"
                onClick={closeWalletModal}
                className="rounded-lg border border-white/10 px-2.5 py-1 text-sm text-gray-300 transition hover:border-white/20 hover:bg-white/5"
              >
                Close
              </button>
            </div>

            {walletMenuArgs?.chain?.name ? (
              <p className="mt-3 rounded-xl border border-sky-500/20 bg-sky-500/10 px-3 py-2 text-xs text-sky-200">
                LI.FI is preparing a route on {walletMenuArgs.chain.name}.
              </p>
            ) : null}

            <div className="mt-4 space-y-2">
              {availableConnectors.length ? (
                availableConnectors.map((connector) => (
                  <button
                    key={connector.uid}
                    type="button"
                    disabled={isPending}
                    onClick={() => void handleConnect(connector.uid)}
                    className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left transition hover:border-white/20 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span>
                      <span className="block text-sm font-medium text-white">
                        {connector.name}
                      </span>
                      <span className="block text-xs text-gray-400">
                        {connector.id === "walletConnect"
                          ? "Best coverage across desktop and mobile wallets"
                          : connector.id === "coinbaseWallet"
                            ? "Coinbase Wallet and Smart Wallet"
                            : "Detected from this browser or device"}
                      </span>
                    </span>
                    <span className="text-xs text-gray-500">
                      {isPending ? "Connecting..." : "Select"}
                    </span>
                  </button>
                ))
              ) : (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                  No wallet connectors are available right now.
                </div>
              )}
            </div>

            {error ? (
              <p className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                {error.message}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
