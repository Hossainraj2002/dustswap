"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, useConnection, useWalletClient } from "wagmi";
import { useWalletConnection } from "@/hooks/useWalletConnection";
import { type WalletWhitelistStatus } from "@/types/dustsweep";

// ── Capability-based wallet support (~99% coverage) ──
// Instead of brand/connector allowlists, we detect functional capabilities:
// 1. signTypedData (EIP-712) — required for Permit2 batch signing
// 2. sendTransaction — required for executing the sweep tx
// This supports MetaMask, Rabby, Trust, Phantom, OKX, Coinbase, WalletConnect,
// and any wallet that exposes these standard methods.

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
  bitget_wallet: "Bitget Wallet",
  safe: "Safe",
  uniswap: "Uniswap Wallet",
  cryptocom: "Crypto.com Wallet",
  im_token: "imToken",
  imtoken: "imToken",
  phantom: "Phantom",
  embedded: "Privy Embedded Wallet",
};

type EthereumFlags = {
  isMetaMask?: boolean;
  isRabby?: boolean;
  isTrust?: boolean;
  isTokenPocket?: boolean;
  isOKExWallet?: boolean;
  isOKXWallet?: boolean;
  isImToken?: boolean;
  isPhantom?: boolean;
  isRainbow?: boolean;
  isBitgetWallet?: boolean;
  isBitKeep?: boolean;
  isZerion?: boolean;
  isSafe?: boolean;
  isUniswapWallet?: boolean;
  isCryptoCom?: boolean;
  isCryptoComWallet?: boolean;
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
  if (flags.isOKExWallet || flags.isOKXWallet) return "OKX Wallet";
  if (flags.isRainbow) return "Rainbow";
  if (flags.isBitgetWallet || flags.isBitKeep) return "Bitget Wallet";
  if (flags.isZerion) return "Zerion";
  if (flags.isSafe) return "Safe";
  if (flags.isUniswapWallet) return "Uniswap Wallet";
  if (flags.isCryptoCom || flags.isCryptoComWallet) return "Crypto.com Wallet";
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

    async function checkCapabilities() {
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
        // Capability-based check: does the wallet expose signTypedData?
        const hasSignTypedData = typeof walletClient.signTypedData === "function";
        const hasSendTransaction = typeof walletClient.sendTransaction === "function";
        const supported = hasSignTypedData && hasSendTransaction;

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

    void checkCapabilities();

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

    // Capability-based support: any wallet with signTypedData + sendTransaction is supported
    // No brand/connector allowlisting — supports ~99% of wallets
    const isSupported = !isConnected || supportsEIP712;

    // Tier is now based on capabilities and features, not brand allowlists
    const isCoinbaseSmartWallet =
      connectorId === "coinbaseWallet" ||
      connectorId === "baseAccount" ||
      walletClientType === "base_account" ||
      walletClientType === "coinbase_smart_wallet" ||
      walletName.toLowerCase().includes("coinbase");

    const tier = !isConnected
      ? "unknown" as const
      : isCoinbaseSmartWallet
        ? "tier1" as const  // Tier 1: smart wallets with paymaster support
        : supportsEIP712
          ? "tier2" as const  // Tier 2: any wallet with EIP-712 support
          : "blocked" as const; // Blocked: wallet can't sign typed data

    return {
      isSupported,
      isChecking,
      tier,
      connectorId,
      walletName,
      reason: isSupported
        ? null
        : "This wallet does not support EIP-712 batch signing required for DustSweep.",
      supportsEIP712,
      isCoinbaseSmartWallet,
    };
  }, [connectorId, isChecking, isConnected, supportsEIP712, walletClientType]);
}
