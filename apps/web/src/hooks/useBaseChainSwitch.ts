"use client";

import { useCallback, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import { base } from "wagmi/chains";
import { getRpcUrlForChain } from "@/config/web3";
import { isUserRejectedRequest } from "@/lib/paymaster";
import { BASE_CHAIN_ID } from "@/lib/tokens";

type RequestCapableProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

function toHexChainId(chainId: number) {
  return `0x${chainId.toString(16)}`;
}

function hasRequestMethod(value: unknown): value is RequestCapableProvider {
  return !!value && typeof value === "object" && typeof (value as { request?: unknown }).request === "function";
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
    return "Please switch your wallet to Base to continue.";
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Your wallet could not switch to Base automatically. Please switch to Base and try again.";
}

export function useBaseChainSwitch() {
  const { chainId, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const [isSwitching, setIsSwitching] = useState(false);

  const isOnBase = chainId === BASE_CHAIN_ID;

  const switchToBase = useCallback(async () => {
    if (!isConnected) {
      throw new Error("Connect your wallet first.");
    }

    if (chainId === BASE_CHAIN_ID) {
      return true;
    }

    const provider =
      (hasRequestMethod(walletClient) ? walletClient : null) ||
      (typeof window !== "undefined" && hasRequestMethod(window.ethereum)
        ? window.ethereum
        : null);

    if (!provider) {
      throw new Error(
        "Your wallet connection could not switch to Base automatically. Please switch to Base and try again."
      );
    }

    setIsSwitching(true);

    try {
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: toHexChainId(BASE_CHAIN_ID) }],
        });
      } catch (error) {
        if (!isUnknownChainError(error)) {
          throw error;
        }

        const rpcUrl = getRpcUrlForChain(BASE_CHAIN_ID) || base.rpcUrls.default.http[0];
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: toHexChainId(BASE_CHAIN_ID),
              chainName: base.name,
              nativeCurrency: base.nativeCurrency,
              rpcUrls: [rpcUrl],
              blockExplorerUrls: [base.blockExplorers?.default.url || "https://basescan.org"],
            },
          ],
        });
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: toHexChainId(BASE_CHAIN_ID) }],
        });
      }

      return true;
    } catch (error) {
      throw new Error(getSwitchErrorMessage(error));
    } finally {
      setIsSwitching(false);
    }
  }, [chainId, isConnected, walletClient]);

  return {
    isOnBase,
    isSwitching,
    switchToBase,
  };
}
