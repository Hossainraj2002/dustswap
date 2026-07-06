"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useSwitchChain, useWalletClient } from "wagmi";
import { getRpcUrlForChain } from "@/config/web3";
import { getSweepChain } from "@/config/sweepChainConfig";
import { isUserRejectedRequest } from "@/lib/paymaster";

/**
 * Generic per-chain switch hook for DustSweep — a chain-parameterized generalization of
 * useBaseChainSwitch (which stays untouched for its 5 Base-only consumers). Given a target sweep
 * chain id, exposes { isOnChain, isSwitching, switchToSweepChain } and adds the chain via
 * wallet_addEthereumChain when the wallet doesn't recognize it.
 */

type RequestCapableProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};
type ChainEventProvider = RequestCapableProvider & {
  on: (event: "chainChanged", handler: (chainId: unknown) => void) => void;
  removeListener?: (event: "chainChanged", handler: (chainId: unknown) => void) => void;
};

const CHAIN_SWITCH_SETTLE_TIMEOUT_MS = 6_000;
const CHAIN_SWITCH_POLL_INTERVAL_MS = 150;

function toHexChainId(chainId: number) {
  return `0x${chainId.toString(16)}`;
}

function hasRequestMethod(value: unknown): value is RequestCapableProvider {
  return !!value && typeof value === "object" && typeof (value as { request?: unknown }).request === "function";
}

function hasChainEventMethods(value: RequestCapableProvider): value is ChainEventProvider {
  return typeof (value as ChainEventProvider).on === "function";
}

function parseProviderChainId(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = value.startsWith("0x") ? Number.parseInt(value, 16) : Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function readProviderChainId(provider: RequestCapableProvider) {
  return parseProviderChainId(await provider.request({ method: "eth_chainId" }));
}

async function waitForProviderChainId(provider: RequestCapableProvider, expectedChainId: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < CHAIN_SWITCH_SETTLE_TIMEOUT_MS) {
    const nextChainId = await readProviderChainId(provider).catch(() => null);
    if (nextChainId === expectedChainId) return true;
    await sleep(CHAIN_SWITCH_POLL_INTERVAL_MS);
  }
  return false;
}

function isUnknownChainError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { code?: number | string; message?: string; shortMessage?: string };
  const code = String(maybeError.code ?? "");
  const message = `${maybeError.shortMessage || ""} ${maybeError.message || ""}`.toLowerCase();
  return (
    code === "4902" ||
    message.includes("unrecognized chain") ||
    message.includes("unknown chain") ||
    message.includes("chain has not been added")
  );
}

export function useSweepChainSwitch(targetChainId: number) {
  const sweepChain = getSweepChain(targetChainId);
  const { chainId, connector, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { isPending: isWagmiSwitching, switchChainAsync } = useSwitchChain();
  const [isSwitching, setIsSwitching] = useState(false);
  const [observedChainId, setObservedChainId] = useState<number | null>(null);

  const effectiveChainId = observedChainId ?? chainId ?? null;
  const isOnChain = effectiveChainId === targetChainId;

  const getRequestProvider = useCallback(async () => {
    const connectorProvider = await connector?.getProvider?.().catch(() => null);
    if (hasRequestMethod(connectorProvider)) return connectorProvider;
    if (hasRequestMethod(walletClient)) return walletClient;
    if (typeof window !== "undefined" && hasRequestMethod(window.ethereum)) return window.ethereum;
    return null;
  }, [connector, walletClient]);

  useEffect(() => {
    if (typeof chainId === "number") {
      setObservedChainId(chainId);
      return;
    }
    if (!isConnected) setObservedChainId(null);
  }, [chainId, isConnected]);

  useEffect(() => {
    let disposed = false;
    let removeChainChangedListener: (() => void) | null = null;
    if (!isConnected) return;

    void (async () => {
      const provider = await getRequestProvider();
      if (!provider || disposed) return;

      const syncObservedChainId = async () => {
        const nextChainId = await readProviderChainId(provider).catch(() => null);
        if (!disposed && nextChainId) setObservedChainId(nextChainId);
      };
      await syncObservedChainId();

      if (hasChainEventMethods(provider)) {
        const handleChainChanged = (nextChainId: unknown) => {
          const parsed = parseProviderChainId(nextChainId);
          if (parsed) setObservedChainId(parsed);
          else void syncObservedChainId();
        };
        provider.on("chainChanged", handleChainChanged);
        removeChainChangedListener = () => provider.removeListener?.("chainChanged", handleChainChanged);
      }
    })();

    return () => {
      disposed = true;
      removeChainChangedListener?.();
    };
  }, [getRequestProvider, isConnected]);

  const requestChainFromProvider = useCallback(
    async (provider: RequestCapableProvider) => {
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: toHexChainId(targetChainId) }],
        });
      } catch (error) {
        if (!isUnknownChainError(error)) throw error;
        const rpcUrl = getRpcUrlForChain(targetChainId) || sweepChain.chain.rpcUrls.default.http[0];
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: toHexChainId(targetChainId),
              chainName: sweepChain.chain.name,
              nativeCurrency: sweepChain.chain.nativeCurrency,
              rpcUrls: [rpcUrl],
              blockExplorerUrls: [sweepChain.explorerUrl],
            },
          ],
        });
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: toHexChainId(targetChainId) }],
        });
      }
    },
    [sweepChain, targetChainId],
  );

  const getSwitchErrorMessage = useCallback(
    (error: unknown) => {
      if (isUserRejectedRequest(error)) return `Please switch your wallet to ${sweepChain.label} to continue.`;
      if (error instanceof Error && error.message) return error.message;
      return `Your wallet could not switch to ${sweepChain.label} automatically. Please switch and try again.`;
    },
    [sweepChain.label],
  );

  const switchToSweepChain = useCallback(async () => {
    if (!isConnected) throw new Error("Connect your wallet first.");
    if (isOnChain) return true;

    setIsSwitching(true);
    try {
      const provider = await getRequestProvider();
      const providerChainId = provider ? await readProviderChainId(provider).catch(() => null) : null;
      if ((providerChainId ?? chainId) === targetChainId) {
        setObservedChainId(targetChainId);
        return true;
      }

      try {
        const switchedChain = await switchChainAsync({ chainId: targetChainId });
        if (provider) await waitForProviderChainId(provider, targetChainId);
        setObservedChainId(switchedChain?.id ?? targetChainId);
        return true;
      } catch (error) {
        if (isUserRejectedRequest(error)) throw error;
        if (!provider) throw error;
      }

      if (!provider) {
        throw new Error(
          `Your wallet connection could not switch to ${sweepChain.label} automatically. Please switch and try again.`,
        );
      }

      await requestChainFromProvider(provider);
      await waitForProviderChainId(provider, targetChainId);
      setObservedChainId(targetChainId);
      return true;
    } catch (error) {
      throw new Error(getSwitchErrorMessage(error));
    } finally {
      setIsSwitching(false);
    }
  }, [
    chainId,
    getRequestProvider,
    getSwitchErrorMessage,
    isConnected,
    isOnChain,
    requestChainFromProvider,
    switchChainAsync,
    sweepChain.label,
    targetChainId,
  ]);

  return {
    isOnChain,
    isSwitching: isSwitching || isWagmiSwitching,
    switchToSweepChain,
  };
}
