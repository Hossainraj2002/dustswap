"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import {
  type ConnectedWallet,
  type WalletListEntry,
  useActiveWallet,
  useConnectWallet,
} from "@privy-io/react-auth";
import { useSetActiveWallet } from "@privy-io/wagmi";
import { hasInjectedOkxWallet } from "@/lib/ethereumProviders";

export const PRIVY_WALLET_LIST: WalletListEntry[] = [
  "detected_ethereum_wallets",
  "metamask",
  "coinbase_wallet",
  "base_account",
  "rainbow",
  "okx_wallet",
  "phantom",
  "zerion",
  "bitget_wallet",
  "bybit_wallet",
  "kraken_wallet",
  "binance",
  "binanceus",
  "haha_wallet",
  "ronin_wallet",
  "safe",
  "uniswap",
  "cryptocom",
  "universal_profile",
  "wallet_connect",
];

export const DUST_SWEEP_PRIVY_WALLET_LIST: WalletListEntry[] = [
  "base_account",
  "metamask",
  "coinbase_wallet",
  "rainbow",
  "okx_wallet",
  "phantom",
  "zerion",
  "bitget_wallet",
  "safe",
  "uniswap",
  "cryptocom",
  "detected_ethereum_wallets",
  "wallet_connect",
];

const BASE_ACCOUNT_FEATURE_WALLET_CLIENT_TYPES = new Set([
  "base_account",
  "base_app",
  "base_wallet",
  "coinbase_smart_wallet",
]);

function uniqueWalletList(walletList: WalletListEntry[]) {
  return walletList.filter(
    (wallet, index) => walletList.indexOf(wallet) === index
  );
}

function isMobileRuntime() {
  if (typeof navigator === "undefined") {
    return false;
  }

  const userAgent = navigator.userAgent || "";
  const isIpadOS =
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  const hasMobilePointer =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  return (
    /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) ||
    isIpadOS ||
    hasMobilePointer
  );
}

function getMobileWalletList(walletList: WalletListEntry[]) {
  if (walletList[0] !== "detected_ethereum_wallets") {
    return walletList;
  }

  return uniqueWalletList([
    ...walletList.filter((wallet) => wallet !== "detected_ethereum_wallets"),
    "detected_ethereum_wallets",
  ]);
}

function prioritizeWallet(
  walletList: WalletListEntry[],
  walletToPrioritize: WalletListEntry
) {
  return uniqueWalletList([
    walletToPrioritize,
    ...walletList.filter((wallet) => wallet !== walletToPrioritize),
  ]);
}

function getRuntimeWalletList(walletList: WalletListEntry[]) {
  const mobileRuntime = isMobileRuntime();
  const hasOkxInjectedWallet = hasInjectedOkxWallet();
  const nextWalletList = mobileRuntime
    ? getMobileWalletList(walletList)
    : walletList;

  if (mobileRuntime) {
    return hasOkxInjectedWallet
      ? prioritizeWallet(nextWalletList, "okx_wallet")
      : nextWalletList;
  }

  if (!hasOkxInjectedWallet) {
    return walletList;
  }

  return uniqueWalletList([
    "detected_ethereum_wallets",
    ...nextWalletList.filter(
      (wallet) =>
        wallet !== "detected_ethereum_wallets" &&
        wallet !== "okx_wallet"
    ),
  ]);
}

export function supportsBaseAccountFeatures(
  wallet: { walletClientType?: string } | null | undefined
) {
  if (!wallet?.walletClientType) {
    return false;
  }

  return BASE_ACCOUNT_FEATURE_WALLET_CLIENT_TYPES.has(wallet.walletClientType);
}

type WalletConnectionContextValue = {
  activeWallet: { address?: string; walletClientType?: string } | null;
  disconnectWallet: () => Promise<void>;
  isAvailable: boolean;
  openWalletModal: (
    description?: string,
    walletList?: WalletListEntry[]
  ) => Promise<void>;
  supportsBaseAccountFeatures: boolean;
};

const noopAsync = async () => {};

const FALLBACK_WALLET_CONNECTION: WalletConnectionContextValue = {
  activeWallet: null,
  disconnectWallet: noopAsync,
  isAvailable: false,
  openWalletModal: noopAsync,
  supportsBaseAccountFeatures: false,
};

const WalletConnectionContext = createContext<WalletConnectionContextValue>(
  FALLBACK_WALLET_CONNECTION
);

function PrivyWalletConnectionProvider({ children }: { children: ReactNode }) {
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
    async (description?: string, walletList?: WalletListEntry[]) => {
      const nextWalletList = getRuntimeWalletList(walletList ?? PRIVY_WALLET_LIST);
      connectWallet({
        description,
        walletList: nextWalletList,
        walletChainType: "ethereum-only",
      });
    },
    [connectWallet]
  );

  const disconnectWallet = useCallback(async () => {
    wallet?.disconnect();
  }, [wallet]);

  const value = useMemo<WalletConnectionContextValue>(
    () => ({
      activeWallet: wallet ?? null,
      disconnectWallet,
      isAvailable: true,
      openWalletModal,
      supportsBaseAccountFeatures: supportsBaseAccountFeatures(wallet),
    }),
    [disconnectWallet, openWalletModal, wallet]
  );

  return (
    <WalletConnectionContext.Provider value={value}>
      {children}
    </WalletConnectionContext.Provider>
  );
}

export function WalletConnectionProvider({
  children,
  enabled,
}: {
  children: ReactNode;
  enabled: boolean;
}) {
  if (!enabled) {
    return (
      <WalletConnectionContext.Provider value={FALLBACK_WALLET_CONNECTION}>
        {children}
      </WalletConnectionContext.Provider>
    );
  }

  return <PrivyWalletConnectionProvider>{children}</PrivyWalletConnectionProvider>;
}

export function useWalletConnection() {
  return useContext(WalletConnectionContext);
}
