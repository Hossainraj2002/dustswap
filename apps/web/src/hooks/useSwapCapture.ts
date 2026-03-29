"use client";

import { useEffect, useRef } from "react";
import { useAccount } from "wagmi";

const STORAGE_KEY = "dustswap.swap.capture.queue";
const CALLS_STORAGE_KEY = "dustswap.swap.capture.calls.queue";
const SYNC_NOW_EVENT = "dustswap:quest-sync-now";
const FAST_RETRY_CODE = "receipt_pending";
const MAX_QUEUE_ITEMS = 50;
const MAX_CALL_QUEUE_ITEMS = 25;
const MAX_ITEM_AGE_MS = 24 * 60 * 60 * 1000;
const FLUSH_INTERVAL_MS = 2000;
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

type SmartWalletCallQueueItem = {
  address: string;
  callId: string;
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

type WalletCall = {
  to?: string;
  value?: string;
  data?: string;
};

type WalletSendCallsRequest = {
  from?: string;
  chainId?: string | number;
  calls?: WalletCall[];
};

type WalletCallsStatusReceipt = {
  transactionHash?: string;
};

type WalletCallsStatusResult = {
  status?: string | number;
  statusCode?: number;
  receipts?: WalletCallsStatusReceipt[];
};

type RequestError = Error & {
  code?: string;
  status?: number;
  permanent?: boolean;
};

function isTxHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
}

function normalizeAddress(value: string) {
  return value.toLowerCase();
}

function normalizeCallId(value: string) {
  return value.trim();
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

function getRetryDelay(attempt: number, errorCode?: string, status?: number) {
  if (errorCode === FAST_RETRY_CODE || status === 429) {
    return FLUSH_INTERVAL_MS;
  }

  return Math.min(60000, FLUSH_INTERVAL_MS * 2 ** Math.max(0, attempt - 1));
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Failed to record swap";
}

function isPermanentRecordFailure(status?: number) {
  return typeof status === "number" && status >= 400 && status < 500 && status !== 429;
}

function readStoredItems<T>(key: string) {
  if (typeof window === "undefined") {
    return [] as T[];
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return [] as T[];
    }

    return JSON.parse(raw) as T[];
  } catch {
    return [] as T[];
  }
}

function writeStoredItems<T>(key: string, items: T[]) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // Ignore storage failures in private mode or when the quota is full.
  }
}

function pruneCaptureQueue(queue: CaptureQueueItem[]) {
  const cutoff = Date.now() - MAX_ITEM_AGE_MS;
  const deduped = new Map<string, CaptureQueueItem>();

  for (const item of queue) {
    if (!item || !isTxHash(item.txHash) || !item.address || item.queuedAt < cutoff) {
      continue;
    }

    deduped.set(item.txHash.toLowerCase(), {
      address: normalizeAddress(item.address),
      txHash: item.txHash.toLowerCase(),
      chainId: resolveChainId(item.chainId),
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

function pruneCallQueue(queue: SmartWalletCallQueueItem[]) {
  const cutoff = Date.now() - MAX_ITEM_AGE_MS;
  const deduped = new Map<string, SmartWalletCallQueueItem>();

  for (const item of queue) {
    const callId = typeof item?.callId === "string" ? normalizeCallId(item.callId) : "";
    if (!item || !callId || !item.address || item.queuedAt < cutoff) {
      continue;
    }

    deduped.set(callId, {
      address: normalizeAddress(item.address),
      callId,
      chainId: resolveChainId(item.chainId),
      queuedAt: Number(item.queuedAt || Date.now()),
      attempts: Number(item.attempts || 0),
      nextRetryAt: Number(item.nextRetryAt || 0),
      lastError: item.lastError,
    });
  }

  return Array.from(deduped.values())
    .sort((left, right) => right.queuedAt - left.queuedAt)
    .slice(0, MAX_CALL_QUEUE_ITEMS);
}

function getRequestPayload(args: EthereumRequestArguments) {
  if (Array.isArray(args?.params)) {
    const firstParam = args.params[0];
    if (firstParam && typeof firstParam === "object" && !Array.isArray(firstParam)) {
      return firstParam as Record<string, unknown>;
    }

    return {};
  }

  if (args?.params && typeof args.params === "object" && !Array.isArray(args.params)) {
    return args.params as Record<string, unknown>;
  }

  return {};
}

function getWalletSendCallsRequest(args: EthereumRequestArguments): WalletSendCallsRequest {
  const payload = getRequestPayload(args);
  const calls = Array.isArray(payload.calls) ? (payload.calls as WalletCall[]) : [];

  return {
    from: typeof payload.from === "string" ? payload.from : undefined,
    chainId:
      typeof payload.chainId === "string" || typeof payload.chainId === "number"
        ? payload.chainId
        : undefined,
    calls,
  };
}

function hasOpenOceanCall(calls: WalletCall[]) {
  return calls.some((call) => {
    const to = typeof call?.to === "string" ? call.to.toLowerCase() : "";
    return OPENOCEAN_ROUTER_ADDRESSES.has(to);
  });
}

function resolveCallsId(result: unknown) {
  if (typeof result === "string" && result.trim()) {
    return normalizeCallId(result);
  }

  if (result && typeof result === "object" && "id" in result) {
    const value = (result as { id?: unknown }).id;
    if (typeof value === "string" && value.trim()) {
      return normalizeCallId(value);
    }
  }

  return "";
}

function getCallsStatusResult(result: unknown): WalletCallsStatusResult | null {
  if (!result || typeof result !== "object") {
    return null;
  }

  return result as WalletCallsStatusResult;
}

function getCallsStatusState(result: WalletCallsStatusResult | null) {
  if (!result) {
    return "pending" as const;
  }

  if (typeof result.status === "string") {
    const normalized = result.status.toLowerCase();
    if (normalized === "success" || normalized === "failure" || normalized === "pending") {
      return normalized;
    }
  }

  const statusCode =
    typeof result.statusCode === "number"
      ? result.statusCode
      : typeof result.status === "number"
        ? result.status
        : 100;

  if (statusCode >= 200 && statusCode < 300) {
    return "success" as const;
  }

  if (statusCode >= 300) {
    return "failure" as const;
  }

  return "pending" as const;
}

function getCallsStatusTxHashes(result: WalletCallsStatusResult | null) {
  if (!result?.receipts?.length) {
    return [] as string[];
  }

  const txHashes = new Set<string>();

  for (const receipt of result.receipts) {
    if (isTxHash(receipt?.transactionHash)) {
      txHashes.add(receipt.transactionHash.toLowerCase());
    }
  }

  return Array.from(txHashes);
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
  const payload = text
    ? (JSON.parse(text) as { success?: boolean; error?: string; code?: string })
    : {};

  if (!response.ok || !payload.success) {
    const error = new Error(payload.error || `Swap record request failed with ${response.status}`) as RequestError;
    error.code = payload.code;
    error.status = response.status;
    error.permanent = isPermanentRecordFailure(response.status);
    throw error;
  }

  return payload;
}

export function useSwapCapture() {
  const { address, chainId } = useAccount();
  const queueRef = useRef<CaptureQueueItem[]>([]);
  const callQueueRef = useRef<SmartWalletCallQueueItem[]>([]);
  const isFlushingRef = useRef(false);
  const isFlushingCallsRef = useRef(false);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    queueRef.current = pruneCaptureQueue(readStoredItems<CaptureQueueItem>(STORAGE_KEY));
    callQueueRef.current = pruneCallQueue(
      readStoredItems<SmartWalletCallQueueItem>(CALLS_STORAGE_KEY)
    );
    writeStoredItems(STORAGE_KEY, queueRef.current);
    writeStoredItems(CALLS_STORAGE_KEY, callQueueRef.current);

    const updateQueue = (nextQueue: CaptureQueueItem[]) => {
      queueRef.current = pruneCaptureQueue(nextQueue);
      writeStoredItems(STORAGE_KEY, queueRef.current);
    };

    const updateCallQueue = (nextQueue: SmartWalletCallQueueItem[]) => {
      callQueueRef.current = pruneCallQueue(nextQueue);
      writeStoredItems(CALLS_STORAGE_KEY, callQueueRef.current);
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

    const enqueueSmartWalletCall = (item: Omit<SmartWalletCallQueueItem, "attempts" | "nextRetryAt">) => {
      const normalizedItem: SmartWalletCallQueueItem = {
        ...item,
        address: normalizeAddress(item.address),
        callId: normalizeCallId(item.callId),
        attempts: 0,
        nextRetryAt: 0,
      };
      const filtered = callQueueRef.current.filter(
        (candidate) => candidate.callId !== normalizedItem.callId
      );
      updateCallQueue([normalizedItem, ...filtered]);
      void flushCallQueue(true);
    };

    const handleCallsStatusResult = (
      callId: string,
      result: WalletCallsStatusResult | null
    ) => {
      const txHashes = getCallsStatusTxHashes(result);
      const state = getCallsStatusState(result);
      const queueItem = callQueueRef.current.find((candidate) => candidate.callId === callId);

      if (queueItem && txHashes.length) {
        for (const txHash of txHashes) {
          enqueueCapture({
            address: queueItem.address,
            txHash,
            chainId: queueItem.chainId,
            queuedAt: Date.now(),
          });
        }
      }

      if (!queueItem) {
        return;
      }

      if (txHashes.length || state === "failure" || state === "success") {
        updateCallQueue(callQueueRef.current.filter((candidate) => candidate.callId !== callId));
      }
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
            const requestError = error as RequestError;
            if (requestError.permanent) {
              nextQueue = nextQueue.filter((candidate) => candidate.txHash !== item.txHash);
              continue;
            }

            nextQueue = nextQueue.map((candidate) =>
              candidate.txHash === item.txHash
                ? {
                    ...candidate,
                    attempts: candidate.attempts + 1,
                    nextRetryAt: Date.now() + getRetryDelay(
                      candidate.attempts + 1,
                      requestError.code,
                      requestError.status
                    ),
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

    const ethereum = (window as Window & { ethereum?: any }).ethereum;
    const originalRequest =
      ethereum && typeof ethereum.request === "function" ? ethereum.request : null;

    const requestCallsStatus = async (callId: string) => {
      if (!ethereum || !originalRequest) {
        return null;
      }

      const result = await Reflect.apply(originalRequest, ethereum, [
        {
          method: "wallet_getCallsStatus",
          params: [callId],
        } satisfies EthereumRequestArguments,
      ]);

      return getCallsStatusResult(result);
    };

    const flushCallQueue = async (force = false) => {
      if (isFlushingCallsRef.current) {
        return;
      }

      isFlushingCallsRef.current = true;

      try {
        let nextQueue = [...callQueueRef.current];

        for (const item of [...nextQueue].sort((left, right) => left.queuedAt - right.queuedAt)) {
          if (!force && item.nextRetryAt > Date.now()) {
            continue;
          }

          try {
            const statusResult = await requestCallsStatus(item.callId);
            const state = getCallsStatusState(statusResult);
            const txHashes = getCallsStatusTxHashes(statusResult);

            if (txHashes.length) {
              for (const txHash of txHashes) {
                enqueueCapture({
                  address: item.address,
                  txHash,
                  chainId: item.chainId,
                  queuedAt: Date.now(),
                });
              }

              nextQueue = nextQueue.filter((candidate) => candidate.callId !== item.callId);
              continue;
            }

            if (state === "failure" || state === "success") {
              nextQueue = nextQueue.filter((candidate) => candidate.callId !== item.callId);
              continue;
            }

            nextQueue = nextQueue.map((candidate) =>
              candidate.callId === item.callId
                ? {
                    ...candidate,
                    attempts: candidate.attempts + 1,
                    nextRetryAt: Date.now() + FLUSH_INTERVAL_MS,
                    lastError: candidate.lastError,
                  }
                : candidate
            );
          } catch (error) {
            nextQueue = nextQueue.map((candidate) =>
              candidate.callId === item.callId
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

        updateCallQueue(nextQueue);
      } finally {
        isFlushingCallsRef.current = false;
      }
    };

    if (ethereum && originalRequest) {
      const wrappedRequest = async (args: EthereumRequestArguments) => {
        const result = await Reflect.apply(originalRequest, ethereum, [args]);

        try {
          const method = args?.method;

          if (method === "eth_sendTransaction" || method === "wallet_sendTransaction") {
            const request = getRequestPayload(args);
            const to = String(request.to || "").toLowerCase();
            const txHash = typeof result === "string" ? result.toLowerCase() : "";
            const resolvedAddress = normalizeAddress(String(request.from || address || ""));
            const resolvedChainId = resolveChainId(request.chainId, chainId, ethereum.chainId);

            if (
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
          }

          if (method === "wallet_sendCalls") {
            const request = getWalletSendCallsRequest(args);
            const resolvedAddress = normalizeAddress(String(request.from || address || ""));
            const resolvedChainId = resolveChainId(request.chainId, chainId, ethereum.chainId);
            const callId = resolveCallsId(result);

            if (
              callId &&
              resolvedAddress &&
              resolvedChainId === 8453 &&
              hasOpenOceanCall(request.calls || [])
            ) {
              enqueueSmartWalletCall({
                address: resolvedAddress,
                callId,
                chainId: resolvedChainId,
                queuedAt: Date.now(),
              });
            }
          }

          if (method === "wallet_getCallsStatus") {
            const params = Array.isArray(args?.params) ? args.params : [];
            const rawCallId = params[0];
            const callId = typeof rawCallId === "string" ? normalizeCallId(rawCallId) : "";

            if (callId) {
              handleCallsStatusResult(callId, getCallsStatusResult(result));
            }
          }
        } catch {
          // Never block the wallet response because of capture bookkeeping.
        }

        return result;
      };

      ethereum.request = wrappedRequest;

      intervalRef.current = window.setInterval(() => {
        void flushCallQueue();
        void flushQueue();
      }, FLUSH_INTERVAL_MS);

      void flushCallQueue(true);
      void flushQueue(true);

      return () => {
        if (ethereum.request === wrappedRequest) {
          ethereum.request = originalRequest;
        }

        if (intervalRef.current) {
          window.clearInterval(intervalRef.current);
          intervalRef.current = null;
        }

        writeStoredItems(STORAGE_KEY, queueRef.current);
        writeStoredItems(CALLS_STORAGE_KEY, callQueueRef.current);
      };
    }

    intervalRef.current = window.setInterval(() => {
      void flushCallQueue();
      void flushQueue();
    }, FLUSH_INTERVAL_MS);

    void flushCallQueue(true);
    void flushQueue(true);

    return () => {
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }

      writeStoredItems(STORAGE_KEY, queueRef.current);
      writeStoredItems(CALLS_STORAGE_KEY, callQueueRef.current);
    };
  }, [address, chainId]);
}
