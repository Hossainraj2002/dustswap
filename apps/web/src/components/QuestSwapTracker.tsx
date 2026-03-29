"use client";

import { useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import { syncSwapQuestActivity } from "@/lib/quests";

const POLL_INTERVAL_MS = 30000;
const SYNC_NOW_EVENT = "dustswap:quest-sync-now";
const SWAP_RECORDED_EVENT = "dustswap:quest-swap-recorded";

type SyncReason = "mount" | "poll" | "focus" | "visibility" | "manual";

export function QuestSwapTracker() {
  const { address } = useAccount();
  const abortControllerRef = useRef<AbortController | null>(null);
  const intervalRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    inFlightRef.current = false;

    if (!address) {
      return;
    }

    let disposed = false;

    const runSync = async (reason: SyncReason) => {
      if (disposed || inFlightRef.current) {
        return;
      }

      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      inFlightRef.current = true;

      try {
        const response = await syncSwapQuestActivity(address);

        if (disposed || controller.signal.aborted || !response.success) {
          return;
        }

        const importedHashes = response.importedHashes || [];
        const completedQuests = response.completedQuests || [];
        const shouldDispatch =
          reason === "manual" || importedHashes.length > 0 || completedQuests.length > 0;

        if (shouldDispatch) {
          window.dispatchEvent(
            new CustomEvent(SWAP_RECORDED_EVENT, {
              detail: {
                reason,
                importedHashes,
                completedQuests,
              },
            })
          );
        }
      } catch {
        // Polling failures should stay silent so the page remains stable.
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        inFlightRef.current = false;
      }
    };

    const handleFocus = () => {
      void runSync("focus");
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void runSync("visibility");
      }
    };

    const handleManualSync = () => {
      void runSync("manual");
    };

    void runSync("mount");

    intervalRef.current = window.setInterval(() => {
      void runSync("poll");
    }, POLL_INTERVAL_MS);

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener(SYNC_NOW_EVENT, handleManualSync);

    return () => {
      disposed = true;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      inFlightRef.current = false;

      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }

      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener(SYNC_NOW_EVENT, handleManualSync);
    };
  }, [address]);

  return null;
}
