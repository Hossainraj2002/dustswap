"use client";

import { useEffect, useRef } from "react";
import { useAccount } from "wagmi";

const STORAGE_KEY = "dustswap.swap.capture.queue";
const SYNC_NOW_EVENT = "dustswap:quest-sync-now";
const MAX_QUEUE_ITEMS = 50;
const MAX_ITEM_AGE_MS = 24 * 60 * 60 * 1000;
const FLUSH_INTERVAL_MS = 5000;
const OPENOCEAN_ROUTER_ADDRESSES = new Set([
  "0x6352a56caadc4f1e25cd6c75970fa768a3304e64",
  "0x6dd434082eab5cd134628d4b9a6e4d0813ef8b07",
]);

type CaptureQueueItem = {
  address: string;
  txHash: string;
  chainId: number;
  queuedAt: number;
  attempts: number;
  nextRetryAt: number;
  lastError?: string;
};

type EthereumRequestArguments = {
  method?: string;
  params?: unknown[] | Record<string, unknown>;
};

function isTxHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
}

function normalizeAddress(value: string) {
  return value.toLowerCase();
}

function getRetryDelay(attempt: number) {
  return Math.min(60000, FLUSH_INTERVAL_MS * 2 ** Math.max(0, attempt - 1));
}

function readQueue(): CaptureQueueItem[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }

    return pruneQueue(JSON.parse(raw) as CaptureQueueItem[]);
  } catch {
    return [];
  }
}

function writeQueue(queue: CaptureQueueItem[]) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pruneQueue(queue)));
  } catch {
    // Ignore storage failures in private mode or when the quota is full.
  }
}

function pruneQueue(queue: CaptureQueueItem[]) {
  const cutoff = Date.now() - MAX_ITEM_AGE_MS;
  const deduped = new Map<string, CaptureQueueItem>();

  for (const item of queue) {
    if (!item || !isTxHash(item.txHash) || !item.address || item.queuedAt < cutoff) {
      continue;
    }

    deduped.set(item.txHash.toLowerCase(), {
      address: normalizeAddress(item.address),
      txHash: item.txHash.toLowerCase(),
      chainId: Number(item.chainId || 8453),
      queuedAt: Number(item.queuedAt || Date.now()),
      attempts: Number(item.attempts || 0),
      nextRetryAt: Number(item.nextRetryAt || 0),
      lastError: item.lastError,
    });
  }

  return Array.from(deduped.values())
    .sort((left, right) => right.queuedAt - left.queuedAt)
    .slice(0, MAX_QUEUE_ITEMS);
}

function resolveChainId(...values: Array<unknown>) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim()) {
      if (value.startsWith("0x")) {
        const parsedHex = Number.parseInt(value, 16);
        if (Number.isFinite(parsedHex)) {
          return parsedHex;
        }
      }

      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return 8453;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Failed to record swap";
}

async function postSwapRecord(item: CaptureQueueItem) {
  const response = await fetch("/api/swaps/record", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      address: item.address,
      txHash: item.txHash,
      chainId: item.chainId,
    }),
    keepalive: true,
  });

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as { success?: boolean; error?: string }) : {};

  if (!response.ok || !payload.success) {
    throw new Error(payload.error || `Swap record request failed with ${response.status}`);
  }

  return payload;
}

export function useSwapCapture() {
  const { address, chainId } = useAccount();
  const queueRef = useRef<CaptureQueueItem[]>([]);
  const isFlushingRef = useRef(false);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    queueRef.current = readQueue();
    writeQueue(queueRef.current);

    const updateQueue = (nextQueue: CaptureQueueItem[]) => {
      queueRef.current = pruneQueue(nextQueue);
      writeQueue(queueRef.current);
    };

    const flushQueue = async (force = false) => {
      if (isFlushingRef.current) {
        return;
      }

      isFlushingRef.current = true;

      try {
        let nextQueue = [...queueRef.current];

        for (const item of [...nextQueue].sort((left, right) => left.queuedAt - right.queuedAt)) {
          if (!force && item.nextRetryAt > Date.now()) {
            continue;
          }

          try {
            await postSwapRecord(item);
            nextQueue = nextQueue.filter((candidate) => candidate.txHash !== item.txHash);
            window.dispatchEvent(new Event(SYNC_NOW_EVENT));
          } catch (error) {
            nextQueue = nextQueue.map((candidate) =>
              candidate.txHash === item.txHash
                ? {
                    ...candidate,
                    attempts: candidate.attempts + 1,
                    nextRetryAt: Date.now() + getRetryDelay(candidate.attempts + 1),
                    lastError: getErrorMessage(error),
                  }
                : candidate
            );
          }
        }

        updateQueue(nextQueue);
      } finally {
        isFlushingRef.current = false;
      }
    };

    const enqueueCapture = (item: Omit<CaptureQueueItem, "attempts" | "nextRetryAt">) => {
      const normalizedItem: CaptureQueueItem = {
        ...item,
        address: normalizeAddress(item.address),
        txHash: item.txHash.toLowerCase(),
        attempts: 0,
        nextRetryAt: 0,
      };
      const filtered = queueRef.current.filter((candidate) => candidate.txHash !== normalizedItem.txHash);
      updateQueue([normalizedItem, ...filtered]);
      void flushQueue(true);
    };

    const ethereum = (window as Window & { ethereum?: any }).ethereum;
    const originalRequest =
      ethereum && typeof ethereum.request === "function" ? ethereum.request : null;

    if (ethereum && originalRequest) {
      const wrappedRequest = async (args: EthereumRequestArguments) => {
        const result = await Reflect.apply(originalRequest, ethereum, [args]);

        try {
          const method = args?.method;
          const params = Array.isArray(args?.params) ? args.params : [];
          const request = (params[0] || {}) as {
            to?: string;
            from?: string;
            chainId?: string | number;
          };
          const to = String(request.to || "").toLowerCase();
          const txHash = typeof result === "string" ? result.toLowerCase() : "";
          const resolvedAddress = normalizeAddress(String(request.from || address || ""));
          const resolvedChainId = resolveChainId(request.chainId, chainId, ethereum.chainId);

          if (
            method === "eth_sendTransaction" &&
            isTxHash(txHash) &&
            resolvedAddress &&
            resolvedChainId === 8453 &&
            OPENOCEAN_ROUTER_ADDRESSES.has(to)
          ) {
            enqueueCapture({
              address: resolvedAddress,
              txHash,
              chainId: resolvedChainId,
              queuedAt: Date.now(),
            });
          }
        } catch {
          // Never block the wallet response because of capture bookkeeping.
        }

        return result;
      };

      ethereum.request = wrappedRequest;

      intervalRef.current = window.setInterval(() => {
        void flushQueue();
      }, FLUSH_INTERVAL_MS);

      void flushQueue(true);

      return () => {
        if (ethereum.request === wrappedRequest) {
          ethereum.request = originalRequest;
        }

        if (intervalRef.current) {
          window.clearInterval(intervalRef.current);
          intervalRef.current = null;
        }

        writeQueue(queueRef.current);
      };
    }

    intervalRef.current = window.setInterval(() => {
      void flushQueue();
    }, FLUSH_INTERVAL_MS);

    void flushQueue(true);

    return () => {
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }

      writeQueue(queueRef.current);
    };
  }, [address, chainId]);
}
