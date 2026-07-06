/**
 * Transparent eth_call micro-batcher over Multicall3 — cuts quote-probe RPC volume ~90-95%.
 *
 * WHY: every DustSweep quote fires ~35 quoter probes per token as SEPARATE eth_calls; each
 * costs a full request (and ~26 Alchemy CU) even when it merely reverts with "no pool". This
 * layer collects concurrent probes for a few milliseconds and sends them as ONE Multicall3
 * aggregate3 eth_call, then resolves each caller with its own sub-result.
 *
 * SAFETY MODEL (must never be worse than the direct path):
 *   - Sub-call revert → the caller gets an RpcDeterministicError exactly like a direct revert,
 *     so every adapter's existing catch-path behaves identically.
 *   - Whole-batch failure (transport, node gas cap, decode) → every queued item is re-run as a
 *     plain DIRECT eth_call (today's behavior), and batching cools off for 60s.
 *   - Kill switch: DUST_SWEEP_MULTICALL_BATCHING=false restores the direct path instantly.
 *   - Callers that pass an AbortSignal must NOT use this layer (a shared batch cannot honor
 *     per-call cancellation) — the callContract wrapper routes those direct.
 */

import { decodeFunctionResult, encodeFunctionData, isAddress, type Address, type Hex } from "viem";
import { RpcDeterministicError } from "../utils/baseRpc";
import { chainRpcRequest } from "../utils/chainRpc";

// chainRpcRequest(8453, …) delegates 1:1 to baseRpcRequest, so the Base path is unchanged.
const DEFAULT_CHAIN_ID = 8453;

// Canonical Multicall3 — same address on Base as on every major chain.
const MULTICALL3_ADDRESS = (() => {
  const candidate = process.env.MULTICALL3_ADDRESS || "0xcA11bde05977b3631167028862bE2a173976CA11";
  return (isAddress(candidate) ? candidate : "0xcA11bde05977b3631167028862bE2a173976CA11") as Address;
})();

const MULTICALL3_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
        name: "calls",
        type: "tuple[]",
      },
    ],
    name: "aggregate3",
    outputs: [
      {
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
        name: "returnData",
        type: "tuple[]",
      },
    ],
    stateMutability: "payable",
    type: "function",
  },
] as const;

// Gas-starvation canary: Multicall3.getBlockNumber() — a few hundred gas, can only fail if the
// batch ran out of gas by the time it executed. Appended LAST to every batch: if the canary
// reports failure, earlier "reverts" in this batch are NOT trustworthy (an expensive sub-call
// may have starved the rest), so the whole batch is retried on the direct path instead of
// silently reporting healthy pools as "no pool".
const CANARY_CALLDATA = "0x42cbb15c" as Hex; // getBlockNumber()

function boundedEnv(name: string, fallback: number, min: number, max: number) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

// Batch size bounds total gas of the aggregate call (each quoter sim can use ~0.1-1M gas).
// 12 keeps worst-case batches far below every provider's eth_call gas cap while still cutting
// request volume ~90%; the gas canary + whole-batch fallback cover anything beyond that.
const MAX_BATCH = boundedEnv("DUST_SWEEP_MULTICALL_MAX_BATCH", 12, 2, 50);
// Collection window: long enough to gather one probe per concurrently-quoting adapter/token,
// short enough to be invisible next to network latency.
const WINDOW_MS = boundedEnv("DUST_SWEEP_MULTICALL_WINDOW_MS", 8, 1, 100);
const FLUSH_TIMEOUT_MS = boundedEnv("DUST_SWEEP_MULTICALL_TIMEOUT_MS", 8_000, 2_000, 20_000);
const DIRECT_TIMEOUT_MS = 5_000; // same as the historical per-call timeout
const BREAKER_COOL_OFF_MS = 60_000;

type PendingCall = {
  to: Address;
  data: Hex;
  resolve: (value: Hex) => void;
  reject: (error: unknown) => void;
};

// One queue per chain — a batch must never mix chains (each flush is a single eth_call
// against ONE chain's RPC pool). Base traffic keeps its own queue exactly as before.
type ChainQueue = { queue: PendingCall[]; flushTimer: NodeJS.Timeout | null };
const chainQueues = new Map<number, ChainQueue>();
let breakerUntil = 0;
// Cumulative savings counters, logged periodically so the CU reduction is visible in prod logs.
let totalBatchedCalls = 0;
let totalFlushes = 0;

function getChainQueue(chainId: number): ChainQueue {
  let entry = chainQueues.get(chainId);
  if (!entry) {
    entry = { queue: [], flushTimer: null };
    chainQueues.set(chainId, entry);
  }
  return entry;
}

export function isMulticallBatchingEnabled() {
  return process.env.DUST_SWEEP_MULTICALL_BATCHING !== "false" && Date.now() >= breakerUntil;
}

/** Enqueue one eth_call; resolves with its returnData, rejects like a direct call would. */
export function batchedEthCall(to: Address, data: Hex, chainId: number = DEFAULT_CHAIN_ID): Promise<Hex> {
  return new Promise<Hex>((resolve, reject) => {
    const entry = getChainQueue(chainId);
    entry.queue.push({ to, data, resolve, reject });
    if (entry.queue.length >= MAX_BATCH) {
      flushQueue(chainId);
      return;
    }
    if (!entry.flushTimer) {
      entry.flushTimer = setTimeout(() => flushQueue(chainId), WINDOW_MS);
    }
  });
}

function flushQueue(chainId: number) {
  const entry = getChainQueue(chainId);
  if (entry.flushTimer) {
    clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
  }
  const items = entry.queue;
  entry.queue = [];
  for (let i = 0; i < items.length; i += MAX_BATCH) {
    void executeBatch(items.slice(i, i + MAX_BATCH), chainId);
  }
}

async function executeBatch(items: PendingCall[], chainId: number) {
  if (items.length === 0) return;

  // A 1-item "batch" gains nothing from the Multicall hop — send it direct.
  if (items.length === 1) {
    await runDirect(items[0]!, chainId);
    return;
  }

  try {
    const calldata = encodeFunctionData({
      abi: MULTICALL3_ABI,
      functionName: "aggregate3",
      args: [
        [
          ...items.map((item) => ({ target: item.to, allowFailure: true, callData: item.data })),
          // Gas canary — MUST be last; see CANARY_CALLDATA.
          { target: MULTICALL3_ADDRESS, allowFailure: true, callData: CANARY_CALLDATA },
        ],
      ],
    });
    const raw = await chainRpcRequest<Hex>(
      chainId,
      "eth_call",
      [{ to: MULTICALL3_ADDRESS, data: calldata }, "latest"],
      { timeoutMs: FLUSH_TIMEOUT_MS },
    );
    const results = decodeFunctionResult({
      abi: MULTICALL3_ABI,
      functionName: "aggregate3",
      data: raw,
    }) as readonly { success: boolean; returnData: Hex }[];

    if (!Array.isArray(results) || results.length !== items.length + 1) {
      throw new Error(
        `Multicall result shape mismatch (${Array.isArray(results) ? results.length : "?"} of ${items.length + 1})`,
      );
    }
    if (!results[items.length]!.success) {
      // Canary failed → the batch ran out of gas; earlier failures are unreliable.
      throw new Error("Multicall gas canary failed — batch may be gas-starved");
    }

    for (let i = 0; i < items.length; i += 1) {
      const outcome = results[i]!;
      if (outcome.success) {
        items[i]!.resolve(outcome.returnData);
      } else {
        // Identical semantics to a direct reverted eth_call.
        items[i]!.reject(new RpcDeterministicError("execution reverted (multicall sub-call)"));
      }
    }

    totalBatchedCalls += items.length;
    totalFlushes += 1;
    if (totalFlushes % 50 === 0) {
      console.info("[dustsweep/multicall] savings", {
        ethCallsBatched: totalBatchedCalls,
        rpcRequestsSent: totalFlushes,
        requestsSaved: totalBatchedCalls - totalFlushes,
      });
    }
  } catch (batchError) {
    // NEVER degrade below the direct path: re-run every item individually and cool off batching.
    breakerUntil = Date.now() + BREAKER_COOL_OFF_MS;
    console.warn("[dustsweep/multicall] batch flush failed — falling back to direct calls", {
      batchSize: items.length,
      coolOffMs: BREAKER_COOL_OFF_MS,
      message: batchError instanceof Error ? batchError.message : String(batchError),
    });
    await Promise.all(items.map((item) => runDirect(item, chainId)));
  }
}

async function runDirect(item: PendingCall, chainId: number) {
  try {
    item.resolve(
      await chainRpcRequest<Hex>(chainId, "eth_call", [{ to: item.to, data: item.data }, "latest"], {
        timeoutMs: DIRECT_TIMEOUT_MS,
      }),
    );
  } catch (error) {
    item.reject(error);
  }
}
