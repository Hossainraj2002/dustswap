'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAccount, usePublicClient } from 'wagmi';
import { type Address, erc20Abi, maxUint256, encodeFunctionData } from 'viem';
import DustSweepRouterABI from '@/abi/DustSweepRouter.json';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DustToken {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  balance: string;
  balanceFormatted: string;
  usdValue: number;
  logoURI?: string;
  hasLiquidity: boolean;
}

export interface BatchQuote {
  selectedCount: number;
  totalDustValueUsd: number;
  swapFeeUsd: number;
  swapFeePercent: number;
  estimatedOutput: string;
  estimatedOutputFormatted: string;
  outputToken: OutputTokenOption;
  outputTokenSymbol: string;
  outputTokenDecimals: number;
  perTokenQuotes: PerTokenQuote[];
}

export interface PerTokenQuote {
  tokenIn: Address;
  amountIn: string;
  poolFee: number;
  estimatedAmountOut: string;
  minAmountOut: string;
}

export interface SwapOrder {
  tokenIn: Address;
  amountIn: bigint;
  poolFee: number;
  minAmountOut: bigint;
}

export type ThresholdValue = 1 | 2 | 5 | 10;
export type OutputTokenOption = 'ETH' | 'USDC' | 'WETH';

export interface ApprovalStatus {
  token: Address;
  needsApproval: boolean;
  currentAllowance: bigint;
}

export interface SuccessData {
  txHash: string;
  tokensSwept: number;
  amountReceived: string;
  outputSymbol: string;
  particlesEarned: number;
}

export interface TransactionCall {
  to: Address;
  data: `0x${string}`;
  value?: bigint;
}

export interface UseDustSweepReturn {
  dustTokens: DustToken[];
  noLiquidityTokens: DustToken[];
  selectedTokens: DustToken[];
  threshold: ThresholdValue;
  setThreshold: (t: ThresholdValue) => void;
  toggleToken: (address: Address) => void;
  selectAll: () => void;
  deselectAll: () => void;
  outputToken: OutputTokenOption;
  setOutputToken: (token: OutputTokenOption) => void;
  quote: BatchQuote | null;
  getQuote: () => Promise<void>;
  sweepCalls: TransactionCall[];
  isLoading: boolean;
  isQuoting: boolean;
  isSweeping: boolean;
  error: string | null;
  quoteError: string | null;
  handleSuccess: (txHash: string) => Promise<void>;
  particlesEarned: number | null;
  successData: SuccessData | null;
  clearSuccess: () => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ROUTER_ADDRESS = (process.env.NEXT_PUBLIC_ROUTER_ADDRESS ||
  '0x0000000000000000000000000000000000000000') as Address;

const USDC_ADDRESS: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_ADDRESS: Address = '0x4200000000000000000000000000000000000006';

const OUTPUT_TOKEN_MAP: Record<
  OutputTokenOption,
  { address: Address; symbol: string; decimals: number }
> = {
  ETH: { address: WETH_ADDRESS, symbol: 'ETH', decimals: 18 },
  USDC: { address: USDC_ADDRESS, symbol: 'USDC', decimals: 6 },
  WETH: { address: WETH_ADDRESS, symbol: 'WETH', decimals: 18 },
};

const MAX_SELECTED_TOKENS = 10;
const BASE_PARTICLES = 50;
const PER_TOKEN_PARTICLES = 5;

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useDustSweep(): UseDustSweepReturn {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();

  // ── State ──────────────────────────────────────────────────────────────

  const [threshold, setThreshold] = useState<ThresholdValue>(5);
  const [allDustTokens, setAllDustTokens] = useState<DustToken[]>([]);
  const [allNoLiquidityTokens, setAllNoLiquidityTokens] = useState<DustToken[]>([]);
  const [selectedAddresses, setSelectedAddresses] = useState<Set<Address>>(new Set());
  const [outputToken, setOutputToken] = useState<OutputTokenOption>('ETH');
  const [quote, setQuote] = useState<BatchQuote | null>(null);
  const [approvalStatuses, setApprovalStatuses] = useState<ApprovalStatus[]>([]);

  const [isLoading, setIsLoading] = useState(false);
  const [isQuoting, setIsQuoting] = useState(false);
  const [isSweeping, setIsSweeping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const [particlesEarned, setParticlesEarned] = useState<number | null>(null);
  const [successData, setSuccessData] = useState<SuccessData | null>(null);

  // ── Derived State ──────────────────────────────────────────────────────

  const dustTokens = allDustTokens;

  const noLiquidityTokens = allNoLiquidityTokens;

  const selectedTokens = useMemo(
    () => dustTokens.filter((t) => selectedAddresses.has(t.address)),
    [dustTokens, selectedAddresses]
  );

  // ── 1. Fetch Dust Tokens from Railway API ─────────────────────────────

  const fetchDustTokens = useCallback(async () => {
    if (!address || !isConnected) {
      setAllDustTokens([]);
      setAllNoLiquidityTokens([]);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Call through Next.js rewrite → Railway API
      const response = await fetch(
        `/api/tokens/dust?address=${address}&threshold=${threshold}`
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error || `Failed to fetch dust tokens: ${response.status}`
        );
      }

      const json = await response.json();

      // Railway API returns: { success, error, data: { dustTokens, noLiquidityTokens, ... } }
      const data = json.data || json;

      // Parse dust tokens from the API response
      const rawDustTokens = data.dustTokens || data.tokens || [];
      const rawNoLiquidityTokens = data.noLiquidityTokens || [];

      const parsedDustTokens: DustToken[] = rawDustTokens.map(
        (t: Record<string, unknown>) => ({
          address: (t.address || t.tokenAddress) as Address,
          name: (t.name || t.tokenName || 'Unknown') as string,
          symbol: (t.symbol || t.tokenSymbol || '???') as string,
          decimals: Number(t.decimals || 18),
          balance: String(t.balance || t.rawBalance || '0'),
          balanceFormatted: String(
            t.balanceFormatted || t.formattedBalance || t.balance || '0'
          ),
          usdValue: Number(t.usdValue || t.valueUsd || 0),
          logoURI: (t.logoURI || t.logo || undefined) as string | undefined,
          hasLiquidity: t.hasLiquidity !== false,
        })
      );

      const parsedNoLiquidity: DustToken[] = rawNoLiquidityTokens.map(
        (t: Record<string, unknown>) => ({
          address: (t.address || t.tokenAddress) as Address,
          name: (t.name || t.tokenName || 'Unknown') as string,
          symbol: (t.symbol || t.tokenSymbol || '???') as string,
          decimals: Number(t.decimals || 18),
          balance: String(t.balance || t.rawBalance || '0'),
          balanceFormatted: String(
            t.balanceFormatted || t.formattedBalance || t.balance || '0'
          ),
          usdValue: Number(t.usdValue || t.valueUsd || 0),
          logoURI: (t.logoURI || t.logo || undefined) as string | undefined,
          hasLiquidity: false,
        })
      );

      setAllDustTokens(parsedDustTokens);
      setAllNoLiquidityTokens(parsedNoLiquidity);

      // Auto-select dust tokens (up to max)
      const autoSelected = new Set<Address>(
        parsedDustTokens
          .filter((t: DustToken) => t.usdValue <= threshold)
          .slice(0, MAX_SELECTED_TOKENS)
          .map((t: DustToken) => t.address)
      );
      setSelectedAddresses(autoSelected);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to fetch dust tokens';
      setError(message);
      setAllDustTokens([]);
      setAllNoLiquidityTokens([]);
    } finally {
      setIsLoading(false);
    }
  }, [address, isConnected, threshold]);

  // Auto-refetch when address or threshold changes
  useEffect(() => {
    fetchDustTokens();
  }, [fetchDustTokens]);

  // Clear quote when selection or output changes
  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
  }, [selectedAddresses, outputToken]);

  // ── 2. Toggle / Select Tokens ─────────────────────────────────────────

  const toggleToken = useCallback((tokenAddress: Address) => {
    setSelectedAddresses((prev) => {
      const next = new Set(prev);
      if (next.has(tokenAddress)) {
        next.delete(tokenAddress);
      } else {
        if (next.size >= MAX_SELECTED_TOKENS) return prev;
        next.add(tokenAddress);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    const selectableTokens = dustTokens
      .filter((t) => t.usdValue <= threshold)
      .slice(0, MAX_SELECTED_TOKENS)
      .map((t) => t.address);
    setSelectedAddresses(new Set(selectableTokens));
  }, [dustTokens, threshold]);

  const deselectAll = useCallback(() => {
    setSelectedAddresses(new Set());
  }, []);

  // ── 3. Get Batch Quote from Railway API ───────────────────────────────

  const getQuote = useCallback(async () => {
    if (selectedTokens.length === 0) {
      setQuoteError('No tokens selected');
      return;
    }

    setIsQuoting(true);
    setQuoteError(null);
    setQuote(null);

    try {
      const tokenOutAddress = OUTPUT_TOKEN_MAP[outputToken].address;

      // Railway API expects: { orders: [{ tokenIn, amountIn }], tokenOut }
      const response = await fetch('/api/tokens/batch-quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orders: selectedTokens.map((t) => ({
            tokenIn: t.address,
            amountIn: t.balance,
          })),
          tokenOut: tokenOutAddress,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error || `Quote failed: ${response.status}`
        );
      }

      const json = await response.json();
      // Railway returns: { success, data: { quotes, summary, ... } }
      const data = json.data || json;
      const summary = data.summary || data;
      const quotes = data.quotes || data.perTokenQuotes || [];

      // Parse per-token quotes
      const perTokenQuotes: PerTokenQuote[] = quotes.map(
        (q: Record<string, unknown>) => ({
          tokenIn: (q.tokenIn || q.token) as Address,
          amountIn: String(q.amountIn || '0'),
          poolFee: Number(q.poolFee || q.fee || 3000),
          estimatedAmountOut: String(q.amountOut || q.estimatedAmountOut || '0'),
          minAmountOut: String(q.minAmountOut || q.amountOut || '0'),
        })
      );

      // Calculate totals from summary or from quotes
      const totalOutputRaw = summary.totalAmountOut || summary.estimatedOutput;
      const netOutputRaw = summary.netOutput || totalOutputRaw;
      const feeAmountRaw = summary.feeAmount || '0';

      const outputDecimals = OUTPUT_TOKEN_MAP[outputToken].decimals;

      // Calculate USD values
      let totalDustUsd = 0;
      for (const t of selectedTokens) {
        totalDustUsd += t.usdValue;
      }

      const feePercent = summary.dustSweepFeeBps
        ? Number(summary.dustSweepFeeBps) / 100
        : 2;
      const swapFeeUsd = (totalDustUsd * feePercent) / 100;

      // Format output amount
      let estimatedOutputFormatted = '0';
      try {
        const { formatUnits } = await import('viem');
        estimatedOutputFormatted = formatUnits(
          BigInt(netOutputRaw || '0'),
          outputDecimals
        );
      } catch {
        estimatedOutputFormatted = '0';
      }

      const batchQuote: BatchQuote = {
        selectedCount: perTokenQuotes.length || selectedTokens.length,
        totalDustValueUsd: Math.round(totalDustUsd * 100) / 100,
        swapFeeUsd: Math.round(swapFeeUsd * 100) / 100,
        swapFeePercent: feePercent,
        estimatedOutput: String(netOutputRaw || '0'),
        estimatedOutputFormatted,
        outputToken,
        outputTokenSymbol: OUTPUT_TOKEN_MAP[outputToken].symbol,
        outputTokenDecimals: outputDecimals,
        perTokenQuotes,
      };

      setQuote(batchQuote);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to get quote';
      setQuoteError(message);
    } finally {
      setIsQuoting(false);
    }
  }, [selectedTokens, outputToken]);

  // Auto-quote when selection changes
  useEffect(() => {
    if (selectedTokens.length > 0) {
      const debounce = setTimeout(() => {
        getQuote();
      }, 500);
      return () => clearTimeout(debounce);
    }
  }, [selectedTokens.length, outputToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 4. Check Approvals ────────────────────────────────────────────────

  const checkApprovals = useCallback(async (): Promise<ApprovalStatus[]> => {
    if (!publicClient || !address || selectedTokens.length === 0) {
      return [];
    }

    try {
      const results = await Promise.all(
        selectedTokens.map(async (token) => {
          try {
            const allowance = await publicClient.readContract({
              address: token.address,
              abi: erc20Abi,
              functionName: 'allowance',
              args: [address, ROUTER_ADDRESS],
            });

            const amountNeeded = BigInt(token.balance);

            return {
              token: token.address,
              needsApproval: allowance < amountNeeded,
              currentAllowance: allowance,
            };
          } catch {
            return {
              token: token.address,
              needsApproval: true,
              currentAllowance: 0n,
            };
          }
        })
      );

      setApprovalStatuses(results);
      return results;
    } catch {
      return selectedTokens.map((t) => ({
        token: t.address,
        needsApproval: true,
        currentAllowance: 0n,
      }));
    }
  }, [publicClient, address, selectedTokens]);

  // Check approvals when quote is obtained
  useEffect(() => {
    if (quote && selectedTokens.length > 0) {
      checkApprovals();
    }
  }, [quote, checkApprovals, selectedTokens.length]);

  // ── 5. Build Transaction Calls ────────────────────────────────────────

  const sweepCalls = useMemo((): TransactionCall[] => {
    if (
      !quote ||
      !address ||
      selectedTokens.length === 0 ||
      !quote.perTokenQuotes.length
    ) {
      return [];
    }

    const calls: TransactionCall[] = [];

    // Approval calls
    const tokensNeedingApproval = approvalStatuses.filter(
      (s) => s.needsApproval
    );

    for (const status of tokensNeedingApproval) {
      const approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [ROUTER_ADDRESS, maxUint256],
      });

      calls.push({
        to: status.token,
        data: approveData,
      });
    }

    // Build SwapOrder structs
    const orderTuples = quote.perTokenQuotes.map((pq) => {
      const estimatedOut = BigInt(pq.estimatedAmountOut);
      const minOut = pq.minAmountOut
        ? BigInt(pq.minAmountOut)
        : (estimatedOut * 97n) / 100n;

      return {
        tokenIn: pq.tokenIn,
        amountIn: BigInt(pq.amountIn),
        poolFee: pq.poolFee,
        minAmountOut: minOut,
      };
    });

    // Sweep call
    if (outputToken === 'ETH') {
      const sweepData = encodeFunctionData({
        abi: DustSweepRouterABI,
        functionName: 'sweepDustToETH',
        args: [orderTuples, address],
      });

      calls.push({
        to: ROUTER_ADDRESS,
        data: sweepData,
      });
    } else {
      const tokenOutAddress = OUTPUT_TOKEN_MAP[outputToken].address;

      const sweepData = encodeFunctionData({
        abi: DustSweepRouterABI,
        functionName: 'sweepDust',
        args: [orderTuples, tokenOutAddress, address],
      });

      calls.push({
        to: ROUTER_ADDRESS,
        data: sweepData,
      });
    }

    return calls;
  }, [quote, address, selectedTokens, approvalStatuses, outputToken]);

  // ── 6. Handle Success & Award Particles ───────────────────────────────

  const handleSuccess = useCallback(
    async (txHash: string) => {
      setIsSweeping(false);

      const tokensSwept = selectedTokens.length;
      const earned = BASE_PARTICLES + PER_TOKEN_PARTICLES * tokensSwept;

      // Award particles via Railway API
      try {
        if (address) {
          await fetch('/api/points/record-sweep', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              address,
              txHash,
              tokensSwept,
              outputToken,
              threshold,
            }),
          });
        }
      } catch {
        console.error('Failed to award particles');
      }

      setParticlesEarned(earned);
      setSuccessData({
        txHash,
        tokensSwept,
        amountReceived: quote?.estimatedOutputFormatted || '0',
        outputSymbol: OUTPUT_TOKEN_MAP[outputToken].symbol,
        particlesEarned: earned,
      });

      // Refresh after sweep
      setTimeout(() => {
        fetchDustTokens();
      }, 3000);
    },
    [address, selectedTokens, outputToken, threshold, quote, fetchDustTokens]
  );

  const clearSuccess = useCallback(() => {
    setSuccessData(null);
    setParticlesEarned(null);
  }, []);

  // ── Return ────────────────────────────────────────────────────────────

  return {
    dustTokens,
    noLiquidityTokens,
    selectedTokens,
    threshold,
    setThreshold,
    toggleToken,
    selectAll,
    deselectAll,
    outputToken,
    setOutputToken,
    quote,
    getQuote,
    sweepCalls,
    isLoading,
    isQuoting,
    isSweeping,
    error,
    quoteError,
    handleSuccess,
    particlesEarned,
    successData,
    clearSuccess,
  };
}