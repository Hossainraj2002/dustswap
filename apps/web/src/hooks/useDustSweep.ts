'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAccount } from 'wagmi';
import { type Address, formatUnits } from 'viem';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DustToken {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  balance: string;
  balanceFormatted: string;
  usdValue: number;
  priceUsd: number;
  logoURI?: string;
  hasLiquidity: boolean;
  isContentCoin?: boolean;
  isOwnContentCoin?: boolean;
}

export interface PerTokenQuote {
  tokenIn: string;
  amountIn: string;
  amountOut: string;
  estimatedAmountOut: string;
  minAmountOut: string;
  fromAmountUSD: string;
  toAmountUSD: string;
  priceImpact: string;
  poolFee: number;
  maxSwappablePercent?: number;
  success: boolean;
  error?: string;
  source?: string; // "cdp", "0x", or "uniswap"
  // Transaction data — gas/value are string|number for BigInt safety
  approveTransaction?: {
    to: string;
    data: string;
    gas: string | number;
    value: string | number;
  };
  swapTransaction?: {
    to: string;
    data: string;
    gas: string | number;
    value: string | number;
  };
}

export interface BatchQuote {
  selectedCount: number;
  totalDustValueUsd: number;
  swapFeeUsd: number;
  swapFeePercent: number;
  feeAmount?: string;
  estimatedOutput: string;
  estimatedOutputFormatted: string;
  outputToken: OutputTokenOption;
  outputTokenSymbol: string;
  outputTokenDecimals: number;
  perTokenQuotes: PerTokenQuote[];
  approveTransactions?: {
    to: string;
    data: string;
    gas: string | number;
    value: string | number;
  }[];
  sweepTransaction?: {
    to: string;
    data: string;
    gas: string | number;
    value: string | number;
  };
}

export interface TransactionCall {
  to: Address;
  data: `0x${string}`;
  value?: bigint;
}

export interface SuccessData {
  txHash: string;
  tokensSwept: number;
  amountReceived: string;
  outputSymbol: string;
  particlesEarned: number;
}

export type ThresholdValue = 1 | 2 | 5 | 10;
export type OutputTokenOption = 'ETH' | 'USDC' | 'WETH';

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
  showOwnContentCoins: boolean;
  setShowOwnContentCoins: (v: boolean) => void;
  ownContentCoinCount: number;
  contentCoinCount: number;
  particlesEarned: number | null;
  successData: SuccessData | null;
  clearSuccess: () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const USDC_ADDRESS: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_ADDRESS: Address = '0x4200000000000000000000000000000000000006';

const OUTPUT_TOKEN_MAP: Record<
  OutputTokenOption,
  { address: Address; symbol: string; decimals: number; logoURI: string }
> = {
  ETH:  { address: WETH_ADDRESS, symbol: 'ETH',  decimals: 18, logoURI: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png' },
  USDC: { address: USDC_ADDRESS, symbol: 'USDC', decimals: 6,  logoURI: 'https://basescan.org/token/images/centre-usdc_28.png' },
  WETH: { address: WETH_ADDRESS, symbol: 'WETH', decimals: 18, logoURI: 'https://basescan.org/token/images/weth_28.png' },
};

const MAX_SELECTED_TOKENS = 10;
const BASE_PARTICLES = 50;
const PER_TOKEN_PARTICLES = 5;

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useDustSweep(): UseDustSweepReturn {
  const { address, isConnected } = useAccount();

  // ── State ──────────────────────────────────────────────────────────────────

  const [threshold, setThreshold] = useState<ThresholdValue>(5);
  const [allDustTokens, setAllDustTokens] = useState<DustToken[]>([]);
  const [allNoLiquidityTokens, setAllNoLiquidityTokens] = useState<DustToken[]>([]);
  const [selectedAddresses, setSelectedAddresses] = useState<Set<Address>>(new Set());
  const [outputToken, setOutputToken] = useState<OutputTokenOption>('ETH');
  const [quote, setQuote] = useState<BatchQuote | null>(null);

  const [isLoading, setIsLoading] = useState(false);
  const [isQuoting, setIsQuoting] = useState(false);
  const [isSweeping, setIsSweeping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const [particlesEarned, setParticlesEarned] = useState<number | null>(null);
  const [successData, setSuccessData] = useState<SuccessData | null>(null);

  const [showOwnContentCoins, setShowOwnContentCoins] = useState(false);

  // ── Derived State ──────────────────────────────────────────────────────────

  const ownContentCoinCount = allDustTokens.filter(t => t.isOwnContentCoin).length;
  const contentCoinCount = allDustTokens.filter(t => t.isContentCoin).length;
  const dustTokens = showOwnContentCoins ? allDustTokens : allDustTokens.filter(t => !t.isContentCoin);
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

      const json = await response.json() as { data?: Record<string, unknown> } & Record<string, unknown>;

      // Handle both wrapped { data: {...} } and flat response formats
      const data = (json.data || json) as {
        dustTokens?: Record<string, unknown>[];
        noLiquidityTokens?: Record<string, unknown>[];
      };

      const rawDustTokens = data.dustTokens || [];
      const rawNoLiquidityTokens = data.noLiquidityTokens || [];

      const parseToken = (t: Record<string, unknown>): DustToken => ({
        address:          (t.address || t.tokenAddress) as Address,
        name:             (t.name || 'Unknown') as string,
        symbol:           (t.symbol || '???') as string,
        decimals:         Number(t.decimals ?? 18),
        balance:          String(t.balance || '0'),
        balanceFormatted: String(t.balanceFormatted || t.balance || '0'),
        usdValue:         Number(t.usdValue || t.valueUsd || t.fiatBalance || 0),
        priceUsd:         Number(t.priceUsd || 0),
        logoURI:          (t.logoURI || t.image || undefined) as string | undefined,
        hasLiquidity:     t.hasLiquidity !== false,
        isContentCoin:    Boolean(t.isContentCoin),
        isOwnContentCoin: Boolean(t.isOwnContentCoin),
      });

      const parsedDust = rawDustTokens.map(parseToken);
      const parsedNoLiq = rawNoLiquidityTokens.map((t) => ({
        ...parseToken(t),
        hasLiquidity: false,
      }));

      setAllDustTokens(parsedDust);
      setAllNoLiquidityTokens(parsedNoLiq);
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

  // Auto-select when tokens are fetched or filter is toggled
  useEffect(() => {
    const visibleTokens = showOwnContentCoins ? allDustTokens : allDustTokens.filter(t => !t.isContentCoin);
    const autoSelected = new Set<Address>(
      visibleTokens.filter(t => t.hasLiquidity).slice(0, MAX_SELECTED_TOKENS).map((t) => t.address)
    );
    setSelectedAddresses(autoSelected);
  }, [allDustTokens, showOwnContentCoins]);

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
        const visibleSelectedCount = dustTokens.filter(t => prev.has(t.address)).length;
        if (visibleSelectedCount >= MAX_SELECTED_TOKENS) return prev;
        next.add(tokenAddress);
      }
      return next;
    });
  }, [dustTokens]);

  const selectAll = useCallback(() => {
    const selectable = dustTokens
      .filter((t) => t.hasLiquidity)
      .slice(0, MAX_SELECTED_TOKENS)
      .map((t) => t.address);
    setSelectedAddresses(new Set(selectable));
  }, [dustTokens]);

  const deselectAll = useCallback(() => {
    setSelectedAddresses(new Set());
  }, []);

  // ── 3. Get Batch Quote ─────────────────────────────────────────────────────

  const getQuote = useCallback(async () => {
    if (selectedTokens.length === 0) {
      setQuoteError('No tokens selected');
      return;
    }

    if (!address) {
      setQuoteError('Wallet not connected');
      return;
    }

    setIsQuoting(true);
    setQuoteError(null);
    setQuote(null);

    try {
      const tokenOutInfo = OUTPUT_TOKEN_MAP[outputToken];

      const response = await fetch('/api/tokens/batch-quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orders: selectedTokens.map((t) => ({
            tokenIn: t.address,
            amountIn: t.balance,
            decimals: t.decimals,
            symbol: t.symbol,
            name: t.name,
          })),
          tokenOut: tokenOutInfo.address,
          walletAddress: address,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(errorData.error || `Quote failed: ${response.status}`);
      }

      const json = await response.json() as Record<string, unknown>;
      const data = (json.data || json) as Record<string, unknown>;
      const summary = (data.summary || data) as Record<string, unknown>;
      const quotesRaw = (data.perTokenQuotes || data.quotes || []) as PerTokenQuote[];

      // Filter only successful quotes
      const validQuotes = quotesRaw.filter((q) => q.success && q.amountOut && q.amountOut !== '0');

      if (validQuotes.length === 0) {
        throw new Error('No tokens could be quoted — they may have no swap liquidity');
      }

      const outputDecimals = tokenOutInfo.decimals;
      const netOutputRaw = String(summary.netOutput || summary.estimatedOutput || '0');

      let totalDustUsd = 0;
      for (const q of validQuotes) {
        totalDustUsd += parseFloat(q.fromAmountUSD || '0');
      }

      let estimatedOutputFormatted = '0';
      try {
        estimatedOutputFormatted = formatUnits(BigInt(netOutputRaw || '0'), outputDecimals);
      } catch {
        estimatedOutputFormatted = '0';
      }

      const feePercent = Number(summary.dustSweepFeeBps ?? 200) / 100;
      const swapFeeUsd = Number(data.swapFeeUsd || (totalDustUsd * feePercent) / 100);

      // Extract contract-routed transaction data
      const apiApproveTransactions = (data.approveTransactions || []) as BatchQuote['approveTransactions'];
      const apiSweepTransaction = (data.sweepTransaction || undefined) as BatchQuote['sweepTransaction'];

      const batchQuote: BatchQuote = {
        selectedCount: validQuotes.length,
        totalDustValueUsd: Math.round(totalDustUsd * 100) / 100,
        swapFeeUsd: Math.round(swapFeeUsd * 100) / 100,
        swapFeePercent: feePercent,
        estimatedOutput: netOutputRaw,
        estimatedOutputFormatted,
        outputToken,
        outputTokenSymbol: tokenOutInfo.symbol,
        outputTokenDecimals: outputDecimals,
        perTokenQuotes: validQuotes,
        approveTransactions: apiApproveTransactions,
        sweepTransaction: apiSweepTransaction,
      };

      setQuote(batchQuote);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get quote';
      setQuoteError(message);
    } finally {
      setIsQuoting(false);
    }
  }, [selectedTokens, outputToken, address]);

  // Auto-quote when selection changes (debounced)
  useEffect(() => {
    if (selectedTokens.length > 0 && address) {
      const timer = setTimeout(() => { getQuote(); }, 500);
      return () => clearTimeout(timer);
    }
  }, [selectedTokens.length, outputToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 4. Build Sweep Transaction Calls ──────────────────────────────────────
  // Uses the pre-built transaction data from buildSwapTransaction API

  const sweepCalls = useMemo((): TransactionCall[] => {
    if (!quote || !address || selectedTokens.length === 0) {
      return [];
    }

    const calls: TransactionCall[] = [];

    // Contract-routed flow: N approve calls + 1 sweep call
    // Fee is extracted on-chain by the DustSweepRouter contract
    if (quote.approveTransactions && quote.sweepTransaction) {
      // Add all approve transactions
      for (const approveTx of quote.approveTransactions) {
        if (approveTx.to && approveTx.data) {
          calls.push({
            to: approveTx.to as Address,
            data: approveTx.data as `0x${string}`,
            value: 0n,
          });
        }
      }

      // Add the single sweep transaction
      if (quote.sweepTransaction.to && quote.sweepTransaction.data) {
        calls.push({
          to: quote.sweepTransaction.to as Address,
          data: quote.sweepTransaction.data as `0x${string}`,
          value: BigInt(quote.sweepTransaction.value || 0),
        });
      }
    } else {
      // Fallback: per-token calls (for backward compat if router not configured)
      for (const pq of quote.perTokenQuotes) {
        if (!pq.success) continue;

        if (pq.approveTransaction && pq.approveTransaction.to && pq.approveTransaction.data) {
          calls.push({
            to: pq.approveTransaction.to as Address,
            data: pq.approveTransaction.data as `0x${string}`,
            value: BigInt(pq.approveTransaction.value || 0),
          });
        }

        if (pq.swapTransaction && pq.swapTransaction.to && pq.swapTransaction.data) {
          calls.push({
            to: pq.swapTransaction.to as Address,
            data: pq.swapTransaction.data as `0x${string}`,
            value: BigInt(pq.swapTransaction.value || 0),
          });
        }
      }
    }

    return calls;
  }, [quote, address, selectedTokens]);

  // ── 5. Handle Success ─────────────────────────────────────────────────────

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
    showOwnContentCoins,
    setShowOwnContentCoins,
    ownContentCoinCount,
    contentCoinCount,
    particlesEarned,
    successData,
    clearSuccess,
  };
}
