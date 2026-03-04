'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAccount, usePublicClient } from 'wagmi';
import { type Address, erc20Abi, maxUint256, encodeFunctionData } from 'viem';
import DustSweepRouterABI from '@/abi/DustSweepRouter.json';

// ─── Types ────────────────────────────────────────────────────────────────────

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
  amountIn: string;           // actual amount to send (may be < full balance for partial swaps)
  poolFee: number;
  estimatedAmountOut: string;
  minAmountOut: string;
  maxSwappablePercent?: number; // 100, 50, 25, or 10 — indicates partial liquidity
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

// ─── Constants ────────────────────────────────────────────────────────────────

const ROUTER_ADDRESS = (process.env.NEXT_PUBLIC_ROUTER_ADDRESS ||
  '0x0000000000000000000000000000000000000000') as Address;

// FIX 3: Warn in development if router address is not configured
if (
  typeof window !== 'undefined' &&
  process.env.NODE_ENV !== 'production' &&
  ROUTER_ADDRESS === '0x0000000000000000000000000000000000000000'
) {
  console.warn(
    '[DustSweep] ⚠️  NEXT_PUBLIC_ROUTER_ADDRESS is not set. ' +
    'All sweep calls will target the zero address and revert. ' +
    'Set this to your deployed DustSweepRouter contract address.'
  );
}

const USDC_ADDRESS: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_ADDRESS: Address = '0x4200000000000000000000000000000000000006';

const OUTPUT_TOKEN_MAP: Record<
  OutputTokenOption,
  { address: Address; symbol: string; decimals: number }
> = {
  ETH:  { address: WETH_ADDRESS, symbol: 'ETH',  decimals: 18 },
  USDC: { address: USDC_ADDRESS, symbol: 'USDC', decimals: 6  },
  WETH: { address: WETH_ADDRESS, symbol: 'WETH', decimals: 18 },
};

const MAX_SELECTED_TOKENS = 10;
const BASE_PARTICLES = 50;
const PER_TOKEN_PARTICLES = 5;

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useDustSweep(): UseDustSweepReturn {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();

  // ── State ──────────────────────────────────────────────────────────────────

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

  // ── Derived State ──────────────────────────────────────────────────────────

  const dustTokens = allDustTokens;
  const noLiquidityTokens = allNoLiquidityTokens;

  const selectedTokens = useMemo(
    () => dustTokens.filter((t) => selectedAddresses.has(t.address)),
    [dustTokens, selectedAddresses]
  );

  // ── 1. Fetch Dust Tokens ───────────────────────────────────────────────────

  const fetchDustTokens = useCallback(async () => {
    if (!address || !isConnected) {
      setAllDustTokens([]);
      setAllNoLiquidityTokens([]);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/tokens/dust?address=${address}&threshold=${threshold}`
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(errorData.error || `Failed to fetch dust tokens: ${response.status}`);
      }

      const json = await response.json() as {
        data?: unknown;
        dustTokens?: unknown[];
        noLiquidityTokens?: unknown[];
        tokens?: unknown[];
      };

      // Handle both wrapped { data: {...} } and flat response formats
      const data = (json.data || json) as {
        dustTokens?: unknown[];
        noLiquidityTokens?: unknown[];
        tokens?: unknown[];
      };

      // FIX: new dust/route.ts returns { dustTokens, noLiquidityTokens }
      // Old format returned { tokens } — support both
      const rawDustTokens = data.dustTokens || data.tokens || [];
      const rawNoLiquidityTokens = data.noLiquidityTokens || [];

      const parseToken = (t: Record<string, unknown>): DustToken => ({
        address:         (t.address || t.tokenAddress) as Address,
        name:            (t.name || t.tokenName || 'Unknown') as string,
        symbol:          (t.symbol || t.tokenSymbol || '???') as string,
        decimals:        Number(t.decimals ?? 18),
        balance:         String(t.balance || t.rawBalance || '0'),
        balanceFormatted: String(t.balanceFormatted || t.formattedBalance || t.balance || '0'),
        usdValue:        Number(t.usdValue || t.valueUsd || 0),
        logoURI:         (t.logoURI || t.logo || undefined) as string | undefined,
        hasLiquidity:    t.hasLiquidity !== false, // defaults to true if field is missing
      });

      const parsedDustTokens = (rawDustTokens as Record<string, unknown>[]).map(parseToken);
      const parsedNoLiquidity = (rawNoLiquidityTokens as Record<string, unknown>[]).map(
        (t) => ({ ...parseToken(t), hasLiquidity: false })
      );

      setAllDustTokens(parsedDustTokens);
      setAllNoLiquidityTokens(parsedNoLiquidity);

      // Auto-select all dust tokens (up to max)
      const autoSelected = new Set<Address>(
        parsedDustTokens.slice(0, MAX_SELECTED_TOKENS).map((t) => t.address)
      );
      setSelectedAddresses(autoSelected);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch dust tokens';
      setError(message);
      setAllDustTokens([]);
      setAllNoLiquidityTokens([]);
    } finally {
      setIsLoading(false);
    }
  }, [address, isConnected, threshold]);

  useEffect(() => {
    fetchDustTokens();
  }, [fetchDustTokens]);

  // Clear quote when selection or output changes
  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
  }, [selectedAddresses, outputToken]);

  // ── 2. Toggle / Select Tokens ──────────────────────────────────────────────

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
    const selectable = dustTokens
      .filter((t) => t.usdValue <= threshold)
      .slice(0, MAX_SELECTED_TOKENS)
      .map((t) => t.address);
    setSelectedAddresses(new Set(selectable));
  }, [dustTokens, threshold]);

  const deselectAll = useCallback(() => {
    setSelectedAddresses(new Set());
  }, []);

  // ── 3. Get Batch Quote ─────────────────────────────────────────────────────

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

      // Send { orders, tokenOut } format — matches the fixed batch-quote/route.ts
      const response = await fetch('/api/tokens/batch-quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orders: selectedTokens.map((t) => ({
            tokenIn: t.address,
            amountIn: t.balance,
            decimals: t.decimals,
          })),
          tokenOut: tokenOutAddress,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(errorData.error || `Quote failed: ${response.status}`);
      }

      const json = await response.json() as Record<string, unknown>;

      // Parse flexible response — handles both flat and wrapped formats
      const data = (json.data || json) as Record<string, unknown>;
      const summary = (data.summary || data) as Record<string, unknown>;
      const quotesRaw = (data.quotes || data.perTokenQuotes || []) as Record<string, unknown>[];

      // FIX 3: Filter out failed quotes (amountOut = 0 or poolFee = 0)
      const validQuotes = quotesRaw.filter((q) => {
        const amountOut = String(q.amountOut || q.estimatedAmountOut || '0');
        return BigInt(amountOut) > 0n;
      });

      const perTokenQuotes: PerTokenQuote[] = validQuotes.map((q) => ({
        tokenIn:           (q.tokenIn || q.token) as Address,
        amountIn:          String(q.amountIn || '0'),
        poolFee:           Number(q.poolFee || q.fee || 3000),
        estimatedAmountOut: String(q.amountOut || q.estimatedAmountOut || '0'),
        minAmountOut:      String(q.minAmountOut || q.amountOut || '0'),
        maxSwappablePercent: q.maxSwappablePercent as number | undefined,
      }));

      if (perTokenQuotes.length === 0) {
        throw new Error('No tokens could be quoted — they may have no Uniswap liquidity');
      }

      const totalOutputRaw = String(summary.totalAmountOut || summary.estimatedOutput || '0');
      const netOutputRaw   = String(summary.netOutput || summary.estimatedOutput || totalOutputRaw);
      const outputDecimals = OUTPUT_TOKEN_MAP[outputToken].decimals;

      let totalDustUsd = 0;
      for (const t of selectedTokens) totalDustUsd += t.usdValue;

      const feePercent = Number(summary.dustSweepFeeBps ?? 200) / 100;
      const swapFeeUsd = (totalDustUsd * feePercent) / 100;

      let estimatedOutputFormatted = '0';
      try {
        const { formatUnits } = await import('viem');
        estimatedOutputFormatted = formatUnits(BigInt(netOutputRaw || '0'), outputDecimals);
      } catch {
        estimatedOutputFormatted = '0';
      }

      const batchQuote: BatchQuote = {
        selectedCount:          perTokenQuotes.length,
        totalDustValueUsd:      Math.round(totalDustUsd * 100) / 100,
        swapFeeUsd:             Math.round(swapFeeUsd * 100) / 100,
        swapFeePercent:         feePercent,
        estimatedOutput:        netOutputRaw,
        estimatedOutputFormatted,
        outputToken,
        outputTokenSymbol:      OUTPUT_TOKEN_MAP[outputToken].symbol,
        outputTokenDecimals:    outputDecimals,
        perTokenQuotes,
      };

      setQuote(batchQuote);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get quote';
      setQuoteError(message);
    } finally {
      setIsQuoting(false);
    }
  }, [selectedTokens, outputToken]);

  // Auto-quote when selection changes (debounced)
  useEffect(() => {
    if (selectedTokens.length > 0) {
      const timer = setTimeout(() => { getQuote(); }, 500);
      return () => clearTimeout(timer);
    }
  }, [selectedTokens.length, outputToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 4. Check Approvals ─────────────────────────────────────────────────────

  const checkApprovals = useCallback(async (): Promise<ApprovalStatus[]> => {
    if (!publicClient || !address || selectedTokens.length === 0) return [];

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
            // FIX 3: Use the quote's amountIn (may be partial), not full balance
            const quoteForToken = quote?.perTokenQuotes.find(
              (pq) => pq.tokenIn.toLowerCase() === token.address.toLowerCase()
            );
            const amountNeeded = quoteForToken
              ? BigInt(quoteForToken.amountIn)
              : BigInt(token.balance);

            return {
              token: token.address,
              needsApproval: allowance < amountNeeded,
              currentAllowance: allowance,
            };
          } catch {
            return { token: token.address, needsApproval: true, currentAllowance: 0n };
          }
        })
      );
      setApprovalStatuses(results);
      return results;
    } catch {
      return selectedTokens.map((t) => ({ token: t.address, needsApproval: true, currentAllowance: 0n }));
    }
  }, [publicClient, address, selectedTokens, quote]);

  useEffect(() => {
    if (quote && selectedTokens.length > 0) {
      checkApprovals();
    }
  }, [quote, checkApprovals, selectedTokens.length]);

  // ── 5. Build Sweep Transaction Calls ──────────────────────────────────────

  const sweepCalls = useMemo((): TransactionCall[] => {
    if (!quote || !address || selectedTokens.length === 0 || !quote.perTokenQuotes.length) {
      return [];
    }

    // FIX 3: Warn if router is zero address — swaps will fail
    if (ROUTER_ADDRESS === '0x0000000000000000000000000000000000000000') {
      console.error(
        '[DustSweep] Cannot build sweep calls: NEXT_PUBLIC_ROUTER_ADDRESS is not set.'
      );
      return [];
    }

    const calls: TransactionCall[] = [];

    // ── Approval calls ────────────────────────────────────────────────────
    for (const status of approvalStatuses.filter((s) => s.needsApproval)) {
      calls.push({
        to: status.token,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [ROUTER_ADDRESS, maxUint256],
        }),
      });
    }

    // ── Build SwapOrder tuples ────────────────────────────────────────────
    // FIX 3: Only include quotes that have a valid poolFee (> 0) and amountOut (> 0)
    const validOrders = quote.perTokenQuotes.filter((pq) => {
      return pq.poolFee > 0 && BigInt(pq.estimatedAmountOut) > 0n;
    });

    if (validOrders.length === 0) return calls; // only approvals if no valid swaps

    const orderTuples = validOrders.map((pq) => {
      const estimatedOut = BigInt(pq.estimatedAmountOut);
      // Use the minAmountOut from the quote (already has 5% slippage applied)
      const minOut = pq.minAmountOut && BigInt(pq.minAmountOut) > 0n
        ? BigInt(pq.minAmountOut)
        : (estimatedOut * 95n) / 100n; // 5% slippage fallback

      return {
        tokenIn:      pq.tokenIn,
        amountIn:     BigInt(pq.amountIn), // FIX 3: use quote amountIn (may be partial)
        poolFee:      pq.poolFee,
        minAmountOut: minOut,
      };
    });

    // ── Sweep call ────────────────────────────────────────────────────────
    if (outputToken === 'ETH') {
      calls.push({
        to: ROUTER_ADDRESS,
        data: encodeFunctionData({
          abi: DustSweepRouterABI,
          functionName: 'sweepDustToETH',
          args: [orderTuples],
        }),
      });
    } else {
      calls.push({
        to: ROUTER_ADDRESS,
        data: encodeFunctionData({
          abi: DustSweepRouterABI,
          functionName: 'sweepDust',
          args: [orderTuples, OUTPUT_TOKEN_MAP[outputToken].address],
        }),
      });
    }

    return calls;
  }, [quote, address, selectedTokens, approvalStatuses, outputToken]);

  // ── 6. Handle Success ─────────────────────────────────────────────────────

  const handleSuccess = useCallback(
    async (txHash: string) => {
      setIsSweeping(false);

      const tokensSwept = selectedTokens.length;
      const earned = BASE_PARTICLES + PER_TOKEN_PARTICLES * tokensSwept;

      try {
        if (address) {
          await fetch('/api/points/record-sweep', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address, txHash, tokensSwept, outputToken, threshold }),
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

      setTimeout(() => { fetchDustTokens(); }, 3000);
    },
    [address, selectedTokens, outputToken, threshold, quote, fetchDustTokens]
  );

  const clearSuccess = useCallback(() => {
    setSuccessData(null);
    setParticlesEarned(null);
  }, []);

  // ── Return ─────────────────────────────────────────────────────────────────

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
