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
  lastSeenAt: number;
};

type PendingRoutePayload = RoutePayload & {
  attempts: number;
  nextAttemptAt: number;
};

const PENDING_STORAGE_KEY = "dustswap.questSwap.pending";
const SYNCED_STORAGE_KEY = "dustswap.questSwap.synced";
const SYNC_NOW_EVENT = "dustswap:quest-sync-now";
const SWAP_RECORDED_EVENT = "dustswap:quest-swap-recorded";
const ROUTE_STORAGE_SUFFIX = "-widget-routes";
const MAX_CANDIDATE_AGE_MS = 1000 * 60 * 60 * 24;

function isTxHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
}

function toFiniteNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getRetryDelay(attempt: number) {
  const delays = [4000, 8000, 15000, 30000, 45000, 60000];
  return delays[Math.min(attempt, delays.length - 1)];
}

function readJsonStorage<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }

    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJsonStorage<T>(key: string, value: T) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage write failures in private mode / full storage.
  }
}

function collectProcesses(route: any, preferredProcess?: any) {
  const processes = Array.isArray(route?.steps)
    ? route.steps.flatMap((step: any) =>
        Array.isArray(step?.execution?.process) ? step.execution.process : []
      )
    : [];

  return preferredProcess ? [preferredProcess, ...processes] : processes;
}

function pickRouteTxHash(route: any, preferredProcess?: any) {
  const processes = collectProcesses(route, preferredProcess);
  const preferred = processes
    .filter((process: any) => isTxHash(process?.txHash))
    .sort((left: any, right: any) => {
      const leftWeight =
        left?.type === "SWAP" || left?.type === "RECEIVING_CHAIN" || left?.type === "CROSS_CHAIN"
          ? 2
          : left?.type === "TOKEN_ALLOWANCE" || left?.type === "PERMIT"
            ? 0
            : 1;
      const rightWeight =
        right?.type === "SWAP" || right?.type === "RECEIVING_CHAIN" || right?.type === "CROSS_CHAIN"
          ? 2
          : right?.type === "TOKEN_ALLOWANCE" || right?.type === "PERMIT"
            ? 0
            : 1;
      return rightWeight - leftWeight;
    });

  if (preferred.length > 0) {
    return String(preferred[0].txHash);
  }

  return isTxHash(route?.txHash) ? route.txHash : null;
}

function getRouteAmountUsd(route: any) {
  const candidates = [
    route?.fromAmountUSD,
    route?.steps?.[0]?.estimate?.fromAmountUSD,
    route?.toAmountUSD,
    route?.steps?.[0]?.estimate?.toAmountUSD,
    route?.metadata?.fromAmountUSD,
    route?.metadata?.toAmountUSD,
  ];

  for (const value of candidates) {
    const parsed = toFiniteNumber(value, -1);
    if (parsed > 0) {
      return parsed;
    }
  }

  return 0;
}

function normalizeRoutePayload(value: any, source: string): RoutePayload | null {
  const route = value?.route ?? value;
  if (!route) {
    return null;
  }

  const process = value?.process;
  const txHash = pickRouteTxHash(route, process);
  if (!txHash) {
    return null;
  }

  const amountUsd = getRouteAmountUsd(route);

  return {
    txHash,
    chainId: toFiniteNumber(
      route?.fromChainId ?? route?.fromChain?.id ?? route?.steps?.[0]?.action?.fromChainId,
      8453
    ),
    amountUsd,
    inputToken:
      route?.fromToken?.symbol ??
      route?.steps?.[0]?.action?.fromToken?.symbol ??
      null,
    outputToken:
      route?.toToken?.symbol ??
      route?.steps?.[0]?.action?.toToken?.symbol ??
      null,
    metadata: {
      routeId: route?.id || null,
      routeStatus: value?.status ?? route?.steps?.[0]?.execution?.status ?? null,
      processType: process?.type || null,
      processStatus: process?.status || null,
      fromAmountUSD: route?.fromAmountUSD ?? route?.steps?.[0]?.estimate?.fromAmountUSD ?? null,
      toAmountUSD: route?.toAmountUSD ?? route?.steps?.[0]?.estimate?.toAmountUSD ?? null,
      source,
    },
    lastSeenAt: Date.now(),
  };
}

function mergePayload(
  current: PendingRoutePayload | undefined,
  next: RoutePayload
): PendingRoutePayload {
  return {
    txHash: next.txHash,
    chainId: current?.chainId ?? next.chainId,
    amountUsd: Math.max(current?.amountUsd ?? 0, next.amountUsd),
    inputToken: next.inputToken ?? current?.inputToken ?? null,
    outputToken: next.outputToken ?? current?.outputToken ?? null,
    metadata: {
      ...(current?.metadata || {}),
      ...(next.metadata || {}),
    },
    lastSeenAt: Math.max(current?.lastSeenAt ?? 0, next.lastSeenAt),
    attempts: current?.attempts ?? 0,
    nextAttemptAt: current?.nextAttemptAt ?? 0,
  };
}

function prunePendingEntries(entries: Map<string, PendingRoutePayload>) {
  const threshold = Date.now() - MAX_CANDIDATE_AGE_MS;
  for (const [txHash, payload] of entries.entries()) {
    if (payload.lastSeenAt < threshold) {
      entries.delete(txHash);
    }
  }
}

function readPendingEntries() {
  const raw = readJsonStorage<Record<string, PendingRoutePayload>>(PENDING_STORAGE_KEY, {});
  const entries = new Map<string, PendingRoutePayload>();

  for (const [txHash, payload] of Object.entries(raw)) {
    if (isTxHash(txHash)) {
      entries.set(txHash, payload);
    }
  }

  prunePendingEntries(entries);
  return entries;
}

function writePendingEntries(entries: Map<string, PendingRoutePayload>) {
  prunePendingEntries(entries);
  writeJsonStorage(
    PENDING_STORAGE_KEY,
    Object.fromEntries(entries.entries())
  );
}

function readSyncedEntries() {
  const raw = readJsonStorage<Record<string, number>>(SYNCED_STORAGE_KEY, {});
  return new Map<string, number>(Object.entries(raw));
}

function writeSyncedEntries(entries: Map<string, number>) {
  writeJsonStorage(SYNCED_STORAGE_KEY, Object.fromEntries(entries.entries()));
}

function collectPersistedRoutes(address?: string) {
  if (typeof window === "undefined" || !address) {
    return [];
  }

  const normalizedAddress = address.toLowerCase();
  const routes: RoutePayload[] = [];

  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key || !key.endsWith(ROUTE_STORAGE_SUFFIX)) {
      continue;
    }

    const persisted = readJsonStorage<any>(key, null);
    const routeDictionary = persisted?.state?.routes || persisted?.routes;
    if (!routeDictionary || typeof routeDictionary !== "object") {
      continue;
    }

    for (const routeExecution of Object.values(routeDictionary as Record<string, any>)) {
      const route = routeExecution?.route ?? routeExecution;
      if (!route) {
        continue;
      }

      const fromAddress = String(route?.fromAddress || "").toLowerCase();
      if (fromAddress && fromAddress !== normalizedAddress) {
        continue;
      }

      const payload = normalizeRoutePayload(
        { ...routeExecution, route },
        "persisted_route"
      );
      if (payload) {
        routes.push(payload);
      }
    }
  }

  return routes;
}

export function QuestSwapTracker() {
  const { address } = useAccount();
  const pendingEntries = useRef<Map<string, PendingRoutePayload>>(new Map());
  const syncedAmounts = useRef<Map<string, number>>(new Map());
  const inFlightHashes = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    pendingEntries.current = readPendingEntries();
    syncedAmounts.current = readSyncedEntries();
  }, []);

  useEffect(() => {
    if (!address) {
      return;
    }

    const persistState = () => {
      writePendingEntries(pendingEntries.current);
      writeSyncedEntries(syncedAmounts.current);
    };

    const ingestPayload = (payload: RoutePayload) => {
      const syncedAmount = syncedAmounts.current.get(payload.txHash) ?? -1;
      const pending = pendingEntries.current.get(payload.txHash);
      const nextPending = mergePayload(pending, payload);

      if (syncedAmount >= nextPending.amountUsd && !pending) {
        return;
      }

      pendingEntries.current.set(payload.txHash, nextPending);
      persistState();
      void flushPendingEntries();
    };

    const flushPendingEntries = async (force = false) => {
      const entries = Array.from(pendingEntries.current.values()).sort(
        (left, right) => right.lastSeenAt - left.lastSeenAt
      );

      for (const payload of entries) {
        const syncedAmount = syncedAmounts.current.get(payload.txHash) ?? -1;
        if (syncedAmount >= payload.amountUsd) {
          pendingEntries.current.delete(payload.txHash);
          continue;
        }

        if (!force && payload.nextAttemptAt > Date.now()) {
          continue;
        }

        if (inFlightHashes.current.has(payload.txHash)) {
          continue;
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

          syncedAmounts.current.set(payload.txHash, payload.amountUsd);
          pendingEntries.current.delete(payload.txHash);
          persistState();

          window.dispatchEvent(
            new CustomEvent(SWAP_RECORDED_EVENT, {
              detail: {
                txHash: payload.txHash,
                amountUsd: payload.amountUsd,
              },
            })
          );
        } catch (error) {
          const existing = pendingEntries.current.get(payload.txHash);
          if (!existing) {
            continue;
          }

          pendingEntries.current.set(payload.txHash, {
            ...existing,
            attempts: existing.attempts + 1,
            nextAttemptAt: Date.now() + getRetryDelay(existing.attempts),
          });
          persistState();

          console.warn("[QuestSwapTracker] Swap sync retry scheduled", {
            txHash: payload.txHash,
            error: (error as Error).message,
          });
        } finally {
          inFlightHashes.current.delete(payload.txHash);
        }
      }
    };

    const recoverPersistedRoutes = () => {
      const routes = collectPersistedRoutes(address);
      for (const payload of routes) {
        ingestPayload(payload);
      }
    };

    const handleRouteEvent = (value: any) => {
      const payload = normalizeRoutePayload(value, "widget_event");
      if (!payload) {
        return;
      }

      ingestPayload(payload);
    };

    const handleSyncNow = () => {
      recoverPersistedRoutes();
      void flushPendingEntries(true);
    };

    recoverPersistedRoutes();
    void flushPendingEntries(true);

    const recoveryInterval = window.setInterval(() => {
      recoverPersistedRoutes();
      void flushPendingEntries();
    }, 10000);

    widgetEvents.on(WidgetEvent.RouteExecutionUpdated, handleRouteEvent);
    widgetEvents.on(WidgetEvent.RouteExecutionCompleted, handleRouteEvent);
    window.addEventListener(SYNC_NOW_EVENT, handleSyncNow);

    return () => {
      widgetEvents.off(WidgetEvent.RouteExecutionUpdated, handleRouteEvent);
      widgetEvents.off(WidgetEvent.RouteExecutionCompleted, handleRouteEvent);
      window.removeEventListener(SYNC_NOW_EVENT, handleSyncNow);
      window.clearInterval(recoveryInterval);
      persistState();
    };
  }, [address]);

  return null;
}
