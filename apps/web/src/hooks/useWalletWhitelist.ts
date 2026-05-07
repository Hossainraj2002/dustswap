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
  "privy",
  "trust",
  "tokenPocket",
  "okx",
  "zerion",
  "imToken",
  "walletConnect",
  "phantom",
  "coinbaseWalletSDK",
]);

const PRIVY_WALLET_NAMES: Record<string, string> = {
  base_account: "Coinbase Smart Wallet",
  coinbase_smart_wallet: "Coinbase Smart Wallet",
  smart_wallet: "Smart Wallet",
  coinbase_wallet: "Coinbase Wallet",
  metamask: "MetaMask",
  rainbow: "Rainbow",
  wallet_connect: "WalletConnect",
  detected_ethereum_wallets: "Injected Wallet",
  rabby_wallet: "Rabby",
  rabby: "Rabby",
  trust: "Trust Wallet",
  trust_wallet: "Trust Wallet",
  token_pocket: "Token Pocket",
  tokenpocket: "Token Pocket",
  okx_wallet: "OKX Wallet",
  okx: "OKX Wallet",
  zerion: "Zerion",
  im_token: "imToken",
  imtoken: "imToken",
  phantom: "Phantom",
  embedded: "Privy Embedded Wallet",
};

const BLOCKED_PRIVY_WALLET_TYPES = new Set([
  "ledger",
  "ledger_live",
  "mew",
  "myetherwallet",
  "unknown_legacy",
  "unknownLegacy",
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

function normalizeWalletClientType(walletClientType: string | null) {
  return walletClientType?.trim().toLowerCase() ?? null;
}

function getPrivyWalletName(walletClientType: string | null) {
  const normalized = normalizeWalletClientType(walletClientType);
  if (!normalized) return null;
  return PRIVY_WALLET_NAMES[normalized] ?? null;
}

function isWhitelistedPrivyWallet(walletClientType: string | null) {
  const normalized = normalizeWalletClientType(walletClientType);
  if (!normalized) return false;
  if (BLOCKED_PRIVY_WALLET_TYPES.has(normalized)) return false;

  return Boolean(PRIVY_WALLET_NAMES[normalized]);
}

function isWhitelistedConnector(connectorId: string | null, walletClientType: string | null) {
  if (isWhitelistedPrivyWallet(walletClientType)) return true;
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
      if (!isConnected) {
        setSupportsEIP712(false);
        setIsChecking(false);
        return;
      }

      if (!walletClient) {
        setSupportsEIP712(false);
        setIsChecking(true);
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
    const privyWalletName = getPrivyWalletName(walletClientType);
    const walletName =
      walletClientType === "base_account" ||
      walletClientType === "coinbase_smart_wallet"
        ? "Coinbase Smart Wallet"
        : privyWalletName || detectInjectedWalletName(connectorId);
    const whitelisted =
      walletClientType === "base_account" ||
      walletClientType === "coinbase_smart_wallet" ||
      isWhitelistedConnector(connectorId, walletClientType);
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
