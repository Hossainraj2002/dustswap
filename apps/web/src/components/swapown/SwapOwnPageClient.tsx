"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  erc20Abi,
  formatUnits,
  maxUint256,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { useAccount, useChainId, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { WalletConnectButton } from "@/components/wallet/WalletConnectButton";
import { emitDataInvalidation } from "@/lib/clientEvents";
import { buildPublicApiUrl, publicApiFetch } from "@/lib/apiBase";
import {
  SWAPOWN_CHAINS,
  explorerTxUrl,
  getSwapOwnChain,
  getSwapOwnToken,
  shortHash,
  type SwapOwnToken,
} from "@/lib/swapown";

type SwapMode = "single" | "basket";

type InputRow = {
  id: string;
  token: SwapOwnToken;
  amount: string;
};

type OutputRow = {
  id: string;
  token: SwapOwnToken;
  shareBps: number;
};

type QuoteRoute = {
  sourceId: string;
  sourceName: string;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: string;
  quotedAmountOut: string;
  amountOutMin: string;
  target: Address;
  spender: Address;
  value: string;
  data: Hex;
};

type QuoteResponse = {
  success: boolean;
  error?: string;
  quoteId: string;
  aggregatorName: string;
  logoURI: string;
  source: string;
  chainId: number;
  chainLabel: string;
  routerAddress: Address;
  feeBps: number;
  slippageBps: number;
  deadline: number;
  expiresAt: string;
  productionReady: boolean;
  sourceReadiness?: {
    activeSourceCount: number;
    minActiveSources: number;
    productionReady: boolean;
  };
  outputSummaries: Array<{
    token: Address;
    grossAmountOut: string;
    minAmountOut: string;
    feeAmount: string;
    netAmountOut: string;
  }>;
  routes: QuoteRoute[];
};

type BuildTxResponse = {
  success: boolean;
  error?: string;
  routerAddress: Address;
  to: Address;
  value: string;
  calldata: Hex;
  functionName: "swap" | "swapBasket";
  approvalRequirements: Array<{
    token: Address;
    spender: Address;
    amount: string;
  }>;
  outputSummaries: QuoteResponse["outputSummaries"];
};

type SourceStatus = {
  chainId: number;
  chainKey: string;
  minActiveSources: number;
  activeSourceCount: number;
  productionReady: boolean;
  routerAddress?: Address;
};

type HistoryRow = {
  id?: number;
  tx_hash: string;
  chain_id: number;
  src_token_symbol?: string | null;
  dst_token_symbol?: string | null;
  amount_usd?: string | number | null;
  occurred_at?: string | null;
  metadata?: Record<string, unknown> | null;
};

type PendingHistoryRow = {
  txHash: string;
  chainId: number;
  createdAt: number;
  status: "pending" | "recording" | "confirmed" | "failed";
};

const PENDING_HISTORY_KEY = "dustswap.swapown.pending";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function newId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatTokenAmount(raw: string, token?: SwapOwnToken) {
  if (!token) return raw;
  try {
    const formatted = formatUnits(BigInt(raw || "0"), token.decimals);
    const number = Number(formatted);
    if (!Number.isFinite(number)) return formatted;
    return number.toLocaleString(undefined, {
      maximumFractionDigits: token.decimals === 6 ? 6 : 8,
    });
  } catch {
    return "0";
  }
}

function readPendingRows(): PendingHistoryRow[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PENDING_HISTORY_KEY);
    return raw ? (JSON.parse(raw) as PendingHistoryRow[]) : [];
  } catch {
    return [];
  }
}

function writePendingRows(rows: PendingHistoryRow[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PENDING_HISTORY_KEY, JSON.stringify(rows.slice(0, 20)));
  } catch {
    // Local history is best-effort.
  }
}

function TokenPill({ token }: { token: SwapOwnToken }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {token.logoURI ? (
        <Image src={token.logoURI} alt="" width={20} height={20} className="rounded-full" />
      ) : (
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-200 text-[10px] font-bold text-slate-600">
          {token.symbol.slice(0, 1)}
        </span>
      )}
      <span className="truncate">{token.symbol}</span>
    </span>
  );
}

function TokenSelect({
  value,
  tokens,
  onChange,
  label,
}: {
  value: SwapOwnToken;
  tokens: SwapOwnToken[];
  onChange: (token: SwapOwnToken) => void;
  label: string;
}) {
  return (
    <label className="flex min-w-[132px] flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase text-slate-400">{label}</span>
      <select
        value={value.address}
        onChange={(event) => {
          const next = tokens.find((token) => token.address === event.target.value);
          if (next) onChange(next);
        }}
        className="h-10 rounded-[8px] border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-900 shadow-sm outline-none transition focus:border-blue-400"
      >
        {tokens.map((token) => (
          <option key={token.address} value={token.address}>
            {token.symbol}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function SwapOwnPageClient() {
  const { address, isConnected } = useAccount();
  const currentChainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const [chainId, setChainId] = useState(SWAPOWN_CHAINS[0].id);
  const selectedChain = getSwapOwnChain(chainId);
  const publicClient = usePublicClient({ chainId });
  const [mode, setMode] = useState<SwapMode>("single");
  const [slippageBps, setSlippageBps] = useState(50);
  const [inputs, setInputs] = useState<InputRow[]>([
    { id: newId(), token: selectedChain.tokens[0], amount: "" },
  ]);
  const [outputs, setOutputs] = useState<OutputRow[]>([
    { id: newId(), token: selectedChain.tokens[1] || selectedChain.tokens[0], shareBps: 10_000 },
  ]);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [isQuoting, setIsQuoting] = useState(false);
  const [isSwapping, setIsSwapping] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [pendingRows, setPendingRows] = useState<PendingHistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [sourceStatus, setSourceStatus] = useState<SourceStatus | null>(null);

  useEffect(() => {
    const chain = getSwapOwnChain(chainId);
    setInputs([{ id: newId(), token: chain.tokens[0], amount: "" }]);
    setOutputs([{ id: newId(), token: chain.tokens[1] || chain.tokens[0], shareBps: 10_000 }]);
    setQuote(null);
    setError(null);
  }, [chainId]);

  useEffect(() => {
    const rows = readPendingRows();
    setPendingRows(rows);
  }, []);

  const updatePendingRows = useCallback((updater: (rows: PendingHistoryRow[]) => PendingHistoryRow[]) => {
    setPendingRows((current) => {
      const next = updater(current);
      writePendingRows(next);
      return next;
    });
  }, []);

  const loadHistory = useCallback(async () => {
    if (!address) {
      setHistory([]);
      return;
    }

    setHistoryLoading(true);
    try {
      const url = new URL(buildPublicApiUrl("/api/swaps/history"));
      url.searchParams.set("address", address);
      url.searchParams.set("limit", "30");
      const response = await publicApiFetch(url.toString(), { cache: "no-store" });
      const data = await response.json();
      if (data?.success) {
        setHistory(data.rows || []);
      }
    } finally {
      setHistoryLoading(false);
    }
  }, [address]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await publicApiFetch(buildPublicApiUrl("/api/swapown/sources"));
        const data = (await response.json()) as { success?: boolean; chains?: SourceStatus[] };
        if (!active) return;
        if (response.ok && data.success) {
          setSourceStatus(data.chains?.find((item) => item.chainId === chainId) ?? null);
        } else {
          setSourceStatus(null);
        }
      } catch {
        if (active) setSourceStatus(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [chainId]);

  const normalizedOutputs = useMemo(() => {
    if (mode === "single") {
      return outputs.slice(0, 1).map((output) => ({ ...output, shareBps: 10_000 }));
    }

    const total = outputs.reduce((sum, output) => sum + Number(output.shareBps || 0), 0);
    if (total === 10_000) return outputs;
    const equal = Math.floor(10_000 / outputs.length);
    let assigned = 0;
    return outputs.map((output, index) => {
      const shareBps = index === outputs.length - 1 ? 10_000 - assigned : equal;
      assigned += shareBps;
      return { ...output, shareBps };
    });
  }, [mode, outputs]);

  const canQuote = Boolean(sourceStatus?.routerAddress) && inputs.every((row) => row.amount && Number(row.amount) > 0);

  const addInput = () => {
    if (inputs.length >= 6) return;
    setInputs((current) => [...current, { id: newId(), token: selectedChain.tokens[0], amount: "" }]);
  };

  const addOutput = () => {
    if (outputs.length >= 6) return;
    setOutputs((current) => [...current, { id: newId(), token: selectedChain.tokens[1] || selectedChain.tokens[0], shareBps: 0 }]);
  };

  const refreshQuote = useCallback(async () => {
    setIsQuoting(true);
    setError(null);
    setStatus("Finding direct DustSwap routes...");
    try {
      const quoteInputs = inputs.map((row) => ({
        token: row.token.address,
        amount: parseUnits(row.amount || "0", row.token.decimals).toString(),
        symbol: row.token.symbol,
        decimals: row.token.decimals,
      }));
      const quoteOutputs = normalizedOutputs.map((row) => ({
        token: row.token.address,
        shareBps: row.shareBps,
        symbol: row.token.symbol,
        decimals: row.token.decimals,
      }));
      const response = await publicApiFetch(buildPublicApiUrl("/api/swapown/quote"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chainId,
          takerAddress: address || ZERO_ADDRESS,
          inputs: quoteInputs,
          outputs: quoteOutputs,
          slippageBps,
        }),
      });
      const data = (await response.json()) as QuoteResponse;
      if (!response.ok || !data.success) {
        throw new Error(data.error || "DustSwap quote failed");
      }
      setQuote(data);
      setStatus(null);
      return data;
    } catch (quoteError) {
      const message = quoteError instanceof Error ? quoteError.message : "DustSwap quote failed";
      setQuote(null);
      setError(message);
      setStatus(null);
      return null;
    } finally {
      setIsQuoting(false);
    }
  }, [address, chainId, inputs, normalizedOutputs, slippageBps]);

  const ensureApprovals = useCallback(async (buildTx: BuildTxResponse) => {
    if (!address || !walletClient || !publicClient) throw new Error("Connect a wallet first");

    for (const requirement of buildTx.approvalRequirements || []) {
      setStatus(`Checking ${shortHash(requirement.token)} approval...`);
      const allowance = await publicClient.readContract({
        address: requirement.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, requirement.spender],
      });

      if (allowance >= BigInt(requirement.amount)) {
        continue;
      }

      setStatus(`Approve ${shortHash(requirement.token)} for DustSwap`);
      const approveHash = await walletClient.writeContract({
        account: address,
        chain: selectedChain.chain,
        address: requirement.token,
        abi: erc20Abi,
        functionName: "approve",
        args: [requirement.spender, maxUint256],
      } as never);
      await publicClient.waitForTransactionReceipt({ hash: approveHash as Hex });
    }
  }, [address, publicClient, selectedChain.chain, walletClient]);

  const executeSwap = useCallback(async () => {
    if (!address || !walletClient || !publicClient) {
      setError("Connect a wallet first");
      return;
    }

    const activeQuote = quote || (await refreshQuote());
    if (!activeQuote) return;

    setIsSwapping(true);
    setError(null);
    try {
      if (currentChainId !== chainId) {
        setStatus(`Switching to ${selectedChain.label}`);
        await switchChainAsync({ chainId });
      }

      setStatus("Preparing DustSwap transaction...");
      const response = await publicApiFetch(buildPublicApiUrl("/api/swapown/build-tx"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chainId,
          receiver: address,
          routes: activeQuote.routes,
          deadline: activeQuote.deadline,
        }),
      });
      const buildTx = (await response.json()) as BuildTxResponse;
      if (!response.ok || !buildTx.success) {
        throw new Error(buildTx.error || "Failed to build DustSwap transaction");
      }

      await ensureApprovals(buildTx);
      setStatus(`Calling ${buildTx.functionName} on DustSwap`);
      const txHash = (await walletClient.sendTransaction({
        account: address,
        chain: selectedChain.chain,
        to: buildTx.to,
        data: buildTx.calldata,
        value: BigInt(buildTx.value || "0"),
      } as never)) as Hex;

      updatePendingRows((rows) => [
        { txHash, chainId, createdAt: Date.now(), status: "pending" },
        ...rows.filter((row) => row.txHash !== txHash),
      ]);

      setStatus("Waiting for confirmation...");
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") {
        throw new Error("DustSwap transaction reverted");
      }

      updatePendingRows((rows) =>
        rows.map((row) => (row.txHash === txHash ? { ...row, status: "recording" } : row))
      );
      setStatus("Recording swap for quests and history...");
      const recordResponse = await publicApiFetch(buildPublicApiUrl("/api/swaps/record"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, txHash, chainId }),
      });
      const recordData = await recordResponse.json().catch(() => null);
      if (!recordResponse.ok || !recordData?.success) {
        throw new Error(recordData?.error || "Swap confirmed but history recording failed");
      }

      updatePendingRows((rows) =>
        rows.map((row) => (row.txHash === txHash ? { ...row, status: "confirmed" } : row))
      );
      emitDataInvalidation("quests", "swapown-recorded");
      emitDataInvalidation("points", "swapown-recorded");
      emitDataInvalidation("leaderboard", "swapown-recorded");
      setStatus("Swap recorded");
      setQuote(null);
      await loadHistory();
    } catch (swapError) {
      const message = swapError instanceof Error ? swapError.message : "DustSwap swap failed";
      setError(message);
      setStatus(null);
    } finally {
      setIsSwapping(false);
    }
  }, [
    address,
    chainId,
    currentChainId,
    ensureApprovals,
    loadHistory,
    publicClient,
    quote,
    refreshQuote,
    selectedChain.chain,
    selectedChain.label,
    switchChainAsync,
    updatePendingRows,
    walletClient,
  ]);

  const primaryOutput = quote?.outputSummaries?.[0];
  const primaryOutputToken = primaryOutput ? getSwapOwnToken(chainId, primaryOutput.token) : normalizedOutputs[0]?.token;

  return (
    <main className="min-h-screen bg-[linear-gradient(180deg,#f8fbff_0%,#eef6ff_52%,#f8fafc_100%)] px-3 py-5 text-slate-950 sm:px-6 sm:py-8">
      <div className="mx-auto grid max-w-5xl gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-[8px] border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <Image src="/logo.png" alt="DustSwap" width={42} height={42} className="rounded-[8px]" priority />
              <div className="min-w-0">
                <h1 className="truncate text-xl font-black tracking-tight">DustSwap</h1>
                <p className="truncate text-xs font-semibold text-blue-600">Direct DEX aggregator</p>
              </div>
            </div>
            <WalletConnectButton
              connectLabel="Connect"
              connectedLabel={address ? shortHash(address) : undefined}
              showDisconnect
              className="rounded-[8px] border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-bold text-blue-700 shadow-sm hover:border-blue-300 hover:bg-blue-100"
            />
          </div>

          <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_auto]">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase text-slate-400">Chain</span>
              <select
                value={chainId}
                onChange={(event) => setChainId(Number(event.target.value))}
                className="h-11 rounded-[8px] border border-slate-200 bg-white px-3 text-sm font-bold text-slate-900 shadow-sm outline-none focus:border-blue-400"
              >
                {SWAPOWN_CHAINS.map((chain) => (
                  <option key={chain.id} value={chain.id}>
                    {chain.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end rounded-[8px] bg-slate-100 p-1">
              {(["single", "basket"] as SwapMode[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setMode(item)}
                  className={cx(
                    "h-9 rounded-[7px] px-3 text-sm font-bold capitalize transition",
                    mode === item ? "bg-white text-blue-700 shadow-sm" : "text-slate-500 hover:text-slate-800",
                  )}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <div className="rounded-[8px] border border-slate-200 bg-slate-50 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-black">From</p>
                {mode === "basket" ? (
                  <button type="button" onClick={addInput} className="text-xs font-bold text-blue-700">
                    Add input
                  </button>
                ) : null}
              </div>
              <div className="space-y-2">
                {inputs.map((row, index) => (
                  <div key={row.id} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_150px_auto]">
                    <input
                      value={row.amount}
                      onChange={(event) => {
                        const value = event.target.value.replace(/[^0-9.]/g, "");
                        setInputs((current) =>
                          current.map((item) => (item.id === row.id ? { ...item, amount: value } : item))
                        );
                      }}
                      placeholder="0.0"
                      inputMode="decimal"
                      className="h-11 min-w-0 rounded-[8px] border border-slate-200 bg-white px-3 font-mono text-lg font-semibold outline-none focus:border-blue-400"
                    />
                    <TokenSelect
                      label="Token"
                      value={row.token}
                      tokens={selectedChain.tokens}
                      onChange={(token) =>
                        setInputs((current) =>
                          current.map((item) => (item.id === row.id ? { ...item, token } : item))
                        )
                      }
                    />
                    {mode === "basket" && inputs.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => setInputs((current) => current.filter((item) => item.id !== row.id))}
                        className="h-11 rounded-[8px] px-2 text-sm font-bold text-red-600 hover:bg-red-50"
                        aria-label={`Remove input ${index + 1}`}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-[8px] border border-slate-200 bg-slate-50 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-black">To</p>
                {mode === "basket" ? (
                  <button type="button" onClick={addOutput} className="text-xs font-bold text-blue-700">
                    Add output
                  </button>
                ) : null}
              </div>
              <div className="space-y-2">
                {normalizedOutputs.map((row, index) => (
                  <div key={row.id} className="grid gap-2 sm:grid-cols-[150px_minmax(0,1fr)_auto]">
                    <TokenSelect
                      label="Token"
                      value={row.token}
                      tokens={selectedChain.tokens}
                      onChange={(token) =>
                        setOutputs((current) =>
                          current.map((item) => (item.id === row.id ? { ...item, token } : item))
                        )
                      }
                    />
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] font-semibold uppercase text-slate-400">Share</span>
                      <input
                        value={(row.shareBps / 100).toString()}
                        disabled={mode === "single"}
                        onChange={(event) => {
                          const next = Math.max(0, Math.min(100, Number(event.target.value || 0)));
                          setOutputs((current) =>
                            current.map((item) => (item.id === row.id ? { ...item, shareBps: Math.round(next * 100) } : item))
                          );
                        }}
                        className="h-10 rounded-[8px] border border-slate-200 bg-white px-3 text-sm font-semibold outline-none disabled:bg-slate-100"
                      />
                    </label>
                    {mode === "basket" && outputs.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => setOutputs((current) => current.filter((item) => item.id !== row.id))}
                        className="h-10 self-end rounded-[8px] px-2 text-sm font-bold text-red-600 hover:bg-red-50"
                        aria-label={`Remove output ${index + 1}`}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold uppercase text-slate-400">Slippage</span>
                <input
                  value={(slippageBps / 100).toString()}
                  onChange={(event) => setSlippageBps(Math.round(Number(event.target.value || 0) * 100))}
                  className="h-10 rounded-[8px] border border-slate-200 px-3 text-sm font-semibold outline-none focus:border-blue-400"
                />
              </label>
              <button
                type="button"
                disabled={!canQuote || isQuoting}
                onClick={() => void refreshQuote()}
                className="h-10 self-end rounded-[8px] border border-blue-200 bg-blue-50 px-4 text-sm font-black text-blue-700 shadow-sm transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isQuoting ? "Quoting..." : "Get quote"}
              </button>
              <button
                type="button"
                disabled={!quote || !isConnected || isSwapping}
                onClick={() => void executeSwap()}
                className="h-10 self-end rounded-[8px] bg-blue-600 px-5 text-sm font-black text-white shadow-[0_10px_24px_rgba(37,99,235,0.24)] transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
              >
                {isSwapping ? "Swapping..." : isConnected ? "Swap" : "Connect to swap"}
              </button>
            </div>

            {sourceStatus && (!sourceStatus.routerAddress || !sourceStatus.productionReady) ? (
              <div className="rounded-[8px] border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
                {!sourceStatus.routerAddress
                  ? "DustSwap router is not configured for this chain yet."
                  : `Source readiness: ${sourceStatus.activeSourceCount}/${sourceStatus.minActiveSources}.`}
              </div>
            ) : null}

            {error ? (
              <div className="rounded-[8px] border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
                {error}
              </div>
            ) : null}
            {status ? (
              <div className="rounded-[8px] border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-700">
                {status}
              </div>
            ) : null}
          </div>
        </section>

        <aside className="space-y-4">
          <section className="rounded-[8px] border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center gap-2">
              <Image src="/logo.png" alt="DustSwap" width={28} height={28} className="rounded-[6px]" />
              <div>
                <p className="text-sm font-black">Route</p>
                <p className="text-xs font-semibold text-slate-400">DustSwap direct DEX</p>
              </div>
            </div>
            {quote ? (
              <div className="space-y-3">
                <div className="rounded-[8px] bg-slate-50 p-3">
                  <p className="text-xs font-semibold text-slate-500">Expected output</p>
                  <p className="mt-1 font-mono text-2xl font-black">
                    {formatTokenAmount(primaryOutput?.netAmountOut || "0", primaryOutputToken)}{" "}
                    <span className="text-base">{primaryOutputToken?.symbol}</span>
                  </p>
                  <p className="mt-1 text-xs font-semibold text-slate-500">
                    Fee {quote.feeBps / 100}% routed through DustSwap
                  </p>
                </div>
                <div className="space-y-2">
                  {quote.routes.map((route, index) => {
                    const tokenIn = getSwapOwnToken(chainId, route.tokenIn);
                    const tokenOut = getSwapOwnToken(chainId, route.tokenOut);
                    return (
                      <div key={`${route.sourceId}-${index}`} className="rounded-[8px] border border-slate-200 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-2 text-sm font-black">
                            <Image src="/logo.png" alt="" width={18} height={18} className="rounded-[4px]" />
                            DustSwap
                          </span>
                          <span className="rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-black text-emerald-700">
                            {route.sourceName}
                          </span>
                        </div>
                        <p className="mt-2 text-xs font-semibold text-slate-500">
                          {formatTokenAmount(route.amountIn, tokenIn)} {tokenIn?.symbol || "input"} to{" "}
                          {formatTokenAmount(route.quotedAmountOut, tokenOut)} {tokenOut?.symbol || "output"}
                        </p>
                      </div>
                    );
                  })}
                </div>
                {!quote.productionReady ? (
                  <div className="rounded-[8px] border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
                    Source readiness: {quote.sourceReadiness?.activeSourceCount || 0}/
                    {quote.sourceReadiness?.minActiveSources || 15}. Configure more direct DEX sources before production launch.
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="rounded-[8px] border border-dashed border-slate-200 bg-slate-50 px-3 py-8 text-center text-sm font-semibold text-slate-500">
                DustSwap route appears after quote.
              </div>
            )}
          </section>

          <section className="rounded-[8px] border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-black">History</p>
              <button
                type="button"
                onClick={() => void loadHistory()}
                className="h-8 rounded-[8px] px-2 text-xs font-bold text-blue-700 hover:bg-blue-50"
              >
                Refresh
              </button>
            </div>
            <div className="space-y-2">
              {pendingRows.filter((row) => row.status !== "confirmed").map((row) => (
                <div key={row.txHash} className="rounded-[8px] border border-blue-100 bg-blue-50 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2 text-sm font-black">
                      <Image src="/logo.png" alt="" width={18} height={18} className="rounded-[4px]" />
                      DustSwap
                    </span>
                    <span className="text-xs font-bold capitalize text-blue-700">{row.status}</span>
                  </div>
                  <a
                    href={explorerTxUrl(row.chainId, row.txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 block text-xs font-semibold text-blue-700 underline underline-offset-2"
                  >
                    {shortHash(row.txHash)}
                  </a>
                </div>
              ))}
              {historyLoading ? (
                <p className="rounded-[8px] bg-slate-50 px-3 py-4 text-center text-sm font-semibold text-slate-500">
                  Loading history...
                </p>
              ) : null}
              {history.slice(0, 12).map((row) => {
                const source = String(row.metadata?.source || "openocean");
                const isDustSwap = source === "dustswap_aggregator";
                return (
                  <div key={`${row.chain_id}-${row.tx_hash}`} className="rounded-[8px] border border-slate-200 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex min-w-0 items-center gap-2 text-sm font-black">
                        <Image src="/logo.png" alt="" width={18} height={18} className="rounded-[4px]" />
                        <span className="truncate">{isDustSwap ? "DustSwap" : "Swap"}</span>
                      </span>
                      <span className="text-xs font-bold text-slate-500">
                        ${Number(row.amount_usd || 0).toFixed(2)}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs font-semibold text-slate-500">
                      {row.src_token_symbol || "Token"} to {row.dst_token_symbol || "Token"}
                    </p>
                    <a
                      href={explorerTxUrl(row.chain_id, row.tx_hash)}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 block text-xs font-semibold text-blue-700 underline underline-offset-2"
                    >
                      {shortHash(row.tx_hash)}
                    </a>
                  </div>
                );
              })}
              {!historyLoading && history.length === 0 && pendingRows.length === 0 ? (
                <p className="rounded-[8px] bg-slate-50 px-3 py-6 text-center text-sm font-semibold text-slate-500">
                  No swap history yet.
                </p>
              ) : null}
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
