"use client";

import { useEffect, useRef } from "react";
import { useConnection } from "wagmi";
import { DATA_SUFFIX } from "@/lib/builderCode";
import {
  buildBasePaymasterCapabilities,
  isErc20ApproveCall,
  isOpenOceanRouterAddress,
  isPaymasterEnabled,
  isUserRejectedRequest,
  toRpcHexValue,
} from "@/lib/paymaster";
import { BASE_CHAIN_ID } from "@/lib/tokens";

const STORAGE_KEY = "dustswap.swap.capture.queue";
const CALLS_STORAGE_KEY = "dustswap.swap.capture.calls.queue";
const SYNC_NOW_EVENT = "dustswap:quest-sync-now";
const FAST_RETRY_CODE = "receipt_pending";
const MAX_QUEUE_ITEMS = 50;
const MAX_CALL_QUEUE_ITEMS = 25;
const MAX_ITEM_AGE_MS = 24 * 60 * 60 * 1000;
const FLUSH_INTERVAL_MS = 2000;
const MAX_RETRY_DELAY_MS = 10000;
const SPONSORED_TX_MAX_ATTEMPTS = 40;
const SPONSORED_TX_POLL_DELAY_MS = 1500;
const CONNECTOR_PROVIDER_KEY = "connector";
const WINDOW_PROVIDER_KEY = "window";

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
  providerKey: string;
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

type WalletCapabilitiesResult = Record<
  string,
  {
    paymasterService?: {
      supported?: boolean;
    };
  }
>;

type RequestError = Error & {
  code?: string;
  status?: number;
  permanent?: boolean;
};

type RequestCapableProvider = {
  chainId?: string | number;
  request: (args: EthereumRequestArguments) => Promise<unknown>;
};

type WrappedProviderRecord = {
  key: string;
  provider: RequestCapableProvider;
  originalRequest: (args: EthereumRequestArguments) => Promise<unknown>;
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

function toHexChainId(chainId: number) {
  return `0x${chainId.toString(16)}`;
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

  return Math.min(MAX_RETRY_DELAY_MS, FLUSH_INTERVAL_MS * 2 ** Math.max(0, attempt - 1));
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

    deduped.set(`${item.providerKey}:${callId}`, {
      address: normalizeAddress(item.address),
      callId,
      providerKey: item.providerKey || CONNECTOR_PROVIDER_KEY,
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
    return isOpenOceanRouterAddress(to);
  });
}

function isEligibleSponsoredSwapTransaction(
  request: Record<string, unknown>,
  resolvedChainId: number
) {
  if (resolvedChainId !== BASE_CHAIN_ID) {
    return false;
  }

  const to = typeof request.to === "string" ? request.to.toLowerCase() : "";
  const data = typeof request.data === "string" ? request.data : "";

  return isOpenOceanRouterAddress(to) || isErc20ApproveCall(data);
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

  if (result && typeof result === "object" && "batchId" in result) {
    const value = (result as { batchId?: unknown }).batchId;
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

async function sleep(ms: number) {
  await new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getProviderCandidates(
  windowProvider: RequestCapableProvider | null,
  connectorProvider: RequestCapableProvider | null
) {
  const candidates: Array<{ key: string; provider: RequestCapableProvider }> = [];

  if (connectorProvider && typeof connectorProvider.request === "function") {
    candidates.push({ key: CONNECTOR_PROVIDER_KEY, provider: connectorProvider });
  }

  if (
    windowProvider &&
    typeof windowProvider.request === "function" &&
    windowProvider !== connectorProvider
  ) {
    candidates.push({ key: WINDOW_PROVIDER_KEY, provider: windowProvider });
  }

  return candidates;
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
    const error = new Error(
      payload.error || `Swap record request failed with ${response.status}`
    ) as RequestError;
    error.code = payload.code;
    error.status = response.status;
    error.permanent = isPermanentRecordFailure(response.status);
    throw error;
  }

  return payload;
}

export function useSwapCapture() {
  const connection = useConnection();
  const address = connection.address;
  const chainId = connection.chainId;
  const connector = connection.connector;
  const queueRef = useRef<CaptureQueueItem[]>([]);
  const callQueueRef = useRef<SmartWalletCallQueueItem[]>([]);
  const isFlushingRef = useRef(false);
  const isFlushingCallsRef = useRef(false);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let cancelled = false;
    const providerRecords = new Map<string, WrappedProviderRecord>();
    const providerRestorers: Array<() => void> = [];
    const paymasterSupportCache = new Map<string, boolean>();

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
      const filtered = queueRef.current.filter(
        (candidate) => candidate.txHash !== normalizedItem.txHash
      );
      updateQueue([normalizedItem, ...filtered]);
      void flushQueue(true);
    };

    const enqueueSmartWalletCall = (
      item: Omit<SmartWalletCallQueueItem, "attempts" | "nextRetryAt">
    ) => {
      const normalizedItem: SmartWalletCallQueueItem = {
        ...item,
        address: normalizeAddress(item.address),
        callId: normalizeCallId(item.callId),
        providerKey: item.providerKey || CONNECTOR_PROVIDER_KEY,
        attempts: 0,
        nextRetryAt: 0,
      };
      const filtered = callQueueRef.current.filter(
        (candidate) =>
          !(
            candidate.callId === normalizedItem.callId &&
            candidate.providerKey === normalizedItem.providerKey
          )
      );
      updateCallQueue([normalizedItem, ...filtered]);
      void flushCallQueue(true);
    };

    const handleCallsStatusResult = (
      callId: string,
      providerKey: string,
      result: WalletCallsStatusResult | null
    ) => {
      const txHashes = getCallsStatusTxHashes(result);
      const queueItem = callQueueRef.current.find(
        (candidate) => candidate.callId === callId && candidate.providerKey === providerKey
      );

      if (!queueItem) {
        return;
      }

      if (txHashes.length) {
        for (const txHash of txHashes) {
          enqueueCapture({
            address: queueItem.address,
            txHash,
            chainId: queueItem.chainId,
            queuedAt: Date.now(),
          });
        }

        updateCallQueue(
          callQueueRef.current.filter(
            (candidate) =>
              !(
                candidate.callId === queueItem.callId &&
                candidate.providerKey === queueItem.providerKey
              )
          )
        );
      }
    };

    const getPaymasterSupport = async (
      providerKey: string,
      originalRequest: (args: EthereumRequestArguments) => Promise<unknown>,
      accountAddress: string,
      targetChainId: number
    ) => {
      const cacheKey = `${providerKey}:${accountAddress}:${targetChainId}`;
      const cached = paymasterSupportCache.get(cacheKey);
      if (typeof cached === "boolean") {
        return cached;
      }

      try {
        const result = (await originalRequest({
          method: "wallet_getCapabilities",
          params: [accountAddress],
        })) as WalletCapabilitiesResult | null;
        const chainKey = toHexChainId(targetChainId).toLowerCase();
        const chainCapabilities = result
          ? Object.entries(result).find(([candidate]) => candidate.toLowerCase() === chainKey)?.[1]
          : null;
        const supported = Boolean(chainCapabilities?.paymasterService?.supported);
        paymasterSupportCache.set(cacheKey, supported);
        return supported;
      } catch {
        paymasterSupportCache.set(cacheKey, false);
        return false;
      }
    };

    const waitForSponsoredTxHash = async (
      originalRequest: (args: EthereumRequestArguments) => Promise<unknown>,
      callId: string
    ) => {
      for (let attempt = 0; attempt < SPONSORED_TX_MAX_ATTEMPTS; attempt += 1) {
        const result = await originalRequest({
          method: "wallet_getCallsStatus",
          params: [callId],
        });
        const statusResult = getCallsStatusResult(result);
        const txHashes = getCallsStatusTxHashes(statusResult);

        if (txHashes.length > 0) {
          return txHashes[0];
        }

        if (getCallsStatusState(statusResult) === "failure") {
          throw new Error("Sponsored swap transaction failed");
        }

        await sleep(SPONSORED_TX_POLL_DELAY_MS);
      }

      throw new Error("Timed out waiting for sponsored swap transaction receipt");
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

    const requestCallsStatus = async (item: SmartWalletCallQueueItem) => {
      const providerRecord =
        providerRecords.get(item.providerKey) ||
        providerRecords.get(CONNECTOR_PROVIDER_KEY) ||
        providerRecords.get(WINDOW_PROVIDER_KEY);

      if (!providerRecord) {
        return null;
      }

      const result = await providerRecord.originalRequest({
        method: "wallet_getCallsStatus",
        params: [item.callId],
      });

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
            const statusResult = await requestCallsStatus(item);
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

              nextQueue = nextQueue.filter(
                (candidate) =>
                  !(
                    candidate.callId === item.callId &&
                    candidate.providerKey === item.providerKey
                  )
              );
              continue;
            }

            if (state === "failure") {
              nextQueue = nextQueue.filter(
                (candidate) =>
                  !(
                    candidate.callId === item.callId &&
                    candidate.providerKey === item.providerKey
                  )
              );
              continue;
            }

            nextQueue = nextQueue.map((candidate) =>
              candidate.callId === item.callId && candidate.providerKey === item.providerKey
                ? {
                    ...candidate,
                    attempts: candidate.attempts + 1,
                    nextRetryAt: Date.now() + FLUSH_INTERVAL_MS,
                    lastError:
                      state === "success"
                        ? "wallet_getCallsStatus succeeded without receipts yet"
                        : candidate.lastError,
                  }
                : candidate
            );
          } catch (error) {
            nextQueue = nextQueue.map((candidate) =>
              candidate.callId === item.callId && candidate.providerKey === item.providerKey
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

    const wrapProvider = (providerKey: string, provider: RequestCapableProvider) => {
      if (!provider || typeof provider.request !== "function") {
        return;
      }

      const originalRequest = provider.request.bind(provider);
      const wrappedRequest = async (args: EthereumRequestArguments) => {
        const method = args?.method;
        let result: unknown;

        if (
          isPaymasterEnabled() &&
          (method === "eth_sendTransaction" || method === "wallet_sendTransaction")
        ) {
          const request = getRequestPayload(args);
          const resolvedAddress = normalizeAddress(String(request.from || address || ""));
          const resolvedChainId = resolveChainId(
            request.chainId,
            chainId,
            provider.chainId,
            (window as Window & { ethereum?: RequestCapableProvider }).ethereum?.chainId
          );

          if (
            resolvedAddress &&
            isEligibleSponsoredSwapTransaction(request, resolvedChainId)
          ) {
            try {
              const supportsPaymaster = await getPaymasterSupport(
                providerKey,
                originalRequest,
                resolvedAddress,
                resolvedChainId
              );

              if (supportsPaymaster) {
                const sendCallsResult = await originalRequest({
                  method: "wallet_sendCalls",
                  params: [
                    {
                      version: "2.0.0",
                      chainId: toHexChainId(resolvedChainId),
                      from: resolvedAddress,
                      atomicRequired: true,
                      calls: [
                        {
                          to: String(request.to),
                          data:
                            typeof request.data === "string" && request.data
                              ? request.data
                              : "0x",
                          value: toRpcHexValue(request.value),
                          dataSuffix: DATA_SUFFIX,
                        },
                      ],
                      capabilities: buildBasePaymasterCapabilities(),
                    },
                  ],
                });
                const callId = resolveCallsId(sendCallsResult);

                if (callId) {
                  result = await waitForSponsoredTxHash(originalRequest, callId);
                }
              }
            } catch (error) {
              if (isUserRejectedRequest(error)) {
                throw error;
              }

              console.warn(
                "Falling back to unsponsored Base swap transaction after paymaster attempt failed.",
                error
              );
            }
          }
        }

        if (typeof result === "undefined") {
          result = await originalRequest(args);
        }

        try {
          if (method === "eth_sendTransaction" || method === "wallet_sendTransaction") {
            const request = getRequestPayload(args);
            const to = String(request.to || "").toLowerCase();
            const txHash = typeof result === "string" ? result.toLowerCase() : "";
            const resolvedAddress = normalizeAddress(String(request.from || address || ""));
            const resolvedChainId = resolveChainId(
              request.chainId,
              chainId,
              provider.chainId,
              (window as Window & { ethereum?: RequestCapableProvider }).ethereum?.chainId
            );

            if (
              isTxHash(txHash) &&
              resolvedAddress &&
              resolvedChainId === BASE_CHAIN_ID &&
              isOpenOceanRouterAddress(to)
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
            const resolvedChainId = resolveChainId(
              request.chainId,
              chainId,
              provider.chainId,
              (window as Window & { ethereum?: RequestCapableProvider }).ethereum?.chainId
            );
            const callId = resolveCallsId(result);

            if (
              callId &&
              resolvedAddress &&
              resolvedChainId === BASE_CHAIN_ID &&
              hasOpenOceanCall(request.calls || [])
            ) {
              enqueueSmartWalletCall({
                address: resolvedAddress,
                callId,
                providerKey,
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
              handleCallsStatusResult(callId, providerKey, getCallsStatusResult(result));
            }
          }
        } catch {
          // Never block the wallet response because of capture bookkeeping.
        }

        return result;
      };

      provider.request = wrappedRequest;
      providerRecords.set(providerKey, {
        key: providerKey,
        provider,
        originalRequest,
      });

      providerRestorers.push(() => {
        if (provider.request === wrappedRequest) {
          provider.request = originalRequest;
        }
      });
    };

    const setupProviders = async () => {
      const windowProvider =
        ((window as Window & { ethereum?: RequestCapableProvider }).ethereum as
          | RequestCapableProvider
          | undefined) || null;
      const connectorProvider =
        connector && typeof connector.getProvider === "function"
          ? (((await connector.getProvider({ chainId })) as RequestCapableProvider | undefined) ??
            null)
          : null;

      if (cancelled) {
        return;
      }

      for (const candidate of getProviderCandidates(windowProvider, connectorProvider)) {
        wrapProvider(candidate.key, candidate.provider);
      }

      void flushCallQueue(true);
      void flushQueue(true);
    };

    const flushNow = () => {
      void flushCallQueue(true);
      void flushQueue(true);
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        flushNow();
      }
    };

    window.addEventListener("focus", flushNow);
    window.addEventListener("online", flushNow);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    intervalRef.current = window.setInterval(() => {
      void flushCallQueue();
      void flushQueue();
    }, FLUSH_INTERVAL_MS);

    void setupProviders();
    void flushCallQueue(true);
    void flushQueue(true);

    return () => {
      cancelled = true;

      window.removeEventListener("focus", flushNow);
      window.removeEventListener("online", flushNow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);

      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }

      for (const restore of providerRestorers.reverse()) {
        restore();
      }

      writeStoredItems(STORAGE_KEY, queueRef.current);
      writeStoredItems(CALLS_STORAGE_KEY, callQueueRef.current);
    };
  }, [address, chainId, connector]);
}
