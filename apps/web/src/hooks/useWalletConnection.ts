"use client";

import { useCallback } from "react";
import {
  type ConnectedWallet,
  type WalletListEntry,
  useActiveWallet,
  useConnectWallet,
} from "@privy-io/react-auth";
import { useSetActiveWallet } from "@privy-io/wagmi";

export const PRIVY_WALLET_LIST: WalletListEntry[] = [
  "base_account",
  "metamask",
  "coinbase_wallet",
  "rainbow",
  "wallet_connect",
];

const BASE_ACCOUNT_FEATURE_WALLET_CLIENT_TYPES = new Set([
  "base_account",
  "coinbase_smart_wallet",
]);

export function supportsBaseAccountFeatures(
  wallet: { walletClientType?: string } | null | undefined
) {
  if (!wallet?.walletClientType) {
    return false;
  }

  return BASE_ACCOUNT_FEATURE_WALLET_CLIENT_TYPES.has(wallet.walletClientType);
}

export function useWalletConnection() {
  const { wallet } = useActiveWallet();
  const { setActiveWallet } = useSetActiveWallet();
  const { connectWallet } = useConnectWallet({
    onSuccess: async ({ wallet: connectedWallet }) => {
      if (connectedWallet.type === "ethereum") {
        await setActiveWallet(connectedWallet as ConnectedWallet);
      }
    },
  });

  const openWalletModal = useCallback(
    async (description?: string) => {
      connectWallet({
        description,
        walletList: PRIVY_WALLET_LIST,
      });
    },
    [connectWallet]
  );

  const disconnectWallet = useCallback(async () => {
    wallet?.disconnect();
  }, [wallet]);

  return {
    activeWallet: wallet,
    disconnectWallet,
    openWalletModal,
    supportsBaseAccountFeatures: supportsBaseAccountFeatures(wallet),
  };
}
