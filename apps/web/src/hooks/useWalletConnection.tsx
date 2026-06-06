"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  type ConnectedWallet,
  type WalletListEntry,
  useActiveWallet,
  useConnectWallet,
  usePrivy,
  useWallets,
} from "@privy-io/react-auth";
import { useSetActiveWallet } from "@privy-io/wagmi";
import { useAccount } from "wagmi";
import {
  hasInjectedOkxWallet,
  hasInjectedTokenPocketWallet,
  isOkxAppBrowser,
  isTokenPocketAppBrowser,
} from "@/lib/ethereumProviders";

export const PRIVY_WALLET_LIST: WalletListEntry[] = [
  "detected_ethereum_wallets",
  "okx_wallet",
  "coinbase_wallet",
  "base_account",
  "metamask",
  "rainbow",
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
  "okx_wallet",
  "base_account",
  "coinbase_wallet",
  "metamask",
  "rainbow",
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
  const hasOkxRuntime = hasInjectedOkxWallet() || isOkxAppBrowser();
  const hasTokenPocketRuntime =
    hasInjectedTokenPocketWallet() || isTokenPocketAppBrowser();
  const nextWalletList = mobileRuntime
    ? getMobileWalletList(walletList)
    : walletList;

  if (isTokenPocketAppBrowser()) {
    return prioritizeWallet(nextWalletList, "detected_ethereum_wallets");
  }

  if (isOkxAppBrowser()) {
    return uniqueWalletList([
      "detected_ethereum_wallets",
      ...nextWalletList.filter(
        (wallet) =>
          wallet !== "detected_ethereum_wallets" &&
          wallet !== "okx_wallet"
      ),
    ]);
  }

  if (mobileRuntime) {
    if (hasTokenPocketRuntime) {
      return prioritizeWallet(nextWalletList, "detected_ethereum_wallets");
    }

    return hasOkxRuntime
      ? prioritizeWallet(nextWalletList, "okx_wallet")
      : nextWalletList;
  }

  if (!hasOkxRuntime && !hasTokenPocketRuntime) {
    return walletList;
  }

  if (hasTokenPocketRuntime) {
    return prioritizeWallet(nextWalletList, "detected_ethereum_wallets");
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

// Bug #2C kill-switch: set NEXT_PUBLIC_DISABLE_WALLET_RECONCILE=1 to fall back
// to the previous (connect-only) activation behavior if reconciliation ever
// misbehaves. Defaults to enabled because reconciliation is the actual fix.
const WALLET_RECONCILE_ENABLED =
  process.env.NEXT_PUBLIC_DISABLE_WALLET_RECONCILE !== "1";

// Backoff schedule (ms) used to retry promoting the Privy wallet into wagmi.
// The wagmi connector is set up asynchronously by @privy-io/wagmi, so the first
// setActiveWallet call can be a no-op; we retry until wagmi reports connected.
const WALLET_RECONCILE_RETRY_DELAYS_MS = [0, 150, 300, 600, 1200, 2400];

function PrivyWalletConnectionProvider({ children }: { children: ReactNode }) {
  const { ready } = usePrivy();
  const { wallet } = useActiveWallet();
  const { wallets } = useWallets();
  const { setActiveWallet } = useSetActiveWallet();
  const { address: wagmiAddress, status: wagmiStatus } = useAccount();
  const { connectWallet } = useConnectWallet({
    onSuccess: async ({ wallet: connectedWallet }) => {
      if (connectedWallet.type === "ethereum") {
        try {
          // Fast path: bind the just-connected wallet to wagmi immediately.
          // The reconciliation effect below is the safety net when this call
          // lands before the wagmi connector is set up, or on reconnectOnMount.
          await setActiveWallet(connectedWallet as ConnectedWallet);
        } catch {
          // Swallow: reconciliation will retry. Leaving a dead Privy↔wagmi
          // state here is what previously caused "Connect a wallet first".
        }
      }
    },
  });

  // ── Bug #2A: don't open the modal until Privy has finished initializing ──
  // (its WalletConnect + connector bootstrap). Tapping "Connect" before Privy
  // is ready could surface a blank/blurred backdrop that needed a second tap.
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const openWalletModal = useCallback(
    async (description?: string, walletList?: WalletListEntry[]) => {
      if (!readyRef.current) {
        const deadline = Date.now() + 4000;
        while (!readyRef.current && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      const nextWalletList = getRuntimeWalletList(walletList ?? PRIVY_WALLET_LIST);
      connectWallet({
        description,
        walletList: nextWalletList,
        walletChainType: "ethereum-only",
      });
    },
    [connectWallet]
  );

  // ── Bug #2C: deterministic Privy → wagmi reconciliation ──────────────────
  // OKX (and every external wallet) connects through Privy, but the wagmi
  // walletClient only exists once the matching connector is *active* in wagmi.
  // @privy-io/wagmi's setActiveWallet only binds wagmi if it finds a connector
  // whose getAccounts() already includes the address, and those connectors are
  // set up asynchronously. On the connect race AND on reconnectOnMount the
  // binding can be missed, leaving useWalletClient() null while Privy reports a
  // connected wallet — the exact desync behind "Connect a wallet first" on the
  // Sweep panel. We watch both sides and retry setActiveWallet until wagmi's
  // account matches the Privy wallet, so wagmi stays the single source of truth.
  const targetWallet = useMemo<ConnectedWallet | null>(() => {
    const connected = wallets ?? [];
    if (connected.length === 0) {
      return null;
    }
    // Prefer Privy's active wallet; otherwise bind the first connected wallet.
    if (wallet?.address) {
      const match = connected.find(
        (entry) => entry.address.toLowerCase() === wallet.address.toLowerCase()
      );
      if (match) {
        return match;
      }
    }
    return connected[0] ?? null;
  }, [wallets, wallet]);

  const targetAddress = targetWallet?.address?.toLowerCase() ?? null;
  const wagmiBound =
    wagmiStatus === "connected" &&
    !!wagmiAddress &&
    !!targetAddress &&
    wagmiAddress.toLowerCase() === targetAddress;
  // Don't fight wagmi while it is mid-(re)connect; re-evaluate when it settles.
  const wagmiBusy = wagmiStatus === "connecting" || wagmiStatus === "reconnecting";
  const needsReconcile =
    WALLET_RECONCILE_ENABLED && !!targetAddress && !wagmiBound && !wagmiBusy;

  const targetWalletRef = useRef<ConnectedWallet | null>(targetWallet);
  targetWalletRef.current = targetWallet;

  useEffect(() => {
    if (!needsReconcile || !targetAddress) {
      return;
    }

    let cancelled = false;

    void (async () => {
      for (const delayMs of WALLET_RECONCILE_RETRY_DELAYS_MS) {
        if (cancelled) {
          return;
        }
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        if (cancelled) {
          return;
        }
        const candidate = targetWalletRef.current;
        if (!candidate || candidate.address.toLowerCase() !== targetAddress) {
          // Target changed underneath us; a fresh effect will reconcile it.
          return;
        }
        try {
          await setActiveWallet(candidate);
        } catch {
          // Connector likely not set up yet; the next retry picks it up.
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // `needsReconcile` flips to false as soon as wagmi reports the target as
    // connected, which cancels the in-flight retry loop via the cleanup above.
  }, [needsReconcile, targetAddress, setActiveWallet]);

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
