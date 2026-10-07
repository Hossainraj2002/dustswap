"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

class WalletReadTimeout extends Error {
  constructor() {
    super(`Your wallet took too long to report its network. Check your wallet and try switching to ${CHAIN_NAME} again.`);
  }
}

class WalletSwitchCancelled extends Error {
  constructor() {
    super("Your wallet connection changed. Try again with the selected wallet.");
  }
}

function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) throw new WalletSwitchCancelled();
}

function rethrowInterrupted(error: unknown) {
  if (error instanceof WalletReadTimeout || error instanceof WalletSwitchCancelled) throw error;
}

/** EIP-1193 requests cannot be aborted, so detach from late responses on cancellation. */
function walletRequest<T>(request: () => Promise<T>, signal?: AbortSignal, timeoutMs: number | null = CHAIN_SWITCH_SETTLE_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      complete();
    };
    const cancel = () => finish(() => reject(new WalletSwitchCancelled()));
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener("abort", cancel, { once: true });
    if (timeoutMs !== null) timer = setTimeout(() => finish(() => reject(new WalletReadTimeout())), timeoutMs);
    Promise.resolve().then(() => { assertActive(signal); return request(); }).then(
      value => finish(() => resolve(value)), error => finish(() => reject(error)),
    );
  });
}

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

async function readProviderChainId(provider: RequestCapableProvider, signal?: AbortSignal, timeoutMs?: number) {
  return parseProviderChainId(
    await walletRequest(() => provider.request({
      method: "eth_chainId",
    }), signal, timeoutMs)
  );
}

async function waitForProviderChainId(
  provider: RequestCapableProvider,
  expectedChainId: number,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + CHAIN_SWITCH_SETTLE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    assertActive(signal);
    const nextChainId = await readProviderChainId(provider, signal, deadline - Date.now()).catch(error => {
      rethrowInterrupted(error);
      return null;
    });

    if (nextChainId === expectedChainId) {
      return true;
    }

    await walletRequest(() => sleep(Math.min(CHAIN_SWITCH_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()))), signal, null);
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

async function requestBaseChainFromProvider(provider: RequestCapableProvider, signal: AbortSignal) {
  try {
    await walletRequest(() => provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: toHexChainId(TARGET_CHAIN_ID) }],
    }), signal, null);
  } catch (error) {
    if (!isUnknownChainError(error)) {
      throw error;
    }

    const rpcUrl = getRpcUrlForChain(TARGET_CHAIN_ID) || TARGET_CHAIN.rpcUrls.default.http[0];
    await walletRequest(() => provider.request({
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
    }), signal, null);
    await walletRequest(() => provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: toHexChainId(TARGET_CHAIN_ID) }],
    }), signal, null);
  }
}

export function useBaseChainSwitch() {
  const { address, chainId, connector, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { isPending: isWagmiSwitching, switchChainAsync } = useSwitchChain();
  const [isSwitching, setIsSwitching] = useState(false);
  const [observedChainId, setObservedChainId] = useState<number | null>(null);
  const activeSwitch = useRef<AbortController | null>(null);

  const effectiveChainId = observedChainId ?? chainId ?? null;
  const isOnBase = isConnected && effectiveChainId === TARGET_CHAIN_ID;

  const getRequestProvider = useCallback(async (signal?: AbortSignal) => {
    const connectorProvider = await walletRequest(() => Promise.resolve(connector?.getProvider?.()), signal).catch(error => {
      rethrowInterrupted(error);
      return null;
    });

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

  useEffect(() => () => {
    activeSwitch.current?.abort();
    activeSwitch.current = null;
    setIsSwitching(false);
  }, [address, connector?.uid, isConnected]);

  useEffect(() => {
    if (typeof chainId === "number") {
      setObservedChainId(chainId);
      return;
    }

    if (!isConnected) {
      setObservedChainId(null);
    }
  }, [address, chainId, connector?.uid, isConnected]);

  useEffect(() => {
    let disposed = false;
    const observation = new AbortController();
    let removeChainChangedListener: (() => void) | null = null;

    if (!isConnected) {
      return;
    }

    void (async () => {
      const provider = await getRequestProvider(observation.signal);
      if (!provider || disposed) {
        return;
      }

      const syncObservedChainId = async () => {
        const nextChainId = await readProviderChainId(provider, observation.signal).catch(() => null);
        if (!disposed && nextChainId) {
          setObservedChainId(nextChainId);
        }
      };

      await syncObservedChainId();
      if (disposed) return;

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
    })().catch(() => undefined);

    return () => {
      disposed = true;
      observation.abort();
      removeChainChangedListener?.();
    };
  }, [address, getRequestProvider, isConnected]);

  const switchToBase = useCallback(async () => {
    if (!isConnected) {
      throw new Error("Connect your wallet first.");
    }
    if (activeSwitch.current) throw new Error("A wallet network switch is already pending.");
    const switching = new AbortController();
    const signal = switching.signal;
    activeSwitch.current = switching;

    setIsSwitching(true);

    try {
      const provider = await getRequestProvider(signal);
      const providerChainId = provider
        ? await readProviderChainId(provider, signal).catch(error => { rethrowInterrupted(error); return null; })
        : null;

      if ((provider ? providerChainId : chainId) === TARGET_CHAIN_ID) {
        assertActive(signal);
        setObservedChainId(TARGET_CHAIN_ID);
        return true;
      }

      try {
        const switchedChain = await walletRequest(() => switchChainAsync({
          chainId: TARGET_CHAIN_ID,
        }), signal, null);

        if (provider) {
          if (!await waitForProviderChainId(provider, TARGET_CHAIN_ID, signal)) {
            throw new Error(`Your wallet has not switched to ${CHAIN_NAME}. Please switch it and try again.`);
          }
        } else if (switchedChain?.id !== TARGET_CHAIN_ID) {
          throw new Error(`Your wallet has not switched to ${CHAIN_NAME}. Please switch it and try again.`);
        }

        assertActive(signal);
        setObservedChainId(TARGET_CHAIN_ID);
        return true;
      } catch (error) {
        rethrowInterrupted(error);
        assertActive(signal);
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

      await requestBaseChainFromProvider(provider, signal);
      if (!await waitForProviderChainId(provider, TARGET_CHAIN_ID, signal)) {
        throw new Error(`Your wallet has not switched to ${CHAIN_NAME}. Please switch it and try again.`);
      }
      assertActive(signal);
      setObservedChainId(TARGET_CHAIN_ID);
      return true;
    } catch (error) {
      throw new Error(getSwitchErrorMessage(error));
    } finally {
      if (activeSwitch.current === switching) {
        activeSwitch.current = null;
        setIsSwitching(false);
      }
    }
  }, [chainId, getRequestProvider, isConnected, switchChainAsync]);

  return {
    isOnBase,
    isSwitching: isSwitching || isWagmiSwitching,
    switchToBase,
  };
}
