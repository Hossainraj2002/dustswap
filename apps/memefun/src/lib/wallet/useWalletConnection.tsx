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
import { useAccount, useConfig, useDisconnect } from "wagmi";
import { toast } from "sonner";
import { activatePrivyWallet } from "./activateWallet";
import {
  ensureOkxEip6963Shim,
  hasAnyInjectedEthereumProvider,
  hasInjectedOkxWallet,
  hasInjectedTokenPocketWallet,
  isOkxAppBrowser,
  isTokenPocketAppBrowser,
  waitForInjectedProvider,
} from "@/lib/wallet/ethereumProviders";

// How long to wait on mobile for an in-app wallet browser to inject its provider
// before building the wallet list. OKX's in-app browser injects a bit after load;
// too short a window keeps the WalletConnect okx_wallet entry that stalls on
// "Waiting for OKX Wallet…". Resolves instantly once a provider appears, so only
// a plain browser (no wallet) ever waits the whole window.
const WALLET_INJECTION_WAIT_MS = 2500;

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

  // Safety net for in-app wallet browsers where the OKX-specific signals were
  // missed — e.g. the UA lacks "OKApp" AND window.okxwallet/EIP-6963 injected a
  // beat late. On mobile, ANY injected EVM provider means we are inside a
  // wallet's in-app browser (a plain Chrome/Safari injects nothing), so connect
  // through that injected provider and DROP the WalletConnect okx_wallet entry,
  // which would otherwise strand the user on Privy's "Waiting for OKX Wallet…"
  // relay screen — the exact failure reported from the OKX in-app browser.
  if (mobileRuntime && hasAnyInjectedEthereumProvider()) {
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
  isConnecting: boolean;
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
  isConnecting: false,
  openWalletModal: noopAsync,
  supportsBaseAccountFeatures: false,
};

const WalletConnectionContext = createContext<WalletConnectionContextValue>(
  FALLBACK_WALLET_CONNECTION
);

// Bounded retries for a selected provider that is still initializing.
const WALLET_RECONCILE_RETRY_DELAYS_MS = [0, 150, 300, 600, 1200, 2400];
const MANUAL_DISCONNECT_STORAGE_KEY = "memefun:wallet-manual-disconnect";
const SELECTED_WALLET_STORAGE_KEY = "memefun:selected-wallet-v1";

function rememberSelectedWallet(wallet: ConnectedWallet) {
  try {
    window.localStorage.setItem(SELECTED_WALLET_STORAGE_KEY, JSON.stringify({ address: wallet.address.toLowerCase(), id: wallet.meta.id }));
  } catch { /* Storage is optional in private browsing. */ }
}

function previouslySelectedWallet(wallets: ConnectedWallet[], recentId: string | null | undefined) {
  let selected: { address?: string; id?: string } | null = null;
  try { selected = JSON.parse(window.localStorage.getItem(SELECTED_WALLET_STORAGE_KEY) ?? "null"); } catch { /* Ignore malformed/blocked storage. */ }
  if (selected?.address && selected.id) {
    return wallets.find(entry => entry.address.toLowerCase() === selected!.address && entry.meta.id === selected!.id) ?? null;
  }
  const matches = recentId ? wallets.filter(entry => (entry.walletClientType === "privy" ? `${entry.meta.id}.${entry.address}` : entry.meta.id) === recentId) : wallets;
  return matches.length === 1 ? matches[0]! : null;
}

function hasManualDisconnectMarker() {
  if (typeof window === "undefined") return false;
  try {
    return Boolean(window.localStorage.getItem(MANUAL_DISCONNECT_STORAGE_KEY));
  } catch {
    return false;
  }
}

function writeManualDisconnectMarker() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MANUAL_DISCONNECT_STORAGE_KEY, String(Date.now()));
  } catch {
    // Storage can be blocked in private mode; the in-memory latch still works.
  }
}

function clearManualDisconnectMarker() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(MANUAL_DISCONNECT_STORAGE_KEY);
  } catch {
    // Storage can be blocked in private mode; the in-memory latch still works.
  }
}

function PrivyWalletConnectionProvider({ children }: { children: ReactNode }) {
  const { ready, authenticated, logout } = usePrivy();
  const { wallet } = useActiveWallet();
  const { wallets, ready: walletsReady } = useWallets();
  const hasWallets = wallets.length > 0;
  const config = useConfig();
  const { address: wagmiAddress, status: wagmiStatus, connector: wagmiConnector } = useAccount();
  const { disconnectAsync } = useDisconnect();
  const setActiveWalletRef = useRef<(selected: ConnectedWallet) => Promise<void>>(async () => {});
  const activationAttemptsRef = useRef({ address: null as string | null, count: 0 });
  const [activationVersion, setActivationVersion] = useState(0);
  const openingRef = useRef<Promise<void> | null>(null);
  const connectionGenerationRef = useRef(0);
  const restoreStartedRef = useRef(false);
  const selectedWalletIdRef = useRef<string | null>(null);
  const [activating, setActivating] = useState(false);
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
  const manualDisconnectRef = useRef(hasManualDisconnectMarker());
  const walletsRef = useRef(wallets);
  walletsRef.current = wallets;
  const [allowedReconcileAddress, setAllowedReconcileAddress] = useState<
    string | null
  >(null);
  const allowedReconcileAddressRef = useRef<string | null>(null);
  const pauseReconcile = useCallback(() => {
    setActivating(false);
    reconcilePausedRef.current = true;
    setReconcilePaused(true);
  }, []);
  const resumeReconcile = useCallback(() => {
    setActivating(true);
    reconcilePausedRef.current = false;
    setReconcilePaused(false);
  }, []);
  const setAllowedAddress = useCallback((address?: string | null) => {
    const normalized = address?.toLowerCase() ?? null;
    if (!normalized) selectedWalletIdRef.current = null;
    allowedReconcileAddressRef.current = normalized;
    setAllowedReconcileAddress(normalized);
  }, []);
  const markManualDisconnected = useCallback(() => {
    manualDisconnectRef.current = true;
    writeManualDisconnectMarker();
  }, []);
  const clearManualDisconnected = useCallback(() => {
    manualDisconnectRef.current = false;
    clearManualDisconnectMarker();
  }, []);

  setActiveWalletRef.current = async selected => {
    const generation = connectionGenerationRef.current;
    const isCurrent = () => generation === connectionGenerationRef.current && !manualDisconnectRef.current && allowedReconcileAddressRef.current === selected.address.toLowerCase() && selectedWalletIdRef.current === selected.meta.id;
    await activatePrivyWallet(config, selected, isCurrent);
    if (isCurrent()) rememberSelectedWallet(selected);
  };

  // Restore at most one previously selected wallet after Privy has finished
  // loading its wallets. Changing SDK array/object identities is not a request
  // to reconnect, and an ambiguous wallet list never silently chooses an account.
  useEffect(() => {
    if (!ready || !walletsReady || !hasWallets || restoreStartedRef.current) return;
    restoreStartedRef.current = true;
    if (manualDisconnectRef.current) return;
    const generation = connectionGenerationRef.current;
    let disposed = false;
    let finished = false;
    void (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const recentId = await Promise.race([
        Promise.resolve(config.storage?.getItem("recentConnectorId")).catch(() => null),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1_000); }),
      ]);
      if (timer) clearTimeout(timer);
      if (disposed || generation !== connectionGenerationRef.current || manualDisconnectRef.current) return;
      finished = true;
      const selected = previouslySelectedWallet(walletsRef.current.filter(entry => entry.type === "ethereum"), recentId);
      if (!selected) return;
      selectedWalletIdRef.current = selected.meta.id;
      activationAttemptsRef.current = { address: selected.address.toLowerCase(), count: 0 };
      setActivationVersion(version => version + 1);
      setAllowedAddress(selected.address);
      resumeReconcile();
    })();
    return () => {
      disposed = true;
      // React Strict Mode replays mount effects before the async storage read
      // completes. The replay can restore once; array churn cannot restart it.
      if (!finished) restoreStartedRef.current = false;
    };
  }, [config, ready, walletsReady, hasWallets, resumeReconcile, setAllowedAddress]);

  const { connectWallet } = useConnectWallet({
    onSuccess: async ({ wallet: connectedWallet }) => {
      if (manualDisconnectRef.current) {
        try {
          await Promise.resolve(connectedWallet.disconnect());
        } catch {
          // The manual-disconnect latch is already set; ignore stale cleanup errors.
        }
        await disconnectAsync().catch(() => {});
        return;
      }
      if (connectedWallet.type !== "ethereum") return;
      restoreStartedRef.current = true;
      const selectedAddress = connectedWallet.address.toLowerCase();
      // Duplicate SDK notifications for the same selection aren't new attempts.
      if (!reconcilePausedRef.current && allowedReconcileAddressRef.current === selectedAddress && selectedWalletIdRef.current === connectedWallet.meta.id) return;
      selectedWalletIdRef.current = connectedWallet.meta.id;
      activationAttemptsRef.current = { address: selectedAddress, count: 0 };
      setActivationVersion((version) => version + 1);
      setAllowedAddress(connectedWallet.address);
      // One activation schedule owns this choice. Starting a second activation
      // here races both the retry effect and Privy's own connector bootstrap.
      resumeReconcile();
    },
  });

  // ── Bug #2A: don't open the modal until Privy has finished initializing ──
  // (its WalletConnect + connector bootstrap). Tapping "Connect" before Privy
  // is ready could surface a blank/blurred backdrop that needed a second tap.
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const openWalletModal = useCallback(
    (description?: string, walletList?: WalletListEntry[]) => {
      if (openingRef.current) return openingRef.current;
      restoreStartedRef.current = true;
      const generation = ++connectionGenerationRef.current;
      const opening = (async () => {
        // Opening the picker is not a completed wallet choice. Keep reconciliation
        // paused until Privy's onSuccess returns the wallet the user selected.
        clearManualDisconnected();
        pauseReconcile();
        setAllowedAddress(null);
        await disconnectAsync().catch(() => {});
        if (!readyRef.current) {
          const deadline = Date.now() + 4000;
          while (!readyRef.current && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        if (!readyRef.current) {
          throw new Error("Your wallet connection is still loading. Please try again.");
        }
        // On mobile, give an in-app wallet browser time to inject its provider
        // before we decide the wallet list. OKX's in-app browser announces via
        // EIP-6963 / window.okxwallet after load; if we read too early,
        // getRuntimeWalletList() misses OKX and keeps the WalletConnect okx_wallet
        // entry that strands the user on "Waiting for OKX Wallet…" (the reported
        // failure). The wait returns the instant a provider appears, so a desktop
        // extension or an already-injected in-app browser sees no delay — only a
        // plain browser (which never injects) waits out the window. We allow a
        // generous window so a slightly-late OKX injection is still caught.
        // Install the EIP-6963 responder early (idempotent; usually a no-op now
        // because OKX injects a beat after load).
        ensureOkxEip6963Shim();
        let okxAnnounced = false;
        if (isMobileRuntime()) {
          // Wait for OKX's in-app browser to inject its provider…
          await waitForInjectedProvider(WALLET_INJECTION_WAIT_MS);
          // …then PROACTIVELY announce it to Privy's EIP-6963 (mipd) store. mipd
          // only auto-requests providers once at startup (before OKX exists), so
          // this post-injection announcement is the one that actually lands OKX in
          // Privy — making the picker offer the NATIVE injected OKX instead of the
          // WalletConnect relay that stalls on "Waiting for OKX Wallet…".
          okxAnnounced = ensureOkxEip6963Shim();
          // Give Privy's reactive mipd subscription a beat to fold OKX into its
          // connector list before we open the picker.
          if (okxAnnounced) {
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
        }
        const nextWalletList = getRuntimeWalletList(walletList ?? PRIVY_WALLET_LIST);
        if (generation !== connectionGenerationRef.current || manualDisconnectRef.current) return;
        // Lightweight, PII-free trace so an OKX-in-app-browser connect can be
        // diagnosed if it still misbehaves. Visible in the console for remote
        // inspection, and — only when the page is opened with ?wldebug=1 — shown
        // on-screen via alert() so it can be screenshotted from a phone where the
        // console is not reachable. The query flag is opt-in; normal users never
        // see it.
        const okxInjected =
          typeof window !== "undefined" &&
          !!(window as { okxwallet?: unknown }).okxwallet;
        const walletModalTrace = `[memefun] wallet modal: mobile=${isMobileRuntime()} injected=${hasAnyInjectedEthereumProvider()} okxApp=${isOkxAppBrowser()} okxwallet=${okxInjected} okxAnnounced=${okxAnnounced} list=${nextWalletList.join(",")}`;
        console.info(walletModalTrace);
        if (
          typeof window !== "undefined" &&
          window.location.search.includes("wldebug=1")
        ) {
          window.alert(walletModalTrace);
        }
        connectWallet({
          description,
          walletList: nextWalletList,
          walletChainType: "ethereum-only",
        });
      })();
      openingRef.current = opening;
      void opening.finally(() => {
        if (openingRef.current === opening) openingRef.current = null;
      }).catch(() => {});
      return opening;
    },
    [clearManualDisconnected, connectWallet, disconnectAsync, pauseReconcile, setAllowedAddress]
  );

  // One bounded activation schedule owns the selected Privy EIP-1193 provider.
  // The SDK's automatic wagmi synchronization is deliberately not mounted.
  const targetWallet: ConnectedWallet | null = (() => {
    const connected = wallets ?? [];
    if (connected.length === 0) {
      return null;
    }
    if (allowedReconcileAddress) {
      const allowed = connected.find(
        (entry) => entry.address.toLowerCase() === allowedReconcileAddress && entry.meta.id === selectedWalletIdRef.current
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
  })();

  const targetAddress = targetWallet?.address?.toLowerCase() ?? null;
  const wagmiBound =
    wagmiStatus === "connected" &&
    !!wagmiAddress &&
    !!targetAddress &&
    wagmiAddress.toLowerCase() === targetAddress &&
    !!targetWallet &&
    !!wagmiConnector?.id.startsWith(`memefun.${targetWallet.meta.id}.${targetAddress}.`);
  // Don't fight wagmi while it is mid-(re)connect; re-evaluate when it settles.
  const wagmiBusy = wagmiStatus === "connecting" || wagmiStatus === "reconnecting";
  const needsReconcile =
    !manualDisconnectRef.current &&
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
      const attempts = activationAttemptsRef.current;
      while (attempts.address === targetAddress && attempts.count < WALLET_RECONCILE_RETRY_DELAYS_MS.length) {
        const delayMs = WALLET_RECONCILE_RETRY_DELAYS_MS[attempts.count]!;
        if (cancelled) {
          return;
        }
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        if (cancelled || reconcilePausedRef.current || activationAttemptsRef.current !== attempts) {
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
          attempts.count++;
          await setActiveWalletRef.current(candidate);
        } catch (error) {
          // Pending native state cancels this effect's retry loop, but the last
          // failure must still end the UI's Connecting state for this selection.
          if (attempts.count === WALLET_RECONCILE_RETRY_DELAYS_MS.length && activationAttemptsRef.current === attempts && !manualDisconnectRef.current && allowedReconcileAddressRef.current === targetAddress) {
            pauseReconcile();
            toast.error(error instanceof Error ? error.message : "Your wallet could not connect. Please try again.");
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // `needsReconcile` flips to false as soon as wagmi reports the target as
    // connected, which cancels the in-flight retry loop via the cleanup above.
  }, [needsReconcile, targetAddress, activationVersion, pauseReconcile]);

  useEffect(() => { if (wagmiBound) setActivating(false); }, [wagmiBound]);

  useEffect(() => () => { connectionGenerationRef.current++; }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== MANUAL_DISCONNECT_STORAGE_KEY || !event.newValue) {
        return;
      }
      manualDisconnectRef.current = true;
      connectionGenerationRef.current++;
      pauseReconcile();
      setAllowedAddress(null);
      void Promise.allSettled(
        (walletsRef.current ?? []).map((entry) =>
          Promise.resolve().then(() => entry.disconnect())
        )
      );
      void disconnectAsync().catch(() => {});
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [disconnectAsync, pauseReconcile, setAllowedAddress]);

  const disconnectWallet = useCallback(async () => {
    connectionGenerationRef.current++;
    // Latch reconciliation OFF and keep it off — do NOT reset in a finally.
    // It stays paused until the user explicitly connects again (openWalletModal
    // / connect onSuccess). This is what makes "Disconnect" actually stick.
    markManualDisconnected();
    pauseReconcile();
    setAllowedAddress(null);
    // 1) Disconnect every Privy-connected wallet (not just the active one), so
    //    Privy's wallet set empties and it won't auto-reconnect on next mount.
    await Promise.allSettled(
      (wallets ?? []).map((entry) =>
        Promise.resolve().then(() => entry.disconnect())
      )
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
    markManualDisconnected,
    pauseReconcile,
    setAllowedAddress,
  ]);

  const value = useMemo<WalletConnectionContextValue>(
    () => ({
      activeWallet: targetWallet ?? wallet ?? null,
      disconnectWallet,
      isAvailable: true,
      isConnecting: activating,
      openWalletModal,
      supportsBaseAccountFeatures: supportsBaseAccountFeatures(targetWallet ?? wallet),
    }),
    [activating, disconnectWallet, openWalletModal, targetWallet, wallet]
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
