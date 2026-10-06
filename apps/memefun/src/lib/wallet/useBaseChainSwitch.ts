"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useSwitchChain, useWalletClient } from "wagmi";
import { getRpcUrlForChain } from "@/lib/wallet/rpc";
import { CHAIN_NAME, TARGET_CHAIN, TARGET_CHAIN_ID } from "@/lib/chain";
import { isUserRejectedRequest } from "@/lib/wallet/paymaster";

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
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string" && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }

  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function readProviderChainId(provider: RequestCapableProvider) {
  return parseProviderChainId(
    await provider.request({
      method: "eth_chainId",
    })
  );
}

async function waitForProviderChainId(
  provider: RequestCapableProvider,
  expectedChainId: number
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < CHAIN_SWITCH_SETTLE_TIMEOUT_MS) {
    const nextChainId = await readProviderChainId(provider).catch(() => null);

    if (nextChainId === expectedChainId) {
      return true;
    }

    await sleep(CHAIN_SWITCH_POLL_INTERVAL_MS);
  }

  return false;
}

function isUnknownChainError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeError = error as {
    code?: number | string;
    message?: string;
    shortMessage?: string;
  };
  const code = String(maybeError.code ?? "");
  const message = `${maybeError.shortMessage || ""} ${maybeError.message || ""}`.toLowerCase();

  return (
    code === "4902" ||
    message.includes("unrecognized chain") ||
    message.includes("unknown chain") ||
    message.includes("chain has not been added")
  );
}

function getSwitchErrorMessage(error: unknown) {
  if (isUserRejectedRequest(error)) {
    return `Please switch your wallet to ${CHAIN_NAME} to continue.`;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return `Your wallet could not switch to ${CHAIN_NAME} automatically. Please switch to ${CHAIN_NAME} and try again.`;
}

async function requestBaseChainFromProvider(provider: RequestCapableProvider) {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: toHexChainId(TARGET_CHAIN_ID) }],
    });
  } catch (error) {
    if (!isUnknownChainError(error)) {
      throw error;
    }

    const rpcUrl = getRpcUrlForChain(TARGET_CHAIN_ID) || TARGET_CHAIN.rpcUrls.default.http[0];
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: toHexChainId(TARGET_CHAIN_ID),
          chainName: TARGET_CHAIN.name,
          nativeCurrency: TARGET_CHAIN.nativeCurrency,
          rpcUrls: [rpcUrl],
          ...(TARGET_CHAIN.blockExplorers ? { blockExplorerUrls: [TARGET_CHAIN.blockExplorers.default.url] } : {}),
        },
      ],
    });
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: toHexChainId(TARGET_CHAIN_ID) }],
    });
  }
}

export function useBaseChainSwitch() {
  const { chainId, connector, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { isPending: isWagmiSwitching, switchChainAsync } = useSwitchChain();
  const [isSwitching, setIsSwitching] = useState(false);
  const [observedChainId, setObservedChainId] = useState<number | null>(null);

  const effectiveChainId = observedChainId ?? chainId ?? null;
  const isOnBase = isConnected && effectiveChainId === TARGET_CHAIN_ID;

  const getRequestProvider = useCallback(async () => {
    const connectorProvider = await connector?.getProvider?.().catch(() => null);

    if (hasRequestMethod(connectorProvider)) {
      return connectorProvider;
    }

    if (hasRequestMethod(walletClient)) {
      return walletClient;
    }

    // A browser may have several injected wallets. Only the selected connector
    // or its wallet client is allowed to confirm/switch the signing chain.
    return null;
  }, [connector, walletClient]);

  useEffect(() => {
    if (typeof chainId === "number") {
      setObservedChainId(chainId);
      return;
    }

    if (!isConnected) {
      setObservedChainId(null);
    }
  }, [chainId, isConnected]);

  useEffect(() => {
    let disposed = false;
    let removeChainChangedListener: (() => void) | null = null;

    if (!isConnected) {
      return;
    }

    void (async () => {
      const provider = await getRequestProvider();
      if (!provider || disposed) {
        return;
      }

      const syncObservedChainId = async () => {
        const nextChainId = await readProviderChainId(provider).catch(() => null);
        if (!disposed && nextChainId) {
          setObservedChainId(nextChainId);
        }
      };

      await syncObservedChainId();

      if (hasChainEventMethods(provider)) {
        const handleChainChanged = (nextChainId: unknown) => {
          if (disposed) return;
          const parsed = parseProviderChainId(nextChainId);
          if (parsed) {
            setObservedChainId(parsed);
          } else {
            void syncObservedChainId();
          }
        };

        provider.on("chainChanged", handleChainChanged);
        removeChainChangedListener = () => {
          provider.removeListener?.("chainChanged", handleChainChanged);
        };
      }
    })();

    return () => {
      disposed = true;
      removeChainChangedListener?.();
    };
  }, [getRequestProvider, isConnected]);

  const switchToBase = useCallback(async () => {
    if (!isConnected) {
      throw new Error("Connect your wallet first.");
    }

    setIsSwitching(true);

    try {
      const provider = await getRequestProvider();
      const providerChainId = provider
        ? await readProviderChainId(provider).catch(() => null)
        : null;

      if ((provider ? providerChainId : chainId) === TARGET_CHAIN_ID) {
        setObservedChainId(TARGET_CHAIN_ID);
        return true;
      }

      try {
        const switchedChain = await switchChainAsync({
          chainId: TARGET_CHAIN_ID,
        });

        if (provider) {
          if (!await waitForProviderChainId(provider, TARGET_CHAIN_ID)) {
            throw new Error(`Your wallet has not switched to ${CHAIN_NAME}. Please switch it and try again.`);
          }
        } else if (switchedChain?.id !== TARGET_CHAIN_ID) {
          throw new Error(`Your wallet has not switched to ${CHAIN_NAME}. Please switch it and try again.`);
        }

        setObservedChainId(TARGET_CHAIN_ID);
        return true;
      } catch (error) {
        if (isUserRejectedRequest(error)) {
          throw error;
        }

        if (!provider) {
          throw error;
        }
      }

      if (!provider) {
        throw new Error(
          `Your wallet connection could not switch to ${CHAIN_NAME} automatically. Please switch to ${CHAIN_NAME} and try again.`
        );
      }

      await requestBaseChainFromProvider(provider);
      if (!await waitForProviderChainId(provider, TARGET_CHAIN_ID)) {
        throw new Error(`Your wallet has not switched to ${CHAIN_NAME}. Please switch it and try again.`);
      }
      setObservedChainId(TARGET_CHAIN_ID);
      return true;
    } catch (error) {
      throw new Error(getSwitchErrorMessage(error));
    } finally {
      setIsSwitching(false);
    }
  }, [chainId, getRequestProvider, isConnected, switchChainAsync]);

  return {
    isOnBase,
    isSwitching: isSwitching || isWagmiSwitching,
    switchToBase,
  };
}
