"use client";

import { useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import { WidgetEvent, widgetEvents } from "@openocean.finance/widget";
import { recordSwapQuestActivity } from "@/lib/quests";

type RoutePayload = {
  txHash: string;
  chainId: number;
  amountUsd: number;
  inputToken?: string | null;
  outputToken?: string | null;
  metadata?: Record<string, unknown>;
};

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

function normalizeRoutePayload(value: any): RoutePayload | null {
  const route = value?.route ?? value;
  const txHash = findFirstTxHash(route);

  if (!txHash) {
    return null;
  }

  return {
    txHash,
    chainId: Number(route?.fromChainId || route?.fromChain?.id || 8453),
    amountUsd: Number(route?.fromAmountUSD || route?.toAmountUSD || 0),
    inputToken: route?.fromToken?.symbol || null,
    outputToken: route?.toToken?.symbol || null,
    metadata: {
      fromAmountUSD: route?.fromAmountUSD || null,
      toAmountUSD: route?.toAmountUSD || null,
      routeId: route?.id || null,
    },
  };
}

function getRetryDelay(attempt: number) {
  const delays = [4000, 8000, 15000, 30000, 45000];
  return delays[Math.min(attempt, delays.length - 1)];
}

export function QuestSwapTracker() {
  const { address } = useAccount();
  const syncedAmounts = useRef<Map<string, number>>(new Map());
  const inFlightHashes = useRef<Set<string>>(new Set());
  const retryTimers = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!address) {
      return;
    }

    const clearRetry = (txHash: string) => {
      const timeout = retryTimers.current.get(txHash);
      if (timeout) {
        window.clearTimeout(timeout);
        retryTimers.current.delete(txHash);
      }
    };

    const submitPayload = async (payload: RoutePayload, attempt = 0) => {
      const previousAmount = syncedAmounts.current.get(payload.txHash) ?? -1;
      const hasNewVolumeInfo = payload.amountUsd > previousAmount;

      if (previousAmount > 0 && !hasNewVolumeInfo && attempt === 0) {
        return;
      }

      if (inFlightHashes.current.has(payload.txHash)) {
        return;
      }

      inFlightHashes.current.add(payload.txHash);

      try {
        const response = await recordSwapQuestActivity({
          address,
          txHash: payload.txHash,
          chainId: payload.chainId,
          amountUsd: payload.amountUsd,
          inputToken: payload.inputToken,
          outputToken: payload.outputToken,
          metadata: payload.metadata,
        });

        if (!response.success) {
          throw new Error(response.error || "Failed to record swap quest activity");
        }

        syncedAmounts.current.set(
          payload.txHash,
          Math.max(previousAmount, payload.amountUsd)
        );
        clearRetry(payload.txHash);

        if (payload.amountUsd <= 0 && attempt < 5) {
          const timeout = window.setTimeout(() => {
            retryTimers.current.delete(payload.txHash);
            void submitPayload(payload, attempt + 1);
          }, getRetryDelay(attempt));
          retryTimers.current.set(payload.txHash, timeout);
        }
      } catch (error) {
        if (attempt < 5) {
          clearRetry(payload.txHash);
          const timeout = window.setTimeout(() => {
            retryTimers.current.delete(payload.txHash);
            void submitPayload(payload, attempt + 1);
          }, getRetryDelay(attempt));
          retryTimers.current.set(payload.txHash, timeout);
        } else {
          console.error("[QuestSwapTracker] Failed to record swap quest activity", error);
        }
      } finally {
        inFlightHashes.current.delete(payload.txHash);
      }
    };

    const handleRouteEvent = (value: any) => {
      const payload = normalizeRoutePayload(value);
      if (!payload) {
        return;
      }

      void submitPayload(payload);
    };

    widgetEvents.on(WidgetEvent.RouteExecutionUpdated, handleRouteEvent);
    widgetEvents.on(WidgetEvent.RouteExecutionCompleted, handleRouteEvent);

    return () => {
      widgetEvents.off(WidgetEvent.RouteExecutionUpdated, handleRouteEvent);
      widgetEvents.off(WidgetEvent.RouteExecutionCompleted, handleRouteEvent);
      for (const timeout of retryTimers.current.values()) {
        window.clearTimeout(timeout);
      }
      retryTimers.current.clear();
    };
  }, [address]);

  return null;
}
