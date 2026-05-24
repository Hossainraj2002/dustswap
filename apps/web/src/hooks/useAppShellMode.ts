'use client';

import { useEffect, useLayoutEffect, useState } from 'react';
import { useAccount, useConnection, useWalletClient } from 'wagmi';

export type AppShellMode = 'top' | 'bottom';

const MOBILE_BREAKPOINT_PX = 768;
const BOTTOM_GAP_BUCKET_SIZE_PX = 8;
const BOTTOM_GAP_NOISE_THRESHOLD_PX = 8;
const BOTTOM_GAP_TOP_NAV_THRESHOLD_PX = 48;
const BOTTOM_GAP_TOP_SAMPLE_THRESHOLD = 2;
const BROWSER_BAR_STORAGE_KEY = 'ds-mobile-shell-browser-bar';
const SMART_WALLET_STORAGE_KEY_PREFIX = 'ds-smart-wallet-capability';
const STARTUP_DETECTION_WINDOW_MS = 800;
const SMART_WALLET_TOP_NAV_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.NEXT_PUBLIC_SMART_WALLET_TOP_NAV_ENABLED || '')
    .trim()
    .toLowerCase()
);

const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

type WalletCapabilitiesResult = Record<
  string,
  {
    atomic?: {
      supported?: string;
    };
    auxiliaryFunds?: {
      supported?: boolean;
    };
    paymasterService?: {
      supported?: boolean;
    };
  }
>;

type RequestArguments = {
  method: string;
  params?: unknown[];
};

type RequestCapableProvider = {
  request: (args: RequestArguments) => Promise<unknown>;
};

interface UseAppShellModeOptions {
  enabled: boolean;
}

function getSmartWalletStorageKey(address: string, chainId: number) {
  return `${SMART_WALLET_STORAGE_KEY_PREFIX}:${address.toLowerCase()}:${chainId}`;
}

function isMobileViewport() {
  return typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT_PX;
}

function readSessionValue(key: string) {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionValue(key: string, value: string) {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Ignore storage failures so the shell still renders.
  }
}

function toHexChainId(chainId: number) {
  return `0x${chainId.toString(16)}`.toLowerCase();
}

function getChainCapabilities(
  capabilities: WalletCapabilitiesResult | null,
  chainId: number
) {
  const targetChainId = toHexChainId(chainId);

  return capabilities
    ? Object.entries(capabilities).find(
        ([candidateChainId]) => candidateChainId.toLowerCase() === targetChainId
      )?.[1] ?? null
    : null;
}

function hasSmartWalletCapabilities(
  chainCapabilities: ReturnType<typeof getChainCapabilities>
) {
  if (!chainCapabilities) {
    return false;
  }

  return (
    chainCapabilities.paymasterService?.supported === true ||
    chainCapabilities.auxiliaryFunds?.supported === true ||
    chainCapabilities.atomic?.supported === 'supported' ||
    chainCapabilities.atomic?.supported === 'ready'
  );
}

function readBottomBrowserBarMode(): AppShellMode | null {
  const storedValue = readSessionValue(BROWSER_BAR_STORAGE_KEY);
  return storedValue === 'top' || storedValue === 'bottom' ? storedValue : null;
}

function readSmartWalletCapability(
  address: string | undefined,
  chainId: number | undefined
) {
  if (!address || !chainId) {
    return null;
  }

  const storedValue = readSessionValue(getSmartWalletStorageKey(address, chainId));
  if (storedValue === '1') {
    return true;
  }

  if (storedValue === '0') {
    return false;
  }

  return null;
}

function readViewportBottomGap() {
  const visualViewport = window.visualViewport;
  const layoutViewportHeight = Math.max(
    window.innerHeight,
    document.documentElement.clientHeight
  );
  const visibleViewportHeight = visualViewport?.height ?? layoutViewportHeight;
  const visibleViewportTop = visualViewport?.offsetTop ?? 0;

  return Math.round(
    Math.max(
      0,
      layoutViewportHeight - (visibleViewportTop + visibleViewportHeight)
    )
  );
}

function normalizeBottomGap(bottomGap: number) {
  if (bottomGap <= BOTTOM_GAP_NOISE_THRESHOLD_PX) {
    return 0;
  }

  return Math.round(bottomGap / BOTTOM_GAP_BUCKET_SIZE_PX) * BOTTOM_GAP_BUCKET_SIZE_PX;
}

async function resolveCapabilityRequester(
  connector: { getProvider?: (args?: { chainId?: number }) => Promise<unknown> } | null,
  chainId: number,
  walletClient: RequestCapableProvider | null
) {
  if (connector && typeof connector.getProvider === 'function') {
    try {
      const provider = (await connector.getProvider({
        chainId,
      })) as RequestCapableProvider | null;

      if (provider && typeof provider.request === 'function') {
        return provider;
      }
    } catch {
      // Fall through to the wallet client request path.
    }
  }

  if (walletClient && typeof walletClient.request === 'function') {
    return walletClient;
  }

  return null;
}

export function useAppShellMode({ enabled }: UseAppShellModeOptions): AppShellMode {
  const { address, chainId, isConnected } = useAccount();
  const connection = useConnection();
  const { data: walletClient } = useWalletClient();
  const [browserMode, setBrowserMode] = useState<AppShellMode>('bottom');
  const [smartWalletCapable, setSmartWalletCapable] = useState(false);

  useIsomorphicLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (!enabled || !isMobileViewport()) {
      setBrowserMode('bottom');
      return;
    }

    const cachedBrowserMode = readBottomBrowserBarMode();
    if (cachedBrowserMode) {
      setBrowserMode(cachedBrowserMode);
      return;
    }

    if (SMART_WALLET_TOP_NAV_ENABLED) {
      const cachedSmartWalletCapability = readSmartWalletCapability(address, chainId);
      if (cachedSmartWalletCapability === true) {
        setBrowserMode('bottom');
        return;
      }
    }

    if (!window.visualViewport) {
      writeSessionValue(BROWSER_BAR_STORAGE_KEY, 'bottom');
      setBrowserMode('bottom');
      return;
    }

    let frameId: number | null = null;
    let topGapSamples = 0;
    const startedAt = window.performance.now();

    const sampleBottomBar = () => {
      const normalizedBottomGap = normalizeBottomGap(readViewportBottomGap());
      if (normalizedBottomGap >= BOTTOM_GAP_TOP_NAV_THRESHOLD_PX) {
        topGapSamples += 1;
      }

      if (topGapSamples >= BOTTOM_GAP_TOP_SAMPLE_THRESHOLD) {
        writeSessionValue(BROWSER_BAR_STORAGE_KEY, 'top');
        setBrowserMode('top');
        return;
      }

      if (window.performance.now() - startedAt >= STARTUP_DETECTION_WINDOW_MS) {
        writeSessionValue(BROWSER_BAR_STORAGE_KEY, 'bottom');
        setBrowserMode('bottom');
        return;
      }

      frameId = window.requestAnimationFrame(sampleBottomBar);
    };

    frameId = window.requestAnimationFrame(sampleBottomBar);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [address, chainId, enabled]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (
      !SMART_WALLET_TOP_NAV_ENABLED ||
      !enabled ||
      !isMobileViewport() ||
      !isConnected ||
      !address ||
      !chainId
    ) {
      setSmartWalletCapable(false);
      return;
    }

    const cachedCapability = readSmartWalletCapability(address, chainId);
    if (cachedCapability !== null) {
      setSmartWalletCapable(cachedCapability);
      return;
    }

    let cancelled = false;
    setSmartWalletCapable(false);

    const loadCapabilities = async () => {
      const requester = await resolveCapabilityRequester(
        connection.connector ?? null,
        chainId,
        (walletClient as RequestCapableProvider | null) ?? null
      );

      if (!requester) {
        return;
      }

      try {
        const capabilities = (await requester.request({
          method: 'wallet_getCapabilities',
          params: [address],
        })) as WalletCapabilitiesResult | null;

        const nextSmartWalletCapable = hasSmartWalletCapabilities(
          getChainCapabilities(capabilities, chainId)
        );

        if (cancelled) {
          return;
        }

        writeSessionValue(
          getSmartWalletStorageKey(address, chainId),
          nextSmartWalletCapable ? '1' : '0'
        );
        setSmartWalletCapable(nextSmartWalletCapable);
      } catch {
        if (!cancelled) {
          setSmartWalletCapable(false);
        }
      }
    };

    void loadCapabilities();

    return () => {
      cancelled = true;
    };
  }, [
    address,
    chainId,
    connection.connector,
    enabled,
    isConnected,
    walletClient,
  ]);

  return SMART_WALLET_TOP_NAV_ENABLED && smartWalletCapable ? 'top' : browserMode;
}
