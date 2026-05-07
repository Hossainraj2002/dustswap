"use client";

import { useCallback, useEffect, useState } from "react";
import { type Address } from "viem";
import {
  type DustSweepTokensResponse,
  type SwappableToken,
  type UnavailableToken,
} from "@/types/dustsweep";

type TokenBalanceState = {
  swappableTokens: SwappableToken[];
  unavailableTokens: UnavailableToken[];
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
};

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
  return {
    swappable: Array.isArray(response.swappable) ? response.swappable : [],
    unavailable: Array.isArray(response.unavailable) ? response.unavailable : [],
  };
}

export function useTokenBalances(address?: Address): TokenBalanceState {
  const [swappableTokens, setSwappableTokens] = useState<SwappableToken[]>([]);
  const [unavailableTokens, setUnavailableTokens] = useState<UnavailableToken[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!address) {
      setSwappableTokens([]);
      setUnavailableTokens([]);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/dustsweep/tokens/${address}`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error?: unknown }).error)
            : "Failed to load wallet tokens";
        throw new Error(message);
      }

      const normalized = normalizeTokenPayload(payload);
      setSwappableTokens(normalized.swappable);
      setUnavailableTokens(normalized.unavailable);
    } catch (fetchError) {
      setSwappableTokens([]);
      setUnavailableTokens([]);
      setError(
        fetchError instanceof Error
          ? fetchError.message
          : "Failed to load wallet tokens",
      );
    } finally {
      setIsLoading(false);
    }
  }, [address]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return {
    swappableTokens,
    unavailableTokens,
    isLoading,
    error,
    refetch,
  };
}
