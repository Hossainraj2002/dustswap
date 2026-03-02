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

// ─── Constants ───────────────────────────────────────────────────────────────

const ROUTER_ADDRESS = (process.env.NEXT_PUBLIC_ROUTER_ADDRESS ||
  '0x0000000000000000000000000000000000000000') as Address;

const USDC_ADDRESS: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_ADDRESS: Address = '0x4200000000000000000000000000000000000006';

const OUTPUT_TOKEN_MAP: Record<OutputTokenOption, { address: Address | null; symbol: string; decimals: number }> = {
  ETH: { address: null, symbol: 'ETH', decimals: 18 },
  USDC: { address: USDC_ADDRESS, symbol: 'USDC', decimals: 6 },
  WETH: { address: WETH_ADDRESS, symbol: 'WETH', decimals: 18 },
};

const MAX_SELECTED_TOKENS = 10;
const SLIPPAGE_TOLERANCE = 0.03; // 3%
const BASE_PARTICLES = 50;
const PER_TOKEN_PARTICLES = 5;

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useDustSweep(): UseDustSweepReturn {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();

  // ── State ────────────────────────────────────────────────────────────────

  const [threshold, setThreshold] = useState<ThresholdValue>(5);
  const [allDustTokens, setAllDustTokens] = useState<DustToken[]>([]);
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

  // ── Derived State ────────────────────────────────────────────────────────

  const dustTokens = useMemo(
    () => allDustTokens.filter((t) => t.hasLiquidity),
    [allDustTokens]
  );

  const noLiquidityTokens = useMemo(
    () => allDustTokens.filter((t) => !t.hasLiquidity),
    [allDustTokens]
  );

  const selectedTokens = useMemo(
    () => dustTokens.filter((t) => selectedAddresses.has(t.address)),
    [dustTokens, selectedAddresses]
  );

  // ── 1. Fetch Dust Tokens ────────────────────────────────────────────────

  const fetchDustTokens = useCallback(async () => {
    if (!address || !isConnected) {
      setAllDustTokens([]);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/tokens/dust?address=${address}&threshold=${threshold}`
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Failed to fetch dust tokens: ${response.status}`);
      }

      const data = await response.json();

      const tokens: DustToken[] = (data.tokens || []).map((t: Record<string, unknown>) => ({
        address: t.address as Address,
        name: t.name as string,
        symbol: t.symbol as string,
        decimals: t.decimals as number,
        balance: t.balance as string,
        balanceFormatted: t.balanceFormatted as string,
        usdValue: Number(t.usdValue),
        logoURI: (t.logoURI as string) || undefined,
        hasLiquidity: t.hasLiquidity !== false,
      }));

      setAllDustTokens(tokens);

      // Auto-select all tokens with liquidity below threshold
      const autoSelected = new Set<Address>(
        tokens
          .filter((t: DustToken) => t.hasLiquidity && t.usdValue <= threshold)
          .slice(0, MAX_SELECTED_TOKENS)
          .map((t: DustToken) => t.address)
      );
      setSelectedAddresses(autoSelected);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch dust tokens';
      setError(message);
      setAllDustTokens([]);
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

  // ── 2. Toggle / Select Tokens ────────────────────────────────────────────

  const toggleToken = useCallback((tokenAddress: Address) => {
    setSelectedAddresses((prev) => {
      const next = new Set(prev);
      if (next.has(tokenAddress)) {
        next.delete(tokenAddress);
      } else {
        if (next.size >= MAX_SELECTED_TOKENS) {
          return prev; // Don't add beyond max
        }
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

  // ── 3. Get Batch Quote ───────────────────────────────────────────────────

  const getQuote = useCallback(async () => {
    if (selectedTokens.length === 0) {
      setQuoteError('No tokens selected');
      return;
    }

    setIsQuoting(true);
    setQuoteError(null);
    setQuote(null);

    try {
      const response = await fetch('/api/tokens/batch-quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokens: selectedTokens.map((t) => ({
            address: t.address,
            balance: t.balance,
            decimals: t.decimals,
          })),
          outputToken,
          outputTokenAddress: OUTPUT_TOKEN_MAP[outputToken].address,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Quote failed: ${response.status}`);
      }

      const data = await response.json();

      const batchQuote: BatchQuote = {
        selectedCount: data.selectedCount || selectedTokens.length,
        totalDustValueUsd: Number(data.totalDustValueUsd),
        swapFeeUsd: Number(data.swapFeeUsd),
        swapFeePercent: data.swapFeePercent || 2,
        estimatedOutput: data.estimatedOutput as string,
        estimatedOutputFormatted: data.estimatedOutputFormatted as string,
        outputToken,
        outputTokenSymbol: OUTPUT_TOKEN_MAP[outputToken].symbol,
        outputTokenDecimals: OUTPUT_TOKEN_MAP[outputToken].decimals,
        perTokenQuotes: (data.perTokenQuotes || []).map((q: Record<string, unknown>) => ({
          tokenIn: q.tokenIn as Address,
          amountIn: q.amountIn as string,
          poolFee: Number(q.poolFee),
          estimatedAmountOut: q.estimatedAmountOut as string,
          minAmountOut: q.minAmountOut as string,
        })),
      };

      setQuote(batchQuote);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get quote';
      setQuoteError(message);
    } finally {
      setIsQuoting(false);
    }
  }, [selectedTokens, outputToken]);

  // Auto-quote when selection changes and has tokens
  useEffect(() => {
    if (selectedTokens.length > 0) {
      const debounce = setTimeout(() => {
        getQuote();
      }, 500);
      return () => clearTimeout(debounce);
    }
  }, [selectedTokens.length, outputToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 4. Check Approvals ──────────────────────────────────────────────────

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
            // If read fails, assume approval needed
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

  // ── 5. Build Transaction Calls ──────────────────────────────────────────

  const sweepCalls = useMemo((): TransactionCall[] => {
    if (!quote || !address || selectedTokens.length === 0 || !quote.perTokenQuotes.length) {
      return [];
    }

    const calls: TransactionCall[] = [];

    // Step 1: Approval calls for tokens that need approval
    const tokensNeedingApproval = approvalStatuses.filter((s) => s.needsApproval);

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

    // Step 2: Build SwapOrder structs from quote data
    const orders: SwapOrder[] = quote.perTokenQuotes.map((pq) => {
      const estimatedOut = BigInt(pq.estimatedAmountOut);
      // Apply 3% slippage tolerance: minAmountOut = estimatedOut * 0.97
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

    // Convert orders to tuple format for ABI encoding
    const orderTuples = orders.map((o) => ({
      tokenIn: o.tokenIn,
      amountIn: o.amountIn,
      poolFee: o.poolFee,
      minAmountOut: o.minAmountOut,
    }));

    // Step 3: Sweep call
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
      const tokenOutAddress = OUTPUT_TOKEN_MAP[outputToken].address!;

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

  // ── 6. Handle Success & Award Particles ─────────────────────────────────

  const handleSuccess = useCallback(
    async (txHash: string) => {
      setIsSweeping(false);

      const tokensSwept = selectedTokens.length;
      const earned = BASE_PARTICLES + PER_TOKEN_PARTICLES * tokensSwept;

      // Award particles
      try {
        if (address) {
          await fetch('/api/points/award', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              address,
              action: 'sweep',
              particles: earned,
              metadata: {
                txHash,
                tokensSwept,
                outputToken,
                threshold,
              },
            }),
          });
        }
      } catch {
        // Don't block success on points failure
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

      // Refresh dust tokens after successful sweep
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

  // ── Return ──────────────────────────────────────────────────────────────

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