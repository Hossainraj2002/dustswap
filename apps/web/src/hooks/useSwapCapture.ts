"use client";

import { useEffect, useRef } from "react";
import { useConnection } from "wagmi";
import { appendBuilderCodeToData } from "@/lib/builderCode";
import { isErc20ApproveCall, isOpenOceanRouterAddress } from "@/lib/paymaster";
import { emitDataInvalidation, emitSwapTamperWarning } from "@/lib/clientEvents";
import { buildPublicApiUrl, publicApiFetch } from "@/lib/apiBase";
import { clearPointsSummaryCache } from "@/lib/points";
import { BASE_CHAIN_ID } from "@/lib/tokens";
import {
  SWAP_REFERRER_TAMPERED_ERROR_MESSAGE,
  SWAP_ROUTE_UNAVAILABLE_ERROR_MESSAGE,
  getInvalidSwapTxReason,
  getSwapReferrerTamperReason,
  isSwapReferrerGuardEnabled,
  validateWalletSendCalls,
  type WalletCall,
  type WalletSendCallsRequest,
} from "@/lib/swapTxGuard";
import { isSupportedSwapCaptureChainId } from "@/config/swapChains";

const STORAGE_KEY = "dustswap.swap.capture.queue";
const CALLS_STORAGE_KEY = "dustswap.swap.capture.calls.queue";
const FAST_RETRY_CODE = "receipt_pending";
const MAX_QUEUE_ITEMS = 50;
const MAX_CALL_QUEUE_ITEMS = 25;
const MAX_ITEM_AGE_MS = 24 * 60 * 60 * 1000;
const FLUSH_INTERVAL_MS = 2000;
const MAX_RETRY_DELAY_MS = 10000;
const APPROVAL_RECEIPT_POLL_DELAY_MS = 1000;
const APPROVAL_RECEIPT_MAX_ATTEMPTS = 20;
const CONNECTOR_PROVIDER_KEY = "connector";
const WINDOW_PROVIDER_KEY = "window";
const SWAP_CAPTURE_PROVIDER_STATE_KEY = "__dustswapSwapCaptureState";

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

type WalletCallsStatusReceipt = {
  transactionHash?: string;
};

type WalletCallsStatusResult = {
  status?: string | number;
  statusCode?: number;
  receipts?: WalletCallsStatusReceipt[];
};

type TransactionReceiptResult = {
  blockHash?: string | null;
  blockNumber?: string | null;
  status?: string | number;
  transactionHash?: string;
};

type RequestError = Error & {
  code?: string;
  status?: number;
  permanent?: boolean;
};

type RequestCapableProvider = {
  chainId?: string | number;
  request: (args: EthereumRequestArguments) => Promise<unknown>;
  [SWAP_CAPTURE_PROVIDER_STATE_KEY]?: SwapCaptureProviderState;
};

type WrappedProviderRecord = {
  key: string;
  provider: RequestCapableProvider;
  originalRequest: (args: EthereumRequestArguments) => Promise<unknown>;
};

type SwapCaptureProviderState = {
  originalRequest: (args: EthereumRequestArguments) => Promise<unknown>;
  wrappedRequest: (args: EthereumRequestArguments) => Promise<unknown>;
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

  return Math.min(MAX_RETRY_DELAY_MS, FLUSH_INTERVAL_MS * 2 ** Math.max(0, attempt - 1));
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Failed to record swap";
}

function extractTxHashFromWalletResult(result: unknown) {
  if (isTxHash(result)) {
    return result.toLowerCase();
  }

  if (!result || typeof result !== "object") {
    return null;
  }

  const record = result as Record<string, unknown>;
  const candidates = [
    record.hash,
    record.txHash,
    record.transactionHash,
    record.result,
    record.data,
  ];

  for (const candidate of candidates) {
    if (isTxHash(candidate)) {
      return candidate.toLowerCase();
    }
  }

  return null;
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

    const resolvedChainId = resolveChainId(item.chainId);
    const normalizedTxHash = item.txHash.toLowerCase();

    deduped.set(`${resolvedChainId}:${normalizedTxHash}`, {
      address: normalizeAddress(item.address),
      txHash: normalizedTxHash,
      chainId: resolvedChainId,
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

    const resolvedChainId = resolveChainId(item.chainId);
    const providerKey = item.providerKey || CONNECTOR_PROVIDER_KEY;

    deduped.set(`${providerKey}:${resolvedChainId}:${callId}`, {
      address: normalizeAddress(item.address),
      callId,
      providerKey,
      chainId: resolvedChainId,
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

function withRequestData(args: EthereumRequestArguments, data: `0x${string}`) {
  if (Array.isArray(args?.params)) {
    const [firstParam, ...rest] = args.params;

    if (firstParam && typeof firstParam === "object" && !Array.isArray(firstParam)) {
      return {
        ...args,
        params: [{ ...(firstParam as Record<string, unknown>), data }, ...rest],
      };
    }
  }

  if (args?.params && typeof args.params === "object" && !Array.isArray(args.params)) {
    return {
      ...args,
      params: {
        ...(args.params as Record<string, unknown>),
        data,
      },
    };
  }

  return args;
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

function getDataLength(data: unknown) {
  return typeof data === "string" ? data.length : 0;
}

function getLoggableValue(value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  return undefined;
}

function warnBlockedSwapTransaction({
  reason,
  method,
  tx,
  chainId,
  callIndex,
}: {
  reason: string;
  method?: string;
  tx?: WalletCall | Record<string, unknown>;
  chainId?: number;
  callIndex?: number;
}) {
  if (process.env.NODE_ENV !== "development") {
    return;
  }

  console.warn("[DustSwap] Blocked invalid swap transaction", {
    reason,
    method,
    to: typeof tx?.to === "string" ? tx.to : undefined,
    dataLength: getDataLength(tx?.data),
    value: getLoggableValue(tx?.value),
    chainId,
    callIndex,
  });
}

function throwBlockedSwapTransaction({
  reason,
  method,
  tx,
  chainId,
  callIndex,
  message,
}: {
  reason: string;
  method?: string;
  tx?: WalletCall | Record<string, unknown>;
  chainId?: number;
  callIndex?: number;
  message?: string;
}): never {
  warnBlockedSwapTransaction({ reason, method, tx, chainId, callIndex });
  throw new Error(message ?? SWAP_ROUTE_UNAVAILABLE_ERROR_MESSAGE);
}

// Layer A — pre-sign fee-theft guard. Only on /swap, only Base (certified
// zero-false-positive there), only when the kill-switch is on. Blocks a swap that
// targets an OpenOcean router but has had DustSwap's referrer stripped by an
// extension, and warns the user. Returns true if it blocked (never returns then).
function guardSwapReferrerOrThrow(
  calls: Array<WalletCall | Record<string, unknown>>,
  method: string,
  resolvedChainId: number
) {
  if (
    !isSwapReferrerGuardEnabled() ||
    !shouldGuardSwapWidgetTransaction() ||
    resolvedChainId !== BASE_CHAIN_ID
  ) {
    return;
  }

  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    if (getSwapReferrerTamperReason(call, isOpenOceanRouterAddress)) {
      emitSwapTamperWarning({ source: "pre_sign_block" });
      throwBlockedSwapTransaction({
        reason: "referrer_stripped",
        method,
        tx: call,
        chainId: resolvedChainId,
        callIndex: calls.length > 1 ? index : undefined,
        message: SWAP_REFERRER_TAMPERED_ERROR_MESSAGE,
      });
    }
  }
}

function shouldGuardSwapWidgetTransaction() {
  if (typeof window === "undefined") {
    return false;
  }

  return window.location.pathname.replace(/\/+$/, "") === "/swap";
}

function hasOpenOceanCall(calls: WalletCall[]) {
  return calls.some((call) => {
    const to = typeof call?.to === "string" ? call.to.toLowerCase() : "";
    return isOpenOceanRouterAddress(to);
  });
}

function hasOpenOceanApprovalCall(calls: WalletCall[]) {
  return calls.some((call) => isOpenOceanApprovalCall(call?.data));
}

function isEligibleBuilderCodeSwapTransaction(
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

function applyBuilderCodeToEligibleSwapTransaction(
  args: EthereumRequestArguments,
  request: Record<string, unknown>,
  resolvedChainId: number
) {
  if (!isEligibleBuilderCodeSwapTransaction(request, resolvedChainId)) {
    return args;
  }

  const nextData = appendBuilderCodeToData(
    typeof request.data === "string" && request.data.startsWith("0x")
      ? (request.data as `0x${string}`)
      : undefined
  );

  if (!nextData || nextData === request.data) {
    return args;
  }

  return withRequestData(args, nextData);
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

function extractApproveSpender(data: unknown) {
  if (!isErc20ApproveCall(data)) {
    return null;
  }

  const normalized = (data as string).toLowerCase();
  if (normalized.length < 74) {
    return null;
  }

  return `0x${normalized.slice(34, 74)}`;
}

function isOpenOceanApprovalCall(data: unknown) {
  const spender = extractApproveSpender(data);
  return spender ? isOpenOceanRouterAddress(spender) : false;
}

function getTransactionReceiptResult(result: unknown): TransactionReceiptResult | null {
  if (!result || typeof result !== "object") {
    return null;
  }

  return result as TransactionReceiptResult;
}

function hasReceiptBeenMined(receipt: TransactionReceiptResult | null) {
  if (!receipt) {
    return false;
  }

  return Boolean(receipt.blockHash || receipt.blockNumber);
}

function isSuccessfulReceiptStatus(status: string | number | undefined) {
  if (typeof status === "number") {
    return status === 1;
  }

  if (typeof status === "string") {
    const normalized = status.toLowerCase();
    return normalized === "0x1" || normalized === "1" || normalized === "success";
  }

  return true;
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
  const response = await publicApiFetch(buildPublicApiUrl("/api/swaps/record"), {
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
    ? (JSON.parse(text) as {
        success?: boolean;
        error?: string;
        code?: string;
        referrer?: string | null;
        questSync?: {
          success?: boolean;
          completedQuests?: Array<{ awardedPoints: number; questId: string; slug: string }>;
          error?: string;
        };
      })
    : {};

  // Layer B — server verified the on-chain referrer was hijacked by an extension.
  // Reliable regardless of extension injection order; warn the user to disable it.
  if (payload.code === "referrer_hijacked") {
    emitSwapTamperWarning({ source: "onchain_detected", referrer: payload.referrer ?? null });
  }

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
    let isSettingUpProviders = false;
    const providerRecords = new Map<string, WrappedProviderRecord>();
    const providerRestorers: Array<() => void> = [];
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
        (candidate) =>
          !(
            candidate.txHash === normalizedItem.txHash &&
            candidate.chainId === normalizedItem.chainId
          )
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
            candidate.providerKey === normalizedItem.providerKey &&
            candidate.chainId === normalizedItem.chainId
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
            const swapResult = await postSwapRecord(item);
            nextQueue = nextQueue.filter((candidate) => candidate.txHash !== item.txHash);

            clearPointsSummaryCache(item.address);
            emitDataInvalidation("profile", "swap-recorded");
            emitDataInvalidation("leaderboard", "swap-recorded");

            if (swapResult.questSync?.success) {
              emitDataInvalidation("quests", "swap-recorded");
            }

            if ((swapResult.questSync?.completedQuests?.length || 0) > 0) {
              emitDataInvalidation("points", "swap-recorded:quest-completed");
            }
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

    const waitForApprovalReceipt = async (
      originalRequest: (args: EthereumRequestArguments) => Promise<unknown>,
      txHash: string
    ) => {
      for (let attempt = 0; attempt < APPROVAL_RECEIPT_MAX_ATTEMPTS; attempt += 1) {
        let receiptResult: TransactionReceiptResult | null = null;

        try {
          receiptResult = getTransactionReceiptResult(
            await originalRequest({
              method: "eth_getTransactionReceipt",
              params: [txHash],
            })
          );
        } catch {
          return null;
        }

        if (hasReceiptBeenMined(receiptResult)) {
          if (!isSuccessfulReceiptStatus(receiptResult?.status)) {
            throw new Error("Approval transaction reverted onchain");
          }

          return receiptResult;
        }

        await sleep(APPROVAL_RECEIPT_POLL_DELAY_MS);
      }

      return null;
    };

    const waitForApprovalWalletCall = async (
      originalRequest: (args: EthereumRequestArguments) => Promise<unknown>,
      callId: string
    ) => {
      for (let attempt = 0; attempt < APPROVAL_RECEIPT_MAX_ATTEMPTS; attempt += 1) {
        let statusResult: WalletCallsStatusResult | null = null;

        try {
          statusResult = getCallsStatusResult(
            await originalRequest({
              method: "wallet_getCallsStatus",
              params: [callId],
            })
          );
        } catch {
          return null;
        }

        const txHashes = getCallsStatusTxHashes(statusResult);
        if (txHashes.length > 0) {
          return txHashes;
        }

        if (getCallsStatusState(statusResult) === "failure") {
          throw new Error("Approval wallet call reverted onchain");
        }

        await sleep(APPROVAL_RECEIPT_POLL_DELAY_MS);
      }

      return null;
    };

    const wrapProvider = (providerKey: string, provider: RequestCapableProvider) => {
      if (!provider || typeof provider.request !== "function") {
        return;
      }

      const existingState = provider[SWAP_CAPTURE_PROVIDER_STATE_KEY];
      if (existingState?.wrappedRequest === provider.request) {
        providerRecords.set(providerKey, {
          key: providerKey,
          provider,
          originalRequest: existingState.originalRequest,
        });
        return;
      }

      const originalRequest = provider.request.bind(provider);
      const wrappedRequest = async (args: EthereumRequestArguments) => {
        const method = args?.method;
        let forwardedArgs = args;

        if (method === "eth_sendTransaction" || method === "wallet_sendTransaction") {
          const request = getRequestPayload(args);
          const resolvedChainId = resolveChainId(
            request.chainId,
            chainId,
            provider.chainId,
            (window as Window & { ethereum?: RequestCapableProvider }).ethereum?.chainId
          );
          const invalidReason = shouldGuardSwapWidgetTransaction()
            ? getInvalidSwapTxReason(request)
            : null;

          if (invalidReason) {
            throwBlockedSwapTransaction({
              reason: invalidReason,
              method,
              tx: request,
              chainId: resolvedChainId,
            });
          }

          guardSwapReferrerOrThrow([request], method, resolvedChainId);

          // Preserve builder code attribution on swap and approval calls,
          // but keep the original wallet method so the widget can track state correctly.
          forwardedArgs = applyBuilderCodeToEligibleSwapTransaction(
            args,
            request,
            resolvedChainId
          );
        }

        if (method === "wallet_sendCalls") {
          const request = getWalletSendCallsRequest(args);
          const resolvedChainId = resolveChainId(
            request.chainId,
            chainId,
            provider.chainId,
            (window as Window & { ethereum?: RequestCapableProvider }).ethereum?.chainId
          );
          const invalidRequest = shouldGuardSwapWidgetTransaction()
            ? validateWalletSendCalls(request)
            : null;

          if (invalidRequest) {
            throwBlockedSwapTransaction({
              reason: invalidRequest.reason,
              method,
              tx: invalidRequest.call,
              chainId: resolvedChainId,
              callIndex: invalidRequest.callIndex,
            });
          }

          guardSwapReferrerOrThrow(
            Array.isArray(request.calls) ? request.calls : [],
            method,
            resolvedChainId
          );
        }

        let result = await originalRequest(forwardedArgs);

        if (method === "eth_sendTransaction" || method === "wallet_sendTransaction") {
          const txHash = extractTxHashFromWalletResult(result);
          const request = getRequestPayload(forwardedArgs);

          if (txHash && isOpenOceanApprovalCall(request.data)) {
            await waitForApprovalReceipt(originalRequest, txHash);
          }

          if (txHash) {
            result = txHash;
          }
        }

        if (method === "wallet_sendCalls") {
          const request = getWalletSendCallsRequest(args);
          const callId = resolveCallsId(result);

          if (callId && hasOpenOceanApprovalCall(request.calls || [])) {
            await waitForApprovalWalletCall(originalRequest, callId);
          }
        }

        try {
          if (method === "eth_sendTransaction" || method === "wallet_sendTransaction") {
            const request = getRequestPayload(forwardedArgs);
            const to = String(request.to || "").toLowerCase();
            const txHash = extractTxHashFromWalletResult(result) || "";
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
              isSupportedSwapCaptureChainId(resolvedChainId) &&
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
              isSupportedSwapCaptureChainId(resolvedChainId) &&
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
      provider[SWAP_CAPTURE_PROVIDER_STATE_KEY] = {
        originalRequest,
        wrappedRequest,
      };
      providerRecords.set(providerKey, {
        key: providerKey,
        provider,
        originalRequest,
      });

      providerRestorers.push(() => {
        if (
          provider.request === wrappedRequest &&
          provider[SWAP_CAPTURE_PROVIDER_STATE_KEY]?.wrappedRequest === wrappedRequest
        ) {
          provider.request = originalRequest;
          delete provider[SWAP_CAPTURE_PROVIDER_STATE_KEY];
        }
      });
    };

    const setupProviders = async () => {
      if (isSettingUpProviders) {
        return;
      }

      isSettingUpProviders = true;

      try {
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
      } finally {
        isSettingUpProviders = false;
      }
    };

    const flushNow = () => {
      void setupProviders();
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
      void setupProviders();
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
