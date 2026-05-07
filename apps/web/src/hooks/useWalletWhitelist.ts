"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, useConnection, useWalletClient } from "wagmi";
import { useWalletConnection } from "@/hooks/useWalletConnection";
import { type WalletWhitelistStatus } from "@/types/dustsweep";

const TIER_1_CONNECTORS = new Set(["coinbaseWallet", "safe", "baseAccount"]);
const TIER_2_CONNECTORS = new Set([
  "metaMask",
  "rainbow",
  "injected",
  "trust",
  "tokenPocket",
  "okx",
  "zerion",
  "imToken",
  "walletConnect",
  "phantom",
  "coinbaseWalletSDK",
]);

type EthereumFlags = {
  isMetaMask?: boolean;
  isRabby?: boolean;
  isTrust?: boolean;
  isTokenPocket?: boolean;
  isOKExWallet?: boolean;
  isImToken?: boolean;
  isPhantom?: boolean;
};

function getEthereumFlags(): EthereumFlags {
  if (typeof window === "undefined") return {};
  return ((window as Window & { ethereum?: EthereumFlags }).ethereum ?? {}) as EthereumFlags;
}

function detectInjectedWalletName(connectorId: string | null) {
  const flags = getEthereumFlags();

  if (flags.isRabby) return "Rabby";
  if (flags.isTrust) return "Trust Wallet";
  if (flags.isTokenPocket) return "Token Pocket";
  if (flags.isOKExWallet) return "OKX Wallet";
  if (flags.isImToken) return "imToken";
  if (flags.isPhantom) return "Phantom";
  if (flags.isMetaMask) return "MetaMask";
  if (connectorId === "walletConnect") return "WalletConnect";
  if (connectorId === "safe") return "Safe";
  if (connectorId === "coinbaseWallet" || connectorId === "baseAccount") {
    return "Coinbase Smart Wallet";
  }

  return connectorId || "Unknown wallet";
}

function isWhitelistedConnector(connectorId: string | null) {
  if (!connectorId) return false;
  if (TIER_1_CONNECTORS.has(connectorId)) return true;
  if (TIER_2_CONNECTORS.has(connectorId)) return true;

  const flags = getEthereumFlags();
  return Boolean(
    flags.isMetaMask ||
      flags.isRabby ||
      flags.isTrust ||
      flags.isTokenPocket ||
      flags.isOKExWallet ||
      flags.isImToken ||
      flags.isPhantom,
  );
}

export function useWalletWhitelist(): WalletWhitelistStatus {
  const { isConnected } = useAccount();
  const connection = useConnection();
  const walletConnection = useWalletConnection();
  const { data: walletClient } = useWalletClient();
  const connectorId = connection.connector?.id ?? null;
  const walletClientType = walletConnection.activeWallet?.walletClientType ?? null;
  const [supportsEIP712, setSupportsEIP712] = useState(false);
  const [isChecking, setIsChecking] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function checkEIP712Support() {
      if (!isConnected || !walletClient) {
        setSupportsEIP712(false);
        setIsChecking(false);
        return;
      }

      setIsChecking(true);
      try {
        const supported = typeof walletClient.signTypedData === "function";
        if (!cancelled) {
          setSupportsEIP712(supported);
        }
      } catch {
        if (!cancelled) {
          setSupportsEIP712(false);
        }
      } finally {
        if (!cancelled) {
          setIsChecking(false);
        }
      }
    }

    void checkEIP712Support();

    return () => {
      cancelled = true;
    };
  }, [isConnected, walletClient, connectorId]);

  return useMemo<WalletWhitelistStatus>(() => {
    const walletName =
      walletClientType === "base_account" ||
      walletClientType === "coinbase_smart_wallet"
        ? "Coinbase Smart Wallet"
        : detectInjectedWalletName(connectorId);
    const whitelisted =
      walletClientType === "base_account" ||
      walletClientType === "coinbase_smart_wallet" ||
      isWhitelistedConnector(connectorId);
    const tier = TIER_1_CONNECTORS.has(connectorId || "") || walletName === "Coinbase Smart Wallet"
      ? "tier1"
      : whitelisted
        ? "tier2"
        : isConnected
          ? "blocked"
          : "unknown";
    const isSupported = !isConnected || (whitelisted && supportsEIP712);

    return {
      isSupported,
      isChecking,
      tier,
      connectorId,
      walletName,
      reason: isSupported
        ? null
        : !whitelisted
          ? "This wallet is not whitelisted for DustSweep."
          : "This wallet does not expose EIP-712 batch signing.",
      supportsEIP712,
      isCoinbaseSmartWallet:
        connectorId === "coinbaseWallet" ||
        connectorId === "baseAccount" ||
        walletClientType === "base_account" ||
        walletClientType === "coinbase_smart_wallet" ||
        walletName.toLowerCase().includes("coinbase"),
    };
  }, [connectorId, isChecking, isConnected, supportsEIP712, walletClientType]);
}
