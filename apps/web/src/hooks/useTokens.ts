'use client';

/**
 * useTokens Hook
 * ===============
 * 
 * Fetches user's ERC-20 tokens on Base with balances, prices, and metadata.
 * Also manages recent searches and trending tokens.
 */

import { useState, useCallback, useEffect } from 'react';
import { useAccount, useBalance } from 'wagmi';
import { formatUnits, type Address } from 'viem';
import type { Token } from './useUniswapSwap';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TokenWithBalance extends Token {
  balance: bigint;
  balanceFormatted: string;
  priceUsd: number;
  usdValue: number;
}

export interface TrendingToken extends Token {
  volume24h: number;
  priceChange24h: number;
  priceUsd: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

// Popular Base tokens for fallback
const BASE_TOKENS: Token[] = [
  {
    address: '0x0000000000000000000000000000000000000000' as Address,
    symbol: 'ETH',
    name: 'Ethereum',
    decimals: 18,
    logoURI: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png',
  },
  {
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    logoURI: 'https://basescan.org/token/images/centre-usdc_28.png',
  },
  {
    address: '0x4200000000000000000000000000000000000006' as Address,
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    logoURI: 'https://basescan.org/token/images/weth_28.png',
  },
  {
    address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22' as Address,
    symbol: 'cbETH',
    name: 'Coinbase Wrapped Staked ETH',
    decimals: 18,
    logoURI: 'https://assets.coingecko.com/coins/images/26536/small/cbeth.png',
  },
  {
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
    symbol: 'USDbC',
    name: 'USD Base Coin',
    decimals: 6,
    logoURI: 'https://assets.coingecko.com/coins/images/32225/small/USDbC.png',
  },
  {
    address: '0x4Ed4E862860beD51a9570b96d89aF5E1B0Efefed' as Address,
    symbol: 'DEGEN',
    name: 'Degen',
    decimals: 18,
    logoURI: 'https://assets.coingecko.com/coins/images/32236/small/token_200x200.png',
  },
  {
    address: '0x940181a94A35A4569E4529A1CDf11B2565b43F84' as Address,
    symbol: 'AERO',
    name: 'Aerodrome',
    decimals: 18,
    logoURI: 'https://assets.coingecko.com/coins/images/23762/small/aerodrome.png',
  },
];

// ─── Recent Searches Management ───────────────────────────────────────────────

const RECENT_SEARCHES_KEY = 'dustswap_recent_searches';
const MAX_RECENT_SEARCHES = 10;

export function useRecentSearches() {
  const [recentSearches, setRecentSearches] = useState<Token[]>([]);

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(RECENT_SEARCHES_KEY);
      if (stored) {
        setRecentSearches(JSON.parse(stored));
      }
    } catch {
      // Ignore errors
    }
  }, []);

  const addRecentSearch = useCallback((token: Token) => {
    setRecentSearches(prev => {
      // Remove if already exists
      const filtered = prev.filter(t => t.address.toLowerCase() !== token.address.toLowerCase());
      // Add to front
      const updated = [token, ...filtered].slice(0, MAX_RECENT_SEARCHES);
      // Save to localStorage
      try {
        localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(updated));
      } catch {
        // Ignore
      }
      return updated;
    });
  }, []);

  const clearRecentSearches = useCallback(() => {
    setRecentSearches([]);
    try {
      localStorage.removeItem(RECENT_SEARCHES_KEY);
    } catch {
      // Ignore
    }
  }, []);

  return { recentSearches, addRecentSearch, clearRecentSearches };
}

// ─── Swap History Management ──────────────────────────────────────────────────

const SWAP_HISTORY_KEY = 'dustswap_swap_history';

export interface SwapHistoryItem {
  id: string;
  type: 'swap' | 'sweep';
  inputToken?: string;
  outputToken?: string;
  amountIn?: string;
  amountOut?: string;
  timestamp: number;
  status: 'pending' | 'confirmed' | 'failed';
  txHash?: string;
  orderId?: string;
}

export function useSwapHistory() {
  const [history, setHistory] = useState<SwapHistoryItem[]>([]);

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(SWAP_HISTORY_KEY);
      if (stored) {
        setHistory(JSON.parse(stored));
      }
    } catch {
      // Ignore
    }
  }, []);

  const addToHistory = useCallback((item: Omit<SwapHistoryItem, 'timestamp'>) => {
    setHistory(prev => {
      const updated = [{ ...item, timestamp: Date.now() }, ...prev].slice(0, 50);
      try {
        localStorage.setItem(SWAP_HISTORY_KEY, JSON.stringify(updated));
      } catch {
        // Ignore
      }
      return updated;
    });
  }, []);

  const updateStatus = useCallback((id: string, status: SwapHistoryItem['status']) => {
    setHistory(prev => {
      const updated = prev.map(item => 
        item.id === id ? { ...item, status } : item
      );
      try {
        localStorage.setItem(SWAP_HISTORY_KEY, JSON.stringify(updated));
      } catch {
        // Ignore
      }
      return updated;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    try {
      localStorage.removeItem(SWAP_HISTORY_KEY);
    } catch {
      // Ignore
    }
  }, []);

  return { history, addToHistory, updateStatus, clearHistory };
}

// ─── User Tokens Hook ─────────────────────────────────────────────────────────

export function useUserTokens() {
  const { address, isConnected } = useAccount();
  const [tokens, setTokens] = useState<TokenWithBalance[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch ETH balance separately
  const { data: ethBalance } = useBalance({
    address,
    query: { enabled: !!address },
  });

  const fetchUserTokens = useCallback(async () => {
    if (!address || !isConnected) {
      setTokens([]);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Call our backend API to get token balances
      const response = await fetch(`${API_BASE}/api/tokens/balances?address=${address}`);

      if (!response.ok) {
        throw new Error(`Failed to fetch tokens: ${response.status}`);
      }

      const data = await response.json();
      const tokenBalances = data.data?.tokens || data.tokens || [];

      // Format tokens with balance info
      const formattedTokens: TokenWithBalance[] = tokenBalances.map((t: any) => ({
        address: t.address || t.tokenAddress,
        symbol: t.symbol || 'UNKNOWN',
        name: t.name || 'Unknown Token',
        decimals: t.decimals || 18,
        logoURI: t.logoURI || t.image,
        balance: BigInt(t.balance || '0'),
        balanceFormatted: t.balanceFormatted || formatUnits(BigInt(t.balance || '0'), t.decimals || 18),
        priceUsd: t.priceUsd || 0,
        usdValue: t.usdValue || t.fiatBalance || 0,
      }));

      // Add ETH as first token
      if (ethBalance && ethBalance.value > 0n) {
        const ethToken: TokenWithBalance = {
          address: '0x0000000000000000000000000000000000000000' as Address,
          symbol: 'ETH',
          name: 'Ethereum',
          decimals: 18,
          logoURI: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png',
          balance: ethBalance.value,
          balanceFormatted: ethBalance.formatted,
          priceUsd: 0, // Will be fetched separately
          usdValue: 0,
        };
        
        // Insert ETH at the beginning
        formattedTokens.unshift(ethToken);
      }

      // Sort by USD value
      formattedTokens.sort((a, b) => b.usdValue - a.usdValue);

      setTokens(formattedTokens);
    } catch (err: any) {
      console.error('Failed to fetch user tokens:', err);
      setError(err.message || 'Failed to fetch tokens');
      
      // Fallback to base tokens with zero balance
      setTokens(BASE_TOKENS.map(t => ({
        ...t,
        balance: 0n,
        balanceFormatted: '0',
        priceUsd: 0,
        usdValue: 0,
      })));
    } finally {
      setIsLoading(false);
    }
  }, [address, isConnected, ethBalance]);

  useEffect(() => {
    fetchUserTokens();
  }, [fetchUserTokens]);

  return {
    tokens,
    isLoading,
    error,
    refetch: fetchUserTokens,
  };
}

// ─── Trending Tokens Hook ─────────────────────────────────────────────────────

export function useTrendingTokens() {
  const [tokens, setTokens] = useState<TrendingToken[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTrending = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Use CoinGecko API for trending tokens on Base
      // Alternative: Defined.fi API for more accurate data
      const response = await fetch(
        'https://api.coingecko.com/api/v3/coins/markets?' +
        new URLSearchParams({
          vs_currency: 'usd',
          category: 'base-ecosystem',
          order: 'volume_desc',
          per_page: '20',
          page: '1',
          sparkline: 'false',
          price_change_percentage: '24h',
        })
      );

      if (!response.ok) {
        throw new Error('Failed to fetch trending tokens');
      }

      const data = await response.json();

      const trending: TrendingToken[] = data.map((coin: any) => ({
        address: coin.platforms?.base || coin.contract_address || '',
        symbol: coin.symbol?.toUpperCase() || '',
        name: coin.name || '',
        decimals: 18, // Default
        logoURI: coin.image || '',
        volume24h: coin.total_volume || 0,
        priceChange24h: coin.price_change_percentage_24h || 0,
        priceUsd: coin.current_price || 0,
      }));

      setTokens(trending);
    } catch (err: any) {
      console.error('Failed to fetch trending tokens:', err);
      setError(err.message);

      // Fallback static data
      setTokens([
        {
          address: '0x940181a94A35A4569E4529A1CDf11B2565b43F84' as Address,
          symbol: 'AERO',
          name: 'Aerodrome',
          decimals: 18,
          logoURI: 'https://assets.coingecko.com/coins/images/23762/small/aerodrome.png',
          volume24h: 50000000,
          priceChange24h: 12.5,
          priceUsd: 1.15,
        },
        {
          address: '0x4Ed4E862860beD51a9570b96d89aF5E1B0Efefed' as Address,
          symbol: 'DEGEN',
          name: 'Degen',
          decimals: 18,
          logoURI: 'https://assets.coingecko.com/coins/images/32236/small/token_200x200.png',
          volume24h: 25000000,
          priceChange24h: 45.2,
          priceUsd: 0.02,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTrending();
  }, [fetchTrending]);

  return {
    tokens,
    isLoading,
    error,
    refetch: fetchTrending,
  };
}

// ─── Token Search Hook ────────────────────────────────────────────────────────

export function useTokenSearch() {
  const [results, setResults] = useState<Token[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const search = useCallback(async (query: string) => {
    if (!query || query.length < 2) {
      setResults([]);
      return;
    }

    setIsSearching(true);

    try {
      // Search via our backend API
      const response = await fetch(
        `${API_BASE}/api/tokens/search?q=${encodeURIComponent(query)}`
      );

      if (response.ok) {
        const data = await response.json();
        setResults(data.tokens || data.data || []);
      } else {
        // Fallback: filter base tokens
        const filtered = BASE_TOKENS.filter(
          t => t.symbol.toLowerCase().includes(query.toLowerCase()) ||
               t.name.toLowerCase().includes(query.toLowerCase())
        );
        setResults(filtered);
      }
    } catch {
      // Fallback
      const filtered = BASE_TOKENS.filter(
        t => t.symbol.toLowerCase().includes(query.toLowerCase()) ||
             t.name.toLowerCase().includes(query.toLowerCase())
      );
      setResults(filtered);
    } finally {
      setIsSearching(false);
    }
  }, []);

  return {
    results,
    isSearching,
    search,
    clear: () => setResults([]),
  };
}
