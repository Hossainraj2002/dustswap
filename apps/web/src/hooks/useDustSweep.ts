"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useConnection, usePublicClient, useWalletClient } from "wagmi";
import { base } from "viem/chains";
import { useBaseChainSwitch } from "@/hooks/useBaseChainSwitch";
import { concatHex, encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import {
  useTokenBalances,
  type TokenBalanceRefetchOptions,
  type TokenBalanceScanState,
} from "@/hooks/useTokenBalances";
import { useWalletConnection } from "@/hooks/useWalletConnection";
import { useWalletWhitelist } from "@/hooks/useWalletWhitelist";
import { getPermit2SignatureErrorMessage, PERMIT2_ADDRESS } from "@/lib/permit2";
import {
  canRecommendOneClickWallet,
  identifyDelegate,
  isSameEip7702WalletFamily,
  parseEip7702AuthorizedAddress,
} from "@/lib/eip7702";
import {
  DUST_SWEEP_AUTO_SELECT_LIMIT,
  DUST_SWEEP_AUTO_SELECT_LIMIT_BASE_COINBASE,
  DUST_SWEEP_EXECUTION_LANE,
  DUST_SWEEP_ROUTER_ADDRESS,
  DUST_SWEEP_ROUTER_V2_ADDRESS,
  V1_MAX_BATCH_SIZE,
  V2_MAX_BATCH_SIZE,
  encodeDustSweepV2Calldata,
  isOwnedModernLane,
  parseDustSweepError,
} from "@/lib/dustsweep-router";
import {
  isDustSweepApprovalBatchingEnabled,
  METAMASK_APPROVAL_BATCHING_DISABLED_NOTICE,
} from "@/lib/dustsweep-feature-flags";
import {
  getBatchCapabilityStatus,
  getChainCapabilities,
  getDustSweepWalletProfileBase,
  getWalletBatchNotice,
  getWalletRequestCandidates,
  isBatchCapabilitySupported,
  type WalletRpcRequest,
} from "@/lib/dustsweep-wallets";
import {
  buildWalletSendCallsPayload,
  requestWalletSendCalls,
} from "@/lib/dustsweep-wallet-rpc";
import { DATA_SUFFIX } from "@/lib/builderCode";
import { buildBasePaymasterCapabilities } from "@/lib/paymaster";
import { USDC_ADDRESS, WETH_ADDRESS } from "@/lib/tokens";
import {
  type DustSweepAtomicStatus,
  type DustSweepBuildTxResponse,
  type DustSweepCompletionSummary,
  type DustSweepWalletKey,
  type DustSweepWalletProfile,
  type DustSweepQuoteResponse,
  type DustSweepRoute,
  type RecommendedWallet,
  type SelectedToken,
  type SweepDelegation,
  type SweepRouteKind,
  type SweepStep,
  type SwappableToken,
  type Token,
  type UnavailableReason,
  type UnavailableToken,
} from "@/types/dustsweep";

const NATIVE_TOKEN_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;
const USDT_ADDRESS = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" as Address;

export const DEFAULT_OUTPUT_TOKENS: Token[] = [
  {
    address: NATIVE_TOKEN_SENTINEL,
    symbol: "ETH",
    name: "Ethereum",
    decimals: 18,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
    isNative: true,
  },
  {
    address: USDC_ADDRESS,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    logoURI: "https://basescan.org/token/images/centre-usdc_28.png",
  },
  {
    address: WETH_ADDRESS,
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
  },
  {
    address: USDT_ADDRESS,
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png",
  },
];

type ExecuteSweepResult = {
  txHash: Hex;
};

type ApprovalRequirement = {
  token: Address;
  amount: bigint;
  allowance: bigint;
  approvalAmount: bigint;
  resetFirst: boolean;
};

type WalletSendCall = {
  to: Address;
  data: Hex;
  value?: bigint;
  dataSuffix?: Hex;
};

type WalletCallsStatusResult = {
  status?: string | number;
  statusCode?: number;
  atomic?: boolean;
  receipts?: Array<{ transactionHash?: unknown; status?: unknown }>;
};

export type UseDustSweepReturn = {
  swappableTokens: SwappableToken[];
  unavailableTokens: UnavailableToken[];
  selectedTokens: SelectedToken[];
  tokenOut: Token | null;
  quote: DustSweepQuoteResponse | null;
  slippageBps: number;
  isLoading: boolean;
  balanceScan: TokenBalanceScanState;
  isQuoting: boolean;
  isSweeping: boolean;
  sweepStep: SweepStep;
  txHash: Hex | null;
  completionSummary: DustSweepCompletionSummary | null;
  error: string | null;
  executionNotice: string | null;
  quoteError: string | null;
  autoMode: boolean;
  autoSelectionUsd: number;
  batchMode: boolean;
  smartRouting: boolean;
  removeFailedTokens: boolean;
  routeMaxCap: number;
  supportsWalletSendCalls: boolean;
  routeKind: SweepRouteKind;
  delegation: SweepDelegation;
  recommendedWallet: RecommendedWallet | null;
  isDetectingRoute: boolean;
  permit2SetupCount: number;
  walletProfile: DustSweepWalletProfile;
  outputTokens: Token[];
  walletStatus: ReturnType<typeof useWalletWhitelist>;
  quoteFailedTokenAddresses: string[];
  setTokenOut: (token: Token | null) => void;
  setSlippageBps: (value: number) => void;
  setAutoMode: (value: boolean) => void;
  setAutoSelectionUsd: (value: number) => void;
  setBatchMode: (value: boolean) => void;
  setSmartRouting: (value: boolean) => void;
  setRemoveFailedTokens: (value: boolean) => void;
  setSelectedTokens: (tokens: SelectedToken[]) => void;
  addToken: (token: SelectedToken) => void;
  selectAllTokens: () => void;
  removeToken: (address: string) => void;
  clearSelectedTokens: () => void;
  clearUnavailableTokens: () => void;
  removeUnavailableToken: (address: string) => void;
  refreshTokens: (options?: TokenBalanceRefetchOptions) => Promise<void>;
  refreshQuote: () => Promise<void>;
  previewSweep: () => Promise<void>;
  executeSweep: () => Promise<ExecuteSweepResult | null>;
  resetSweepState: () => void;
  dismissCompletionSummary: () => void;
};

const ATOMIC_BATCH_UNSUPPORTED_MESSAGE =
  "This wallet cannot combine token approvals and the sweep into one atomic Base request. DustSweep will use Permit2 approvals and a standard sweep.";
const TOKENPOCKET_SPLIT_BATCH_NOTICE =
  "TokenPocket estimates DustSweep more reliably when approvals are batched first. DustSweep will send approvals first, then send the sweep after allowances are confirmed.";
const TOKENPOCKET_BUNDLED_NOTICE =
  "TokenPocket batches your token approvals and the sweep into one transaction.";
const OKX_SPLIT_BATCH_NOTICE =
  "OKX Wallet will send token approvals in one real batch first, then send the sweep after the approval batch is confirmed.";
const METAMASK_LOCKED_MESSAGE = "Unlock MetaMask and try again. No transaction was sent.";
const TOKENPOCKET_BATCH_FAILURE_MESSAGE =
  "TokenPocket batch execution failed. Please retry, reduce selected tokens, or use another supported wallet while we continue improving TokenPocket support.";
const OKX_BATCH_STATUS_UNCLEAR_MESSAGE =
  "OKX batch status was unclear. No fallback prompts were sent. Check OKX activity or retry once.";
const OKX_COMBINED_BATCH_NOTICE =
  "OKX bundles all your token approvals and the sweep into one transaction. If the batch is too large, DustSweep automatically retries in smaller batches.";
const OKX_CHUNKED_BATCH_NOTICE =
  "OKX couldn't take all tokens in one batch — sweeping in smaller combined approve+sweep batches.";
const OKX_BATCH_FALLBACK_NOTICE =
  "OKX couldn't combine approvals and the sweep into one transaction; approving each token, then sweeping.";
const TOKENPOCKET_EXECUTE_FAILURES_TOPIC =
  "0xc42159347c71974b140767e5ffe0d24cb03d38c0e86462ec59a240394c3b9b4c";
const TOKENPOCKET_BATCH_APPROVALS_ENABLED =
  process.env.NEXT_PUBLIC_DUST_SWEEP_TOKENPOCKET_BATCH_APPROVALS === "true";
// Fallback chunk size (calls per wallet prompt) used ONLY after an EIP-5792 wallet
// rejects the single full bundle as "batch too large". This is NOT a cap on the
// first attempt — the full up-to-50-token bundle is always tried first.
const CHUNK_APPROVALS_PER_BATCH = 10;
// OKX: tokens per SMALLER combined approve+sweep batch used as the fallback when
// the single combined batch over all selected tokens is too large for OKX to
// decode/simulate. Each chunk still carries its OWN approvals + sweep as ONE
// atomic wallet_sendCalls, so this is never a one-by-one approval flow — it is
// "batch again, smaller". Override with NEXT_PUBLIC_DUST_SWEEP_OKX_CHUNK_SIZE.
const OKX_COMBINED_CHUNK_SIZE = (() => {
  const parsed = Number(process.env.NEXT_PUBLIC_DUST_SWEEP_OKX_CHUNK_SIZE);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 10;
})();

function isSameAddress(a?: string | null, b?: string | null) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function isSelectedOutputToken(token: Token, tokenOut: Token | null) {
  return Boolean(tokenOut && isSameAddress(token.address, tokenOut.address));
}

function chunkWalletCalls<T>(calls: T[], size: number): T[][] {
  const chunks: T[][] = [];
  const step = Math.max(1, size);
  for (let index = 0; index < calls.length; index += step) {
    chunks.push(calls.slice(index, index + step));
  }
  return chunks;
}

function normalizeQuotePayload(payload: unknown): DustSweepQuoteResponse {
  const data =
    payload &&
    typeof payload === "object" &&
    "data" in payload &&
    (payload as { data?: unknown }).data
      ? (payload as { data: unknown }).data
      : payload;

  if (!data || typeof data !== "object") {
    throw new Error("Quote response was empty");
  }

  return data as DustSweepQuoteResponse;
}

// Skip reasons that are DEFINITIVE for the current balance — a token flagged with one of
// these must never be carried forward from an earlier quote (it would re-introduce a token
// the server/preflight just decided to drop, e.g. a transfer-restricted token). Everything
// else (NO_LIQUIDITY / QUOTE_FAILED / a plain timeout with no skip entry) is treated as
// transient and is eligible for carry-forward.
const DEFINITIVE_SKIP_REASONS = new Set<UnavailableReason>([
  "CANT_TRANSFER",
  "BELOW_THRESHOLD",
  "NOT_WHITELISTED",
  "NATIVE_WRAP_REQUIRED",
  "OUTPUT_ASSET",
  "SPAM_OR_DENYLISTED",
]);

function safeBigInt(value: string | undefined | null): bigint {
  try {
    return value ? BigInt(value) : 0n;
  } catch {
    return 0n;
  }
}

function sumRouteField(routes: DustSweepRoute[], field: "estimatedOut" | "amountOutMin"): bigint {
  return routes.reduce((total, route) => total + safeBigInt(route[field]), 0n);
}

// Re-derive the basket aggregates after the route set was changed by a carry-forward
// merge (see refreshQuote). Output amounts are summed EXACTLY in base units; the
// USD/fee figures are scaled proportionally from a trusted reference quote. Because the
// whole basket pays out the SAME output token, USD is exactly proportional to the summed
// output amount, so the scale is precise (the 6-digit BigInt ratio avoids Number(bigint)
// overflow for 18-decimal output tokens). Meta fields (deadline, permit2Nonce, feeBps,
// gas, lane) are inherited from `base` untouched.
function recomputeQuoteForRoutes(
  base: DustSweepQuoteResponse,
  routes: DustSweepRoute[],
  reference: Pick<DustSweepQuoteResponse, "totalEstimatedOut" | "totalEstimatedOutUSD"> | null,
): DustSweepQuoteResponse {
  const totalOut = sumRouteField(routes, "estimatedOut");
  const minOut = sumRouteField(routes, "amountOutMin");
  const feeBps = Math.max(0, Math.min(10_000, base.feeBps ?? 0));
  const feeAmount = (totalOut * BigInt(feeBps)) / 10_000n;
  const netOut = totalOut - feeAmount;

  const refOut = reference ? safeBigInt(reference.totalEstimatedOut) : 0n;
  const canScale = Boolean(reference) && refOut > 0n && (reference?.totalEstimatedOutUSD ?? 0) > 0;
  const scaleUsd = (amount: bigint) =>
    canScale
      ? (Number((amount * 1_000_000n) / refOut) / 1_000_000) * (reference as DustSweepQuoteResponse).totalEstimatedOutUSD
      : 0;

  const totalUsd = canScale ? scaleUsd(totalOut) : base.totalEstimatedOutUSD;
  const netUsd = canScale ? scaleUsd(netOut) : base.netEstimatedOutUSD;
  const feeUsd = canScale ? Math.max(0, totalUsd - (netUsd ?? totalUsd)) : base.feeAmountUSD;

  return {
    ...base,
    routes,
    totalEstimatedOut: totalOut.toString(),
    minAmountOut: minOut.toString(),
    protocolFeeAmount: feeAmount.toString(),
    netEstimatedOut: netOut.toString(),
    totalEstimatedOutUSD: totalUsd,
    netEstimatedOutUSD: netUsd,
    feeAmountUSD: feeUsd,
  };
}

function isRejectedByUser(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  const lowered = message.toLowerCase();
  if (lowered.includes("wallet rejected approval+sweep batching")) {
    return false;
  }
  if (
    (lowered.includes("wallet_sendcalls") ||
      lowered.includes("atomic") ||
      lowered.includes("batch")) &&
    isBatchFallbackError(error)
  ) {
    return false;
  }
  return (
    lowered.includes("user rejected") ||
    lowered.includes("rejected") ||
    lowered.includes("denied") ||
    lowered.includes("cancel")
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "");
}

function getDebugErrorMessage(error: unknown) {
  return getErrorMessage(error)
    .replace(/0x[a-fA-F0-9]{64,}/g, "0x[...]")
    .replace(/0x[a-fA-F0-9]{40}/g, "0x[...]")
    .slice(0, 240);
}

function getErrorCode(error: unknown) {
  if (!error || typeof error !== "object") {
    return "";
  }

  const candidate = error as {
    code?: unknown;
    cause?: { code?: unknown };
    data?: { code?: unknown; originalError?: { code?: unknown } };
  };
  return String(
    candidate.code ??
      candidate.cause?.code ??
      candidate.data?.code ??
      candidate.data?.originalError?.code ??
      "",
  );
}

function isWalletLockedError(error: unknown) {
  const lowered = getErrorMessage(error).toLowerCase();
  return (
    (lowered.includes("keyringcontroller") && lowered.includes("locked")) ||
    lowered.includes("controller is locked") ||
    lowered.includes("wallet is locked") ||
    (lowered.includes("metamask") && lowered.includes("locked"))
  );
}

function isBatchFallbackError(error: unknown) {
  const code = getErrorCode(error);
  const lowered = getErrorMessage(error).toLowerCase();
  return (
    ["4100", "5700", "5710", "5740", "5750", "5760"].includes(code) ||
    lowered.includes("wallet_sendcalls") ||
    lowered.includes("wallet sendcalls") ||
    lowered.includes("wallet_getcallsstatus") ||
    lowered.includes("eip-7702") ||
    lowered.includes("eip7702") ||
    lowered.includes("atomic batch") ||
    lowered.includes("atomicity") ||
    lowered.includes("forceatomic") ||
    lowered.includes("atomicrequired") ||
    lowered.includes("method not found") ||
    lowered.includes("method does not exist") ||
    lowered.includes("unsupported method") ||
    lowered.includes("not implemented") ||
    lowered.includes("not supported") ||
    lowered.includes("not available") ||
    lowered.includes("unavailable") ||
    lowered.includes("bundle too large") ||
    lowered.includes("batch too large") ||
    lowered.includes("batch size") ||
    lowered.includes("cannot estimate gas") ||
    lowered.includes("contract error") ||
    lowered.includes("invalid params") ||
    lowered.includes("unauthorized") ||
    lowered.includes("upgrade rejected") ||
    lowered.includes("third-party contract execution") ||
    lowered.includes("contact the project") ||
    lowered.includes("atomicity not supported") ||
    lowered.includes("unsupported chain") ||
    lowered.includes("unsupported non-optional capability") ||
    lowered.includes("5700") ||
    lowered.includes("5710") ||
    lowered.includes("5740") ||
    lowered.includes("5750") ||
    lowered.includes("5760") ||
    (lowered.includes("batch") &&
      (lowered.includes("failed") ||
        lowered.includes("rejected") ||
        lowered.includes("unsupported")))
  );
}

function isTokenPocketConnectorExecutionError(error: unknown) {
  const lowered = getErrorMessage(error).toLowerCase();
  return (
    lowered.includes("unknown connector error") ||
    lowered.includes("transaction is expected to fail") ||
    lowered.includes("cannot estimate gas") ||
    lowered.includes("contract error") ||
    lowered.includes(TOKENPOCKET_BATCH_FAILURE_MESSAGE.toLowerCase())
  );
}

function isApprovalBatchStatusUncertainError(error: unknown) {
  const lowered = getErrorMessage(error).toLowerCase();
  return (
    lowered.includes("wallet_getcallsstatus") ||
    lowered.includes("did not return an id") ||
    lowered.includes("timed out") ||
    lowered.includes("without a transaction hash") ||
    lowered.includes("finished without") ||
    lowered.includes("transaction receipt") ||
    lowered.includes("transaction not found") ||
    lowered.includes("could not be found") ||
    lowered.includes("unknown bundle id")
  );
}

function getBatchFallbackNotice(walletName?: string | null, walletKey?: DustSweepWalletKey) {
  if (walletKey === "rabby") {
    return "Rabby does not expose atomic wallet batching here, so DustSweep will use Permit2 approvals and a standard sweep.";
  }

  return `${walletName || "Wallet"} atomic batch was not ready, using Permit2 approvals and a standard sweep.`;
}

// The wallet rejected the bundle specifically because it had too many calls / too
// much gas for one atomic request (EIP-5792 error 5740). Distinct from a generic
// batch failure: this one is fixable by splitting the approvals into smaller
// chunks, so it drives the chunked-approvals-then-sweep fallback.
function isBatchTooLargeError(error: unknown) {
  const code = getErrorCode(error);
  const lowered = getErrorMessage(error).toLowerCase();
  return (
    code === "5740" ||
    lowered.includes("bundle too large") ||
    lowered.includes("batch too large") ||
    lowered.includes("too many calls") ||
    lowered.includes("exceeds block gas limit") ||
    lowered.includes("gas limit too high") ||
    lowered.includes("exceeds the gas limit")
  );
}

function getBatchFallbackNoticeForError(args: {
  walletName?: string | null;
  walletKey?: DustSweepWalletKey;
  error: unknown;
  callCount?: number;
}) {
  const prefix = `${args.walletName || "Wallet"} atomic batch`;
  const code = getErrorCode(args.error);
  const lowered = getErrorMessage(args.error).toLowerCase();

  if (code === "5740" || lowered.includes("bundle too large") || lowered.includes("batch too large")) {
    return `${prefix} was too large${args.callCount ? ` (${args.callCount} calls)` : ""}, using Permit2 approvals and a standard sweep. Try fewer tokens for one-click batch.`;
  }

  if (code === "5750" || lowered.includes("upgrade rejected")) {
    return `${prefix} needs a wallet-managed EIP-7702 upgrade, but the upgrade was rejected. Using Permit2 approvals and a standard sweep.`;
  }

  if (code === "5760" || lowered.includes("atomicity not supported")) {
    return `${prefix} is not atomic for this account/network right now, using Permit2 approvals and a standard sweep.`;
  }

  if (code === "4100" || lowered.includes("unauthorized")) {
    return `${prefix} was not authorized for this account, using Permit2 approvals and a standard sweep. Reconnect the wallet and try again.`;
  }

  if (code === "5710" || lowered.includes("unsupported chain")) {
    return `${prefix} is not enabled for this network, using Permit2 approvals and a standard sweep.`;
  }

  if (code === "-32602" || lowered.includes("invalid params")) {
    return `${prefix} rejected the batch request format, using Permit2 approvals and a standard sweep.`;
  }

  return getBatchFallbackNotice(args.walletName, args.walletKey);
}

function uniqueApprovalRequirements(routes: DustSweepQuoteResponse["routes"]) {
  const byToken = new Map<string, { token: Address; amount: bigint }>();

  for (const route of routes) {
    const amount = BigInt(route.amountIn || "0");
    if (amount <= 0n) continue;

    const key = route.tokenIn.toLowerCase();
    const current = byToken.get(key);
    byToken.set(key, {
      token: route.tokenIn,
      amount: (current?.amount || 0n) + amount,
    });
  }

  return Array.from(byToken.values());
}

function requiresApprovalReset(token: Address) {
  return token.toLowerCase() === USDT_ADDRESS.toLowerCase();
}

function isTxHash(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
}

function resolveSendCallsId(result: unknown) {
  if (typeof result === "string" && result.trim()) {
    return result;
  }

  if (result && typeof result === "object" && "id" in result) {
    const value = (result as { id?: unknown }).id;
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  if (result && typeof result === "object" && "batchId" in result) {
    const value = (result as { batchId?: unknown }).batchId;
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return "";
}

function getCallsStatusState(result: WalletCallsStatusResult | null) {
  if (!result) {
    return "pending" as const;
  }

  if (typeof result.status === "string") {
    const normalized = result.status.toLowerCase();
    if (normalized === "success" || normalized === "confirmed" || normalized === "completed") {
      return "success" as const;
    }
    if (normalized === "failure" || normalized === "failed") {
      return "failure" as const;
    }
    if (normalized === "pending") {
      return "pending" as const;
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

function getLatestCallsStatusTxHash(result: WalletCallsStatusResult | null) {
  for (const receipt of [...(result?.receipts || [])].reverse()) {
    const r = receipt as { transactionHash?: unknown; txHash?: unknown; hash?: unknown };
    const h = r?.transactionHash ?? r?.txHash ?? r?.hash;
    if (isTxHash(h)) return h as Hex;
  }
  return undefined;
}

function hasFailedCallsReceipt(result: WalletCallsStatusResult | null) {
  return Boolean(
    result?.receipts?.some((receipt) => {
      const status = receipt?.status;
      return status === 0 || status === "0" || status === "0x0" || status === false;
    }),
  );
}

function getSendCallsResultTxHash(result: unknown) {
  if (!result || typeof result !== "object") {
    return undefined;
  }

  const candidate = result as {
    hash?: unknown;
    transactionHash?: unknown;
    receipts?: Array<{ transactionHash?: unknown }>;
  };

  if (isTxHash(candidate.transactionHash)) return candidate.transactionHash;
  if (isTxHash(candidate.hash)) return candidate.hash;
  return getLatestCallsStatusTxHash(candidate as WalletCallsStatusResult);
}

function toRpcQuantity(value?: bigint) {
  return `0x${(value || 0n).toString(16)}`;
}

function appendDataSuffix(data: Hex, dataSuffix?: Hex) {
  return dataSuffix && dataSuffix !== "0x" ? concatHex([data, dataSuffix]) : data;
}

// Clean, standard wallet_sendCalls call object: { to, data, value } only. No
// per-call gas or custom capability fields — the wallet/provider estimates gas
// for the whole atomic bundle. When appendSuffix is true the builder-code suffix
// (if present on the call) is concatenated into data; when false it's kept as a
// separate field for callers that bake the suffix in themselves.
function normalizeWalletSendCall(
  call: WalletSendCall,
  appendSuffix = true,
): WalletSendCall {
  if (!appendSuffix) {
    return {
      to: call.to,
      value: call.value,
      data: call.data,
      dataSuffix: call.dataSuffix,
    };
  }

  return {
    to: call.to,
    value: call.value,
    data: appendDataSuffix(call.data, call.dataSuffix),
  };
}

function buildSendCallsCapabilities(args: {
  usePaymasterCapabilities: boolean;
}) {
  const capabilities: Record<string, unknown> = {};

  if (args.usePaymasterCapabilities) {
    Object.assign(capabilities, buildBasePaymasterCapabilities());
  }

  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function mergeUnavailableTokens(current: UnavailableToken[], additions: UnavailableToken[]) {
  const byAddress = new Map<string, UnavailableToken>();
  for (const token of current) {
    byAddress.set(token.address.toLowerCase(), token);
  }
  for (const token of additions) {
    byAddress.set(token.address.toLowerCase(), token);
  }
  return Array.from(byAddress.values());
}

function getCapForLane(lane?: string | null) {
  return lane === "owned_v1" ? V1_MAX_BATCH_SIZE : V2_MAX_BATCH_SIZE;
}

export function useDustSweep(): UseDustSweepReturn {
  const { address, isConnected } = useAccount();
  const connection = useConnection();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: base.id });
  const { switchToBase } = useBaseChainSwitch();
  const walletConnection = useWalletConnection();
  const walletStatus = useWalletWhitelist();
  const balances = useTokenBalances(address);
  const refetchBalances = balances.refetch;

  const [unavailableTokens, setUnavailableTokens] = useState<UnavailableToken[]>([]);
  const [selectedTokens, setSelectedTokens] = useState<SelectedToken[]>([]);
  const [tokenOut, setTokenOut] = useState<Token | null>(DEFAULT_OUTPUT_TOKENS[0]);
  const [quote, setQuote] = useState<DustSweepQuoteResponse | null>(null);
  const [slippageBps, setSlippageBps] = useState(50);
  const [autoMode, setAutoMode] = useState(false);
  const [autoSelectionUsd, setAutoSelectionUsd] = useState(100);
  const [batchMode, setBatchMode] = useState(true);
  const [smartRouting, setSmartRouting] = useState(true);
  const [removeFailedTokens, setRemoveFailedTokens] = useState(false);
  const [isQuoting, setIsQuoting] = useState(false);
  const [isSweeping, setIsSweeping] = useState(false);
  const [sweepStep, setSweepStep] = useState<SweepStep>("idle");
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [completionSummary, setCompletionSummary] = useState<DustSweepCompletionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [executionNotice, setExecutionNotice] = useState<string | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteFailedTokenAddresses, setQuoteFailedTokenAddresses] = useState<string[]>([]);
  const [supportsWalletSendCalls, setSupportsWalletSendCalls] = useState(false);
  const [atomicStatus, setAtomicStatus] = useState<DustSweepAtomicStatus>("unknown");
  const [delegation, setDelegation] = useState<SweepDelegation>({
    address: null,
    info: { state: "none" },
  });
  const [isDetectingRoute, setIsDetectingRoute] = useState(false);
  const [permit2SetupCount, setPermit2SetupCount] = useState(0);
  const sweepInFlightRef = useRef(false);
  // Sticky flag: once the OKX one-click combined batch is abandoned (the user
  // hits "Reject all" because OKX left Confirm disabled, or it errors), the NEXT
  // Sweep click skips the combined batch and uses the proven approve+sweep path so
  // the sweep always completes instead of dead-ending. Reset on account change and
  // after a successful sweep.
  const okxOneClickAbandonedRef = useRef(false);

  // Quote stability (fixes routes/quote vanishing when tokens are added/removed):
  //  - quoteRequestSeqRef: monotonic id so a slow, stale re-quote can never overwrite
  //    a newer one (race guard).
  //  - carriedRoutesRef: last KNOWN-GOOD route per input token (keyed by address). On a
  //    re-quote, any still-selected token whose fresh quote transiently missed (server
  //    per-token timeout under load) keeps its carried route instead of disappearing —
  //    but only while its input amount (balance) is unchanged.
  //  - lastQuoteMetaRef: the last full successful quote, used as the trusted reference
  //    for USD scaling + meta fields when rebuilding from carried routes.
  // All three are cleared when the output token / slippage / account changes.
  const quoteRequestSeqRef = useRef(0);
  const carriedRoutesRef = useRef<Map<string, DustSweepRoute>>(new Map());
  const lastQuoteMetaRef = useRef<DustSweepQuoteResponse | null>(null);

  const configuredRouteCap = getCapForLane(DUST_SWEEP_EXECUTION_LANE);
  const walletProfileBase = useMemo(
    () =>
      getDustSweepWalletProfileBase({
        walletClientType: walletConnection.activeWallet?.walletClientType ?? null,
        connectorId: connection.connector?.id ?? walletStatus.connectorId,
        connectorName: connection.connector?.name ?? null,
        walletName: walletStatus.walletName,
        isCoinbaseSmartWallet: walletStatus.isCoinbaseSmartWallet,
      }),
    [
      connection.connector?.id,
      connection.connector?.name,
      walletConnection.activeWallet?.walletClientType,
      walletStatus.connectorId,
      walletStatus.isCoinbaseSmartWallet,
      walletStatus.walletName,
    ],
  );

  // Per-wallet token selection ceiling. The regular limit
  // (NEXT_PUBLIC_DUST_SWEEP_AUTO_SELECT_LIMIT) is a HARD cap on Auto + Select all + manual
  // adds for every wallet. Base Wallet (base_account) and Coinbase Wallet (coinbase) instead
  // use DUST_SWEEP_AUTO_SELECT_LIMIT_BASE_COINBASE when it is set, falling back to the regular
  // limit otherwise. Both are bounded by the lane execution cap so selection can never exceed
  // the on-chain batch max (50 on V2/V3). Unset regular limit ⇒ lane cap (current behavior).
  const regularSelectCap =
    DUST_SWEEP_AUTO_SELECT_LIMIT != null
      ? Math.min(DUST_SWEEP_AUTO_SELECT_LIMIT, configuredRouteCap)
      : configuredRouteCap;
  const isBaseOrCoinbaseWallet =
    walletProfileBase.walletKey === "base_account" ||
    walletProfileBase.walletKey === "coinbase";
  const baseCoinbaseSelectCap =
    DUST_SWEEP_AUTO_SELECT_LIMIT_BASE_COINBASE != null
      ? Math.min(DUST_SWEEP_AUTO_SELECT_LIMIT_BASE_COINBASE, configuredRouteCap)
      : regularSelectCap;
  const selectionCap = isBaseOrCoinbaseWallet ? baseCoinbaseSelectCap : regularSelectCap;
  // Effective max tokens the user can put in one sweep on the CURRENT wallet — drives the
  // Auto/Select-all picks, the manual add cap, the "Add more" gate, and token-picker disabling.
  // Never above the server/lane cap (selectionCap is already <= configuredRouteCap).
  const routeMaxCap = Math.min(selectionCap, quote?.routeMaxCap ?? configuredRouteCap);

  // Keep the invariant "never more than the limit selected": if the cap shrinks (e.g. the
  // user switches from a Base/Coinbase wallet with a higher limit to a more-restricted one),
  // trim the current selection down to the new ceiling.
  useEffect(() => {
    setSelectedTokens((current) =>
      current.length > selectionCap ? current.slice(0, selectionCap) : current,
    );
  }, [selectionCap]);

  const walletProfile = useMemo<DustSweepWalletProfile>(() => {
    // OKX targets one combined approve+sweep wallet_sendCalls (atomicRequired:false),
    // so show the combined-batch notice.
    const isOkx = walletProfileBase.walletKey === "okx";

    return {
      ...walletProfileBase,
      atomicStatus,
      batchNotice: isOkx
        ? OKX_COMBINED_BATCH_NOTICE
        : getWalletBatchNotice(
            walletProfileBase.walletName,
            walletProfileBase.walletKey,
            atomicStatus,
          ),
    };
  }, [atomicStatus, delegation.info, walletProfileBase]);

  const allSwappableTokens = balances.swappableTokens;
  const outputTokens = useMemo(() => {
    const byAddress = new Map<string, Token>();
    for (const token of [...balances.swappableTokens, ...balances.unavailableTokens]) {
      byAddress.set(token.address.toLowerCase(), token);
    }
    return DEFAULT_OUTPUT_TOKENS.map((token) => {
      const discovered = byAddress.get(token.address.toLowerCase());
      return discovered
        ? {
            ...token,
            balance: discovered.balance,
            balanceFormatted: discovered.balanceFormatted,
            valueUSD: discovered.valueUSD,
            logoURI: token.logoURI || discovered.logoURI,
          }
        : token;
    });
  }, [balances.swappableTokens, balances.unavailableTokens]);
  const swappableTokens = useMemo(
    () => allSwappableTokens.filter((token) => !isSelectedOutputToken(token, tokenOut)),
    [allSwappableTokens, tokenOut],
  );

  useEffect(() => {
    setUnavailableTokens([]);
    setQuoteFailedTokenAddresses([]);
    setExecutionNotice(null);
    setSelectedTokens([]);
    setQuote(null);
    setQuoteError(null);
    setTxHash(null);
    setError(null);
    setSweepStep("idle");
    setAutoMode(false);
    okxOneClickAbandonedRef.current = false;
  }, [address]);

  useEffect(() => {
    if (!isConnected || !address) {
      setSelectedTokens([]);
      setQuote(null);
      setTxHash(null);
      setSweepStep("idle");
      setExecutionNotice(null);
    }
  }, [address, isConnected]);

  // Carried routes are only valid for a fixed (account, output token, slippage). When any
  // of those change, every cached route is stale — drop them so nothing is carried across.
  // Deliberately NOT keyed on selectedTokens: surviving add/remove is the entire purpose.
  useEffect(() => {
    carriedRoutesRef.current.clear();
    lastQuoteMetaRef.current = null;
  }, [address, tokenOut, slippageBps]);

  useEffect(() => {
    if (tokenOut) {
      setSelectedTokens((current) =>
        current.filter((token) => !isSelectedOutputToken(token, tokenOut)),
      );
    }
  }, [tokenOut]);

  useEffect(() => {
    if (!autoMode) return;
    setSelectedTokens(
      swappableTokens
        .filter((token) => (token.valueUSD ?? 0) <= autoSelectionUsd)
        .slice(0, selectionCap),
    );
  }, [autoMode, autoSelectionUsd, selectionCap, swappableTokens]);

  useEffect(() => {
    if (!address || !walletClient) {
      setSupportsWalletSendCalls(false);
      setAtomicStatus("unknown");
      setDelegation({ address: null, info: { state: "none" } });
      setIsDetectingRoute(false);
      return;
    }

    let cancelled = false;
    const chainIdHex = `0x${base.id.toString(16)}`;
    setIsDetectingRoute(true);

    // (b) Can the connected wallet batch atomically right now? (wallet_getCapabilities)
    async function detectCapabilities() {
      try {
        const requests = getWalletRequestCandidates(walletClient, walletProfileBase.walletKey);
        if (requests.length === 0) {
          if (!cancelled) {
            setSupportsWalletSendCalls(false);
            setAtomicStatus("unknown");
          }
          return;
        }

        const capabilityParamSets: unknown[][] = [
          [address, [chainIdHex]],
          [address, [String(base.id)]],
          [address],
          [],
        ];
        let supported = false;
        let detectedAtomicStatus: DustSweepAtomicStatus = "unknown";

        for (const request of requests) {
          for (const params of capabilityParamSets) {
            try {
              const result = await request({
                method: "wallet_getCapabilities",
                params,
              });
              const chainCapabilities = getChainCapabilities(result, base.id);
              detectedAtomicStatus = getBatchCapabilityStatus(chainCapabilities);
              supported = isBatchCapabilitySupported(chainCapabilities);
              if (supported) break;
            } catch {
              // Some wallet providers or wrapper clients don't support this method/shape.
            }
          }
          if (supported) break;
        }

        if (!cancelled) {
          setSupportsWalletSendCalls(supported);
          setAtomicStatus(detectedAtomicStatus);
        }
      } catch {
        if (!cancelled) {
          setSupportsWalletSendCalls(false);
          setAtomicStatus("unknown");
        }
      }
    }

    // (a) Is the EOA delegated on Base, and to whom? (eth_getCode on Base).
    // publicClient is pinned to base.id, so this always reads Base state — 7702
    // authorization is per-chain, so it must be read on the network we sweep on.
    async function detectDelegation() {
      if (!publicClient) {
        if (!cancelled) setDelegation({ address: null, info: { state: "none" } });
        return;
      }
      try {
        const code = await publicClient.getCode({ address: address as Address });
        const delegate = parseEip7702AuthorizedAddress(code);
        const info = identifyDelegate(delegate);
        // Harvest unrecognized delegates at connect time (even if the user never
        // sweeps) so wallets we can't pre-catalogue (TokenPocket, Bitget, …) can
        // be identified from real sessions and added to KNOWN_DELEGATES.
        if (delegate && info.state === "unknown") {
          console.info("DustSweep unknown 7702 delegate detected", {
            delegateAddress: delegate,
            connectedWalletKey: walletProfileBase.walletKey,
          });
        }
        if (!cancelled) {
          setDelegation({ address: delegate, info });
        }
      } catch {
        if (!cancelled) setDelegation({ address: null, info: { state: "none" } });
      }
    }

    void Promise.allSettled([detectCapabilities(), detectDelegation()]).finally(() => {
      if (!cancelled) setIsDetectingRoute(false);
    });

    return () => {
      cancelled = true;
    };
  }, [address, walletClient, walletProfileBase.walletKey, publicClient]);

  // ── Route resolution (single source of truth; UI never derives this) ──
  // Matrix from docs/eip7702-delegation-aware-workflow.md §4, hardened against
  // wallets that misreport their atomic capability on a foreign-delegated EOA.
  const routeKind = useMemo<SweepRouteKind>(() => {
    const isDelegated = delegation.address !== null;
    const delegateWallet =
      delegation.info.state === "known" ? delegation.info.wallet : null;
    const ownKnownDelegate =
      delegateWallet !== null &&
      isSameEip7702WalletFamily(
        delegateWallet,
        walletProfileBase.walletKey,
      );
    const knownForeignDelegate =
      delegateWallet !== null &&
      delegateWallet !== "unknown" &&
      !isSameEip7702WalletFamily(
        delegateWallet,
        walletProfileBase.walletKey,
      );
    const tokenPocketOwnDelegate =
      ownKnownDelegate &&
      walletProfileBase.walletKey === "tokenpocket" &&
      walletProfileBase.executionStrategy === "tokenpocket_existing";

    // (1) Delegated to a wallet we can name that isn't the connected one →
    // offer the switch (+ Permit2 fallback).
    if (knownForeignDelegate && canRecommendOneClickWallet(delegateWallet)) {
      return "switch_or_permit2";
    }

    // OKX: target ONE combined approve+sweep wallet_sendCalls (the user's goal).
    // OKX bundles it into a single tx via its 7702 smart account. DustSweep tries
    // the raw wallet_sendCalls batch whenever there is NO known FOREIGN delegate:
    // - already on OKX's own delegate → batch runs over OKX's smart account,
    // - undelegated → the batch triggers OKX's own EIP-7702 upgrade/enable prompt,
    // - on an unrecognized/infra delegate → still attempt; OKX surfaces the real
    //   error and execution falls back to standard approvals + one sweep tx.
    // Only a delegate we positively recognize as ANOTHER wallet blocks the batch
    // (handled as switch_or_permit2 above, or permit2 here when not switchable).
    if (walletProfileBase.walletKey === "okx") {
      return knownForeignDelegate ? "permit2" : "batch";
    }

    // TokenPocket's Base delegate is enough to prove the connected TokenPocket
    // wallet owns the account upgrade. Its wallet_getCapabilities response can
    // be flaky inside the in-app browser, while the execution path below uses
    // TokenPocket's provider directly with explicit gas. Let the verified own
    // delegate unlock the one-click path instead of falling back to Permit2.
    if (tokenPocketOwnDelegate) {
      return "batch";
    }

    // (2a) The account already sits on THIS wallet's own EIP-7702 delegate —
    // i.e. the connected wallet's own smart-account implementation. That proves
    // it can bundle approvals + sweep through wallet_sendCalls even when
    // wallet_getCapabilities probing is flaky/unknown (e.g. OKX, which reports
    // "Batch status unknown" yet still executes wallet_sendCalls). Attempt the
    // batch first; the execution path falls back to one-by-one approvals + a
    // standard sweep if the wallet actually rejects the batch. Only an EXPLICIT
    // "unsupported" probe (the wallet positively says it can't batch) opts out.
    // Require a NAMED delegate family — never the "unknown" infra bucket, which
    // could match when both the connected wallet and an infra delegate are
    // unidentified.
    if (
      ownKnownDelegate &&
      delegateWallet !== "unknown" &&
      atomicStatus !== "unsupported"
    ) {
      return "batch";
    }

    // (2b) Otherwise only trust the wallet's atomic batch claim when we're
    // certain the account isn't sitting on a FOREIGN delegate. Wallets (e.g.
    // TokenPocket) report atomic "supported"/"ready" even on an account
    // delegated to another wallet, then the batch fails. So batch only when the
    // account is undelegated, OR on a delegate we positively recognize as this
    // wallet's own. (Coinbase/Base smart wallets aren't 7702 EOAs → not
    // "delegated" here → OK.)
    const safeToBatch = !isDelegated || ownKnownDelegate;
    if (safeToBatch && (atomicStatus === "supported" || atomicStatus === "ready")) {
      return "batch";
    }

    // (3) Delegated to an unrecognized/foreign impl, or no atomic support →
    // Permit2 / standard approvals, which don't depend on the delegation.
    return "permit2";
  }, [
    atomicStatus,
    delegation,
    walletProfileBase.executionStrategy,
    walletProfileBase.walletKey,
  ]);

  const recommendedWallet = useMemo<RecommendedWallet | null>(() => {
    if (routeKind === "switch_or_permit2" && delegation.info.state === "known") {
      return { key: delegation.info.wallet, label: delegation.info.label };
    }
    return null;
  }, [routeKind, delegation]);

  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    setExecutionNotice(null);
    if (selectedTokens.length > 0) {
      setTxHash(null);
      setError(null);
      setSweepStep((current) =>
        current === "success" || current === "error" ? "idle" : current,
      );
    }
  }, [selectedTokens, tokenOut, slippageBps]);

  useEffect(() => {
    const selected = new Set(selectedTokens.map((token) => token.address.toLowerCase()));
    setQuoteFailedTokenAddresses((current) =>
      current.filter((address) => selected.has(address.toLowerCase())),
    );
    setUnavailableTokens((current) =>
      current.filter((token) => selected.has(token.address.toLowerCase())),
    );
  }, [selectedTokens]);

  const refreshTokens = useCallback(async (options?: TokenBalanceRefetchOptions) => {
    await refetchBalances(options);
  }, [refetchBalances]);

  const refreshQuote = useCallback(async () => {
    if (!address || !tokenOut || selectedTokens.length === 0) {
      setQuote(null);
      return;
    }

    // Race guard: a re-quote fires on every add/remove. Stamp this request so a slow,
    // earlier response can never overwrite a newer one's result.
    const requestSeq = ++quoteRequestSeqRef.current;
    const isStale = () => requestSeq !== quoteRequestSeqRef.current;
    // Snapshot the selection this request is for (it can change while we await).
    const requestTokens = selectedTokens;

    // Pull last-known-good routes for the given tokens, keeping only those whose input
    // amount is unchanged and that the server hasn't DEFINITIVELY skipped this round.
    const collectCarried = (
      tokens: SelectedToken[],
      skips?: Map<string, UnavailableReason>,
    ) => {
      const routes: DustSweepRoute[] = [];
      const missing: SelectedToken[] = [];
      for (const token of tokens) {
        const key = token.address.toLowerCase();
        const skipReason = skips?.get(key);
        const definitive = skipReason ? DEFINITIVE_SKIP_REASONS.has(skipReason) : false;
        const carried = carriedRoutesRef.current.get(key);
        if (carried && carried.amountIn === token.balance && !definitive) {
          routes.push(carried);
        } else {
          if (definitive) carriedRoutesRef.current.delete(key);
          missing.push(token);
        }
      }
      return { routes, missing };
    };

    setIsQuoting(true);
    setQuoteError(null);
    setQuoteFailedTokenAddresses([]);
    setUnavailableTokens([]);

    // Non-destructive failure: rather than wipe a good quote when a transient re-quote
    // fails, rebuild from carried routes so the user keeps every route still valid for the
    // current selection. Only surfaces the hard error when nothing can be carried.
    const handleFailure = (message: string, skips: Map<string, UnavailableReason>) => {
      const meta = lastQuoteMetaRef.current;
      const { routes: carriedRoutes, missing } = collectCarried(requestTokens, skips);
      if (meta && carriedRoutes.length > 0) {
        // A carried quote is rebuilt from an OLDER quote — its wethUnwrap may not match the
        // current selection. Keep it only when WETH is actually still selected.
        const rebuilt = recomputeQuoteForRoutes(meta, carriedRoutes, meta);
        const wethStillSelected = requestTokens.some(
          (token) => token.address.toLowerCase() === WETH_ADDRESS.toLowerCase(),
        );
        setQuote(wethStillSelected ? rebuilt : { ...rebuilt, wethUnwrap: undefined });
        if (missing.length > 0) {
          const missingUnavailable = missing.map((token) => ({
            ...token,
            reason: skips.get(token.address.toLowerCase()) || ("QUOTE_FAILED" as UnavailableReason),
          }));
          setUnavailableTokens((current) => mergeUnavailableTokens(current, missingUnavailable));
          setQuoteFailedTokenAddresses(missingUnavailable.map((token) => token.address.toLowerCase()));
        }
        setQuoteError(null); // routes preserved — nothing was lost, so no scary banner
        return;
      }
      // Nothing to carry — surface the real failure (original behavior).
      if (skips.size > 0) {
        const failedTokens = requestTokens
          .filter((token) => skips.has(token.address.toLowerCase()))
          .map((token) => ({
            ...token,
            reason: skips.get(token.address.toLowerCase()) || ("NO_LIQUIDITY" as UnavailableReason),
          }));
        if (failedTokens.length > 0) {
          setUnavailableTokens((current) => mergeUnavailableTokens(current, failedTokens));
          setQuoteFailedTokenAddresses(failedTokens.map((token) => token.address.toLowerCase()));
          if (removeFailedTokens) {
            setSelectedTokens((current) =>
              current.filter((token) => !skips.has(token.address.toLowerCase())),
            );
          }
        }
      }
      setQuote(null);
      setQuoteError(message);
    };

    try {
      const response = await fetch("/api/dustsweep/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokenIns: requestTokens.map((token) => token.address),
          amounts: requestTokens.map((token) => token.balance),
          tokenOut: tokenOut.address,
          slippageBps,
          userAddress: address,
        }),
      });
      const payload = await response.json().catch(() => null);

      if (isStale()) return; // a newer re-quote already superseded this one

      if (!response.ok) {
        const skippedTokens =
          payload && typeof payload === "object" && Array.isArray((payload as { skippedTokens?: unknown }).skippedTokens)
            ? ((payload as { skippedTokens: Array<{ token?: string; reason?: UnavailableReason }> }).skippedTokens)
            : [];
        const skippedByAddress = new Map<string, UnavailableReason>(
          skippedTokens
            .filter((item) => item.token)
            .map((item) => [String(item.token).toLowerCase(), (item.reason || "NO_LIQUIDITY") as UnavailableReason]),
        );
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error?: unknown }).error)
            : "Couldn't get quote";
        handleFailure(message, skippedByAddress);
        return;
      }

      const serverQuote = normalizeQuotePayload(payload);
      const serverByToken = new Map(
        serverQuote.routes.map((route) => [route.tokenIn.toLowerCase(), route]),
      );
      const skippedByAddress = new Map<string, UnavailableReason>(
        (serverQuote.skippedTokens || []).map((item) => [item.token.toLowerCase(), item.reason]),
      );

      // Merge: prefer the fresh server route; otherwise carry a recent good route for any
      // still-selected token the server transiently missed (unchanged balance, not a
      // definitive skip). This is what stops routes from vanishing on add/remove.
      const mergedRoutes: DustSweepRoute[] = [];
      const missingTokens: SelectedToken[] = [];
      let carriedCount = 0;
      for (const token of requestTokens) {
        const key = token.address.toLowerCase();
        // WETH with native-ETH output is served by quote.wethUnwrap (1:1 wallet-side
        // unwrap), not by a router route — never treat it as missing/unroutable.
        if (serverQuote.wethUnwrap && key === WETH_ADDRESS.toLowerCase()) continue;
        const fresh = serverByToken.get(key);
        if (fresh) {
          mergedRoutes.push(fresh);
          continue;
        }
        const skipReason = skippedByAddress.get(key);
        const definitive = skipReason ? DEFINITIVE_SKIP_REASONS.has(skipReason) : false;
        const carried = carriedRoutesRef.current.get(key);
        if (carried && carried.amountIn === token.balance && !definitive) {
          mergedRoutes.push(carried);
          carriedCount += 1;
        } else {
          if (definitive) carriedRoutesRef.current.delete(key);
          missingTokens.push(token);
        }
      }

      // USD/meta reference: the fresh server quote when it actually routed something, else
      // the last good full quote (so USD stays right even if every token was carried).
      const reference =
        safeBigInt(serverQuote.totalEstimatedOut) > 0n && serverQuote.totalEstimatedOutUSD > 0
          ? serverQuote
          : lastQuoteMetaRef.current;
      const finalQuote =
        carriedCount > 0
          ? recomputeQuoteForRoutes(serverQuote, mergedRoutes, reference)
          : serverQuote;

      // Refresh the carry-forward store from the winning routes + the resulting quote.
      for (const route of mergedRoutes) {
        carriedRoutesRef.current.set(route.tokenIn.toLowerCase(), route);
      }
      if (finalQuote.routes.length > 0) lastQuoteMetaRef.current = finalQuote;

      if (missingTokens.length > 0) {
        const failedTokens = missingTokens.map((token) => ({
          ...token,
          reason: skippedByAddress.get(token.address.toLowerCase()) || ("NO_LIQUIDITY" as UnavailableReason),
        }));
        setUnavailableTokens((current) => mergeUnavailableTokens(current, failedTokens));
        setQuoteFailedTokenAddresses(failedTokens.map((token) => token.address.toLowerCase()));
        if (removeFailedTokens) {
          const missingSet = new Set(missingTokens.map((token) => token.address.toLowerCase()));
          setSelectedTokens((current) =>
            current.filter((token) => !missingSet.has(token.address.toLowerCase())),
          );
        }
      }

      setQuote(finalQuote);
    } catch (quoteFetchError) {
      if (isStale()) return;
      const message =
        quoteFetchError instanceof Error ? quoteFetchError.message : "Couldn't get quote";
      handleFailure(message, new Map());
    } finally {
      if (!isStale()) setIsQuoting(false);
    }
  }, [address, removeFailedTokens, selectedTokens, slippageBps, tokenOut]);

  useEffect(() => {
    if (!address || !tokenOut || selectedTokens.length === 0) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void refreshQuote();
    }, 450);

    return () => window.clearTimeout(timeoutId);
  }, [address, refreshQuote, selectedTokens, slippageBps, tokenOut]);

  const addToken = useCallback((token: SelectedToken) => {
    if (isSelectedOutputToken(token, tokenOut)) return;
    setAutoMode(false);
    setSelectedTokens((current) => {
      if (current.some((item) => isSameAddress(item.address, token.address))) {
        return current;
      }
      // Manual adds are capped at the SAME per-wallet selection ceiling as Auto/Select all,
      // so a user can never manually exceed the configured limit (Base/Coinbase get their
      // own, possibly higher, ceiling via selectionCap).
      return [...current, token].slice(0, selectionCap);
    });
  }, [selectionCap, tokenOut]);

  const selectAllTokens = useCallback(() => {
    setAutoMode(false);
    // "Select all" honors the same per-wallet selection ceiling as Auto and manual adds.
    setSelectedTokens(swappableTokens.slice(0, selectionCap));
  }, [selectionCap, swappableTokens]);

  const removeToken = useCallback((tokenAddress: string) => {
    setAutoMode(false);
    setSelectedTokens((current) =>
      current.filter((token) => !isSameAddress(token.address, tokenAddress)),
    );
    setUnavailableTokens((current) =>
      current.filter((token) => !isSameAddress(token.address, tokenAddress)),
    );
    setQuoteFailedTokenAddresses((current) =>
      current.filter((address) => !isSameAddress(address, tokenAddress)),
    );
  }, []);

  const clearSelectedTokens = useCallback(() => {
    setAutoMode(false);
    setSelectedTokens([]);
    setUnavailableTokens([]);
    setQuoteFailedTokenAddresses([]);
  }, []);

  const clearUnavailableTokens = useCallback(() => {
    setUnavailableTokens([]);
    setQuoteFailedTokenAddresses([]);
  }, []);

  const removeUnavailableToken = useCallback((tokenAddress: string) => {
    setUnavailableTokens((current) =>
      current.filter((token) => !isSameAddress(token.address, tokenAddress)),
    );
    setQuoteFailedTokenAddresses((current) =>
      current.filter((address) => !isSameAddress(address, tokenAddress)),
    );
  }, []);

  const resetSweepState = useCallback(() => {
    setSweepStep("idle");
    setTxHash(null);
    setCompletionSummary(null);
    setError(null);
    setExecutionNotice(null);
  }, []);

  const dismissCompletionSummary = useCallback(() => {
    setCompletionSummary(null);
  }, []);

  const waitForSuccessfulTransaction = useCallback(async (hash: Hex) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error("Transaction reverted");
    }
    const failedBatchCall = (receipt.logs as Array<{ topics: readonly Hex[] }>).find(
      (log) => log.topics[0]?.toLowerCase() === TOKENPOCKET_EXECUTE_FAILURES_TOPIC,
    );
    if (failedBatchCall) {
      const failedIndex =
        failedBatchCall.topics[1] ? BigInt(failedBatchCall.topics[1]).toString() : "unknown";
      throw new Error(`Wallet batch executed but inner call ${failedIndex} failed`);
    }
    return receipt;
  }, [publicClient]);

  const getTokenApprovalRequirements = useCallback(async (
    routes: DustSweepQuoteResponse["routes"],
    spender: Address,
  ) => {
    if (!address) return [];
    const requirements = uniqueApprovalRequirements(routes);
    if (requirements.length === 0) return [];

    // Read ALL allowances in ONE multicall (Multicall3 on Base) instead of N
    // sequential eth_call round-trips. For a 49-token sweep this turns ~1-3 minutes
    // of per-token RPC latency into a single ~1s call, so the wallet prompt opens
    // fast. Falls back to parallel reads if multicall is unavailable.
    let allowances: bigint[];
    try {
      const results = await publicClient.multicall({
        allowFailure: true,
        contracts: requirements.map((requirement) => ({
          address: requirement.token,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address, spender],
        })),
      });
      allowances = results.map((result) =>
        result.status === "success" ? (result.result as bigint) : 0n,
      );
    } catch {
      allowances = await Promise.all(
        requirements.map(async (requirement) => {
          try {
            return (await publicClient.readContract({
              address: requirement.token,
              abi: erc20Abi,
              functionName: "allowance",
              args: [address, spender],
            })) as bigint;
          } catch {
            return 0n;
          }
        }),
      );
    }

    const approvalRequirements: ApprovalRequirement[] = [];
    requirements.forEach((requirement, index) => {
      const allowance = allowances[index] ?? 0n;
      if (allowance >= requirement.amount) {
        return;
      }
      approvalRequirements.push({
        ...requirement,
        allowance,
        approvalAmount: requirement.amount,
        resetFirst: allowance > 0n && requiresApprovalReset(requirement.token),
      });
    });

    return approvalRequirements;
  }, [address, publicClient]);

  // For Route C (Permit2), count how many selected tokens still need a one-time
  // approve(Permit2, max). Drives the "one-time setup for N tokens" UI hint and
  // the permit2ApprovalsNeeded telemetry field. Permit2 is the spender here.
  useEffect(() => {
    if (routeKind !== "permit2" || !quote || quote.routes.length === 0) {
      setPermit2SetupCount(0);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const requirements = await getTokenApprovalRequirements(
          quote.routes,
          PERMIT2_ADDRESS,
        );
        if (!cancelled) setPermit2SetupCount(requirements.length);
      } catch {
        if (!cancelled) setPermit2SetupCount(0);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [routeKind, quote, getTokenApprovalRequirements]);

  const waitForApprovalRequirementsCleared = useCallback(async (
    routes: DustSweepQuoteResponse["routes"],
    spender: Address,
    timeoutMs = 90_000,
  ) => {
    const deadline = Date.now() + timeoutMs;
    let remaining = await getTokenApprovalRequirements(routes, spender);

    while (remaining.length > 0 && Date.now() < deadline) {
      await delay(2500);
      remaining = await getTokenApprovalRequirements(routes, spender);
    }

    return remaining;
  }, [getTokenApprovalRequirements]);

  const sendTokenPocketRawTransaction = useCallback(async (args: {
    to: Address;
    data: Hex;
    value?: bigint;
  }) => {
    if (!address || !walletClient) {
      throw new Error("Wallet client unavailable");
    }

    const requests = getWalletRequestCandidates(walletClient, "tokenpocket", {
      preferInjected: true,
    });
    if (requests.length === 0) {
      throw new Error("TokenPocket provider unavailable");
    }

    // No explicit gas — TokenPocket estimates the transaction itself.
    const tx = {
      from: address,
      to: args.to,
      data: concatHex([args.data, DATA_SUFFIX]),
      value: toRpcQuantity(args.value),
      chainId: `0x${base.id.toString(16)}`,
    };
    let lastError: unknown;

    for (const request of requests) {
      try {
        const result = await request({
          method: "eth_sendTransaction",
          params: [tx],
        });
        if (isTxHash(result)) {
          return result;
        }
        throw new Error("TokenPocket did not return a transaction hash");
      } catch (error) {
        if (isRejectedByUser(error) || isWalletLockedError(error)) {
          throw error;
        }
        lastError = error;
        console.warn("DustSweep TokenPocket raw transaction failed.", {
          to: args.to,
          code: getErrorCode(error),
          message: getDebugErrorMessage(error),
        });
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("TokenPocket transaction failed");
  }, [address, walletClient]);

  const sendTokenApprovals = useCallback(async (
    approvalRequirements: ApprovalRequirement[],
    spender: Address,
  ) => {
    if (!address || !walletClient || approvalRequirements.length === 0) return;

    const paymasterUrl = process.env.NEXT_PUBLIC_PAYMASTER_URL;
    const usesTokenPocketExisting =
      walletProfile.executionStrategy === "tokenpocket_existing";
    // OKX must get CLEAN exact ERC20 approve calldata (no builder-code suffix) so
    // each approval decodes as a normal "Approve" in OKX. Builder attribution stays
    // on the sweep. Other wallets keep the suffix on approvals as before.
    const attachBuilderSuffix = walletProfile.walletKey !== "okx";
    for (const requirement of approvalRequirements) {
      const txBase = {
        account: address,
        chain: base,
        to: requirement.token,
        ...(attachBuilderSuffix ? { dataSuffix: DATA_SUFFIX } : {}),
        ...(walletStatus.isCoinbaseSmartWallet && paymasterUrl
          ? {
              capabilities: buildBasePaymasterCapabilities(),
            }
          : {}),
      };

      if (requirement.resetFirst) {
        const resetData = encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [spender, 0n],
        });
        if (usesTokenPocketExisting) {
          const resetHash = await sendTokenPocketRawTransaction({
            to: requirement.token,
            data: resetData,
          });
          await waitForSuccessfulTransaction(resetHash);
        } else {
          const resetHash = (await walletClient.sendTransaction({
            ...txBase,
            data: resetData,
          } as never)) as Hex;
          await waitForSuccessfulTransaction(resetHash);
        }
      }

      const approvalData = encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, requirement.approvalAmount],
      });
      if (usesTokenPocketExisting) {
        const approvalHash = await sendTokenPocketRawTransaction({
          to: requirement.token,
          data: approvalData,
        });
        await waitForSuccessfulTransaction(approvalHash);
        continue;
      }

      const approvalHash = (await walletClient.sendTransaction({
        ...txBase,
        data: approvalData,
      } as never)) as Hex;
      await waitForSuccessfulTransaction(approvalHash);
    }
  }, [
    address,
    sendTokenPocketRawTransaction,
    waitForSuccessfulTransaction,
    walletClient,
    walletProfile.executionStrategy,
    walletProfile.walletKey,
    walletStatus.isCoinbaseSmartWallet,
  ]);

  // Submits one raw wallet_sendCalls through TokenPocket's provider and resolves
  // to the resulting tx hash. No explicit gas — TokenPocket estimates the batch
  // itself (it simulates approvals→sweep as a sequence, so estimation succeeds).
  // Shared by the approvals-only batch and the combined approve+sweep batch.
  const sendTokenPocketWalletSendCalls = useCallback(async (
    calls: Array<{ to: string; data: Hex; value: string }>,
    atomicRequired: boolean,
  ): Promise<Hex> => {
    if (!address || !walletClient) {
      throw new Error("TokenPocket provider unavailable");
    }
    const requests = getWalletRequestCandidates(walletClient, "tokenpocket", {
      preferInjected: true,
    });
    if (requests.length === 0) {
      throw new Error("TokenPocket provider unavailable");
    }

    let lastError: unknown;
    for (const request of requests) {
      try {
        const result = await request({
          method: "wallet_sendCalls",
          params: [
            {
              version: "2.0.0",
              atomicRequired,
              chainId: `0x${base.id.toString(16)}`,
              from: address,
              calls,
            },
          ],
        });

        const immediateHash = getSendCallsResultTxHash(result);
        if (immediateHash) return immediateHash;

        const callId = resolveSendCallsId(result);
        if (!callId) throw new Error("wallet_sendCalls did not return an id");

        const deadline = Date.now() + 180_000;
        while (Date.now() < deadline) {
          const status = (await request({
            method: "wallet_getCallsStatus",
            params: [callId],
          })) as WalletCallsStatusResult | null;

          const hash = getLatestCallsStatusTxHash(status);
          if (hash) {
            if (hasFailedCallsReceipt(status)) throw new Error("TokenPocket batch failed");
            return hash;
          }
          if (getCallsStatusState(status) === "failure") throw new Error("TokenPocket batch failed");
          await delay(1500);
        }
        throw new Error("TokenPocket batch timed out");
      } catch (error) {
        if (isRejectedByUser(error) || isWalletLockedError(error)) throw error;
        lastError = error;
        console.warn("DustSweep TokenPocket wallet_sendCalls failed.", {
          callCount: calls.length,
          atomicRequired,
          code: getErrorCode(error),
          message: getDebugErrorMessage(error),
        });
      }
    }
    throw lastError instanceof Error ? lastError : new Error("TokenPocket wallet_sendCalls failed");
  }, [address, walletClient]);

  // Sends all approvals as a single wallet_sendCalls batch so TokenPocket shows
  // them all at once (see sendTokenPocketWalletSendCalls). TP estimates the gas.
  const sendTokenPocketBatchApprovals = useCallback(async (
    approvalRequirements: ApprovalRequirement[],
    spender: Address,
  ) => {
    if (!address || !walletClient || approvalRequirements.length === 0) return;

    const needsReset = approvalRequirements.filter(r => r.resetFirst);
    const noReset = approvalRequirements.filter(r => !r.resetFirst);

    const buildRpcCalls = (reqs: ApprovalRequirement[], getAmount: (r: ApprovalRequirement) => bigint) =>
      reqs.map(r => ({
        to: r.token as string,
        // Raw wallet_sendCalls bypasses normalizeWalletSendCall, so append the
        // builder code suffix directly (same as sendTokenPocketRawTransaction).
        data: appendDataSuffix(
          encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, getAmount(r)] }),
          DATA_SUFFIX,
        ),
        value: toRpcQuantity(0n),
      }));

    // Batch 1: all direct approvals + reset-to-zero for tokens that need it.
    const firstBatch = [
      ...buildRpcCalls(noReset, r => r.approvalAmount),
      ...buildRpcCalls(needsReset, () => 0n),
    ];
    const firstHash = await sendTokenPocketWalletSendCalls(firstBatch, false);
    await waitForSuccessfulTransaction(firstHash);

    // Batch 2 (only if needed): follow-up approvals for tokens that were reset.
    // Resets must be confirmed on-chain before the approval can succeed.
    if (needsReset.length > 0) {
      const followupBatch = buildRpcCalls(needsReset, r => r.approvalAmount);
      const followupHash = await sendTokenPocketWalletSendCalls(followupBatch, false);
      await waitForSuccessfulTransaction(followupHash);
    }
  }, [address, sendTokenPocketWalletSendCalls, waitForSuccessfulTransaction, walletClient]);

  const buildApprovalCalls = useCallback((
    approvalRequirements: ApprovalRequirement[],
    spender: Address,
    // OKX must receive CLEAN, exact ERC20 approve calldata so it can decode each
    // call and show a normal approval+sweep bundle. Appending the builder-code
    // suffix to approvals makes OKX render "Unknown transaction" / disable Confirm.
    // So attach the suffix to approvals only for non-OKX wallets; the builder code
    // is always preserved on the final V3 sweep call regardless of this flag.
    attachBuilderSuffix = true,
  ) => {
    const calls: WalletSendCall[] = [];
    const approvalSuffix = attachBuilderSuffix ? DATA_SUFFIX : undefined;

    for (const requirement of approvalRequirements) {
      if (requirement.resetFirst) {
        calls.push({
          to: requirement.token,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [spender, 0n],
          }),
          value: 0n,
          dataSuffix: approvalSuffix,
        });
      }

      calls.push({
        to: requirement.token,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [spender, requirement.approvalAmount],
        }),
        value: 0n,
        dataSuffix: approvalSuffix,
      });
    }

    return calls;
  }, []);

  const sendAtomicWalletCalls = useCallback(async (args: {
    account: Address;
    calls: WalletSendCall[];
    usePaymasterCapabilities: boolean;
    walletKey: DustSweepWalletKey;
    requireAtomic?: boolean;
    appendDataSuffixes?: boolean;
  }) => {
    if (!walletClient) {
      throw new Error("Wallet client unavailable");
    }

    const client = walletClient as unknown as {
      sendCalls?: (request: {
        account?: Address;
        chain?: typeof base;
        calls: WalletSendCall[];
        capabilities?: unknown;
        forceAtomic?: boolean;
        version?: string;
      }) => Promise<unknown>;
      waitForCallsStatus?: (request: {
        id: string;
        throwOnFailure?: boolean;
        timeout?: number;
      }) => Promise<WalletCallsStatusResult>;
    };

    const useSingleOkxRequest = args.walletKey === "okx";
    // OKX one-click: send the exact ERC20 approvals + the V3 sweep as ONE
    // wallet_sendCalls with atomicRequired:TRUE. This is REQUIRED for OKX to
    // PREVIEW the bundle correctly: OKX simulates an atomic batch sequentially
    // (state flows call→call), so the 49 approvals are applied before the sweep's
    // transferFrom is previewed. With atomicRequired:false OKX previews each call
    // against current state, the sweep reverts (no allowance yet), OKX can't build
    // a preview, and "Confirm" stays disabled ("Unknown transaction"). The earlier
    // "Unable to decode" on true came from the builder suffix on approval calldata,
    // which is now removed (approvals are clean; only the sweep carries the suffix).
    const requireAtomic = args.requireAtomic ?? true;
    const calls = args.calls.map((call) =>
      normalizeWalletSendCall(call, args.appendDataSuffixes ?? true),
    );
    const callCount = calls.length;
    // OKX documents EIP-5792 request capabilities as unsupported. Keep its
    // payload to the standard {to,data,value} calls and carry builder attribution
    // in calldata, as the existing production path did.
    const capabilities = useSingleOkxRequest
      ? undefined
      : buildSendCallsCapabilities({
          usePaymasterCapabilities: args.usePaymasterCapabilities,
        });

    if (
      !useSingleOkxRequest &&
      typeof client.sendCalls === "function" &&
      typeof client.waitForCallsStatus === "function"
    ) {
      let viemCallId = "";
      try {
        const sendCallsResult = await client.sendCalls({
          account: args.account,
          chain: base,
          calls,
          forceAtomic: requireAtomic,
          version: "2.0.0",
          ...(capabilities ? { capabilities } : {}),
        });
        const immediateHash = getSendCallsResultTxHash(sendCallsResult);
        if (immediateHash) {
          return immediateHash;
        }
        viemCallId = resolveSendCallsId(sendCallsResult);
      } catch (error) {
        if (isRejectedByUser(error)) {
          throw error;
        }
        if (isWalletLockedError(error)) {
          throw error;
        }
        console.warn("DustSweep walletClient.sendCalls failed before raw wallet_sendCalls retry.", {
          walletKey: args.walletKey,
          requireAtomic,
          callCount,
          code: getErrorCode(error),
          message: getDebugErrorMessage(error),
        });
      }

      if (viemCallId) {
        const status = await client.waitForCallsStatus({
          id: viemCallId,
          throwOnFailure: true,
          timeout: 180_000,
        });
        if (requireAtomic && status.atomic === false) {
          throw new Error(ATOMIC_BATCH_UNSUPPORTED_MESSAGE);
        }
        if (hasFailedCallsReceipt(status) || getCallsStatusState(status) === "failure") {
          throw new Error("Bundled sweep failed");
        }
        const hash = getLatestCallsStatusTxHash(status);

        if (!hash) {
          throw new Error("Bundled sweep finished without a transaction hash");
        }

        return hash;
      }
    }

    const requests = getWalletRequestCandidates(walletClient, args.walletKey, {
      // For OKX use exactly the injected window.okxwallet provider (the one OKX
      // documents for wallet_sendCalls), through a single transport so an unclear
      // result can never open a second prompt via another provider.
      preferInjected: useSingleOkxRequest,
      limit: useSingleOkxRequest ? 1 : undefined,
    });
    if (requests.length === 0) {
      throw new Error(
        useSingleOkxRequest
          ? "The connected OKX provider is unavailable. Reconnect OKX Wallet and retry."
          : "wallet_sendCalls is unavailable",
      );
    }

    const sendCallsPayload = buildWalletSendCallsPayload({
      account: args.account,
      chainId: base.id,
      calls,
      atomicRequired: requireAtomic,
      capabilities,
    });

    // Full payload trace so the EXACT wallet_sendCalls OKX receives can be
    // inspected from the console (selector + calldata length per call; the last
    // call is the V3 sweep). Helps diagnose "Unknown transaction / Confirm
    // disabled": confirm atomicRequired:true, the spender on every approve, and
    // that no call carries unexpected trailing bytes.
    if (useSingleOkxRequest) {
      console.info("DustSweep OKX wallet_sendCalls payload", {
        version: sendCallsPayload.version,
        atomicRequired: sendCallsPayload.atomicRequired,
        chainId: sendCallsPayload.chainId,
        from: sendCallsPayload.from,
        callCount: sendCallsPayload.calls.length,
        calls: sendCallsPayload.calls.map((call, index) => ({
          index,
          to: call.to,
          selector: call.data.slice(0, 10),
          dataLength: call.data.length,
          value: call.value,
          isSweep: index === sendCallsPayload.calls.length - 1,
        })),
      });
    }

    let sendCallsResult: unknown;
    let requestForStatus: WalletRpcRequest | null = null;
    let lastSendCallsError: unknown;
    for (const request of requests) {
      try {
        sendCallsResult = await requestWalletSendCalls(request, sendCallsPayload);
        requestForStatus = request;
        break;
      } catch (error) {
        if (isRejectedByUser(error) || isWalletLockedError(error)) {
          throw error;
        }
        console.warn("DustSweep raw wallet_sendCalls provider failed.", {
          walletKey: args.walletKey,
          requireAtomic,
          callCount,
          code: getErrorCode(error),
          message: getDebugErrorMessage(error),
        });
        lastSendCallsError = error;
      }
    }

    if (!requestForStatus) {
      throw lastSendCallsError instanceof Error
        ? lastSendCallsError
        : new Error("wallet_sendCalls is unavailable");
    }

    const immediateHash = getSendCallsResultTxHash(sendCallsResult);
    if (immediateHash) {
      return immediateHash;
    }

    const callId = resolveSendCallsId(sendCallsResult);
    if (!callId) {
      throw new Error("wallet_sendCalls did not return an id");
    }

    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const status = (await requestForStatus({
        method: "wallet_getCallsStatus",
        params: [callId],
      })) as WalletCallsStatusResult | null;
      const hash = getLatestCallsStatusTxHash(status);

      if (hash) {
        if (requireAtomic && status?.atomic === false) {
          throw new Error(ATOMIC_BATCH_UNSUPPORTED_MESSAGE);
        }
        if (hasFailedCallsReceipt(status)) {
          throw new Error("Bundled sweep failed");
        }
        return hash;
      }

      if (getCallsStatusState(status) === "failure") {
        throw new Error("Bundled sweep failed");
      }

      await delay(1500);
    }

    throw new Error("Bundled sweep timed out before a transaction hash was available");
  }, [walletClient]);

  const executeSweep = useCallback(async () => {
    if (!address || !walletClient || !publicClient) {
      setError("Connect a wallet first");
      return null;
    }

    if (!walletStatus.isSupported) {
      setError(walletStatus.reason || "Wallet not supported");
      return null;
    }

    if (!tokenOut || !quote || selectedTokens.length === 0) {
      setError("Select tokens and wait for a route");
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (quote.deadline <= now) {
      setError("Deadline expired. Refreshing quote.");
      await refreshQuote();
      return null;
    }

    // High price impact is gated by the explicit confirmation checkbox in the sweep page
    // (quote.requiresImpactConfirmation) — impact values are real now, so the old blind
    // window.confirm here would double-prompt users who already acknowledged the banner.

    if (sweepInFlightRef.current) {
      setExecutionNotice("A sweep request is already waiting in your wallet.");
      return null;
    }
    sweepInFlightRef.current = true;

    // Per-sweep telemetry so KNOWN_DELEGATES and the route matrix become
    // data-driven (docs/eip7702-delegation-aware-workflow.md §1.5/§7.6).
    const logSweepTelemetry = (outcome: "success" | "cancelled" | "error") => {
      console.info("DustSweep route telemetry", {
        walletKey: walletProfile.walletKey,
        delegateAddress: delegation.address,
        delegateLabel:
          delegation.info.state === "known"
            ? delegation.info.label
            : delegation.info.state === "unknown"
              ? "unknown"
              : null,
        atomicStatus: walletProfile.atomicStatus,
        routeKind,
        permit2ApprovalsNeeded: permit2SetupCount,
        outcome,
      });
    };

    let currentStep: SweepStep = "approving";
    // Tracks whether THIS attempt sent the OKX one-click combined batch, so the
    // outer catch can turn a reject/abandon of an unconfirmable batch into a sticky
    // fall-through to the proven approve+sweep path (instead of a dead-end cancel).
    let attemptedOkxOneClick = false;
    setIsSweeping(true);
    setSweepStep(currentStep);
    setError(null);
    setExecutionNotice(null);
    setCompletionSummary(null);

    try {
      await switchToBase();

      // WETH → native ETH: a direct 1:1 WETH.withdraw() from the user's own wallet, sent as a
      // plain standalone transaction BEFORE the sweep flow. It is deliberately NEVER added to
      // the wallet_sendCalls batch (per-wallet batch heuristics — especially OKX's security
      // engine — must stay byte-identical) and never routed through the sweep router (the V3
      // contract reverts on tokenIn == actualOutput). No protocol fee applies.
      let unwrapHash: Hex | null = null;
      // Guard against a stale carried quote: only unwrap when WETH is actually still selected.
      const wethStillSelected = selectedTokens.some((item) =>
        isSameAddress(item.address, WETH_ADDRESS),
      );
      if (quote.wethUnwrap && wethStillSelected && BigInt(quote.wethUnwrap.amount) > 0n) {
        currentStep = "pending";
        setSweepStep(currentStep);
        unwrapHash = (await walletClient.sendTransaction({
          account: address,
          chain: base,
          to: WETH_ADDRESS,
          data: encodeFunctionData({
            abi: [
              {
                type: "function",
                name: "withdraw",
                stateMutability: "nonpayable",
                inputs: [{ name: "amount", type: "uint256" }],
                outputs: [],
              },
            ] as const,
            functionName: "withdraw",
            args: [BigInt(quote.wethUnwrap.amount)],
          }),
          value: 0n,
        } as never)) as Hex;

        // Unwrap-only selection: no router sweep to send — settle and finish here.
        if (quote.routes.length === 0) {
          setTxHash(unwrapHash);
          await waitForSuccessfulTransaction(unwrapHash);
          const wethToken = selectedTokens.find((item) =>
            isSameAddress(item.address, WETH_ADDRESS),
          );
          setCompletionSummary({
            txHash: unwrapHash,
            tokenOut,
            tokenOutAmount: quote.wethUnwrap.amount,
            tokenOutValueUSD: quote.wethUnwrap.valueUSD,
            inputValueUSD: wethToken?.valueUSD || quote.wethUnwrap.valueUSD,
            feeAmountUSD: 0,
            gasEstimateUSD: quote.gasEstimateUSD,
            routeCount: 0,
            walletName: walletProfile.walletName,
            routeKind,
            completedAt: Date.now(),
            inputs: wethToken
              ? [
                  {
                    address: wethToken.address,
                    symbol: wethToken.symbol,
                    name: wethToken.name,
                    decimals: wethToken.decimals,
                    logoURI: wethToken.logoURI,
                    balanceFormatted: wethToken.balanceFormatted,
                    valueUSD: wethToken.valueUSD,
                    estimatedOut: quote.wethUnwrap.amount,
                    dexName: "Unwrap",
                  },
                ]
              : [],
          });
          setSweepStep("success");
          logSweepTelemetry("success");
          setSelectedTokens([]);
          setQuote(null);
          setExecutionNotice(null);
          void refreshTokens({ force: true });
          return { txHash: unwrapHash };
        }

        // Mixed basket: unwrap submitted; hand off to the untouched sweep flow.
        currentStep = "approving";
        setSweepStep(currentStep);
      }

      const lane = quote.executionLane || DUST_SWEEP_EXECUTION_LANE;
      let approvalSpender = isOwnedModernLane(lane) ? DUST_SWEEP_ROUTER_V2_ADDRESS : DUST_SWEEP_ROUTER_ADDRESS;
      let approvalRequirements: ApprovalRequirement[] = [];

      if (!isOwnedModernLane(lane)) {
        approvalRequirements = await getTokenApprovalRequirements(quote.routes, approvalSpender);
        await sendTokenApprovals(approvalRequirements, approvalSpender);
      }

      const response = await fetch("/api/dustsweep/build-tx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          routes: quote.routes,
          tokenOut: tokenOut.address,
          receiver: address,
          deadline: quote.deadline,
          permit2Nonce: quote.permit2Nonce,
          userAddress: address,
        }),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error?: unknown }).error)
            : "Failed to build sweep transaction";
        throw new Error(message);
      }

      const buildTx = payload as DustSweepBuildTxResponse;
      let canonicalCalldata = buildTx.calldata;

      // Tokens the backend pre-flight dropped because their transferFrom would
      // revert the atomic pull (transfer tax / max-tx / blacklist / honeypot).
      // The build-tx calldata already excludes them; here we surface them in the
      // unavailable list and exclude them from approvals so the rest of the basket
      // still sweeps instead of the whole sweep reverting on one bad token.
      const droppedAddresses = new Set(
        (buildTx.skippedTokens ?? []).map((entry) => entry.token.toLowerCase()),
      );
      if (droppedAddresses.size > 0) {
        const droppedTokens = selectedTokens
          .filter((token) => droppedAddresses.has(token.address.toLowerCase()))
          .map((token) => ({ ...token, reason: "CANT_TRANSFER" as UnavailableReason }));
        if (droppedTokens.length > 0) {
          setUnavailableTokens((current) => mergeUnavailableTokens(current, droppedTokens));
          setQuoteFailedTokenAddresses((current) =>
            Array.from(
              new Set([...current, ...droppedTokens.map((token) => token.address.toLowerCase())]),
            ),
          );
        }
        setExecutionNotice(
          `${droppedAddresses.size} token${droppedAddresses.size === 1 ? "" : "s"} couldn't be transferred to the sweep router and ${droppedAddresses.size === 1 ? "was" : "were"} skipped. Sweeping the rest.`,
        );
      }
      // Routes that survived the pre-flight drop. Approvals are computed against
      // this set so it always matches the build-tx sweep calldata.
      const effectiveRoutes =
        droppedAddresses.size > 0
          ? quote.routes.filter(
              (route) => !droppedAddresses.has(route.tokenIn.toLowerCase()),
            )
          : quote.routes;

      if (isOwnedModernLane(lane)) {
        approvalSpender = (buildTx.approvalSpender || DUST_SWEEP_ROUTER_V2_ADDRESS) as Address;
        approvalRequirements = await getTokenApprovalRequirements(effectiveRoutes, approvalSpender);
      }

      const requiresPermitSignature =
        buildTx.requiresSignature || buildTx.signatureMode === "permit2_witness";
      const getCanonicalCalldata = async () => {
        if (!requiresPermitSignature) {
          return canonicalCalldata;
        }

        if (canonicalCalldata !== buildTx.calldata) {
          return canonicalCalldata;
        }

        const typedData = buildTx.typedData || buildTx.permit2;
        if (!typedData) {
          throw new Error("Permit2 typed data missing from V2 sweep transaction");
        }

        currentStep = "signing";
        setSweepStep(currentStep);

        let signature: Hex;
        try {
          signature = (await walletClient.signTypedData({
            account: address,
            domain: typedData.domain,
            types: typedData.types,
            primaryType: typedData.primaryType || "PermitBatchWitnessTransferFrom",
            message: typedData.message,
          } as never)) as Hex;
        } catch (signatureError) {
          throw new Error(getPermit2SignatureErrorMessage(signatureError));
        }

        if (buildTx.callMode === "sweepV3Permit2") {
          // V3 permit2: re-build with the signature so the backend encodes the final
          // sweep() calldata against the real V3 ABI (no client-side V2 encoding).
          const v3Resp = await fetch("/api/dustsweep/build-tx", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              routes: quote.routes,
              tokenOut: tokenOut.address,
              receiver: address,
              deadline: quote.deadline,
              permit2Nonce: quote.permit2Nonce,
              userAddress: address,
              signature,
            }),
          });
          const v3Payload = await v3Resp.json().catch(() => null);
          if (!v3Resp.ok || !v3Payload?.calldata) {
            const message =
              v3Payload && typeof v3Payload === "object" && "error" in v3Payload
                ? String((v3Payload as { error?: unknown }).error)
                : "Failed to finalize V3 sweep transaction";
            throw new Error(message);
          }
          canonicalCalldata = v3Payload.calldata as Hex;
        } else {
          canonicalCalldata = encodeDustSweepV2Calldata(buildTx, signature);
        }
        return canonicalCalldata;
      };

      // Use the backend's canonical calldata — it encodes against the real compiled ABI.
      // The old encodeDustSweepPermit2Calldata used a phantom sweep() that doesn't exist on-chain.
      // Note: The current V1 contract doesn't accept Permit2 parameters inline —
      // the Permit2 signature is verified separately through the Permit2 contract.
      const paymasterUrl = process.env.NEXT_PUBLIC_PAYMASTER_URL;
      const txValue = buildTx.value ? BigInt(buildTx.value) : 0n;
      const sweepTarget = buildTx.routerAddress || buildTx.contractAddress;
      const hasV2Approvals = isOwnedModernLane(lane) && approvalRequirements.length > 0;
      // (A/B) OKX can submit a raw wallet_sendCalls bundle even when
      // wallet_getCapabilities is unknown/unreliable. We only reach the batch route
      // when there is NO known foreign delegate (own OKX delegate, undelegated, or
      // an unrecognized infra delegate), so OKX batching is no longer gated on
      // supportsWalletSendCalls.
      const canTryOkxRawSendCalls =
        walletProfile.walletKey === "okx" && routeKind === "batch";
      // Guaranteed fallback: once the OKX one-click combined batch has been
      // abandoned this session (OKX left Confirm disabled and the user rejected,
      // or it errored), skip the SINGLE full combined batch and instead retry as
      // multiple SMALLER combined approve+sweep batches (OKX_COMBINED_CHUNK_SIZE
      // tokens each) — "batch again, smaller", never one-by-one. Reset on account
      // change / on success.
      const okxRetryWithChunks =
        canTryOkxRawSendCalls && okxOneClickAbandonedRef.current;
      // (C) OKX must receive CLEAN exact ERC20 approve calldata (no builder-code
      // suffix) so it decodes the bundle and shows a normal approval+sweep prompt.
      // The builder code stays on the final V3 sweep call. Other wallets keep the
      // suffix on approvals as before.
      const approvalCalls = hasV2Approvals
        ? buildApprovalCalls(approvalRequirements, approvalSpender, !canTryOkxRawSendCalls)
        : [];
      const bundledCallCount = approvalCalls.length + 1;
      const usesTokenPocketExisting =
        walletProfile.executionStrategy === "tokenpocket_existing";
      const routeCount = quote.routes.length;
      // Coinbase / Base smart wallets always support EIP-5792 atomic batching,
      // even when wallet_getCapabilities probing is flaky inside their in-app
      // browser. Attempt the bundle for them regardless of the probe result —
      // sendAtomicWalletCalls falls back to standard approvals if the wallet
      // genuinely can't batch, so this can only reduce prompts, never break.
      const canUseWalletSendCalls =
        supportsWalletSendCalls ||
        walletStatus.isCoinbaseSmartWallet ||
        canTryOkxRawSendCalls;
      // Only attempt wallet batching on the batch route. When the account is
      // delegated to a foreign/unknown impl (routeKind !== "batch"), the wallet's
      // atomic batch can't actually work, so skip it and go straight to standard
      // approvals + sweep — avoiding the "approval batch was not ready" failure.
      const batchRouteAllowed = routeKind === "batch";
      const walletApprovalBatchingEnabled = isDustSweepApprovalBatchingEnabled(
        walletProfile.walletKey,
      );
      const canUseAtomicBatch =
        batchRouteAllowed &&
        batchMode &&
        hasV2Approvals &&
        canUseWalletSendCalls &&
        walletApprovalBatchingEnabled &&
        !usesTokenPocketExisting;
      const canUseTokenPocketBatch =
        batchRouteAllowed &&
        batchMode &&
        hasV2Approvals &&
        usesTokenPocketExisting;
      const shouldSplitTokenPocketBatch = hasV2Approvals && usesTokenPocketExisting;
      // OKX is NEVER force-split on internal call count. The whole approve+sweep
      // bundle goes out as ONE atomic wallet_sendCalls regardless of how many
      // calls it generates (requirement E).
      const shouldSplitOkxBatch = false;
      const shouldSplitWalletBatch =
        shouldSplitTokenPocketBatch ||
        shouldSplitOkxBatch;
      // (E) No app-level internal call cap may block, split, or fail the atomic
      // bundle for ANY wallet — including Coinbase / Base Account. The user selects
      // at most 50 tokens; whatever number of internal calls that produces
      // (51/80/120/200 — exact approvals + reset-first approvals + the sweep) all
      // go in ONE atomic wallet_sendCalls. Per the Base Account batch-transactions
      // guide, wallet_sendCalls batches all calls atomically with no documented
      // call cap; if Base Account rejects (e.g. 5740 "batch too large"), the catch
      // below falls back to standard approvals + a single sweep. (TokenPocket keeps
      // its approvals-then-sweep fallback — that is an estimation strategy, not a
      // call-count cap.)
      const canBundleAllCalls =
        !shouldSplitWalletBatch &&
        (canUseAtomicBatch || canUseTokenPocketBatch) &&
        // OKX: approvals + sweep MUST go out as ONE clean atomic wallet_sendCalls.
        // A standalone approval-only batch is HARD-BLOCKED by OKX's security engine
        // ("This signature type is risky — will be canceled"): a 7702 set-code auth
        // bundled with bare approvals and no consuming call reads like a drainer.
        // The combined batch carries the sweep as the consuming call, so OKX accepts
        // it as a normal swap. Calldata is kept 100% clean (no builder suffix on any
        // call — see canTryOkxRawSendCalls below) so OKX can decode + simulate it.
        // After the OKX one-click batch is abandoned this session, fall through to
        // the SMALLER combined approve+sweep batches instead of re-attempting the
        // full bundle.
        !okxRetryWithChunks;
      // Approvals-only batch (no sweep) — NEVER for OKX. OKX hard-blocks a bare
      // approval/7702 batch as a "risky signature type" (confirmed live), so OKX
      // must always use the combined bundle above, or (on abandonment) the
      // per-token approvals + sweep fallback. Other wallets keep the split.
      const canBundleApprovalsOnly =
        !canTryOkxRawSendCalls &&
        (canUseAtomicBatch || canUseTokenPocketBatch) &&
        approvalCalls.length > 0;
      // TokenPocket can put approvals + the sweep in ONE wallet_sendCalls. If TP
      // rejects the combined batch the execution path falls back to the proven
      // approvals-then-sweep split below.
      const canBundleTokenPocketAllCalls =
        canUseTokenPocketBatch &&
        approvalCalls.length > 0;
      const usePaymasterCapabilities =
        walletStatus.isCoinbaseSmartWallet && Boolean(paymasterUrl);

      console.info("DustSweep execution selection", {
        walletName: walletProfile.walletName,
        walletKey: walletProfile.walletKey,
        connectorId: walletStatus.connectorId,
        atomicStatus: walletProfile.atomicStatus,
        supportsWalletSendCalls,
        canUseWalletSendCalls,
        canTryOkxRawSendCalls,
        isCoinbaseSmartWallet: walletStatus.isCoinbaseSmartWallet,
        executionStrategy: walletProfile.executionStrategy,
        lane,
        routeCount,
        approvalCallCount: approvalCalls.length,
        fullBundleCallCount: bundledCallCount,
        artificialCallCapApplied: false,
        walletApprovalBatchingEnabled,
        tokenPocketCompatibleBatch: canUseTokenPocketBatch,
        splitOkxBatch: shouldSplitOkxBatch,
        splitWalletBatch: shouldSplitWalletBatch,
      });

      const sendSweepTransaction = async (calldata: Hex) => {
        // No explicit gas — the wallet estimates the sweep itself.
        if (usesTokenPocketExisting) {
          return sendTokenPocketRawTransaction({
            to: sweepTarget,
            data: calldata,
            value: txValue,
          });
        }

        return (await walletClient.sendTransaction({
          account: address,
          chain: base,
          to: sweepTarget,
          data: calldata,
          value: txValue,
          dataSuffix: DATA_SUFFIX,
          ...(walletStatus.isCoinbaseSmartWallet && paymasterUrl
            ? {
                capabilities: buildBasePaymasterCapabilities(),
              }
            : {}),
        } as never)) as Hex;
      };

      const sendStandardSweepWithApprovals = async () => {
        if (hasV2Approvals) {
          currentStep = "approving";
          setSweepStep(currentStep);
          await sendTokenApprovals(approvalRequirements, approvalSpender);
          currentStep = "pending";
          setSweepStep(currentStep);
        }

        const sweepCalldata = await getCanonicalCalldata();
        currentStep = "pending";
        setSweepStep(currentStep);
        return sendSweepTransaction(sweepCalldata);
      };

      const sendBundledApprovalsThenSweep = async (notice?: string) => {
        if (notice) {
          setExecutionNotice(notice);
        }

        const tokenPocketApprovalBatch = usesTokenPocketExisting;
        currentStep = "approving";
        setSweepStep(currentStep);

        try {
          if (tokenPocketApprovalBatch) {
            // TokenPocket: use raw wallet_sendCalls with gas per call so TP shows all
            // approvals at once and never needs to estimate gas internally.
            await sendTokenPocketBatchApprovals(approvalRequirements, approvalSpender);
          } else {
            const approvalHash = await sendAtomicWalletCalls({
              account: address,
              calls: approvalCalls,
              usePaymasterCapabilities,
              walletKey: walletProfile.walletKey,
              requireAtomic: true,
              appendDataSuffixes: true,
            });
            await waitForSuccessfulTransaction(approvalHash);
          }
        } catch (approvalBatchError) {
          if (isRejectedByUser(approvalBatchError) || isWalletLockedError(approvalBatchError)) {
            throw approvalBatchError;
          }

          // Approval-only batch failed (e.g. OKX flagged the bare-approval batch).
          // This is SAFE to degrade to per-token approvals — there is no sweep in
          // this batch, so re-approving can't double-spend; the sweep follows after.
          console.warn("DustSweep approval batch failed; falling back to standard approvals.", {
            walletKey: walletProfile.walletKey,
            approvalCallCount: approvalCalls.length,
            code: getErrorCode(approvalBatchError),
            message: getDebugErrorMessage(approvalBatchError),
          });
          setExecutionNotice(
            `${walletProfile.walletName || "Wallet"} couldn't take the approvals in one batch, approving the remaining tokens before the sweep.`,
          );
          return sendStandardSweepWithApprovals();
        }

        const remainingApprovals = await getTokenApprovalRequirements(effectiveRoutes, approvalSpender);
        if (remainingApprovals.length > 0) {
          console.warn("DustSweep approval batch left missing allowances; completing standard approvals.", {
            walletKey: walletProfile.walletKey,
            missingApprovalCount: remainingApprovals.length,
          });
          setExecutionNotice(
            `${walletProfile.walletName || "Wallet"} approval batch finished with missing allowances, sending the remaining approvals before the sweep.`,
          );
          await sendTokenApprovals(remainingApprovals, approvalSpender);
        }

        const sweepCalldata = await getCanonicalCalldata();
        currentStep = "pending";
        setSweepStep(currentStep);
        return sendSweepTransaction(sweepCalldata);
      };

      // Fallback for EIP-5792 wallets (Coinbase / Base Account, etc.) that reject
      // the single up-to-50-token bundle as "batch too large" (error 5740). Instead
      // of degrading all the way to one-by-one approvals, send the approvals in
      // small atomic wallet_sendCalls chunks (CHUNK_APPROVALS_PER_BATCH per prompt),
      // wait for each to confirm, then send the (gas-heavy) sweep as its own tx —
      // so a 50-token sweep is ~5 approval prompts + 1 sweep, not 50.
      const sendChunkedApprovalsThenSweep = async (notice?: string) => {
        if (notice) {
          setExecutionNotice(notice);
        }

        currentStep = "approving";
        setSweepStep(currentStep);

        const approvalChunks = chunkWalletCalls(approvalCalls, CHUNK_APPROVALS_PER_BATCH);
        for (let index = 0; index < approvalChunks.length; index += 1) {
          const chunkHash = await sendAtomicWalletCalls({
            account: address,
            calls: approvalChunks[index],
            usePaymasterCapabilities,
            walletKey: walletProfile.walletKey,
            requireAtomic: true,
            appendDataSuffixes: true,
          });
          await waitForSuccessfulTransaction(chunkHash);
        }

        // Approvals re-checked so any chunk that didn't land is completed one-by-one
        // before the sweep (prevents a sweep that reverts on a missing allowance).
        const remaining = await getTokenApprovalRequirements(effectiveRoutes, approvalSpender);
        if (remaining.length > 0) {
          await sendTokenApprovals(remaining, approvalSpender);
        }

        const sweepCalldata = await getCanonicalCalldata();
        currentStep = "pending";
        setSweepStep(currentStep);
        return sendSweepTransaction(sweepCalldata);
      };

      // OKX: when the single combined approve+sweep batch over ALL selected tokens
      // is too large for OKX to decode/simulate (the "Unknown transaction" /
      // "Unable to submit" failure on 13/50-token sweeps), retry as multiple
      // SMALLER combined approve+sweep batches of OKX_COMBINED_CHUNK_SIZE tokens.
      // Each chunk rebuilds its OWN sweep calldata for just that subset of routes
      // and sends [approvals…, sweep] as ONE atomic, 100%-clean wallet_sendCalls —
      // so OKX still gets one clean approve+sweep transaction per chunk and NEVER a
      // one-by-one approval flow. Only used on the allowance lane (the mode OKX
      // runs on); a Permit2-signature lane would need per-chunk signing, so it
      // throws and the caller degrades to the standard path.
      const fetchChunkBuildTx = async (
        chunkRoutes: DustSweepQuoteResponse["routes"],
      ) => {
        const chunkResponse = await fetch("/api/dustsweep/build-tx", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            routes: chunkRoutes,
            tokenOut: tokenOut.address,
            receiver: address,
            deadline: quote.deadline,
            permit2Nonce: quote.permit2Nonce,
            userAddress: address,
          }),
        });
        const chunkPayload = await chunkResponse.json().catch(() => null);
        if (!chunkResponse.ok) {
          const message =
            chunkPayload && typeof chunkPayload === "object" && "error" in chunkPayload
              ? String((chunkPayload as { error?: unknown }).error)
              : "Failed to build chunked sweep transaction";
          throw new Error(message);
        }
        return chunkPayload as DustSweepBuildTxResponse;
      };

      const sendOkxChunkedCombinedBatches = async (notice?: string) => {
        if (requiresPermitSignature) {
          // Per-chunk Permit2 signing isn't supported here; let the caller fall
          // back to the standard approvals + sweep path.
          throw new Error("OKX chunked combined batch requires the allowance lane");
        }
        if (notice) {
          setExecutionNotice(notice);
        }

        const routeChunks = chunkWalletCalls(quote.routes, OKX_COMBINED_CHUNK_SIZE);
        let lastHash: Hex | null = null;

        for (let index = 0; index < routeChunks.length; index += 1) {
          const chunkRoutes = routeChunks[index];
          setExecutionNotice(
            `OKX couldn't take all tokens in one batch — sweeping in batches of up to ${OKX_COMBINED_CHUNK_SIZE} (batch ${index + 1} of ${routeChunks.length}).`,
          );

          // Rebuild the sweep calldata for ONLY this subset of routes.
          const chunkBuild = await fetchChunkBuildTx(chunkRoutes);
          if (
            chunkBuild.requiresSignature ||
            chunkBuild.signatureMode === "permit2_witness"
          ) {
            throw new Error("OKX chunked combined batch requires the allowance lane");
          }
          const chunkSpender = (chunkBuild.approvalSpender || approvalSpender) as Address;
          const chunkApprovals = await getTokenApprovalRequirements(
            chunkRoutes,
            chunkSpender,
          );
          // OKX: clean exact ERC20 approve calldata (no builder suffix) so OKX can
          // decode the chunk; builder attribution is dropped on OKX chunk sweeps.
          const chunkApprovalCalls = buildApprovalCalls(chunkApprovals, chunkSpender, false);
          const chunkSweepTarget = (chunkBuild.routerAddress ||
            chunkBuild.contractAddress) as Address;
          const chunkValue = chunkBuild.value ? BigInt(chunkBuild.value) : 0n;

          const chunkCalls: WalletSendCall[] = [
            ...chunkApprovalCalls,
            {
              to: chunkSweepTarget,
              data: chunkBuild.calldata,
              value: chunkValue,
              // No dataSuffix — OKX needs 100% clean ABI calldata in the batch.
            },
          ];

          currentStep = "pending";
          setSweepStep(currentStep);
          console.info("DustSweep OKX chunked combined batch attempt", {
            walletKey: walletProfile.walletKey,
            chunkIndex: index,
            chunkCount: routeChunks.length,
            chunkTokenCount: chunkRoutes.length,
            chunkCallCount: chunkCalls.length,
          });
          const chunkHash = await sendAtomicWalletCalls({
            account: address,
            calls: chunkCalls,
            usePaymasterCapabilities,
            walletKey: walletProfile.walletKey,
            requireAtomic: true,
            appendDataSuffixes: true,
          });
          await waitForSuccessfulTransaction(chunkHash);
          lastHash = chunkHash;
        }

        if (!lastHash) {
          throw new Error("No tokens to sweep");
        }
        return lastHash;
      };

      // TokenPocket: approvals + sweep in ONE wallet_sendCalls. Mirrors the proven
      // TP approval-batch mechanism (raw wallet_sendCalls with explicit per-call
      // gas) and just appends the sweep call, so a fresh wallet upgrades (7702),
      // approves, and sweeps in a single transaction.
      const sendTokenPocketBundledSweep = async () => {
        currentStep = "approving";
        setSweepStep(currentStep);

        const sweepCalldata = await getCanonicalCalldata();

        // No explicit gas — TokenPocket estimates the batch itself (it simulates
        // approvals→sweep in sequence, so the sweep estimates fine).
        const bundledCalls: Array<{ to: string; data: Hex; value: string }> = [];
        for (const requirement of approvalRequirements) {
          // USDT-style reset: approve(0) then approve(amount). Within one atomic
          // batch they run in sequence, so both can live in the same tx.
          if (requirement.resetFirst) {
            bundledCalls.push({
              to: requirement.token,
              data: appendDataSuffix(
                encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [approvalSpender, 0n] }),
                DATA_SUFFIX,
              ),
              value: toRpcQuantity(0n),
            });
          }
          bundledCalls.push({
            to: requirement.token,
            data: appendDataSuffix(
              encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [approvalSpender, requirement.approvalAmount] }),
              DATA_SUFFIX,
            ),
            value: toRpcQuantity(0n),
          });
        }
        bundledCalls.push({
          to: sweepTarget,
          data: appendDataSuffix(sweepCalldata, DATA_SUFFIX),
          value: toRpcQuantity(txValue),
        });

        currentStep = "pending";
        setSweepStep(currentStep);
        // Use atomicRequired:false — the SAME mode as TokenPocket's proven approval
        // batch (which it executes as ONE tx for its smart account). TP rejected
        // atomicRequired:true here, which is what forced the fall back to two calls.
        // For a 7702 smart account TP still bundles the whole wallet_sendCalls into
        // a single transaction, so approvals + sweep land in one tx.
        return sendTokenPocketWalletSendCalls(bundledCalls, false);
      };

      if (
        batchMode &&
        hasV2Approvals &&
        !canUseWalletSendCalls &&
        !usesTokenPocketExisting
      ) {
        setExecutionNotice(getBatchFallbackNotice(walletProfile.walletName, walletProfile.walletKey));
      }
      if (
        batchMode &&
        hasV2Approvals &&
        batchRouteAllowed &&
        !walletApprovalBatchingEnabled
      ) {
        setExecutionNotice(METAMASK_APPROVAL_BATCHING_DISABLED_NOTICE);
      }

      let hash: Hex;
      if (canBundleTokenPocketAllCalls) {
        // Try TokenPocket's combined approve+sweep (one tx). If TP rejects the
        // combined batch for any non-cancel reason, fall back to the proven
        // approvals-then-sweep split so a working flow is never lost.
        setExecutionNotice(TOKENPOCKET_BUNDLED_NOTICE);
        try {
          hash = await sendTokenPocketBundledSweep();
        } catch (tokenPocketBundleError) {
          if (
            isRejectedByUser(tokenPocketBundleError) ||
            isWalletLockedError(tokenPocketBundleError)
          ) {
            throw tokenPocketBundleError;
          }
          console.warn("DustSweep TokenPocket combined approve+sweep failed; using the approvals-then-sweep split.", {
            walletKey: walletProfile.walletKey,
            callCount: approvalCalls.length + 1,
            code: getErrorCode(tokenPocketBundleError),
            message: getDebugErrorMessage(tokenPocketBundleError),
          });
          hash = await sendBundledApprovalsThenSweep(TOKENPOCKET_SPLIT_BATCH_NOTICE);
        }
      } else if (canBundleAllCalls) {
        const sweepCalldata = await getCanonicalCalldata();
        const fullBundleCalls: WalletSendCall[] = [
          ...approvalCalls,
          {
            to: sweepTarget,
            data: sweepCalldata,
            value: txValue,
            // OKX: omit the builder-code suffix on the sweep too. The non-ABI
            // trailing bytes on the custom router call make OKX's atomic-batch
            // decoder fail ("Unable to decode transaction data") and disable
            // Confirm. The whole OKX bundle must be clean ABI calldata. All other
            // wallets keep builder attribution on the sweep.
            ...(canTryOkxRawSendCalls ? {} : { dataSuffix: DATA_SUFFIX }),
          },
        ];

        // (G) Full telemetry for the OKX one-click bundle before the single prompt.
        if (canTryOkxRawSendCalls) {
          // Mark the one-click attempt so a reject/abandon falls through to the
          // proven approve+sweep path on the next Sweep click.
          attemptedOkxOneClick = true;
          console.info("DustSweep OKX wallet_sendCalls bundle", {
            walletKey: walletProfile.walletKey,
            routeKind,
            delegationAddress: delegation.address,
            delegateLabel:
              delegation.info.state === "known"
                ? delegation.info.label
                : delegation.info.state === "unknown"
                  ? "unknown"
                  : null,
            atomicStatus: walletProfile.atomicStatus,
            supportsWalletSendCalls,
            canTryOkxRawSendCalls,
            canUseWalletSendCalls,
            lane,
            callMode: buildTx.callMode,
            approvalSpender,
            sweepTarget,
            approvalCallsLength: approvalCalls.length,
            fullBundleCallsLength: fullBundleCalls.length,
            artificialCallCapApplied: false,
            approvalCallsHaveSuffix: false,
            // OKX bundle is now 100% clean ABI calldata (no builder suffix on any
            // call) so OKX's batch decoder can decode it.
            sweepCallHasSuffix: false,
            // atomicRequired:true so OKX previews the batch sequentially (approvals
            // applied before the sweep's transferFrom) — otherwise the sweep reverts
            // in OKX's preview and Confirm is disabled.
            atomicRequired: true,
          });
        }

        try {
          currentStep = "pending";
          setSweepStep(currentStep);
          console.info("DustSweep wallet batch attempt", {
            walletKey: walletProfile.walletKey,
            requireAtomic: true,
            callCount: fullBundleCalls.length,
            tokenPocketCompatibleBatch: usesTokenPocketExisting,
          });
          hash = await sendAtomicWalletCalls({
            account: address,
            calls: fullBundleCalls,
            usePaymasterCapabilities,
            walletKey: walletProfile.walletKey,
            requireAtomic: true,
            appendDataSuffixes: !usesTokenPocketExisting,
          });
        } catch (strictBundleError) {
          if (isRejectedByUser(strictBundleError) || isWalletLockedError(strictBundleError)) {
            throw strictBundleError;
          }

          console.warn("Atomic DustSweep sendCalls failed.", {
            walletKey: walletProfile.walletKey,
            requireAtomic: true,
            callCount: fullBundleCalls.length,
            code: getErrorCode(strictBundleError),
            message: getDebugErrorMessage(strictBundleError),
          });

          if (canTryOkxRawSendCalls) {
            // (H) If OKX already opened its prompt and the bundle was submitted —
            // an id came back but wallet_getCallsStatus was slow/unsupported, so we
            // couldn't resolve a hash — DO NOT resend approvals/sweep one by one;
            // that risks duplicate transactions. Surface a pending/submitted
            // message instead. Only fall back to standard approvals + a single
            // sweep when the batch clearly failed BEFORE a user-confirmed
            // submission (rejected/locked are already rethrown above).
            if (isApprovalBatchStatusUncertainError(strictBundleError)) {
              console.warn("DustSweep OKX bundle submitted but status was unclear; not sending fallback prompts.", {
                walletKey: walletProfile.walletKey,
                code: getErrorCode(strictBundleError),
                message: getDebugErrorMessage(strictBundleError),
              });
              throw new Error(OKX_BATCH_STATUS_UNCLEAR_MESSAGE);
            }
            // The combined batch failed before submission (e.g. OKX couldn't
            // decode/simulate the full up-to-50-token bundle). Don't drop to
            // one-by-one approvals — retry as multiple SMALLER combined
            // approve+sweep batches (OKX_COMBINED_CHUNK_SIZE tokens each), which
            // OKX can decode. Only if the chunked combined path also fails do we
            // degrade to standard per-token approvals + a single sweep.
            console.info(
              "DustSweep OKX combined batch failed before submission; retrying as chunked combined approve+sweep batches.",
            );
            try {
              hash = await sendOkxChunkedCombinedBatches(OKX_CHUNKED_BATCH_NOTICE);
            } catch (okxChunkError) {
              if (isRejectedByUser(okxChunkError) || isWalletLockedError(okxChunkError)) {
                throw okxChunkError;
              }
              console.warn(
                "DustSweep OKX chunked combined batches failed; falling back to standard approvals + sweep.",
                {
                  walletKey: walletProfile.walletKey,
                  chunkSize: OKX_COMBINED_CHUNK_SIZE,
                  code: getErrorCode(okxChunkError),
                  message: getDebugErrorMessage(okxChunkError),
                },
              );
              setExecutionNotice(OKX_BATCH_FALLBACK_NOTICE);
              hash = await sendStandardSweepWithApprovals();
            }
          } else if (usesTokenPocketExisting) {
            console.info("DustSweep TokenPocket strict batch failed; retrying compatible mode.", {
              walletKey: walletProfile.walletKey,
              requireAtomic: false,
              callCount: fullBundleCalls.length,
            });

            try {
              hash = await sendAtomicWalletCalls({
                account: address,
                calls: fullBundleCalls,
                usePaymasterCapabilities,
                walletKey: walletProfile.walletKey,
                requireAtomic: false,
                appendDataSuffixes: false,
              });
            } catch (compatibleBundleError) {
              if (isRejectedByUser(compatibleBundleError) || isWalletLockedError(compatibleBundleError)) {
                throw compatibleBundleError;
              }

              console.warn("DustSweep TokenPocket compatible batch failed.", {
                walletKey: walletProfile.walletKey,
                requireAtomic: false,
                callCount: fullBundleCalls.length,
                code: getErrorCode(compatibleBundleError),
                message: getDebugErrorMessage(compatibleBundleError),
              });

              setExecutionNotice(TOKENPOCKET_BATCH_FAILURE_MESSAGE);
              if (
                isBatchFallbackError(strictBundleError) ||
                isBatchFallbackError(compatibleBundleError)
              ) {
                try {
                  hash = await sendStandardSweepWithApprovals();
                } catch (standardFallbackError) {
                  console.warn("DustSweep TokenPocket standard fallback failed.", {
                    walletKey: walletProfile.walletKey,
                    code: getErrorCode(standardFallbackError),
                    message: getDebugErrorMessage(standardFallbackError),
                  });
                  throw new Error(TOKENPOCKET_BATCH_FAILURE_MESSAGE);
                }
              } else {
                throw new Error(TOKENPOCKET_BATCH_FAILURE_MESSAGE);
              }
            }
          } else {
            // User-cancel and wallet-locked errors are already rethrown above.
            // Any other failure means the atomic batch did not go through, so
            // fall back — "try the full bundle first, then degrade".
            if (canBundleApprovalsOnly && isBatchTooLargeError(strictBundleError)) {
              // The wallet (e.g. Coinbase / Base Account) accepted the request
              // shape but the single up-to-50-token bundle was too large for one
              // atomic tx. Don't drop to one-by-one (50 prompts) — approve in
              // small chunks (CHUNK_APPROVALS_PER_BATCH per prompt), then sweep.
              // If even the chunked path fails, degrade to one-by-one + sweep.
              try {
                hash = await sendChunkedApprovalsThenSweep(
                  `${walletProfile.walletName || "Wallet"} couldn't take all approvals and the sweep in one transaction, so DustSweep will approve in batches of ${CHUNK_APPROVALS_PER_BATCH}, then sweep.`,
                );
              } catch (chunkError) {
                if (isRejectedByUser(chunkError) || isWalletLockedError(chunkError)) {
                  throw chunkError;
                }
                console.warn("DustSweep chunked approval fallback failed; using standard approvals.", {
                  walletKey: walletProfile.walletKey,
                  chunkSize: CHUNK_APPROVALS_PER_BATCH,
                  approvalCallCount: approvalCalls.length,
                  code: getErrorCode(chunkError),
                  message: getDebugErrorMessage(chunkError),
                });
                hash = await sendStandardSweepWithApprovals();
              }
            } else {
              // sendBundledApprovalsThenSweep / sendStandardSweepWithApprovals
              // re-check allowances, so a partially applied batch is handled safely.
              const notice = getBatchFallbackNoticeForError({
                walletName: walletProfile.walletName,
                walletKey: walletProfile.walletKey,
                error: strictBundleError,
                callCount: bundledCallCount,
              });

              hash = canBundleApprovalsOnly
                ? await sendBundledApprovalsThenSweep(notice)
                : await sendStandardSweepWithApprovals();
            }
          }
        }
      } else if (okxRetryWithChunks) {
        // OKX abandoned the SINGLE full combined batch this session (Confirm left
        // disabled → rejected). Retry as multiple SMALLER combined approve+sweep
        // batches — never one-by-one. Degrade to standard only if chunking fails.
        try {
          hash = await sendOkxChunkedCombinedBatches(OKX_CHUNKED_BATCH_NOTICE);
        } catch (okxChunkError) {
          if (isRejectedByUser(okxChunkError) || isWalletLockedError(okxChunkError)) {
            throw okxChunkError;
          }
          console.warn(
            "DustSweep OKX chunked combined batches failed; falling back to standard approvals + sweep.",
            {
              walletKey: walletProfile.walletKey,
              chunkSize: OKX_COMBINED_CHUNK_SIZE,
              code: getErrorCode(okxChunkError),
              message: getDebugErrorMessage(okxChunkError),
            },
          );
          setExecutionNotice(OKX_BATCH_FALLBACK_NOTICE);
          hash = await sendStandardSweepWithApprovals();
        }
      } else if (canBundleApprovalsOnly) {
        hash = await sendBundledApprovalsThenSweep(
          shouldSplitOkxBatch
            ? OKX_SPLIT_BATCH_NOTICE
            : shouldSplitTokenPocketBatch
            ? TOKENPOCKET_SPLIT_BATCH_NOTICE
            : `Approval+sweep needs ${bundledCallCount} wallet calls, so DustSweep will batch approvals first and then send the sweep.`,
        );
      } else {
        hash = await sendStandardSweepWithApprovals();
      }

      setTxHash(hash);
      await waitForSuccessfulTransaction(hash);
      // Sweep completed — clear the OKX fallback flag for the next sweep.
      okxOneClickAbandonedRef.current = false;

      const completedInputs: DustSweepCompletionSummary["inputs"] = [];
      for (const route of effectiveRoutes) {
        const token = selectedTokens.find((item) =>
          isSameAddress(item.address, route.tokenIn),
        );
        if (!token) continue;
        completedInputs.push({
          address: token.address,
          symbol: token.symbol,
          name: token.name,
          decimals: token.decimals,
          logoURI: token.logoURI,
          balanceFormatted: token.balanceFormatted,
          valueUSD: token.valueUSD,
          estimatedOut: route.estimatedOut,
          dexName: route.dexName,
        });
      }

      // Mixed basket with a WETH→ETH unwrap: the unwrap tx already went out before the sweep —
      // include it in the success summary the user sees (record-sweep below stays router-only,
      // a 1:1 unwrap is not swap volume).
      if (unwrapHash && quote.wethUnwrap) {
        const wethToken = selectedTokens.find((item) =>
          isSameAddress(item.address, WETH_ADDRESS),
        );
        if (wethToken) {
          completedInputs.push({
            address: wethToken.address,
            symbol: wethToken.symbol,
            name: wethToken.name,
            decimals: wethToken.decimals,
            logoURI: wethToken.logoURI,
            balanceFormatted: wethToken.balanceFormatted,
            valueUSD: wethToken.valueUSD,
            estimatedOut: quote.wethUnwrap.amount,
            dexName: "Unwrap",
          });
        }
      }

      const unwrapOutAmount =
        unwrapHash && quote.wethUnwrap ? BigInt(quote.wethUnwrap.amount) : 0n;
      const unwrapOutUSD = unwrapHash && quote.wethUnwrap ? quote.wethUnwrap.valueUSD : 0;

      setCompletionSummary({
        txHash: hash,
        tokenOut,
        tokenOutAmount: (
          BigInt(quote.netEstimatedOut || quote.totalEstimatedOut || "0") + unwrapOutAmount
        ).toString(),
        tokenOutValueUSD:
          (quote.netEstimatedOutUSD ?? quote.totalEstimatedOutUSD) + unwrapOutUSD,
        inputValueUSD: completedInputs.reduce((sum, token) => sum + (token.valueUSD || 0), 0),
        feeAmountUSD: quote.feeAmountUSD,
        gasEstimateUSD: quote.gasEstimateUSD,
        routeCount: effectiveRoutes.length + (unwrapHash ? 1 : 0),
        walletName: walletProfile.walletName,
        routeKind,
        completedAt: Date.now(),
        inputs: completedInputs,
      });

      setSweepStep("success");
      logSweepTelemetry("success");
      await fetch("/api/dustsweep/record-sweep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: hash,
          userAddress: address,
          tokensSwapped: effectiveRoutes.length,
          valueUSD: quote.totalEstimatedOutUSD,
          walletKey: walletProfile.walletKey,
          delegateAddress: delegation.address,
          delegateLabel:
            delegation.info.state === "known" ? delegation.info.label : null,
          atomicStatus: walletProfile.atomicStatus,
          routeKind,
          permit2ApprovalsNeeded: permit2SetupCount,
        }),
      }).catch(() => null);

      setSelectedTokens([]);
      setQuote(null);
      setExecutionNotice(null);
      void refreshTokens({ force: true });

      return { txHash: hash };
    } catch (sweepError) {
      // OKX left the combined batch with Confirm disabled and the user rejected it.
      // This only fires on a genuine pre-submission rejection (nothing was sent —
      // a clear pre-submission failure already falls back inline, and a submitted-
      // but-status-unclear batch throws OKX_BATCH_STATUS_UNCLEAR_MESSAGE and is NOT
      // caught here, so we never risk a duplicate). Arm the sticky fallback so the
      // NEXT Sweep click runs the proven approve+sweep path — never dead-end.
      if (
        attemptedOkxOneClick &&
        isRejectedByUser(sweepError) &&
        !okxOneClickAbandonedRef.current
      ) {
        okxOneClickAbandonedRef.current = true;
        setError(
          "OKX couldn't confirm the one-click approve+sweep. Tap Sweep again — DustSweep will sweep your tokens in smaller combined approve+sweep batches instead.",
        );
        setSweepStep("error");
        logSweepTelemetry("cancelled");
        return null;
      }
      const message =
        isWalletLockedError(sweepError)
          ? METAMASK_LOCKED_MESSAGE
          : isRejectedByUser(sweepError)
          ? currentStep === "approving"
            ? "Approval cancelled"
            : "Transaction cancelled"
          : walletProfile.walletKey === "tokenpocket" &&
              isTokenPocketConnectorExecutionError(sweepError)
            ? TOKENPOCKET_BATCH_FAILURE_MESSAGE
          : sweepError instanceof Error
            ? parseDustSweepError(sweepError)
            : "Transaction failed";
      setError(message);
      setSweepStep("error");
      logSweepTelemetry(isRejectedByUser(sweepError) ? "cancelled" : "error");
      return null;
    } finally {
      sweepInFlightRef.current = false;
      setIsSweeping(false);
    }
  }, [
    address,
    batchMode,
    delegation,
    getTokenApprovalRequirements,
    permit2SetupCount,
    publicClient,
    quote,
    refreshQuote,
    routeKind,
    refreshTokens,
    buildApprovalCalls,
    sendAtomicWalletCalls,
    sendTokenApprovals,
    sendTokenPocketBatchApprovals,
    sendTokenPocketWalletSendCalls,
    sendTokenPocketRawTransaction,
    selectedTokens,
    supportsWalletSendCalls,
    switchToBase,
    tokenOut,
    waitForSuccessfulTransaction,
    waitForApprovalRequirementsCleared,
    walletClient,
    walletProfile.atomicStatus,
    walletProfile.executionStrategy,
    walletProfile.walletKey,
    walletProfile.walletName,
    walletStatus,
  ]);

  return {
    swappableTokens,
    unavailableTokens,
    selectedTokens,
    tokenOut,
    quote,
    slippageBps,
    isLoading: balances.isLoading,
    balanceScan: balances.scan,
    isQuoting,
    isSweeping,
    sweepStep,
    txHash,
    completionSummary,
    error: error || balances.error,
    executionNotice,
    quoteError,
    autoMode,
    autoSelectionUsd,
    batchMode,
    smartRouting,
    removeFailedTokens,
    routeMaxCap,
    supportsWalletSendCalls,
    routeKind,
    delegation,
    recommendedWallet,
    isDetectingRoute,
    permit2SetupCount,
    walletProfile,
    outputTokens,
    walletStatus,
    quoteFailedTokenAddresses,
    setTokenOut,
    setSlippageBps,
    setAutoMode,
    setAutoSelectionUsd,
    setBatchMode,
    setSmartRouting,
    setRemoveFailedTokens,
    setSelectedTokens,
    addToken,
    selectAllTokens,
    removeToken,
    clearSelectedTokens,
    clearUnavailableTokens,
    removeUnavailableToken,
    refreshTokens,
    refreshQuote,
    previewSweep: refreshQuote,
    executeSweep,
    resetSweepState,
    dismissCompletionSummary,
  };
}
