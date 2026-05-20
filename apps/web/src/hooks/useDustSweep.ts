"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { base } from "viem/chains";
import { useBaseChainSwitch } from "@/hooks/useBaseChainSwitch";
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { useTokenBalances } from "@/hooks/useTokenBalances";
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
  type DustSweepBuildTxResponse,
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
  quoteError: string | null;
  autoMode: boolean;
  routeMaxCap: number;
  supportsWalletSendCalls: boolean;
  outputTokens: Token[];
  walletStatus: ReturnType<typeof useWalletWhitelist>;
  setTokenOut: (token: Token | null) => void;
  setSlippageBps: (value: number) => void;
  setAutoMode: (value: boolean) => void;
  setSelectedTokens: (tokens: SelectedToken[]) => void;
  addToken: (token: SelectedToken) => void;
  selectAllTokens: () => void;
  removeToken: (address: string) => void;
  clearSelectedTokens: () => void;
  clearUnavailableTokens: () => void;
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

function isSameAddress(a?: string | null, b?: string | null) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
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
  return (
    lowered.includes("user rejected") ||
    lowered.includes("rejected") ||
    lowered.includes("denied") ||
    lowered.includes("cancel")
  );
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

function isAtomicCapabilitySupported(atomic: unknown) {
  if (!atomic || typeof atomic !== "object") {
    return false;
  }

  const capability = atomic as { status?: unknown; supported?: unknown };
  return (
    capability.status === "supported" ||
    capability.status === "ready" ||
    capability.supported === true ||
    capability.supported === "supported" ||
    capability.supported === "ready"
  );
}

function isBatchCapabilitySupported(chainCapabilities: unknown) {
  if (!chainCapabilities || typeof chainCapabilities !== "object") {
    return false;
  }

  const capability = chainCapabilities as WalletChainCapabilities;
  return capability.atomicBatch?.supported === true || isAtomicCapabilitySupported(capability.atomic);
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

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getWalletRequest(walletClient: unknown): WalletRpcRequest | null {
  const clientRequest = (walletClient as { request?: WalletRpcRequest } | null)?.request;
  if (typeof clientRequest === "function") {
    return (args) => clientRequest.call(walletClient, args);
  }

  if (typeof window === "undefined") {
    return null;
  }

  const ethereum = (window as Window & {
    ethereum?: { request?: WalletRpcRequest };
  }).ethereum;
  if (typeof ethereum?.request === "function") {
    return (args) => ethereum.request!.call(ethereum, args);
  }

  return null;
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
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: base.id });
  const { switchToBase } = useBaseChainSwitch();
  const walletStatus = useWalletWhitelist();
  const balances = useTokenBalances(address);
  const refetchBalances = balances.refetch;

  const [unavailableTokens, setUnavailableTokens] = useState<UnavailableToken[]>([]);
  const [selectedTokens, setSelectedTokens] = useState<SelectedToken[]>([]);
  const [tokenOut, setTokenOut] = useState<Token | null>(DEFAULT_OUTPUT_TOKENS[0]);
  const [quote, setQuote] = useState<DustSweepQuoteResponse | null>(null);
  const [slippageBps, setSlippageBps] = useState(50);
  const [autoMode, setAutoMode] = useState(false);
  const [isQuoting, setIsQuoting] = useState(false);
  const [isSweeping, setIsSweeping] = useState(false);
  const [sweepStep, setSweepStep] = useState<SweepStep>("idle");
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [supportsWalletSendCalls, setSupportsWalletSendCalls] = useState(false);

  const configuredRouteCap = getCapForLane(DUST_SWEEP_EXECUTION_LANE);
  const routeMaxCap = quote?.routeMaxCap ?? configuredRouteCap;

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
        token.symbol === "WETH" ||
        token.symbol === "ETH"
      ) {
        byAddress.set(token.address.toLowerCase(), token);
      }
    }
    return Array.from(byAddress.values());
  }, [balances.swappableTokens, balances.unavailableTokens]);

  useEffect(() => {
    setUnavailableTokens(balances.unavailableTokens);
  }, [balances.unavailableTokens]);

  useEffect(() => {
    if (!isConnected || !address) {
      setSelectedTokens([]);
      setQuote(null);
      setTxHash(null);
      setSweepStep("idle");
    }
  }, [address, isConnected]);

  useEffect(() => {
    if (!autoMode) return;
    setSelectedTokens(swappableTokens.slice(0, configuredRouteCap));
  }, [autoMode, configuredRouteCap, swappableTokens]);

  useEffect(() => {
    if (!address || !walletClient) {
      setSupportsWalletSendCalls(false);
      return;
    }

    let cancelled = false;
    const chainIdHex = `0x${base.id.toString(16)}`;

    async function detectCapabilities() {
      try {
        const request = (walletClient as unknown as {
          request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
        }).request;
        if (!request) {
          if (!cancelled) setSupportsWalletSendCalls(false);
          return;
        }

        const capabilityParamSets: unknown[][] = [
          [address, [chainIdHex]],
          [address],
        ];
        let supported = false;

        for (const params of capabilityParamSets) {
          try {
            const result = await request({
              method: "wallet_getCapabilities",
              params,
            });
            supported = isBatchCapabilitySupported(getChainCapabilities(result, base.id));
            if (supported) break;
          } catch {
            // Some wallets only accept the older one-argument form. Try the next shape.
          }
        }

        if (!cancelled) setSupportsWalletSendCalls(supported);
      } catch {
        if (!cancelled) setSupportsWalletSendCalls(false);
      }
    }

    void detectCapabilities();

    return () => {
      cancelled = true;
    };
  }, [address, walletClient]);

  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
  }, [selectedTokens, tokenOut, slippageBps]);

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
          setUnavailableTokens((current) => mergeUnavailableTokens(current, failedTokens));
          setSelectedTokens((current) =>
            current.filter((token) => !skippedByAddress.has(token.address.toLowerCase())),
          );
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
        setUnavailableTokens((current) => mergeUnavailableTokens(current, failedTokens));
        setSelectedTokens((current) =>
          current.filter((token) => routedAddresses.has(token.address.toLowerCase())),
        );
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
  }, [address, selectedTokens, slippageBps, tokenOut]);

  // Quote ONLY fires on explicit user action (previewSweep), not on token selection

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
  }, []);

  const clearSelectedTokens = useCallback(() => {
    setAutoMode(false);
    setSelectedTokens([]);
  }, []);

  const clearUnavailableTokens = useCallback(() => {
    setUnavailableTokens([]);
  }, []);

  const resetSweepState = useCallback(() => {
    setSweepStep("idle");
    setTxHash(null);
    setError(null);
  }, []);

  const waitForSuccessfulTransaction = useCallback(async (hash: Hex) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error("Transaction reverted");
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
          dataSuffix: DATA_SUFFIX,
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
    const capabilities = args.usePaymasterCapabilities ? buildBasePaymasterCapabilities() : undefined;

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

    const request = getWalletRequest(walletClient);
    if (!request) {
      throw new Error("wallet_sendCalls is unavailable");
    }

    const sendCallsResult = await request({
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
      const status = (await request({
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
      const shouldTryBundledV2 = lane === "owned_v2" && approvalRequirements.length > 0;

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
            requireAtomic: true,
          });
        } catch (strictBundleError) {
          if (isRejectedByUser(strictBundleError)) {
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
              requireAtomic: false,
            });
          } catch (compatibleBundleError) {
            if (isRejectedByUser(compatibleBundleError)) {
              throw compatibleBundleError;
            }

            console.warn("Compatible DustSweep wallet_sendCalls failed.", compatibleBundleError);
            throw new Error(WALLET_BATCH_UNSUPPORTED_MESSAGE);
          }
        }
      } else {
        hash = await sendSweepTransaction();
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
      void refreshTokens();

      return { txHash: hash };
    } catch (sweepError) {
      const message =
        isRejectedByUser(sweepError)
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
    getTokenApprovalRequirements,
    publicClient,
    quote,
    refreshQuote,
    refreshTokens,
    sendAtomicSweepCalls,
    sendTokenApprovals,
    selectedTokens.length,
    supportsWalletSendCalls,
    switchToBase,
    tokenOut,
    waitForSuccessfulTransaction,
    walletClient,
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
    quoteError,
    autoMode,
    routeMaxCap,
    supportsWalletSendCalls,
    outputTokens,
    walletStatus,
    setTokenOut,
    setSlippageBps,
    setAutoMode,
    setSelectedTokens,
    addToken,
    selectAllTokens,
    removeToken,
    clearSelectedTokens,
    clearUnavailableTokens,
    refreshTokens,
    refreshQuote,
    previewSweep: refreshQuote,
    executeSweep,
    resetSweepState,
  };
}
