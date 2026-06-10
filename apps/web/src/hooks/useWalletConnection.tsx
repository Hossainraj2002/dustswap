"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
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
import { useAccount, useDisconnect } from "wagmi";
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

// Put the injected provider first and drop okx_wallet, so an injected OKX
// connects natively instead of being routed back through WalletConnect.
function collapseToInjectedProvider(walletList: WalletListEntry[]) {
  return uniqueWalletList([
    "detected_ethereum_wallets",
    ...walletList.filter(
      (wallet) =>
        wallet !== "detected_ethereum_wallets" && wallet !== "okx_wallet"
    ),
  ]);
}

function getRuntimeWalletList(walletList: WalletListEntry[]) {
  const mobileRuntime = isMobileRuntime();
  // OKX is directly available: desktop extension OR the OKX in-app browser. We
  // detect via the injected provider AND the OKApp user-agent, because some OKX
  // in-app browser builds expose the provider but NOT the OKApp UA token.
  const okxNative = hasInjectedOkxWallet() || isOkxAppBrowser();
  const tokenPocketNative =
    hasInjectedTokenPocketWallet() || isTokenPocketAppBrowser();
  const nextWalletList = mobileRuntime
    ? getMobileWalletList(walletList)
    : walletList;

  // TokenPocket in-app/injected → connect through the injected provider.
  if (tokenPocketNative) {
    return prioritizeWallet(nextWalletList, "detected_ethereum_wallets");
  }

  // Bug #2: when OKX is injected (extension or its in-app browser) connect via
  // the injected provider and DROP the okx_wallet entry — on mobile AND desktop.
  // Previously, mobile only collapsed when the OKApp UA matched; if it didn't,
  // okx_wallet stayed and routed OKX through WalletConnect, stalling on "Waiting
  // for OKX Wallet…" even though OKX was right there. The injected provider now
  // always wins when present.
  if (okxNative) {
    return collapseToInjectedProvider(nextWalletList);
  }

  // No injected wallet. On a plain mobile browser keep okx_wallet so OKX stays
  // reachable through the WalletConnect deep link; on desktop keep the full list.
  return nextWalletList;
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
  activeWallet: {
    address?: string;
    connectorType?: string;
    meta?: { id?: string; name?: string };
    walletClientType?: string;
  } | null;
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
  const { ready, authenticated, logout } = usePrivy();
  const { wallet } = useActiveWallet();
  const { wallets } = useWallets();
  const { setActiveWallet } = useSetActiveWallet();
  const { address: wagmiAddress, status: wagmiStatus } = useAccount();
  const { disconnectAsync } = useDisconnect();
  // ── Sticky manual-disconnect latch ───────────────────────────────────────
  // When the user clicks "Disconnect" we must keep the Privy→wagmi
  // reconciliation effect OFF until they intentionally connect again. A plain
  // ref reset in a `finally` was not enough: `wallet.disconnect()` resolving
  // does NOT mean React's useWallets() has emptied yet, so a later render still
  // saw a connected Privy wallet + a disconnected wagmi and the reconcile loop
  // instantly re-bound the wallet — which is exactly why "Disconnect" looked
  // like it did nothing. We use state (re-renders, recomputes needsReconcile)
  // plus a ref mirror (read synchronously inside the retry loop).
  const [reconcilePaused, setReconcilePaused] = useState(true);
  const reconcilePausedRef = useRef(true);
  const [allowedReconcileAddress, setAllowedReconcileAddress] = useState<
    string | null
  >(null);
  const allowedReconcileAddressRef = useRef<string | null>(null);
  const pauseReconcile = useCallback(() => {
    reconcilePausedRef.current = true;
    setReconcilePaused(true);
  }, []);
  const resumeReconcile = useCallback(() => {
    reconcilePausedRef.current = false;
    setReconcilePaused(false);
  }, []);
  const setAllowedAddress = useCallback((address?: string | null) => {
    const normalized = address?.toLowerCase() ?? null;
    allowedReconcileAddressRef.current = normalized;
    setAllowedReconcileAddress(normalized);
  }, []);

  const { connectWallet } = useConnectWallet({
    onSuccess: async ({ wallet: connectedWallet }) => {
      setAllowedAddress(connectedWallet.address);
      // The user intentionally selected this wallet, so reconnect wagmi to it.
      resumeReconcile();
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
      // Opening the picker is not a completed wallet choice. Keep reconciliation
      // paused until Privy's onSuccess returns the wallet the user selected.
      pauseReconcile();
      setAllowedAddress(null);
      await disconnectAsync().catch(() => {});
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
    [connectWallet, disconnectAsync, pauseReconcile, setAllowedAddress]
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
    if (allowedReconcileAddress) {
      const allowed = connected.find(
        (entry) => entry.address.toLowerCase() === allowedReconcileAddress
      );
      if (allowed) {
        return allowed;
      }
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
  }, [wallets, wallet, allowedReconcileAddress]);

  const targetAddress = targetWallet?.address?.toLowerCase() ?? null;
  const wagmiBound =
    wagmiStatus === "connected" &&
    !!wagmiAddress &&
    !!targetAddress &&
    wagmiAddress.toLowerCase() === targetAddress;
  // Don't fight wagmi while it is mid-(re)connect; re-evaluate when it settles.
  const wagmiBusy = wagmiStatus === "connecting" || wagmiStatus === "reconnecting";
  const needsReconcile =
    WALLET_RECONCILE_ENABLED &&
    !reconcilePaused &&
    !!targetAddress &&
    allowedReconcileAddress === targetAddress &&
    !wagmiBound &&
    !wagmiBusy;

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
        if (cancelled || reconcilePausedRef.current) {
          return;
        }
        if (allowedReconcileAddressRef.current !== targetAddress) {
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
    // Latch reconciliation OFF and keep it off — do NOT reset in a finally.
    // It stays paused until the user explicitly connects again (openWalletModal
    // / connect onSuccess). This is what makes "Disconnect" actually stick.
    pauseReconcile();
    setAllowedAddress(null);
    // 1) Disconnect every Privy-connected wallet (not just the active one), so
    //    Privy's wallet set empties and it won't auto-reconnect on next mount.
    await Promise.allSettled(
      (wallets ?? []).map((entry) => entry.disconnect())
    );
    // 2) Drop the wagmi connection — this is the source of truth the "connected"
    //    pill reads via useAccount(); without it the UI stays stuck on the
    //    address. Disconnect the active connection and any lingering connectors.
    await disconnectAsync().catch(() => {});
    // 3) If an authenticated Privy session exists (embedded/login flows), end it
    //    too so reconnectOnMount can't restore the wallet. No-op for the common
    //    connect-only path where `authenticated` is false.
    if (authenticated) {
      await logout().catch(() => {});
    }
  }, [
    wallets,
    disconnectAsync,
    authenticated,
    logout,
    pauseReconcile,
    setAllowedAddress,
  ]);

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
