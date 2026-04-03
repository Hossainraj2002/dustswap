"use client";

import { useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import { syncSwapQuestActivity } from "@/lib/quests";
import { emitDataInvalidation } from "@/lib/clientEvents";
import { clearPointsSummaryCache } from "@/lib/points";

type SyncReason = "focus" | "mount" | "visibility";

export function QuestSwapTracker() {
  const { address } = useAccount();
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    inFlightRef.current = false;

    if (!address) {
      return;
    }

    let disposed = false;

    const runSync = async (reason: SyncReason) => {
      if (disposed || inFlightRef.current) {
        return;
      }

      inFlightRef.current = true;

      try {
        const response = await syncSwapQuestActivity(address);

        if (disposed || !response.success) {
          return;
        }

        const importedHashes = response.importedHashes || [];
        const completedQuests = response.completedQuests || [];
        const shouldRefreshBoard =
          reason !== "mount" || importedHashes.length > 0 || completedQuests.length > 0;

        if (shouldRefreshBoard) {
          emitDataInvalidation("quests", `quest-sync:${reason}`);
        }

        if (importedHashes.length > 0) {
          clearPointsSummaryCache(address);
          emitDataInvalidation("profile", "quest-sync:swap-imported");
          emitDataInvalidation("leaderboard", "quest-sync:swap-imported");
        }

        if (completedQuests.length > 0) {
          clearPointsSummaryCache(address);
          emitDataInvalidation(["leaderboard", "points"], "quest-sync:quest-completed");
        }
      } catch {
        // Polling failures should stay silent so the page remains stable.
      } finally {
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

    void runSync("mount");

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      disposed = true;
      inFlightRef.current = false;

      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [address]);

  return null;
}
