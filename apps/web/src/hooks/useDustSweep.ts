"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useConnection, usePublicClient, useWalletClient } from "wagmi";
import { base } from "viem/chains";
import { useBaseChainSwitch } from "@/hooks/useBaseChainSwitch";
import { concatHex, encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { useTokenBalances, type TokenBalanceScanState } from "@/hooks/useTokenBalances";
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
  DUST_SWEEP_EXECUTION_LANE,
  DUST_SWEEP_ROUTER_ADDRESS,
  DUST_SWEEP_ROUTER_V2_ADDRESS,
  V1_MAX_BATCH_SIZE,
  V2_MAX_BATCH_SIZE,
  encodeDustSweepV2Calldata,
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
  gas?: bigint;
  capabilities?: Record<string, unknown>;
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
  refreshTokens: () => Promise<void>;
  refreshQuote: () => Promise<void>;
  previewSweep: () => Promise<void>;
  executeSweep: () => Promise<ExecuteSweepResult | null>;
  resetSweepState: () => void;
  dismissCompletionSummary: () => void;
};

const ATOMIC_BATCH_UNSUPPORTED_MESSAGE =
  "This wallet cannot combine token approvals and the sweep into one atomic Base request. DustSweep will use Permit2 approvals and a standard sweep.";
const WALLET_BATCH_UNSUPPORTED_MESSAGE =
  "This wallet rejected atomic approval+sweep batching. DustSweep will use Permit2 approvals and a standard sweep.";
const BASE_ACCOUNT_SPLIT_BATCH_NOTICE =
  "Base Account will batch approvals first, then send the sweep in a second wallet request for more reliable estimation.";
const TOKENPOCKET_SPLIT_BATCH_NOTICE =
  "TokenPocket estimates DustSweep more reliably when approvals are batched first. DustSweep will send approvals first, then send the sweep after allowances are confirmed.";
const METAMASK_LOCKED_MESSAGE = "Unlock MetaMask and try again. No transaction was sent.";
const TOKENPOCKET_BATCH_FAILURE_MESSAGE =
  "TokenPocket batch execution failed. Please retry, reduce selected tokens, or use another supported wallet while we continue improving TokenPocket support.";
const TOKENPOCKET_EXECUTE_FAILURES_TOPIC =
  "0xc42159347c71974b140767e5ffe0d24cb03d38c0e86462ec59a240394c3b9b4c";
const APPROVAL_CALL_GAS_LIMIT = 150_000n;
const TOKENPOCKET_SWEEP_GAS_BASE = 500_000n;
const TOKENPOCKET_SWEEP_GAS_PER_ROUTE = 250_000n;
const WALLET_SEND_CALLS_MAX_CALLS = Math.max(
  1,
  Number(process.env.NEXT_PUBLIC_DUST_SWEEP_WALLET_BATCH_CALL_CAP || "50") || 50,
);
const METAMASK_WALLET_SEND_CALLS_MAX_CALLS = 10;
// Coinbase / Base smart wallets bundle approvals + sweep into ONE atomic
// wallet_sendCalls for sweeps at or below this token count (one wallet prompt).
// Above it, DustSweep splits into exactly two prompts: all approvals in one
// batch, then all sweeps in one batch — so a large sweep never exceeds 2 tx.
const SINGLE_BATCH_ROUTE_LIMIT = Math.max(
  1,
  Number(process.env.NEXT_PUBLIC_DUST_SWEEP_SINGLE_BATCH_LIMIT || "10") || 10,
);
const TOKENPOCKET_BATCH_APPROVALS_ENABLED =
  process.env.NEXT_PUBLIC_DUST_SWEEP_TOKENPOCKET_BATCH_APPROVALS === "true";

function isSameAddress(a?: string | null, b?: string | null) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function isSelectedOutputToken(token: Token, tokenOut: Token | null) {
  return Boolean(tokenOut && isSameAddress(token.address, tokenOut.address));
}

function getWalletSendCallsMaxCalls(walletKey: DustSweepWalletKey) {
  if (walletKey === "metamask") {
    return Math.min(WALLET_SEND_CALLS_MAX_CALLS, METAMASK_WALLET_SEND_CALLS_MAX_CALLS);
  }

  return WALLET_SEND_CALLS_MAX_CALLS;
}

function chunkWalletCalls(calls: WalletSendCall[], maxCallCount: number) {
  const chunks: WalletSendCall[][] = [];
  const size = Math.max(1, maxCallCount);
  for (let index = 0; index < calls.length; index += size) {
    chunks.push(calls.slice(index, index + size));
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

function buildGasLimitOverrideCapabilities(gas?: bigint) {
  if (!gas || gas <= 0n) {
    return undefined;
  }

  return {
    gasLimitOverride: {
      optional: true,
      value: toRpcQuantity(gas),
    },
  };
}

function mergeCallCapabilities(call: WalletSendCall) {
  const gasLimitOverride = buildGasLimitOverrideCapabilities(call.gas);
  if (!gasLimitOverride) {
    return call.capabilities;
  }

  return {
    ...(call.capabilities || {}),
    ...gasLimitOverride,
  };
}

function appendDataSuffix(data: Hex, dataSuffix?: Hex) {
  return dataSuffix && dataSuffix !== "0x" ? concatHex([data, dataSuffix]) : data;
}

function normalizeWalletSendCall(call: WalletSendCall, appendSuffix = true): WalletSendCall {
  const capabilities = mergeCallCapabilities(call);

  if (!appendSuffix) {
    return {
      to: call.to,
      value: call.value,
      data: call.data,
      dataSuffix: call.dataSuffix,
      ...(capabilities ? { capabilities } : {}),
    };
  }

  return {
    to: call.to,
    value: call.value,
    data: appendDataSuffix(call.data, call.dataSuffix),
    ...(capabilities ? { capabilities } : {}),
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

function getTokenPocketSweepFallbackGas(routeCount: number) {
  return TOKENPOCKET_SWEEP_GAS_BASE + BigInt(Math.max(1, routeCount)) * TOKENPOCKET_SWEEP_GAS_PER_ROUTE;
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

  const configuredRouteCap = getCapForLane(DUST_SWEEP_EXECUTION_LANE);
  const routeMaxCap = quote?.routeMaxCap ?? configuredRouteCap;
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
  const walletProfile = useMemo<DustSweepWalletProfile>(
    () => ({
      ...walletProfileBase,
      atomicStatus,
      batchNotice: getWalletBatchNotice(
        walletProfileBase.walletName,
        walletProfileBase.walletKey,
        atomicStatus,
      ),
    }),
    [atomicStatus, walletProfileBase],
  );

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
        .slice(0, configuredRouteCap),
    );
  }, [autoMode, autoSelectionUsd, configuredRouteCap, swappableTokens]);

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

    // TokenPocket's Base delegate is enough to prove the connected TokenPocket
    // wallet owns the account upgrade. Its wallet_getCapabilities response can
    // be flaky inside the in-app browser, while the execution path below uses
    // TokenPocket's provider directly with explicit gas. Let the verified own
    // delegate unlock the one-click path instead of falling back to Permit2.
    if (tokenPocketOwnDelegate) {
      return "batch";
    }

    // (2) Only trust the wallet's atomic batch claim when we're certain the
    // account isn't sitting on a FOREIGN delegate. Wallets (e.g. TokenPocket)
    // report atomic "supported"/"ready" even on an account delegated to another
    // wallet, then the batch fails. So batch only when the account is
    // undelegated, OR on a delegate we positively recognize as this wallet's own.
    // (Coinbase/Base smart wallets aren't 7702 EOAs → not "delegated" here → OK.)
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

  const refreshTokens = useCallback(async () => {
    await refetchBalances();
  }, [refetchBalances]);

  const refreshQuote = useCallback(async () => {
    if (!address || !tokenOut || selectedTokens.length === 0) {
      setQuote(null);
      return;
    }

    setIsQuoting(true);
    setQuoteError(null);
    setQuoteFailedTokenAddresses([]);
    setUnavailableTokens([]);

    try {
      const response = await fetch("/api/dustsweep/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokenIns: selectedTokens.map((token) => token.address),
          amounts: selectedTokens.map((token) => token.balance),
          tokenOut: tokenOut.address,
          slippageBps,
          userAddress: address,
        }),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const skippedTokens =
          payload && typeof payload === "object" && Array.isArray((payload as { skippedTokens?: unknown }).skippedTokens)
            ? ((payload as { skippedTokens: Array<{ token?: string; reason?: UnavailableReason }> }).skippedTokens)
            : [];
        const skippedByAddress = new Map(
          skippedTokens
            .filter((item) => item.token)
            .map((item) => [String(item.token).toLowerCase(), item.reason || "NO_LIQUIDITY" as UnavailableReason]),
        );
        const failedTokens = selectedTokens
          .filter((token) => skippedByAddress.has(token.address.toLowerCase()))
          .map((token) => ({
            ...token,
            reason: skippedByAddress.get(token.address.toLowerCase()) || "NO_LIQUIDITY" as UnavailableReason,
          }));
        if (failedTokens.length > 0) {
          const failedAddresses = failedTokens.map((token) => token.address.toLowerCase());
          setUnavailableTokens((current) => mergeUnavailableTokens(current, failedTokens));
          setQuoteFailedTokenAddresses(failedAddresses);
          if (removeFailedTokens) {
            setSelectedTokens((current) =>
              current.filter((token) => !skippedByAddress.has(token.address.toLowerCase())),
            );
          }
        }

        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error?: unknown }).error)
            : "Couldn't get quote";
        throw new Error(message);
      }

      const nextQuote = normalizeQuotePayload(payload);
      const routedAddresses = new Set(nextQuote.routes.map((route) => route.tokenIn.toLowerCase()));
      const skippedByAddress = new Map(
        (nextQuote.skippedTokens || []).map((item) => [
          item.token.toLowerCase(),
          item.reason,
        ]),
      );
      const failedTokens = selectedTokens
        .filter((token) => !routedAddresses.has(token.address.toLowerCase()))
        .map((token) => ({
          ...token,
          reason: skippedByAddress.get(token.address.toLowerCase()) || "NO_LIQUIDITY" as UnavailableReason,
        }));

      if (failedTokens.length > 0) {
        const failedAddresses = failedTokens.map((token) => token.address.toLowerCase());
        setUnavailableTokens((current) => mergeUnavailableTokens(current, failedTokens));
        setQuoteFailedTokenAddresses(failedAddresses);
        if (removeFailedTokens) {
          setSelectedTokens((current) =>
            current.filter((token) => routedAddresses.has(token.address.toLowerCase())),
          );
        }
      }

      setQuote(nextQuote);
    } catch (quoteFetchError) {
      const message =
        quoteFetchError instanceof Error
          ? quoteFetchError.message
          : "Couldn't get quote";
      setQuote(null);
      setQuoteError(message);
    } finally {
      setIsQuoting(false);
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
      return [...current, token].slice(0, configuredRouteCap);
    });
  }, [configuredRouteCap, tokenOut]);

  const selectAllTokens = useCallback(() => {
    setAutoMode(false);
    setSelectedTokens(swappableTokens.slice(0, configuredRouteCap));
  }, [configuredRouteCap, swappableTokens]);

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
    const approvalRequirements: ApprovalRequirement[] = [];

    for (const requirement of uniqueApprovalRequirements(routes)) {
      const allowance = (await publicClient.readContract({
        address: requirement.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, spender],
      })) as bigint;

      if (allowance >= requirement.amount) {
        continue;
      }

      approvalRequirements.push({
        ...requirement,
        allowance,
        approvalAmount: requirement.amount,
        resetFirst: allowance > 0n && requiresApprovalReset(requirement.token),
      });
    }

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
    gas: bigint;
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

    const tx = {
      from: address,
      to: args.to,
      data: concatHex([args.data, DATA_SUFFIX]),
      value: toRpcQuantity(args.value),
      gas: toRpcQuantity(args.gas),
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
          gas: tx.gas,
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
    for (const requirement of approvalRequirements) {
      const txBase = {
        account: address,
        chain: base,
        to: requirement.token,
        dataSuffix: DATA_SUFFIX,
        ...(usesTokenPocketExisting ? { gas: APPROVAL_CALL_GAS_LIMIT } : {}),
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
            gas: APPROVAL_CALL_GAS_LIMIT,
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
          gas: APPROVAL_CALL_GAS_LIMIT,
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
    walletStatus.isCoinbaseSmartWallet,
  ]);

  // Sends all approvals as a single wallet_sendCalls batch so TokenPocket shows
  // them all at once. The gas field is included directly on each call object
  // (as a hex quantity per EIP-5792), which bypasses TP's internal eth_estimateGas
  // call that always fails with "Contract error, cannot estimate gas limit".
  const sendTokenPocketBatchApprovals = useCallback(async (
    approvalRequirements: ApprovalRequirement[],
    spender: Address,
  ) => {
    if (!address || !walletClient || approvalRequirements.length === 0) return;

    const requests = getWalletRequestCandidates(walletClient, "tokenpocket", {
      preferInjected: true,
    });
    if (requests.length === 0) {
      throw new Error("TokenPocket provider unavailable");
    }

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
        // gas as a direct top-level field (EIP-5792) so TP uses it without estimating.
        gas: toRpcQuantity(APPROVAL_CALL_GAS_LIMIT),
      }));

    const sendBatch = async (batchCalls: ReturnType<typeof buildRpcCalls>) => {
      let lastError: unknown;
      for (const request of requests) {
        try {
          const result = await request({
            method: "wallet_sendCalls",
            params: [
              {
                version: "2.0.0",
                atomicRequired: false,
                chainId: `0x${base.id.toString(16)}`,
                from: address,
                calls: batchCalls,
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
              if (hasFailedCallsReceipt(status)) throw new Error("Approval batch failed");
              return hash;
            }
            if (getCallsStatusState(status) === "failure") throw new Error("Approval batch failed");
            await delay(1500);
          }
          throw new Error("Approval batch timed out");
        } catch (error) {
          if (isRejectedByUser(error) || isWalletLockedError(error)) throw error;
          lastError = error;
          console.warn("DustSweep TokenPocket wallet_sendCalls approval batch failed.", {
            callCount: batchCalls.length,
            code: getErrorCode(error),
            message: getDebugErrorMessage(error),
          });
        }
      }
      throw lastError instanceof Error ? lastError : new Error("TokenPocket wallet_sendCalls failed");
    };

    // Batch 1: all direct approvals + reset-to-zero for tokens that need it.
    const firstBatch = [
      ...buildRpcCalls(noReset, r => r.approvalAmount),
      ...buildRpcCalls(needsReset, () => 0n),
    ];
    const firstHash = await sendBatch(firstBatch);
    await waitForSuccessfulTransaction(firstHash);

    // Batch 2 (only if needed): follow-up approvals for tokens that were reset.
    // Resets must be confirmed on-chain before the approval can succeed.
    if (needsReset.length > 0) {
      const followupBatch = buildRpcCalls(needsReset, r => r.approvalAmount);
      const followupHash = await sendBatch(followupBatch);
      await waitForSuccessfulTransaction(followupHash);
    }
  }, [address, waitForSuccessfulTransaction, walletClient]);

  const buildApprovalCalls = useCallback((
    approvalRequirements: ApprovalRequirement[],
    spender: Address,
  ) => {
    const calls: WalletSendCall[] = [];

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
          // Builder code attribution, symmetric with the sweep call so every
          // batched approval also carries the suffix (normalizeWalletSendCall appends it).
          dataSuffix: DATA_SUFFIX,
          gas: APPROVAL_CALL_GAS_LIMIT,
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
        dataSuffix: DATA_SUFFIX,
        gas: APPROVAL_CALL_GAS_LIMIT,
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

    const requireAtomic = args.requireAtomic ?? true;
    const calls = args.calls.map((call) =>
      normalizeWalletSendCall(call, args.appendDataSuffixes ?? true),
    );
    const callCount = calls.length;
    const capabilities = buildSendCallsCapabilities({
      usePaymasterCapabilities: args.usePaymasterCapabilities,
    });
    // OKX extension decodes raw wallet_sendCalls approval batches well, but the
    // viem walletClient.sendCalls wrapper can report an error while OKX still
    // opens/queues a confirmation. Go straight to OKX's injected provider so a
    // single sweep click maps to a single OKX confirmation queue.
    const preferInjectedWalletSendCalls = args.walletKey === "okx";

    if (
      !preferInjectedWalletSendCalls &&
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
      preferInjected: preferInjectedWalletSendCalls,
    });
    if (requests.length === 0) {
      throw new Error("wallet_sendCalls is unavailable");
    }

    let sendCallsResult: unknown;
    let requestForStatus: WalletRpcRequest | null = null;
    let lastSendCallsError: unknown;
    for (const request of requests) {
      try {
        sendCallsResult = await request({
          method: "wallet_sendCalls",
          params: [
            {
              version: "2.0.0",
              atomicRequired: requireAtomic,
              chainId: `0x${base.id.toString(16)}`,
              from: args.account,
              calls: calls.map((call) => ({
                to: call.to,
                data: call.data,
                value: toRpcQuantity(call.value),
                ...(call.capabilities ? { capabilities: call.capabilities } : {}),
              })),
              ...(capabilities ? { capabilities } : {}),
            },
          ],
        });
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

    if (quote.routes.some((route) => route.priceImpactBps > 500)) {
      const confirmed = window.confirm("High price impact. Proceed with this sweep?");
      if (!confirmed) {
        return null;
      }
    }

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
    setIsSweeping(true);
    setSweepStep(currentStep);
    setError(null);
    setExecutionNotice(null);
    setCompletionSummary(null);

    try {
      await switchToBase();

      const lane = quote.executionLane || DUST_SWEEP_EXECUTION_LANE;
      let approvalSpender = lane === "owned_v2" ? DUST_SWEEP_ROUTER_V2_ADDRESS : DUST_SWEEP_ROUTER_ADDRESS;
      let approvalRequirements: ApprovalRequirement[] = [];

      if (lane !== "owned_v2") {
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

      if (lane === "owned_v2") {
        approvalSpender = (buildTx.approvalSpender || DUST_SWEEP_ROUTER_V2_ADDRESS) as Address;
        approvalRequirements = await getTokenApprovalRequirements(quote.routes, approvalSpender);
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
      const hasV2Approvals = lane === "owned_v2" && approvalRequirements.length > 0;
      const approvalCalls = hasV2Approvals
        ? buildApprovalCalls(approvalRequirements, approvalSpender)
        : [];
      const bundledCallCount = approvalCalls.length + 1;
      const usesTokenPocketExisting =
        walletProfile.executionStrategy === "tokenpocket_existing";
      const walletCallCap = getWalletSendCallsMaxCalls(walletProfile.walletKey);
      const routeCount = quote.routes.length;
      const exceedsSingleBatchLimit = routeCount > SINGLE_BATCH_ROUTE_LIMIT;
      // Coinbase / Base smart wallets always support EIP-5792 atomic batching,
      // even when wallet_getCapabilities probing is flaky inside their in-app
      // browser. Attempt the bundle for them regardless of the probe result —
      // sendAtomicWalletCalls falls back to standard approvals if the wallet
      // genuinely can't batch, so this can only reduce prompts, never break.
      const canUseWalletSendCalls =
        supportsWalletSendCalls || walletStatus.isCoinbaseSmartWallet;
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
      // Below the single-batch limit Coinbase/Base bundle approvals + sweep into
      // ONE prompt. Only split (approvals batch, then sweep) once the sweep is
      // large enough that one bundle gets unwieldy — keeping it to two prompts.
      const shouldSplitBaseAccountBatch =
        hasV2Approvals &&
        walletProfile.executionStrategy === "coinbase_paymaster" &&
        exceedsSingleBatchLimit;
      const shouldSplitTokenPocketBatch = hasV2Approvals && usesTokenPocketExisting;
      const shouldSplitWalletBatch = shouldSplitBaseAccountBatch || shouldSplitTokenPocketBatch;
      const canBundleAllCalls =
        !shouldSplitWalletBatch &&
        (canUseAtomicBatch || canUseTokenPocketBatch) &&
        bundledCallCount <= walletCallCap;
      const canBundleApprovalsOnly =
        (canUseAtomicBatch || canUseTokenPocketBatch) &&
        approvalCalls.length > 0 &&
        // TP uses parallel eth_sendTransaction (no wallet_sendCalls cap); other wallets respect the cap.
        (usesTokenPocketExisting || approvalCalls.length <= walletCallCap);
      const shouldChunkWalletBatch =
        canUseAtomicBatch &&
        !usesTokenPocketExisting &&
        approvalCalls.length > walletCallCap;
      const usePaymasterCapabilities =
        walletStatus.isCoinbaseSmartWallet && Boolean(paymasterUrl);

      console.info("DustSweep execution selection", {
        walletName: walletProfile.walletName,
        walletKey: walletProfile.walletKey,
        connectorId: walletStatus.connectorId,
        atomicStatus: walletProfile.atomicStatus,
        supportsWalletSendCalls,
        canUseWalletSendCalls,
        isCoinbaseSmartWallet: walletStatus.isCoinbaseSmartWallet,
        executionStrategy: walletProfile.executionStrategy,
        lane,
        routeCount,
        singleBatchLimit: SINGLE_BATCH_ROUTE_LIMIT,
        exceedsSingleBatchLimit,
        approvalCallCount: approvalCalls.length,
        fullBundleCallCount: bundledCallCount,
        walletCallCap,
        walletApprovalBatchingEnabled,
        tokenPocketCompatibleBatch: canUseTokenPocketBatch,
        splitWalletBatch: shouldSplitWalletBatch,
        chunkWalletBatch: shouldChunkWalletBatch,
      });

      const sendSweepTransaction = async (calldata: Hex) => {
        // TokenPocket's internal eth_estimateGas fails on complex multicall sweeps,
        // causing "Contract error, cannot estimate gas limit". Pre-estimate via our
        // publicClient (reliable RPC) and pass an explicit gas limit so TokenPocket
        // never needs to estimate on its own.
        let tokenPocketGas: bigint | undefined;
        if (usesTokenPocketExisting) {
          try {
            const fullData = concatHex([calldata, DATA_SUFFIX]);
            const estimated = await publicClient.estimateGas({
              account: address,
              to: sweepTarget,
              data: fullData,
              value: txValue,
            });
            tokenPocketGas = (estimated * 16n) / 10n; // 60% buffer
          } catch {
            // Fallback: generous static estimate scaled by route count
            tokenPocketGas = getTokenPocketSweepFallbackGas(quote.routes.length);
          }
        }

        if (usesTokenPocketExisting && tokenPocketGas !== undefined) {
          return sendTokenPocketRawTransaction({
            to: sweepTarget,
            data: calldata,
            value: txValue,
            gas: tokenPocketGas,
          });
        }

        return (await walletClient.sendTransaction({
          account: address,
          chain: base,
          to: sweepTarget,
          data: calldata,
          value: txValue,
          dataSuffix: DATA_SUFFIX,
          ...(tokenPocketGas !== undefined ? { gas: tokenPocketGas } : {}),
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

          console.warn("DustSweep approval batch failed; falling back to standard approvals.", {
            walletKey: walletProfile.walletKey,
            approvalCallCount: approvalCalls.length,
            code: getErrorCode(approvalBatchError),
            message: getDebugErrorMessage(approvalBatchError),
          });
          setExecutionNotice(
            `${walletProfile.walletName || "Wallet"} approval batch was not ready, sending approvals one by one before the sweep.`,
          );
          return sendStandardSweepWithApprovals();
        }

        const remainingApprovals = await getTokenApprovalRequirements(quote.routes, approvalSpender);
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

      const sendChunkedWalletBatches = async (notice?: string) => {
        if (notice) {
          setExecutionNotice(notice);
        }

        const sweepCalldata = await getCanonicalCalldata();
        const sweepCall: WalletSendCall = {
          to: sweepTarget,
          data: sweepCalldata,
          value: txValue,
          dataSuffix: DATA_SUFFIX,
        };
        const approvalChunks = chunkWalletCalls(approvalCalls, walletCallCap);

        currentStep = "approving";
        setSweepStep(currentStep);

        let hash: Hex | null = null;
        for (let index = 0; index < approvalChunks.length; index += 1) {
          const isLastChunk = index === approvalChunks.length - 1;
          const chunk = approvalChunks[index];
          const canIncludeSweep = isLastChunk && chunk.length + 1 <= walletCallCap;
          const calls = canIncludeSweep ? [...chunk, sweepCall] : chunk;

          if (canIncludeSweep) {
            currentStep = "pending";
            setSweepStep(currentStep);
          }

          try {
            hash = await sendAtomicWalletCalls({
              account: address,
              calls,
              usePaymasterCapabilities,
              walletKey: walletProfile.walletKey,
              requireAtomic: true,
              appendDataSuffixes: true,
            });
          } catch (chunkError) {
            if (isRejectedByUser(chunkError) || isWalletLockedError(chunkError)) {
              throw chunkError;
            }

            console.warn("DustSweep chunked wallet batch failed.", {
              walletKey: walletProfile.walletKey,
              chunkIndex: index,
              chunkCallCount: calls.length,
              walletCallCap,
              code: getErrorCode(chunkError),
              message: getDebugErrorMessage(chunkError),
            });
            throw new Error(WALLET_BATCH_UNSUPPORTED_MESSAGE);
          }

          if (!isLastChunk || !canIncludeSweep) {
            await waitForSuccessfulTransaction(hash);
          }

          if (canIncludeSweep) {
            return hash;
          }
        }

        currentStep = "pending";
        setSweepStep(currentStep);
        return sendSweepTransaction(sweepCalldata);
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
      if (canBundleAllCalls) {
        const sweepCalldata = await getCanonicalCalldata();
        const fullBundleCalls: WalletSendCall[] = [
          ...approvalCalls,
          {
            to: sweepTarget,
            data: sweepCalldata,
            value: txValue,
            dataSuffix: DATA_SUFFIX,
          },
        ];

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

          if (usesTokenPocketExisting) {
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
            if (!isBatchFallbackError(strictBundleError)) {
              throw new Error(WALLET_BATCH_UNSUPPORTED_MESSAGE);
            }

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
      } else if (canBundleApprovalsOnly) {
        hash = await sendBundledApprovalsThenSweep(
          shouldSplitBaseAccountBatch
            ? BASE_ACCOUNT_SPLIT_BATCH_NOTICE
            : shouldSplitTokenPocketBatch
            ? TOKENPOCKET_SPLIT_BATCH_NOTICE
            : `Approval+sweep needs ${bundledCallCount} wallet calls, so DustSweep will batch approvals first and then send the sweep.`,
        );
      } else if (shouldChunkWalletBatch) {
        hash = await sendChunkedWalletBatches(
          `${walletProfile.walletName || "Wallet"} supports ${walletCallCap} calls per batch. DustSweep will send approvals in wallet batches, then sweep.`,
        );
      } else if (canUseAtomicBatch) {
        setExecutionNotice(
          `Approval batching needs ${approvalCalls.length} wallet calls, above the ${walletCallCap} call cap. DustSweep will use Permit2 approvals and a standard sweep.`,
        );
        hash = await sendStandardSweepWithApprovals();
      } else {
        hash = await sendStandardSweepWithApprovals();
      }

      setTxHash(hash);
      await waitForSuccessfulTransaction(hash);

      const completedInputs: DustSweepCompletionSummary["inputs"] = [];
      for (const route of quote.routes) {
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

      setCompletionSummary({
        txHash: hash,
        tokenOut,
        tokenOutAmount: quote.netEstimatedOut || quote.totalEstimatedOut,
        tokenOutValueUSD: quote.netEstimatedOutUSD ?? quote.totalEstimatedOutUSD,
        inputValueUSD: completedInputs.reduce((sum, token) => sum + (token.valueUSD || 0), 0),
        feeAmountUSD: quote.feeAmountUSD,
        gasEstimateUSD: quote.gasEstimateUSD,
        routeCount: quote.routes.length,
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
          tokensSwapped: quote.routes.length,
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
      void refreshTokens();

      return { txHash: hash };
    } catch (sweepError) {
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
