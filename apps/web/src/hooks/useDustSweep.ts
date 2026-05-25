"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useConnection, usePublicClient, useWalletClient } from "wagmi";
import { base } from "viem/chains";
import { useBaseChainSwitch } from "@/hooks/useBaseChainSwitch";
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { useTokenBalances } from "@/hooks/useTokenBalances";
import { useWalletConnection } from "@/hooks/useWalletConnection";
import { useWalletWhitelist } from "@/hooks/useWalletWhitelist";
import { getPermit2SignatureErrorMessage } from "@/lib/permit2";
import {
  DUST_SWEEP_EXECUTION_LANE,
  DUST_SWEEP_ROUTER_ADDRESS,
  DUST_SWEEP_ROUTER_V2_ADDRESS,
  V1_MAX_BATCH_SIZE,
  V2_MAX_BATCH_SIZE,
  encodeDustSweepV2Calldata,
  parseDustSweepError,
} from "@/lib/dustsweep-router";
import { DATA_SUFFIX } from "@/lib/builderCode";
import { buildBasePaymasterCapabilities } from "@/lib/paymaster";
import { USDC_ADDRESS, WETH_ADDRESS } from "@/lib/tokens";
import {
  type DustSweepAtomicStatus,
  type DustSweepBuildTxResponse,
  type DustSweepWalletKey,
  type DustSweepWalletProfile,
  type DustSweepQuoteResponse,
  type SelectedToken,
  type SweepStep,
  type SwappableToken,
  type Token,
  type UnavailableReason,
  type UnavailableToken,
} from "@/types/dustsweep";

export const DEFAULT_OUTPUT_TOKENS: Token[] = [
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

type WalletRpcRequest = (args: { method: string; params?: unknown[] }) => Promise<unknown>;
type WalletRpcProvider = EthereumFlags & {
  request?: WalletRpcRequest;
  providers?: WalletRpcProvider[];
  selectedProvider?: WalletRpcProvider;
};

type WalletCallsStatusResult = {
  status?: string | number;
  statusCode?: number;
  atomic?: boolean;
  receipts?: Array<{ transactionHash?: unknown }>;
};

type WalletChainCapabilities = {
  atomic?: { status?: unknown; supported?: unknown };
  atomicBatch?: { supported?: unknown };
};

type DustSweepWalletProfileBase = Omit<DustSweepWalletProfile, "atomicStatus" | "batchNotice">;

export type UseDustSweepReturn = {
  swappableTokens: SwappableToken[];
  unavailableTokens: UnavailableToken[];
  selectedTokens: SelectedToken[];
  tokenOut: Token | null;
  quote: DustSweepQuoteResponse | null;
  slippageBps: number;
  isLoading: boolean;
  isQuoting: boolean;
  isSweeping: boolean;
  sweepStep: SweepStep;
  txHash: Hex | null;
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
};

const USDT_ADDRESS = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" as Address;
const ATOMIC_BATCH_UNSUPPORTED_MESSAGE =
  "This wallet cannot combine token approvals and the sweep into one Base transaction. Use a wallet/account with atomic batch support, or pre-approve the selected tokens with exact caps.";
const WALLET_BATCH_UNSUPPORTED_MESSAGE =
  "This wallet rejected approval+sweep batching. Use a wallet with EIP-5792/EIP-7702 batch support, or pre-approve the selected tokens with exact caps.";
const METAMASK_LOCKED_MESSAGE = "Unlock MetaMask and try again. No transaction was sent.";
const TOKENPOCKET_EXECUTE_FAILURES_TOPIC =
  "0xc42159347c71974b140767e5ffe0d24cb03d38c0e86462ec59a240394c3b9b4c";

type EthereumFlags = {
  isMetaMask?: boolean;
  isTokenPocket?: boolean;
};

function isSameAddress(a?: string | null, b?: string | null) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function normalizeWalletSignal(value?: string | null) {
  return value?.trim().toLowerCase().replace(/[\s-]+/g, "_") || "";
}

function getEthereumFlags(): EthereumFlags {
  if (typeof window === "undefined") return {};
  return ((window as Window & { ethereum?: WalletRpcProvider }).ethereum ?? {}) as EthereumFlags;
}

function includesWalletSignal(value: string, ...needles: string[]) {
  return needles.some((needle) => value.includes(needle));
}

function getDustSweepWalletProfileBase(args: {
  walletClientType?: string | null;
  connectorId?: string | null;
  connectorName?: string | null;
  walletName: string;
  isCoinbaseSmartWallet: boolean;
}): DustSweepWalletProfileBase {
  const walletClientType = normalizeWalletSignal(args.walletClientType);
  const connectorId = normalizeWalletSignal(args.connectorId);
  const connectorName = normalizeWalletSignal(args.connectorName);
  const walletNameSignal = normalizeWalletSignal(args.walletName);
  const combinedSignal = [walletClientType, connectorId, connectorName, walletNameSignal]
    .filter(Boolean)
    .join("_");
  const flags = getEthereumFlags();
  const signalTokenPocket = includesWalletSignal(combinedSignal, "tokenpocket", "token_pocket");
  const signalMetaMask = includesWalletSignal(combinedSignal, "metamask", "meta_mask");
  const signalCoinbase =
    args.isCoinbaseSmartWallet ||
    includesWalletSignal(combinedSignal, "coinbase", "base_account");
  const signalWalletConnect = includesWalletSignal(
    combinedSignal,
    "walletconnect",
    "wallet_connect",
  );
  const signalInjected = includesWalletSignal(
    combinedSignal,
    "injected",
    "detected_ethereum_wallets",
  );

  let walletKey: DustSweepWalletKey = "unknown";
  if (signalTokenPocket) {
    walletKey = "tokenpocket";
  } else if (signalCoinbase) {
    walletKey = "coinbase";
  } else if (signalWalletConnect) {
    walletKey = "walletconnect";
  } else if (signalMetaMask) {
    walletKey = "metamask";
  } else if (flags.isTokenPocket && (signalInjected || !combinedSignal)) {
    walletKey = "tokenpocket";
  } else if (flags.isMetaMask && (signalInjected || !combinedSignal)) {
    walletKey = "metamask";
  } else if (signalInjected) {
    walletKey = "injected";
  }

  const executionStrategy =
    walletKey === "metamask"
      ? "metamask_7702"
      : walletKey === "tokenpocket"
        ? "tokenpocket_existing"
        : walletKey === "coinbase"
          ? "coinbase_paymaster"
          : "generic_capability";

  return {
    walletKey,
    walletName: args.walletName || "Unknown wallet",
    executionStrategy,
  };
}

function getWalletBatchNotice(walletKey: DustSweepWalletKey, atomicStatus: DustSweepAtomicStatus) {
  if (walletKey === "metamask") {
    if (atomicStatus === "supported") {
      return "MetaMask supports batch transactions, but may ask for one-time account permission before preview.";
    }
    if (atomicStatus === "unsupported") {
      return "MetaMask batch is unavailable on this connection, so DustSweep will use standard approvals.";
    }
  }

  if (atomicStatus === "unsupported") {
    return "Wallet batch is unavailable on this connection, so DustSweep will use standard approvals.";
  }

  return null;
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
    lowered.includes("invalid params") ||
    lowered.includes("unauthorized") ||
    lowered.includes("upgrade rejected") ||
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

function getBatchFallbackNotice(walletName?: string | null, walletKey?: DustSweepWalletKey) {
  return walletKey === "metamask" || walletName?.toLowerCase().includes("metamask")
    ? "MetaMask batch was not ready, using standard approvals."
    : "Wallet batch was not ready, using standard approvals.";
}

function getBatchFallbackNoticeForError(args: {
  walletName?: string | null;
  walletKey?: DustSweepWalletKey;
  error: unknown;
  callCount?: number;
}) {
  const prefix =
    args.walletKey === "metamask" || args.walletName?.toLowerCase().includes("metamask")
      ? "MetaMask batch"
      : "Wallet batch";
  const code = getErrorCode(args.error);
  const lowered = getErrorMessage(args.error).toLowerCase();

  if (code === "5740" || lowered.includes("bundle too large") || lowered.includes("batch too large")) {
    return `${prefix} was too large${args.callCount ? ` (${args.callCount} calls)` : ""}, using standard approvals. Try fewer tokens for one-click batch.`;
  }

  if (code === "5750" || lowered.includes("upgrade rejected")) {
    return `${prefix} needs the MetaMask smart account upgrade, but the upgrade was rejected. Using standard approvals.`;
  }

  if (code === "5760" || lowered.includes("atomicity not supported")) {
    return `${prefix} is not atomic for this account/network right now, using standard approvals.`;
  }

  if (code === "4100" || lowered.includes("unauthorized")) {
    return `${prefix} was not authorized for this account, using standard approvals. Reconnect MetaMask and try again.`;
  }

  if (code === "5710" || lowered.includes("unsupported chain")) {
    return `${prefix} is not enabled for this network in MetaMask, using standard approvals.`;
  }

  if (code === "-32602" || lowered.includes("invalid params")) {
    return `${prefix} rejected the batch request format, using standard approvals.`;
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

function getLatestCallsStatusTxHash(result: WalletCallsStatusResult | null) {
  return [...(result?.receipts || [])]
    .reverse()
    .find((receipt) => isTxHash(receipt?.transactionHash))
    ?.transactionHash as Hex | undefined;
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

function getAtomicStatus(atomic: unknown): DustSweepAtomicStatus {
  if (!atomic || typeof atomic !== "object") {
    return "unknown";
  }

  const capability = atomic as { status?: unknown; supported?: unknown };
  const status = typeof capability.status === "string" ? capability.status.toLowerCase() : "";
  if (status === "ready" || status === "supported" || status === "unsupported") {
    return status;
  }

  if (capability.supported === true) {
    return "supported";
  }

  if (typeof capability.supported === "string") {
    const supported = capability.supported.toLowerCase();
    if (supported === "ready" || supported === "supported" || supported === "unsupported") {
      return supported;
    }
  }

  if (capability.supported === false) {
    return "unsupported";
  }

  return "unknown";
}

function getBatchCapabilityStatus(chainCapabilities: unknown): DustSweepAtomicStatus {
  if (!chainCapabilities || typeof chainCapabilities !== "object") {
    return "unknown";
  }

  const capability = chainCapabilities as WalletChainCapabilities;
  const atomicStatus = getAtomicStatus(capability.atomic);
  if (atomicStatus !== "unknown") {
    return atomicStatus;
  }

  if (capability.atomicBatch?.supported === true) {
    return "ready";
  }

  if (capability.atomicBatch?.supported === false) {
    return "unsupported";
  }

  return "unsupported";
}

function isBatchCapabilitySupported(chainCapabilities: unknown) {
  const status = getBatchCapabilityStatus(chainCapabilities);
  return status === "ready" || status === "supported";
}

function getChainCapabilities(capabilities: unknown, chainId: number) {
  if (!capabilities || typeof capabilities !== "object") {
    return undefined;
  }

  const byChain = capabilities as Record<string, WalletChainCapabilities | undefined>;
  const chainIdHex = `0x${chainId.toString(16)}`;
  const chainIdDecimal = String(chainId);

  return byChain[chainIdHex] || byChain[chainIdHex.toUpperCase()] || byChain[chainIdDecimal] || byChain["0x0"];
}

function toRpcQuantity(value?: bigint) {
  return `0x${(value || 0n).toString(16)}`;
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

function getWindowEthereumProviders(walletKey?: DustSweepWalletKey): WalletRpcProvider[] {
  if (typeof window === "undefined") {
    return [];
  }

  const ethereum = (window as Window & { ethereum?: WalletRpcProvider }).ethereum;
  if (!ethereum) {
    return [];
  }

  const providers = [
    ethereum.selectedProvider,
    ...(Array.isArray(ethereum.providers) ? ethereum.providers : []),
    ethereum,
  ].filter(Boolean) as WalletRpcProvider[];
  const uniqueProviders = providers.filter(
    (provider, index) => providers.findIndex((candidate) => candidate === provider) === index,
  );

  if (walletKey === "metamask") {
    return uniqueProviders.filter((provider) => provider.isMetaMask);
  }

  if (walletKey === "tokenpocket") {
    return uniqueProviders.filter((provider) => provider.isTokenPocket);
  }

  if (walletKey === "injected" || walletKey === "unknown") {
    return uniqueProviders;
  }

  return [];
}

function getWalletRequestCandidates(walletClient: unknown, walletKey?: DustSweepWalletKey): WalletRpcRequest[] {
  const candidates: WalletRpcRequest[] = [];
  const clientRequest = (walletClient as { request?: WalletRpcRequest } | null)?.request;
  if (typeof clientRequest === "function") {
    candidates.push((args) => clientRequest.call(walletClient, args));
  }

  for (const provider of getWindowEthereumProviders(walletKey)) {
    if (typeof provider.request === "function") {
      const request = provider.request;
      candidates.push((args) => request.call(provider, args));
    }
  }

  return candidates;
}

function getWalletRequest(walletClient: unknown, walletKey?: DustSweepWalletKey): WalletRpcRequest | null {
  return getWalletRequestCandidates(walletClient, walletKey)[0] ?? null;
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
  const [error, setError] = useState<string | null>(null);
  const [executionNotice, setExecutionNotice] = useState<string | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteFailedTokenAddresses, setQuoteFailedTokenAddresses] = useState<string[]>([]);
  const [supportsWalletSendCalls, setSupportsWalletSendCalls] = useState(false);
  const [atomicStatus, setAtomicStatus] = useState<DustSweepAtomicStatus>("unknown");

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
      batchNotice: getWalletBatchNotice(walletProfileBase.walletKey, atomicStatus),
    }),
    [atomicStatus, walletProfileBase],
  );

  const swappableTokens = balances.swappableTokens;
  const outputTokens = useMemo(() => {
    const byAddress = new Map<string, Token>();
    for (const token of DEFAULT_OUTPUT_TOKENS) {
      byAddress.set(token.address.toLowerCase(), token);
    }
    for (const token of [...balances.swappableTokens, ...balances.unavailableTokens]) {
      if (
        token.symbol === "USDC" ||
        token.symbol === "USDbC" ||
        token.symbol === "WETH"
      ) {
        byAddress.set(token.address.toLowerCase(), token);
      }
    }
    return Array.from(byAddress.values());
  }, [balances.swappableTokens, balances.unavailableTokens]);

  useEffect(() => {
    setUnavailableTokens([]);
    setQuoteFailedTokenAddresses([]);
    setExecutionNotice(null);
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
      return;
    }

    let cancelled = false;
    const chainIdHex = `0x${base.id.toString(16)}`;

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
          [address],
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

    void detectCapabilities();

    return () => {
      cancelled = true;
    };
  }, [address, walletClient, walletProfileBase.walletKey]);

  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    setExecutionNotice(null);
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
    setAutoMode(false);
    setSelectedTokens((current) => {
      if (current.some((item) => isSameAddress(item.address, token.address))) {
        return current;
      }
      return [...current, token].slice(0, configuredRouteCap);
    });
  }, [configuredRouteCap]);

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
    setError(null);
    setExecutionNotice(null);
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

  const sendTokenApprovals = useCallback(async (
    approvalRequirements: ApprovalRequirement[],
    spender: Address,
  ) => {
    if (!address || !walletClient || approvalRequirements.length === 0) return;

    const paymasterUrl = process.env.NEXT_PUBLIC_PAYMASTER_URL;
    for (const requirement of approvalRequirements) {
      const txBase = {
        account: address,
        chain: base,
        to: requirement.token,
        dataSuffix: DATA_SUFFIX,
        ...(walletStatus.isCoinbaseSmartWallet && paymasterUrl
          ? {
              capabilities: buildBasePaymasterCapabilities(),
            }
          : {}),
      };

      if (requirement.resetFirst) {
        const resetHash = (await walletClient.sendTransaction({
          ...txBase,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [spender, 0n],
          }),
        } as never)) as Hex;
        await waitForSuccessfulTransaction(resetHash);
      }

      const approvalHash = (await walletClient.sendTransaction({
        ...txBase,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [spender, requirement.approvalAmount],
        }),
      } as never)) as Hex;
      await waitForSuccessfulTransaction(approvalHash);
    }
  }, [
    address,
    waitForSuccessfulTransaction,
    walletClient,
    walletStatus.isCoinbaseSmartWallet,
  ]);

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
      });
    }

    return calls;
  }, []);

  const sendAtomicSweepCalls = useCallback(async (args: {
    approvalRequirements: ApprovalRequirement[];
    approvalSpender: Address;
    account: Address;
    to: Address;
    data: Hex;
    value: bigint;
    usePaymasterCapabilities: boolean;
    walletKey: DustSweepWalletKey;
    requireAtomic?: boolean;
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
    const calls = [
      ...buildApprovalCalls(args.approvalRequirements, args.approvalSpender),
      {
        to: args.to,
        data: args.data,
        value: args.value,
        dataSuffix: DATA_SUFFIX,
      },
    ];
    const callCount = calls.length;
    const capabilities = buildSendCallsCapabilities({
      usePaymasterCapabilities: args.usePaymasterCapabilities,
    });

    if (typeof client.sendCalls === "function" && typeof client.waitForCallsStatus === "function") {
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
          message: getErrorMessage(error),
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
        const hash = getLatestCallsStatusTxHash(status);

        if (!hash) {
          throw new Error("Bundled sweep finished without a transaction hash");
        }

        return hash;
      }
    }

    const requests = getWalletRequestCandidates(walletClient, args.walletKey);
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
          message: getErrorMessage(error),
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
        return hash;
      }

      if (getCallsStatusState(status) === "failure") {
        throw new Error("Bundled sweep failed");
      }

      await delay(1500);
    }

    throw new Error("Bundled sweep timed out before a transaction hash was available");
  }, [buildApprovalCalls, walletClient]);

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

    let currentStep: SweepStep = "approving";
    setIsSweeping(true);
    setSweepStep(currentStep);
    setError(null);
    setExecutionNotice(null);

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

      if (buildTx.requiresSignature || buildTx.signatureMode === "permit2_witness") {
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

        canonicalCalldata = encodeDustSweepV2Calldata(buildTx, signature);
      }

      currentStep = "pending";
      setSweepStep(currentStep);

      // Use the backend's canonical calldata — it encodes against the real compiled ABI.
      // The old encodeDustSweepPermit2Calldata used a phantom sweep() that doesn't exist on-chain.
      // Note: The current V1 contract doesn't accept Permit2 parameters inline —
      // the Permit2 signature is verified separately through the Permit2 contract.
      const paymasterUrl = process.env.NEXT_PUBLIC_PAYMASTER_URL;
      const txValue = buildTx.value ? BigInt(buildTx.value) : 0n;
      const sweepTarget = buildTx.routerAddress || buildTx.contractAddress;
      const hasV2Approvals = lane === "owned_v2" && approvalRequirements.length > 0;
      const bundledCallCount =
        hasV2Approvals ? buildApprovalCalls(approvalRequirements, approvalSpender).length + 1 : 1;
      const usesMetaMask7702 = walletProfile.executionStrategy === "metamask_7702";
      const usesTokenPocketExisting = walletProfile.executionStrategy === "tokenpocket_existing";
      const shouldTryBundledV2 =
        batchMode &&
        hasV2Approvals &&
        (supportsWalletSendCalls || usesMetaMask7702 || usesTokenPocketExisting);

      const sendSweepTransaction = async () =>
        (await walletClient.sendTransaction({
          account: address,
          chain: base,
          to: sweepTarget,
          data: canonicalCalldata,
          value: txValue,
          dataSuffix: DATA_SUFFIX,
          ...(walletStatus.isCoinbaseSmartWallet && paymasterUrl
            ? {
                capabilities: buildBasePaymasterCapabilities(),
              }
            : {}),
        } as never)) as Hex;

      const sendStandardSweepWithApprovals = async () => {
        if (hasV2Approvals) {
          currentStep = "approving";
          setSweepStep(currentStep);
          await sendTokenApprovals(approvalRequirements, approvalSpender);
          currentStep = "pending";
          setSweepStep(currentStep);
        }
        return sendSweepTransaction();
      };

      if (
        batchMode &&
        hasV2Approvals &&
        !supportsWalletSendCalls &&
        !usesMetaMask7702 &&
        !usesTokenPocketExisting
      ) {
        setExecutionNotice(getBatchFallbackNotice(walletProfile.walletName, walletProfile.walletKey));
      }

      let hash: Hex;
      if (shouldTryBundledV2) {
        try {
          hash = await sendAtomicSweepCalls({
            approvalRequirements,
            approvalSpender,
            account: address,
            to: sweepTarget,
            data: canonicalCalldata,
            value: txValue,
            usePaymasterCapabilities: walletStatus.isCoinbaseSmartWallet && Boolean(paymasterUrl),
            walletKey: walletProfile.walletKey,
            requireAtomic: true,
          });
        } catch (strictBundleError) {
          if (isRejectedByUser(strictBundleError) || isWalletLockedError(strictBundleError)) {
            throw strictBundleError;
          }

          console.warn("Atomic DustSweep sendCalls failed; retrying wallet-compatible batch mode.", strictBundleError);

          try {
            hash = await sendAtomicSweepCalls({
              approvalRequirements,
              approvalSpender,
              account: address,
              to: sweepTarget,
              data: canonicalCalldata,
              value: txValue,
              usePaymasterCapabilities: walletStatus.isCoinbaseSmartWallet && Boolean(paymasterUrl),
              walletKey: walletProfile.walletKey,
              requireAtomic: false,
            });
          } catch (compatibleBundleError) {
            if (isRejectedByUser(compatibleBundleError) || isWalletLockedError(compatibleBundleError)) {
              throw compatibleBundleError;
            }

            console.warn("Compatible DustSweep wallet_sendCalls failed.", compatibleBundleError);
            if (isBatchFallbackError(strictBundleError) || isBatchFallbackError(compatibleBundleError)) {
              setExecutionNotice(
                getBatchFallbackNoticeForError({
                  walletName: walletProfile.walletName,
                  walletKey: walletProfile.walletKey,
                  error: compatibleBundleError,
                  callCount: bundledCallCount,
                }),
              );
              hash = await sendStandardSweepWithApprovals();
            } else {
              throw new Error(WALLET_BATCH_UNSUPPORTED_MESSAGE);
            }
          }
        }
      } else {
        hash = await sendStandardSweepWithApprovals();
      }

      setTxHash(hash);
      await waitForSuccessfulTransaction(hash);

      setSweepStep("success");
      await fetch("/api/dustsweep/record-sweep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: hash,
          userAddress: address,
          tokensSwapped: quote.routes.length,
          valueUSD: quote.totalEstimatedOutUSD,
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
          : sweepError instanceof Error
            ? parseDustSweepError(sweepError)
            : "Transaction failed";
      setError(message);
      setSweepStep("error");
      return null;
    } finally {
      setIsSweeping(false);
    }
  }, [
    address,
    batchMode,
    getTokenApprovalRequirements,
    publicClient,
    quote,
    refreshQuote,
    refreshTokens,
    buildApprovalCalls,
    sendAtomicSweepCalls,
    sendTokenApprovals,
    selectedTokens.length,
    supportsWalletSendCalls,
    switchToBase,
    tokenOut,
    waitForSuccessfulTransaction,
    walletClient,
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
    isQuoting,
    isSweeping,
    sweepStep,
    txHash,
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
  };
}
