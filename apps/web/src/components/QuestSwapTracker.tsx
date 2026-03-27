"use client";

import { useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import { WidgetEvent, widgetEvents } from "@openocean.finance/widget";
import { recordSwapQuestActivity } from "@/lib/quests";

function findFirstTxHash(value: unknown): string | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return /^0x[a-fA-F0-9]{64}$/.test(value) ? value : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const txHash = findFirstTxHash(item);
      if (txHash) {
        return txHash;
      }
    }
    return null;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.txHash === "string" && /^0x[a-fA-F0-9]{64}$/.test(record.txHash)) {
      return record.txHash;
    }

    for (const nested of Object.values(record)) {
      const txHash = findFirstTxHash(nested);
      if (txHash) {
        return txHash;
      }
    }
  }

  return null;
}

export function QuestSwapTracker() {
  const { address } = useAccount();
  const recordedHashes = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!address) {
      return;
    }

    const handleCompletedRoute = async (route: any) => {
      const txHash = findFirstTxHash(route);
      const chainId = Number(route?.fromChainId || route?.fromChain?.id || 8453);
      const amountUsd = Number(route?.fromAmountUSD || route?.toAmountUSD || 0);

      if (!txHash || recordedHashes.current.has(txHash)) {
        return;
      }

      recordedHashes.current.add(txHash);

      try {
        await recordSwapQuestActivity({
          address,
          txHash,
          chainId,
          amountUsd,
          inputToken: route?.fromToken?.symbol || null,
          outputToken: route?.toToken?.symbol || null,
          metadata: {
            fromAmountUSD: route?.fromAmountUSD || null,
            toAmountUSD: route?.toAmountUSD || null,
            routeId: route?.id || null,
          },
        });
      } catch (error) {
        console.error("[QuestSwapTracker] Failed to record swap quest activity", error);
      }
    };

    widgetEvents.on(WidgetEvent.RouteExecutionCompleted, handleCompletedRoute);

    return () => {
      widgetEvents.off(WidgetEvent.RouteExecutionCompleted, handleCompletedRoute);
    };
  }, [address]);

  return null;
}
