"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type Address } from "viem";
import { getSweepChain } from "@/config/sweepChainConfig";
import {
  type DustSweepTokensResponse,
  type SwappableToken,
  type UnavailableToken,
} from "@/types/dustsweep";

export type TokenBalanceScanState = {
  phase: "idle" | "scanning" | "ready" | "error";
  message: string;
  discoveredCount: number;
  refreshedAt?: string;
  elapsedMs?: number;
  walletAddress?: Address;
};

export type TokenBalanceRefetchOptions = {
  force?: boolean;
};

type TokenBalanceState = {
  swappableTokens: SwappableToken[];
  unavailableTokens: UnavailableToken[];
  isLoading: boolean;
  error: string | null;
  scan: TokenBalanceScanState;
  refetch: (options?: TokenBalanceRefetchOptions) => Promise<void>;
};

const BALANCE_SCAN_TIMEOUT_MS = 180_000;

function normalizeTokenPayload(payload: unknown): DustSweepTokensResponse {
  const data =
    payload &&
    typeof payload === "object" &&
    "data" in payload &&
    (payload as { data?: unknown }).data
      ? (payload as { data: unknown }).data
      : payload;

  if (!data || typeof data !== "object") {
    return { swappable: [], unavailable: [] };
  }

  const response = data as Partial<DustSweepTokensResponse>;
  const unavailable = [
    ...(Array.isArray(response.unavailable) ? response.unavailable : []),
    ...(Array.isArray(response.hidden) ? response.hidden : []),
    ...(Array.isArray(response.suspicious) ? response.suspicious : []),
    ...(Array.isArray(response.excludedOutputAssets) ? response.excludedOutputAssets : []),
  ];
  const unavailableByAddress = new Map(
    unavailable.map((token) => [token.address.toLowerCase(), token]),
  );

  return {
    swappable: Array.isArray(response.swappable) ? response.swappable : [],
    unavailable: Array.from(unavailableByAddress.values()),
    hidden: Array.isArray(response.hidden) ? response.hidden : [],
    suspicious: Array.isArray(response.suspicious) ? response.suspicious : [],
    excludedOutputAssets: Array.isArray(response.excludedOutputAssets)
      ? response.excludedOutputAssets
      : [],
    refreshedAt: response.refreshedAt,
    chainId: response.chainId,
    discovery: response.discovery,
  };
}

export function useTokenBalances(address?: Address, chainId = 8453): TokenBalanceState {
  const [swappableTokens, setSwappableTokens] = useState<SwappableToken[]>([]);
  const [unavailableTokens, setUnavailableTokens] = useState<UnavailableToken[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState<TokenBalanceScanState>({
    phase: "idle",
    message: "Connect a wallet to scan balances.",
    discoveredCount: 0,
  });
  const requestSeqRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);
  const activeAddressRef = useRef<string | null>(null);
  const lastDiscoveredCountRef = useRef(0);

  const refetch = useCallback(async (options?: TokenBalanceRefetchOptions) => {
    if (!address) {
      requestSeqRef.current += 1;
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
      activeAddressRef.current = null;
      lastDiscoveredCountRef.current = 0;
      setSwappableTokens([]);
      setUnavailableTokens([]);
      setError(null);
      setIsLoading(false);
      setScan({
        phase: "idle",
        message: "Connect a wallet to scan balances.",
        discoveredCount: 0,
      });
      return;
    }

    const normalizedAddress = address.toLowerCase();
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    activeControllerRef.current?.abort();
    const controller = new AbortController();
    activeControllerRef.current = controller;
    const requestKey = `${chainId}:${normalizedAddress}`;
    const isNewAddress = activeAddressRef.current !== requestKey;
    activeAddressRef.current = requestKey;
    const startedAt = Date.now();
    const isCurrentSequence = () =>
      requestSeqRef.current === requestSeq &&
      activeAddressRef.current === requestKey;
    const isCurrentRequest = () => isCurrentSequence() && !controller.signal.aborted;

    if (isNewAddress) {
      lastDiscoveredCountRef.current = 0;
      setSwappableTokens([]);
      setUnavailableTokens([]);
    }

    setIsLoading(true);
    setError(null);
    setScan({
      phase: "scanning",
      message: `Finding ${getSweepChain(chainId).label} balances...`,
      discoveredCount: lastDiscoveredCountRef.current,
      walletAddress: address,
    });

    const slowTimer = window.setTimeout(() => {
      if (!isCurrentRequest()) return;
      setScan((current) => ({
        ...current,
        phase: "scanning",
        message: "Still scanning token balances...",
      }));
    }, 4_000);

    const verySlowTimer = window.setTimeout(() => {
      if (!isCurrentRequest()) return;
      setScan((current) => ({
        ...current,
        phase: "scanning",
        message: "Checking prices and sweep routes...",
      }));
    }, 9_000);

    const timeout = window.setTimeout(() => {
      controller.abort();
    }, BALANCE_SCAN_TIMEOUT_MS);

    try {
      const params = new URLSearchParams({
        address,
        chainId: String(chainId),
      });
      if (options?.force) {
        params.set("refresh", "1");
      }
      const response = await fetch(`/api/dustsweep/tokens?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);

      if (!isCurrentRequest()) return;

      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error?: unknown }).error)
            : "Failed to load wallet tokens";
        throw new Error(message);
      }

      const normalized = normalizeTokenPayload(payload);
      const discoveredCount =
        normalized.discovery?.erc20BalanceCount ??
        normalized.swappable.length + normalized.unavailable.length;
      lastDiscoveredCountRef.current = discoveredCount;
      setSwappableTokens(normalized.swappable);
      setUnavailableTokens(normalized.unavailable);
      setScan({
        phase: "ready",
        message: normalized.discovery?.stale ? "Showing last scanned balances." : "Balances ready.",
        discoveredCount,
        refreshedAt: normalized.refreshedAt,
        elapsedMs: normalized.discovery?.elapsedMs ?? Date.now() - startedAt,
        walletAddress: address,
      });
    } catch (fetchError) {
      if (!isCurrentSequence()) {
        return;
      }
      if (isNewAddress || lastDiscoveredCountRef.current === 0) {
        setSwappableTokens([]);
        setUnavailableTokens([]);
      }
      const message =
        controller.signal.aborted
          ? "Balance scan timed out. Try refreshing."
          : fetchError instanceof Error
          ? fetchError.message
          : "Failed to load wallet tokens";
      setError(message);
      setScan({
        phase: "error",
        message,
        discoveredCount: isNewAddress ? 0 : lastDiscoveredCountRef.current,
        walletAddress: address,
      });
    } finally {
      window.clearTimeout(slowTimer);
      window.clearTimeout(verySlowTimer);
      window.clearTimeout(timeout);
      if (activeControllerRef.current === controller) {
        activeControllerRef.current = null;
      }
      if (isCurrentSequence()) {
        setIsLoading(false);
      }
    }
    // chainId in deps: switching the sweep chain re-scans against the new network.
  }, [address, chainId]);

  useEffect(() => {
    void refetch();
    return () => {
      activeControllerRef.current?.abort();
    };
  }, [refetch]);

  return {
    swappableTokens,
    unavailableTokens,
    isLoading,
    error,
    scan,
    refetch,
  };
}
