"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  SWEEP_CAMPAIGN_ENABLED,
  fetchCampaignLeaderboard,
  fetchCampaignStatus,
  invalidateCampaignCache,
  type CampaignLeaderboard,
  type CampaignStatus,
} from "@/lib/sweepCampaign";
import { subscribeToDataInvalidation } from "@/lib/clientEvents";

const AUTO_REFRESH_MS = 60 * 1000;
// Sweep verification is asynchronous (the API re-reads the tx on-chain), so a
// completed sweep shows up in campaign volume seconds later — poll a few times.
const POST_SWEEP_REFRESH_DELAYS_MS = [5_000, 20_000, 60_000];

export function useSweepCampaign(address?: string | null) {
  const [status, setStatus] = useState<CampaignStatus | null>(null);
  const [leaderboard, setLeaderboard] = useState<CampaignLeaderboard | null>(null);
  const [isLoading, setIsLoading] = useState(SWEEP_CAMPAIGN_ENABLED);
  const isMountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      for (const timer of timersRef.current) {
        clearTimeout(timer);
      }
      timersRef.current = [];
    };
  }, []);

  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      if (!SWEEP_CAMPAIGN_ENABLED) return;

      const requestId = ++requestIdRef.current;
      try {
        if (options?.force) {
          invalidateCampaignCache();
        }
        const nextStatus = await fetchCampaignStatus(address, options);
        if (!isMountedRef.current || requestId !== requestIdRef.current) return;
        setStatus(nextStatus);

        if (nextStatus.campaign) {
          const nextLeaderboard = await fetchCampaignLeaderboard({
            viewerAddress: address,
          });
          if (!isMountedRef.current || requestId !== requestIdRef.current) return;
          setLeaderboard(nextLeaderboard);
        }
      } catch {
        // Campaign UI is additive — the sweep page must never break because
        // the campaign API is unreachable. Keep the last good state.
      } finally {
        if (isMountedRef.current && requestId === requestIdRef.current) {
          setIsLoading(false);
        }
      }
    },
    [address]
  );

  // Post-sweep: verification lands asynchronously — schedule delayed refetches.
  const refreshAfterSweep = useCallback(() => {
    if (!SWEEP_CAMPAIGN_ENABLED) return;
    for (const delay of POST_SWEEP_REFRESH_DELAYS_MS) {
      const timer = setTimeout(() => {
        void refresh({ force: true });
      }, delay);
      timersRef.current.push(timer);
    }
  }, [refresh]);

  useEffect(() => {
    if (!SWEEP_CAMPAIGN_ENABLED) return;
    setIsLoading(true);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!SWEEP_CAMPAIGN_ENABLED) return;
    const unsubscribe = subscribeToDataInvalidation("sweep-campaign", () => {
      void refresh({ force: true });
    });
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      void refresh();
    }, AUTO_REFRESH_MS);

    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [refresh]);

  return {
    enabled: SWEEP_CAMPAIGN_ENABLED,
    status,
    leaderboard,
    isLoading,
    refresh,
    refreshAfterSweep,
  };
}
