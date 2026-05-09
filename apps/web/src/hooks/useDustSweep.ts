"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { base } from "viem/chains";
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { useTokenBalances } from "@/hooks/useTokenBalances";
import { useWalletWhitelist } from "@/hooks/useWalletWhitelist";
import { PERMIT2_ADDRESS, buildPermit2TypedData, getPermit2SignatureErrorMessage } from "@/lib/permit2";
import { encodeDustSweepPermit2Calldata, parseDustSweepError } from "@/lib/dustsweep-router";
import { DATA_SUFFIX, appendBuilderCodeToData } from "@/lib/builderCode";
import { buildBasePaymasterCapabilities } from "@/lib/paymaster";
import { USDC_ADDRESS, WETH_ADDRESS } from "@/lib/tokens";
import {
  type DustSweepBuildTxResponse,
  type DustSweepQuoteResponse,
  type SelectedToken,
  type SweepStep,
  type SwappableToken,
  type Token,
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
  executeSweep: () => Promise<ExecuteSweepResult | null>;
  resetSweepState: () => void;
};

const APPROVAL_BUFFER_BPS = 100n;
const BPS_DENOMINATOR = 10_000n;
const USDT_ADDRESS = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" as Address;

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

function bufferedApprovalAmount(amount: bigint) {
  const extra = (amount * APPROVAL_BUFFER_BPS + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
  return amount + extra;
}

function requiresApprovalReset(token: Address) {
  return token.toLowerCase() === USDT_ADDRESS.toLowerCase();
}

function isTxHash(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
}

function toHexChainId(chainId: number) {
  return `0x${chainId.toString(16)}`;
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

  return null;
}

function capabilitySupported(value: unknown) {
  if (value === true) return true;
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    return normalized === "supported" || normalized === "ready";
  }
  if (value && typeof value === "object" && "supported" in value) {
    return capabilitySupported((value as { supported?: unknown }).supported);
  }
  if (value && typeof value === "object" && "status" in value) {
    return capabilitySupported((value as { status?: unknown }).status);
  }
  return false;
}

function getAtomicCapability(chainCapabilities: Record<string, unknown> | null | undefined) {
  return chainCapabilities?.atomic ?? chainCapabilities?.atomicBatch ?? null;
}

function getBrowserWalletRequester() {
  if (typeof window === "undefined") return null;
  const ethereum = (window as Window & {
    ethereum?: {
      request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      providers?: Array<{ request?: (args: { method: string; params?: unknown[] }) => Promise<unknown> }>;
    };
  }).ethereum;

  if (ethereum?.request) {
    return ethereum.request.bind(ethereum);
  }

  const provider = ethereum?.providers?.find(
    (item: { request?: (args: { method: string; params?: unknown[] }) => Promise<unknown> }) =>
      typeof item.request === "function",
  );
  return provider?.request ? provider.request.bind(provider) : null;
}

function isFinishedCallStatus(status: unknown) {
  if (typeof status === "number") return status >= 200 && status < 300;
  const normalized = String(status || "").toLowerCase();
  return normalized === "success" || normalized === "confirmed" || normalized === "complete";
}

function isFailedCallStatus(status: unknown) {
  if (typeof status === "number") return status >= 400;
  const normalized = String(status || "").toLowerCase();
  return normalized === "failed" || normalized === "reverted" || normalized === "error";
}

function getReceiptHashFromCallStatus(status: unknown): Hex | null {
  if (!status || typeof status !== "object") return null;
  const receipts = (status as { receipts?: Array<{ transactionHash?: unknown }> }).receipts;
  const hash = receipts?.find((receipt) => isTxHash(receipt?.transactionHash))?.transactionHash;
  return isTxHash(hash) ? hash : null;
}

export function useDustSweep(): UseDustSweepReturn {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const walletStatus = useWalletWhitelist();
  const balances = useTokenBalances(address);
  const refetchBalances = balances.refetch;

  const [unavailableTokens, setUnavailableTokens] = useState<UnavailableToken[]>([]);
  const [selectedTokens, setSelectedTokens] = useState<SelectedToken[]>([]);
  const [tokenOut, setTokenOut] = useState<Token | null>(DEFAULT_OUTPUT_TOKENS[0]);
  const [quote, setQuote] = useState<DustSweepQuoteResponse | null>(null);
  const [slippageBps, setSlippageBps] = useState(50);
  const [autoMode, setAutoMode] = useState(true);
  const [isQuoting, setIsQuoting] = useState(false);
  const [isSweeping, setIsSweeping] = useState(false);
  const [sweepStep, setSweepStep] = useState<SweepStep>("idle");
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);

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
    setSelectedTokens(swappableTokens.slice(0, 50));
  }, [autoMode, swappableTokens]);

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
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error?: unknown }).error)
            : "Couldn't get quote";
        throw new Error(message);
      }

      setQuote(normalizeQuotePayload(payload));
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

  useEffect(() => {
    if (!address || !tokenOut || selectedTokens.length === 0) return;
    const timeoutId = window.setTimeout(() => {
      void refreshQuote();
    }, 500);

    return () => window.clearTimeout(timeoutId);
  }, [address, refreshQuote, selectedTokens.length, slippageBps, tokenOut]);

  const addToken = useCallback((token: SelectedToken) => {
    setAutoMode(false);
    setSelectedTokens((current) => {
      if (current.some((item) => isSameAddress(item.address, token.address))) {
        return current;
      }
      return [...current, token].slice(0, 50);
    });
  }, []);

  const selectAllTokens = useCallback(() => {
    setAutoMode(false);
    setSelectedTokens(swappableTokens.slice(0, 50));
  }, [swappableTokens]);

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

  const sendApprovalBatch = useCallback(async (requirements: ApprovalRequirement[]) => {
    const walletWithCalls = walletClient as typeof walletClient & {
      account?: { address?: Address };
      request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      sendCalls?: (args: unknown) => Promise<unknown>;
      waitForCallsStatus?: (args: unknown) => Promise<{
        receipts?: Array<{ transactionHash?: unknown }>;
      }>;
    };

    if (!walletWithCalls?.sendCalls || !walletWithCalls.waitForCallsStatus) {
      // Some injected wallets expose EIP-5792 only through raw request().
      // Keep going so Rabby/TokenPocket-style batching gets a chance.
    }

    const calls = requirements.flatMap((requirement) => {
      const approvalCall = {
        to: requirement.token,
        value: 0n,
        dataSuffix: DATA_SUFFIX,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [PERMIT2_ADDRESS, requirement.approvalAmount],
        }),
      };

      if (!requirement.resetFirst) {
        return [approvalCall];
      }

      return [
        {
          to: requirement.token,
          value: 0n,
          dataSuffix: DATA_SUFFIX,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [PERMIT2_ADDRESS, 0n],
          }),
        },
        approvalCall,
      ];
    });

    if (calls.length <= 1) {
      return false;
    }

    const requester = walletWithCalls.request as
      | ((args: { method: string; params?: unknown[] }) => Promise<unknown>)
      | undefined;
    const transportRequester = (walletClient as unknown as {
      transport?: {
        request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      };
    })?.transport?.request;
    const rawRequester = requester || transportRequester || getBrowserWalletRequester();
    const accountAddress = walletWithCalls.account?.address || address;

    try {
      const capabilitiesResult =
        rawRequester && accountAddress
          ? ((await rawRequester({
              method: "wallet_getCapabilities",
              params: [accountAddress],
            })) as Record<string, Record<string, unknown>> | null)
          : null;
      const chainCapabilities = capabilitiesResult
        ? Object.entries(capabilitiesResult).find(
            ([candidate]) => candidate.toLowerCase() === toHexChainId(base.id).toLowerCase(),
          )?.[1]
        : null;
      const atomicRequired =
        walletStatus.isCoinbaseSmartWallet || capabilitySupported(getAtomicCapability(chainCapabilities));

      if (!walletWithCalls.sendCalls || !walletWithCalls.waitForCallsStatus) {
        throw new Error("viem sendCalls unavailable");
      }

      const sendCallsResult = await walletWithCalls.sendCalls({
        calls,
        chain: base,
        account: address,
        atomicRequired,
        ...(walletStatus.isCoinbaseSmartWallet && process.env.NEXT_PUBLIC_PAYMASTER_URL
          ? { capabilities: buildBasePaymasterCapabilities() }
          : {}),
      });
      const callId = resolveSendCallsId(sendCallsResult);
      if (!callId) {
        throw new Error("wallet_sendCalls did not return an id");
      }

      const status = await walletWithCalls.waitForCallsStatus({
        id: callId,
        throwOnFailure: true,
        timeout: 180_000,
      });
      const receiptHash = status.receipts?.find((receipt) => isTxHash(receipt?.transactionHash))
        ?.transactionHash;

      if (receiptHash) {
        await waitForSuccessfulTransaction(receiptHash);
      }

      return true;
    } catch (batchError) {
      if (isRejectedByUser(batchError)) {
        throw batchError;
      }

      console.warn("DustSweep approval batch failed, falling back to single approval transactions.", batchError);
    }

    if (!rawRequester || !accountAddress) {
      return false;
    }

    try {
      const capabilitiesResult = (await rawRequester({
        method: "wallet_getCapabilities",
        params: [accountAddress],
      }).catch(() => null)) as Record<string, Record<string, unknown>> | null;
      const chainCapabilities = capabilitiesResult
        ? Object.entries(capabilitiesResult).find(
            ([candidate]) => candidate.toLowerCase() === toHexChainId(base.id).toLowerCase(),
          )?.[1]
        : null;
      const atomicRequired =
        walletStatus.isCoinbaseSmartWallet || capabilitySupported(getAtomicCapability(chainCapabilities));
      const rawCalls = calls.map((call) => ({
        to: call.to,
        value: "0x0",
        data: appendBuilderCodeToData(call.data),
      }));
      const sendCallsResult = await rawRequester({
        method: "wallet_sendCalls",
        params: [
          {
            version: "2.0.0",
            chainId: toHexChainId(base.id),
            from: accountAddress,
            atomicRequired,
            calls: rawCalls,
            ...(walletStatus.isCoinbaseSmartWallet && process.env.NEXT_PUBLIC_PAYMASTER_URL
              ? {
                  capabilities: {
                    paymasterService: {
                      url: process.env.NEXT_PUBLIC_PAYMASTER_URL,
                      optional: true,
                    },
                  },
                }
              : {}),
          },
        ],
      });
      const callId = resolveSendCallsId(sendCallsResult);
      if (!callId) {
        throw new Error("wallet_sendCalls did not return an id");
      }

      for (let attempt = 0; attempt < 90; attempt += 1) {
        const status = await rawRequester({
          method: "wallet_getCallsStatus",
          params: [callId],
        });
        const receiptHash = getReceiptHashFromCallStatus(status);
        if (receiptHash) {
          await waitForSuccessfulTransaction(receiptHash);
          return true;
        }
        const statusValue = (status as { status?: unknown } | null)?.status;
        if (isFinishedCallStatus(statusValue)) {
          return true;
        }
        if (isFailedCallStatus(statusValue)) {
          throw new Error("Approval batch failed");
        }
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
      }

      throw new Error("Approval batch timed out");
    } catch (rawBatchError) {
      if (isRejectedByUser(rawBatchError)) {
        throw rawBatchError;
      }

      console.warn("DustSweep raw approval batch failed, falling back to single approval transactions.", rawBatchError);
      return false;
    }
  }, [address, waitForSuccessfulTransaction, walletClient, walletStatus.isCoinbaseSmartWallet]);

  const ensurePermit2Approvals = useCallback(async (routes: DustSweepQuoteResponse["routes"]) => {
    if (!address || !walletClient) return;

    const approvalRequirements: ApprovalRequirement[] = [];
    for (const requirement of uniqueApprovalRequirements(routes)) {
      const allowance = (await publicClient.readContract({
        address: requirement.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, PERMIT2_ADDRESS],
      })) as bigint;

      if (allowance >= requirement.amount) {
        continue;
      }

      approvalRequirements.push({
        ...requirement,
        allowance,
        approvalAmount: bufferedApprovalAmount(requirement.amount),
        resetFirst: allowance > 0n && requiresApprovalReset(requirement.token),
      });
    }

    if (approvalRequirements.length === 0) return;

    const batched = await sendApprovalBatch(approvalRequirements);
    if (batched) return;

    if (approvalRequirements.length > 1) {
      throw new Error(
        "Batch approval is unavailable from this wallet session. Reconnect Rabby/TokenPocket and try again, or select one token.",
      );
    }

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
            args: [PERMIT2_ADDRESS, 0n],
          }),
        } as never)) as Hex;
        await waitForSuccessfulTransaction(resetHash);
      }

      const approvalHash = (await walletClient.sendTransaction({
        ...txBase,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [PERMIT2_ADDRESS, requirement.approvalAmount],
        }),
      } as never)) as Hex;
      await waitForSuccessfulTransaction(approvalHash);
    }
  }, [
    address,
    publicClient,
    sendApprovalBatch,
    waitForSuccessfulTransaction,
    walletClient,
    walletStatus.isCoinbaseSmartWallet,
  ]);

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
      await ensurePermit2Approvals(quote.routes);

      currentStep = "signing";
      setSweepStep(currentStep);

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
      const permit2 = buildTx.permit2 ?? buildPermit2TypedData({
        routes: quote.routes,
        spender: buildTx.contractAddress,
        nonce: quote.permit2Nonce,
        deadline: quote.deadline,
      });

      let signature: Hex;
      try {
        signature = (await walletClient.signTypedData({
          account: address,
          domain: permit2.domain,
          types: permit2.types,
          primaryType: "PermitBatchTransferFrom",
          message: permit2.message,
        } as never)) as Hex;
      } catch (signatureError) {
        throw new Error(getPermit2SignatureErrorMessage(signatureError));
      }

      currentStep = "pending";
      setSweepStep(currentStep);
      const fullCalldata = encodeDustSweepPermit2Calldata({
        routes: quote.routes,
        tokenOut: tokenOut.address,
        receiver: address,
        deadline: quote.deadline,
        permit2Nonce: quote.permit2Nonce,
        signature,
      });
      const paymasterUrl = process.env.NEXT_PUBLIC_PAYMASTER_URL;

      const hash = (await walletClient.sendTransaction({
        account: address,
        chain: base,
        to: buildTx.contractAddress,
        data: fullCalldata,
        dataSuffix: DATA_SUFFIX,
        ...(walletStatus.isCoinbaseSmartWallet && paymasterUrl
          ? {
              capabilities: buildBasePaymasterCapabilities(),
            }
          : {}),
      } as never)) as Hex;

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
    ensurePermit2Approvals,
    publicClient,
    quote,
    refreshQuote,
    refreshTokens,
    selectedTokens.length,
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
    executeSweep,
    resetSweepState,
  };
}
