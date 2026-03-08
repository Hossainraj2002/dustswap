'use client';

/**
 * Swap Page - Native Uniswap Clone
 * ==================================
 * 
 * Complete DEX swap interface using Uniswap Trading API.
 * Features: Your Tokens, Recent Searches, Trending Tokens, Transaction History
 * 
 * FIXED: Mobile responsive, token overflow, % buttons for all tokens
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useAccount, useBalance, useReadContracts } from 'wagmi';
import { formatUnits, parseUnits, erc20Abi, type Address } from 'viem';
import {
  Transaction,
  TransactionButton,
  TransactionStatus,
  TransactionStatusLabel,
  TransactionStatusAction,
} from '@coinbase/onchainkit/transaction';
import { Wallet, ConnectWallet } from '@coinbase/onchainkit/wallet';
import { useUniswapSwap, formatSwapAmount, type Token } from '@/hooks/useUniswapSwap';
import {
  useUserTokens,
  useTrendingTokens,
  useRecentSearches,
  useSwapHistory,
  useTokenSearch,
  type TokenWithBalance,
  type TrendingToken,
} from '@/hooks/useTokens';

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_CHAIN_ID = 8453;
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NATIVE_ETH = '0x0000000000000000000000000000000000000000';

// Default tokens
const DEFAULT_INPUT_TOKEN: Token = {
  address: NATIVE_ETH as Address,
  symbol: 'ETH',
  name: 'Ethereum',
  decimals: 18,
  logoURI: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png',
};

const DEFAULT_OUTPUT_TOKEN: Token = {
  address: USDC_ADDRESS as Address,
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  logoURI: 'https://basescan.org/token/images/centre-usdc_28.png',
};

// ─── Token Selector Modal ──────────────────────────────────────────────────────

interface TokenSelectorProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (token: Token) => void;
  excludeToken?: Token | null;
  title: string;
}

function TokenSelector({ isOpen, onClose, onSelect, excludeToken, title }: TokenSelectorProps) {
  const [activeTab, setActiveTab] = useState<'your-tokens' | 'trending' | 'search'>('your-tokens');
  const [searchQuery, setSearchQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const { tokens: userTokens, isLoading: loadingUserTokens } = useUserTokens();
  const { tokens: trendingTokens, isLoading: loadingTrending } = useTrendingTokens();
  const { recentSearches, addRecentSearch } = useRecentSearches();
  const { results: searchResults, isSearching, search, clear: clearSearch } = useTokenSearch();

  // Handle search
  useEffect(() => {
    if (searchQuery.length >= 2) {
      setActiveTab('search');
      search(searchQuery);
    }
  }, [searchQuery, search]);

  // Focus input on open
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  // Handle token selection
  const handleSelect = useCallback((token: Token) => {
    addRecentSearch(token);
    onSelect(token);
    onClose();
    setSearchQuery('');
    clearSearch();
  }, [addRecentSearch, onSelect, onClose, clearSearch]);

  // Filter out excluded token
  const filteredUserTokens = useMemo(() => 
    userTokens.filter(t => 
      t.address.toLowerCase() !== excludeToken?.address?.toLowerCase()
    ),
    [userTokens, excludeToken]
  );

  const filteredTrending = useMemo(() => 
    trendingTokens.filter(t => 
      t.address.toLowerCase() !== excludeToken?.address?.toLowerCase()
    ),
    [trendingTokens, excludeToken]
  );

  const filteredSearchResults = useMemo(() => 
    searchResults.filter(t => 
      t.address.toLowerCase() !== excludeToken?.address?.toLowerCase()
    ),
    [searchResults, excludeToken]
  );

  const filteredRecent = useMemo(() => 
    recentSearches.filter(t => 
      t.address.toLowerCase() !== excludeToken?.address?.toLowerCase()
    ),
    [recentSearches, excludeToken]
  );

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center safe-area-inset">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative w-full max-w-md bg-[#0D111C] border border-[#1B2236] rounded-t-3xl sm:rounded-3xl max-h-[80dvh] sm:max-h-[85vh] overflow-hidden flex flex-col animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[#1B2236] shrink-0">
          <h2 className="text-lg font-semibold text-white font-syne">{title}</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-[#1B2236] text-gray-400 hover:text-white hover:bg-[#293249] transition-colors"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Search */}
        <div className="p-4 border-b border-[#1B2236] shrink-0">
          <div className="relative">
            <input
              ref={inputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search token name or paste address"
              className="w-full px-4 py-3.5 pl-11 bg-[#131A2A] border border-[#1B2236] rounded-2xl text-white placeholder-gray-500 focus:outline-none focus:border-[#3b82f6] text-sm transition-colors"
            />
            <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
        </div>

        {/* Tabs - Hidden during search */}
        {searchQuery.length < 2 && (
          <div className="flex border-b border-[#1B2236] shrink-0">
            <button
              onClick={() => setActiveTab('your-tokens')}
              className={`flex-1 py-3.5 text-sm font-medium transition-colors ${
                activeTab === 'your-tokens'
                  ? 'text-[#3b82f6] border-b-2 border-[#3b82f6]'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              Your Tokens
            </button>
            <button
              onClick={() => setActiveTab('trending')}
              className={`flex-1 py-3.5 text-sm font-medium transition-colors ${
                activeTab === 'trending'
                  ? 'text-[#3b82f6] border-b-2 border-[#3b82f6]'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              Trending
            </button>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto overscroll-contain">
          {/* Recent Searches */}
          {activeTab !== 'search' && filteredRecent.length > 0 && (
            <div className="p-4 border-b border-[#1B2236]">
              <p className="text-xs text-gray-500 uppercase tracking-wide mb-3">Recent</p>
              <div className="flex flex-wrap gap-2">
                {filteredRecent.slice(0, 6).map((token) => (
                  <button
                    key={token.address}
                    onClick={() => handleSelect(token)}
                    className="flex items-center gap-2 px-3 py-2 bg-[#1B2236] rounded-xl hover:bg-[#293249] transition-colors"
                  >
                    {token.logoURI ? (
                      <img 
                        src={token.logoURI} 
                        alt={token.symbol} 
                        className="w-5 h-5 rounded-full"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    ) : (
                      <div className="w-5 h-5 rounded-full bg-gradient-to-br from-[#3b82f6] to-[#8b5cf6] flex items-center justify-center text-[10px] font-bold text-white">
                        {token.symbol?.charAt(0) || '?'}
                      </div>
                    )}
                    <span className="text-sm text-white font-medium">{token.symbol}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Search Results */}
          {searchQuery.length >= 2 && (
            <div className="p-2">
              {isSearching ? (
                <div className="flex items-center justify-center py-12">
                  <div className="w-6 h-6 border-2 border-[#3b82f6] border-t-transparent rounded-full animate-spin" />
                </div>
              ) : filteredSearchResults.length > 0 ? (
                filteredSearchResults.map((token) => (
                  <TokenRow
                    key={token.address}
                    token={token}
                    onClick={() => handleSelect(token)}
                  />
                ))
              ) : (
                <div className="text-center py-12 text-gray-500">
                  <div className="text-3xl mb-2">🔍</div>
                  <p>No tokens found for "{searchQuery}"</p>
                </div>
              )}
            </div>
          )}

          {/* Your Tokens */}
          {activeTab === 'your-tokens' && searchQuery.length < 2 && (
            <div className="p-2">
              {loadingUserTokens ? (
                <div className="space-y-1">
                  {[...Array(5)].map((_, i) => (
                    <TokenRowSkeleton key={i} />
                  ))}
                </div>
              ) : filteredUserTokens.length > 0 ? (
                filteredUserTokens.map((token) => (
                  <TokenRow
                    key={token.address}
                    token={token}
                    balance={token.balanceFormatted}
                    usdValue={token.usdValue}
                    onClick={() => handleSelect(token)}
                  />
                ))
              ) : (
                <div className="text-center py-12 text-gray-500">
                  <div className="text-3xl mb-2">👛</div>
                  <p>No tokens found in your wallet</p>
                </div>
              )}
            </div>
          )}

          {/* Trending */}
          {activeTab === 'trending' && searchQuery.length < 2 && (
            <div className="p-2">
              {loadingTrending ? (
                <div className="space-y-1">
                  {[...Array(5)].map((_, i) => (
                    <TokenRowSkeleton key={i} />
                  ))}
                </div>
              ) : filteredTrending.length > 0 ? (
                filteredTrending.map((token, index) => (
                  <TokenRow
                    key={token.address}
                    token={token}
                    priceUsd={token.priceUsd}
                    priceChange={token.priceChange24h}
                    rank={index + 1}
                    onClick={() => handleSelect(token)}
                  />
                ))
              ) : (
                <div className="text-center py-12 text-gray-500">
                  <div className="text-3xl mb-2">📈</div>
                  <p>Failed to load trending tokens</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Token Row Component ───────────────────────────────────────────────────────

interface TokenRowProps {
  token: Token;
  balance?: string;
  usdValue?: number;
  priceUsd?: number;
  priceChange?: number;
  rank?: number;
  onClick: () => void;
}

function TokenRow({ token, balance, usdValue, priceUsd, priceChange, rank, onClick }: TokenRowProps) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-[#131A2A] active:bg-[#1B2236] transition-colors"
    >
      <div className="flex items-center gap-3 min-w-0">
        {rank && (
          <span className="w-5 text-xs text-gray-500 text-right shrink-0">{rank}</span>
        )}
        {token.logoURI ? (
          <img 
            src={token.logoURI} 
            alt={token.symbol} 
            className="w-9 h-9 rounded-full bg-[#1B2236] shrink-0"
            onError={(e) => {
              (e.target as HTMLImageElement).src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="%233b82f6"/><text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" fill="white" font-size="16" font-weight="bold">' + (token.symbol?.charAt(0) || '?') + '</text></svg>';
            }}
          />
        ) : (
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#3b82f6] to-[#8b5cf6] flex items-center justify-center text-white font-bold text-sm shrink-0">
            {token.symbol?.charAt(0) || '?'}
          </div>
        )}
        <div className="text-left min-w-0">
          <p className="font-medium text-white truncate">{token.symbol}</p>
          <p className="text-xs text-gray-500 truncate">{token.name}</p>
        </div>
      </div>
      <div className="text-right shrink-0 pl-2">
        {balance && (
          <>
            <p className="font-medium text-white text-sm">{formatSwapAmount(balance)}</p>
            {usdValue !== undefined && usdValue > 0 && (
              <p className="text-xs text-gray-500">${formatSwapAmount(usdValue, 2)}</p>
            )}
          </>
        )}
        {priceUsd !== undefined && (
          <>
            <p className="font-medium text-white text-sm">${formatSwapAmount(priceUsd, priceUsd < 1 ? 6 : 2)}</p>
            {priceChange !== undefined && (
              <p className={`text-xs ${priceChange >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {priceChange >= 0 ? '+' : ''}{priceChange.toFixed(2)}%
              </p>
            )}
          </>
        )}
      </div>
    </button>
  );
}

function TokenRowSkeleton() {
  return (
    <div className="flex items-center justify-between p-3 rounded-xl animate-pulse">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-[#1B2236]" />
        <div>
          <div className="w-16 h-4 bg-[#1B2236] rounded mb-1" />
          <div className="w-12 h-3 bg-[#1B2236] rounded" />
        </div>
      </div>
      <div className="text-right">
        <div className="w-16 h-4 bg-[#1B2236] rounded mb-1" />
        <div className="w-12 h-3 bg-[#1B2236] rounded" />
      </div>
    </div>
  );
}

// ─── Transaction History Panel ─────────────────────────────────────────────────

interface TransactionHistoryProps {
  isOpen: boolean;
  onClose: () => void;
}

function TransactionHistory({ isOpen, onClose }: TransactionHistoryProps) {
  const { history, clearHistory } = useSwapHistory();

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center safe-area-inset">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      
      <div className="relative w-full max-w-md bg-[#0D111C] border border-[#1B2236] rounded-t-3xl sm:rounded-3xl max-h-[70dvh] sm:max-h-[70vh] overflow-hidden flex flex-col animate-slide-up">
        <div className="flex items-center justify-between p-4 border-b border-[#1B2236] shrink-0">
          <h2 className="text-lg font-semibold text-white font-syne">Recent Transactions</h2>
          <div className="flex items-center gap-2">
            {history.length > 0 && (
              <button
                onClick={clearHistory}
                className="text-xs text-gray-500 hover:text-red-400 transition-colors px-2 py-1"
              >
                Clear All
              </button>
            )}
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-full bg-[#1B2236] text-gray-400 hover:text-white hover:bg-[#293249] transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {history.length > 0 ? (
            <div className="space-y-3">
              {history.map((item) => (
                <div key={item.id} className="p-3 bg-[#131A2A] rounded-xl border border-[#1B2236]">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-white">
                      Swap {item.inputToken} → {item.outputToken}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      item.status === 'confirmed' ? 'bg-green-500/20 text-green-400' :
                      item.status === 'pending' ? 'bg-yellow-500/20 text-yellow-400' :
                      'bg-red-500/20 text-red-400'
                    }`}>
                      {item.status}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-gray-500">
                    <span>{item.amountIn} {item.inputToken}</span>
                    <span>→ {item.amountOut} {item.outputToken}</span>
                  </div>
                  <div className="flex items-center justify-between mt-2 text-xs">
                    <span className="text-gray-600">
                      {new Date(item.timestamp).toLocaleString()}
                    </span>
                    {item.txHash && (
                      <a
                        href={`https://basescan.org/tx/${item.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[#3b82f6] hover:underline"
                      >
                        View on Basescan ↗
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-16 text-gray-500">
              <div className="text-4xl mb-3">📋</div>
              <p className="font-medium">No transactions yet</p>
              <p className="text-sm mt-1 text-gray-600">Your swap history will appear here</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Swap Component ───────────────────────────────────────────────────────

export default function SwapPage() {
  const { address, isConnected } = useAccount();
  const swap = useUniswapSwap();
  const { addRecentSearch } = useRecentSearches();
  const { addToHistory, updateStatus } = useSwapHistory();
  const { tokens: userTokens, refetch: refetchUserTokens } = useUserTokens();

  // UI State
  const [showTokenSelector, setShowTokenSelector] = useState<'input' | 'output' | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);

  // Initialize with default tokens
  useEffect(() => {
    if (!swap.inputToken) {
      swap.setInputToken(DEFAULT_INPUT_TOKEN);
    }
    if (!swap.outputToken) {
      swap.setOutputToken(DEFAULT_OUTPUT_TOKEN);
    }
  }, []);

  // ETH balance for native token
  const { data: ethBalance } = useBalance({
    address,
    query: { enabled: !!address },
  });

  // Get balance for selected input token (for % buttons)
  const getTokenBalance = useCallback((token: Token | null): string => {
    if (!token || !address) return '0';
    
    // Native ETH
    if (token.address.toLowerCase() === NATIVE_ETH.toLowerCase()) {
      return ethBalance?.formatted || '0';
    }
    
    // Find in user tokens
    const userToken = userTokens.find(
      t => t.address.toLowerCase() === token.address.toLowerCase()
    );
    return userToken?.balanceFormatted || '0';
  }, [address, ethBalance, userTokens]);

  // Handle token selection
  const handleSelectToken = useCallback((token: Token) => {
    if (showTokenSelector === 'input') {
      swap.setInputToken(token);
    } else if (showTokenSelector === 'output') {
      swap.setOutputToken(token);
    }
    addRecentSearch(token);
    setShowTokenSelector(null);
  }, [showTokenSelector, swap, addRecentSearch]);

  // Handle percentage buttons - FIXED: uses fresh balance data
  const handleSetPercentage = useCallback((percent: number) => {
    if (!swap.inputToken || !address) return;
    
    // Get fresh balance directly
    let balanceStr = '0';
    if (swap.inputToken.address.toLowerCase() === NATIVE_ETH.toLowerCase()) {
      balanceStr = ethBalance?.formatted || '0';
    } else {
      const userToken = userTokens.find(
        t => t.address.toLowerCase() === swap.inputToken!.address.toLowerCase()
      );
      balanceStr = userToken?.balanceFormatted || '0';
    }
    
    const balance = parseFloat(balanceStr);
    if (!balance || balance <= 0) return;
    
    // For native ETH, leave some for gas (except 100%)
    let maxAmount = balance;
    if (swap.inputToken.address.toLowerCase() === NATIVE_ETH.toLowerCase() && percent < 100) {
      // Leave ~0.005 ETH for gas when using percentage buttons
      maxAmount = Math.max(0, maxAmount - 0.005);
    }
    
    const amount = maxAmount * (percent / 100);
    const formattedAmount = amount > 0
      ? amount.toFixed(swap.inputToken.decimals > 6 ? 6 : swap.inputToken.decimals)
      : '0';
    
    swap.setAmountIn(formattedAmount);
  }, [swap.inputToken, address, ethBalance, userTokens, swap.setAmountIn]);

  // Handle swap execution
  const handleSwap = useCallback(async () => {
    const result = await swap.executeSwap();
    
    if (result.success) {
      setLastTxHash(result.txHash || null);
      addToHistory({
        id: result.txHash || Date.now().toString(),
        type: 'swap',
        inputToken: swap.inputToken?.symbol,
        outputToken: swap.outputToken?.symbol,
        amountIn: swap.amountIn,
        amountOut: swap.amountOut,
        status: 'confirmed',
        txHash: result.txHash,
      });
      // Refresh token balances after swap
      refetchUserTokens();
    } else {
      addToHistory({
        id: Date.now().toString(),
        type: 'swap',
        inputToken: swap.inputToken?.symbol,
        outputToken: swap.outputToken?.symbol,
        amountIn: swap.amountIn,
        amountOut: swap.amountOut,
        status: 'failed',
      });
    }
    
    return result;
  }, [swap, addToHistory, refetchUserTokens]);

  // Compute button state
  const buttonState = useMemo(() => {
    if (!isConnected) return { text: 'Connect Wallet', disabled: false, action: 'connect' };
    if (!swap.inputToken || !swap.outputToken) return { text: 'Select Token', disabled: true, action: 'none' };
    if (!swap.amountIn || parseFloat(swap.amountIn) <= 0) return { text: 'Enter Amount', disabled: true, action: 'none' };
    
    // Check balance
    const balance = getTokenBalance(swap.inputToken);
    if (parseFloat(balance) < parseFloat(swap.amountIn)) {
      return { text: 'Insufficient Balance', disabled: true, action: 'none' };
    }
    
    if (swap.isQuoting) return { text: 'Getting Quote...', disabled: true, action: 'none' };
    if (swap.error) return { text: swap.error.slice(0, 30), disabled: false, action: 'retry' };
    if (!swap.quote) return { text: 'Get Quote', disabled: false, action: 'quote' };
    if (swap.isApproving) return { text: 'Approving...', disabled: true, action: 'none' };
    if (swap.isSwapping) return { text: 'Swapping...', disabled: true, action: 'none' };
    return { text: 'Swap', disabled: false, action: 'swap' };
  }, [isConnected, swap, getTokenBalance]);

  // ── Render: Not Connected ────────────────────────────────────────────────────

  if (!isConnected) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center p-4">
        <div className="max-w-md w-full">
          <div className="text-center mb-8">
            <div className="text-6xl mb-4">💫</div>
            <h1 className="text-3xl font-bold text-white font-syne mb-2">Swap Tokens</h1>
            <p className="text-gray-400">Connect your wallet to start swapping on Base</p>
          </div>
          
          <div className="bg-[#0D111C] border border-[#1B2236] rounded-3xl p-6">
            <Wallet>
              <ConnectWallet className="w-full">
                <button className="w-full py-4 bg-[#3b82f6] hover:bg-[#2563eb] text-white font-semibold rounded-2xl transition-colors font-syne">
                  Connect Wallet
                </button>
              </ConnectWallet>
            </Wallet>
          </div>
        </div>
      </div>
    );
  }

  // ── Render: Main UI ──────────────────────────────────────────────────────────

  const inputBalance = getTokenBalance(swap.inputToken);

  return (
    <div className="min-h-[calc(100vh-80px)] pb-20 pt-2 px-3 sm:px-4 overflow-x-hidden">
      <div className="w-full max-w-md mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-3 px-1">
          <h1 className="text-xl font-bold text-white font-syne">Swap</h1>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setShowHistory(true)}
              className="p-2.5 rounded-xl bg-[#0D111C] border border-[#1B2236] text-gray-400 hover:text-white hover:border-[#3b82f6]/50 transition-colors"
              aria-label="Transaction History"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
            <button
              onClick={() => setShowSettings(!showSettings)}
              className={`p-2.5 rounded-xl border transition-colors ${
                showSettings 
                  ? 'bg-[#3b82f6]/20 border-[#3b82f6]/50 text-[#3b82f6]' 
                  : 'bg-[#0D111C] border-[#1B2236] text-gray-400 hover:text-white hover:border-[#3b82f6]/50'
              }`}
              aria-label="Settings"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          </div>
        </div>

        {/* Settings Panel */}
        {showSettings && (
          <div className="mb-3 p-4 bg-[#0D111C] border border-[#1B2236] rounded-2xl animate-fade-in">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-gray-400">Slippage Tolerance</span>
              <div className="flex items-center gap-2">
                {[0.1, 0.5, 1.0].map((s) => (
                  <button
                    key={s}
                    onClick={() => swap.setSlippage(s)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                      swap.slippage === s
                        ? 'bg-[#3b82f6] text-white'
                        : 'bg-[#1B2236] text-gray-400 hover:text-white hover:bg-[#293249]'
                    }`}
                  >
                    {s}%
                  </button>
                ))}
                <div className="relative">
                  <input
                    type="number"
                    value={swap.slippage}
                    onChange={(e) => swap.setSlippage(parseFloat(e.target.value) || 0.5)}
                    className="w-16 px-2 py-1.5 bg-[#1B2236] rounded-lg text-white text-sm text-center focus:outline-none focus:ring-1 focus:ring-[#3b82f6]"
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 text-xs">%</span>
                </div>
              </div>
            </div>
            <p className="text-xs text-gray-500 flex items-center gap-1">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
              </svg>
              Fee: 0.2% is automatically included in the swap route
            </p>
          </div>
        )}

        {/* Main Swap Card */}
        <div className="bg-[#0D111C] border border-[#1B2236] rounded-3xl p-3 relative">
          {/* Input Token */}
          <div className="bg-[#131A2A] rounded-2xl p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-gray-500">You pay</span>
              {swap.inputToken && (
                <span className="text-sm text-gray-500">
                  Balance: {formatSwapAmount(inputBalance)}
                </span>
              )}
            </div>
            
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={swap.amountIn}
                onChange={(e) => swap.setAmountIn(e.target.value)}
                placeholder="0"
                className="flex-1 min-w-0 bg-transparent text-2xl sm:text-3xl font-medium text-white outline-none placeholder-gray-600 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <button
                onClick={() => setShowTokenSelector('input')}
                className="flex items-center gap-2 px-3 py-2 bg-[#1B2236] rounded-2xl hover:bg-[#293249] transition-colors shrink-0"
              >
                {swap.inputToken?.logoURI ? (
                  <img 
                    src={swap.inputToken.logoURI} 
                    alt="" 
                    className="w-6 h-6 rounded-full"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                ) : (
                  <div className="w-6 h-6 rounded-full bg-gradient-to-br from-[#3b82f6] to-[#8b5cf6] flex items-center justify-center text-xs font-bold text-white">
                    {swap.inputToken?.symbol?.charAt(0) || '?'}
                  </div>
                )}
                <span className="font-medium text-white text-sm">{swap.inputToken?.symbol || 'Select'}</span>
                <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </div>

            {/* Percentage Buttons - FIXED FOR ALL TOKENS */}
            {swap.inputToken && parseFloat(inputBalance) > 0 && (
              <div className="flex flex-wrap items-center gap-2 mt-3">
                {[25, 50, 75, 100].map((pct) => (
                  <button
                    key={pct}
                    onClick={() => handleSetPercentage(pct)}
                    className="px-3 py-1.5 text-xs font-medium text-[#3b82f6] bg-[#3b82f6]/10 border border-[#3b82f6]/20 rounded-lg hover:bg-[#3b82f6]/20 hover:border-[#3b82f6]/30 transition-colors active:scale-95"
                  >
                    {pct}%
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Switch Button */}
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10">
            <button
              onClick={swap.switchTokens}
              className="w-10 h-10 flex items-center justify-center bg-[#0D111C] border-4 border-[#131A2A] rounded-xl hover:bg-[#1B2236] hover:border-[#293249] transition-all active:scale-90"
              aria-label="Switch tokens"
            >
              <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
              </svg>
            </button>
          </div>

          {/* Output Token */}
          <div className="bg-[#131A2A] rounded-2xl p-4 mt-1">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-gray-500">You receive</span>
              {swap.quote && swap.outputToken && (
                <span className="text-sm text-gray-500">
                  1 {swap.inputToken?.symbol} ≈ {formatSwapAmount(parseFloat(swap.amountOut) / Math.max(parseFloat(swap.amountIn || '1'), 0.000001))} {swap.outputToken?.symbol}
                </span>
              )}
            </div>
            
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={swap.isQuoting ? '...' : swap.amountOut || '0'}
                readOnly
                placeholder="0"
                className="flex-1 min-w-0 bg-transparent text-2xl sm:text-3xl font-medium text-white outline-none placeholder-gray-600"
              />
              <button
                onClick={() => setShowTokenSelector('output')}
                className="flex items-center gap-2 px-3 py-2 bg-[#1B2236] rounded-2xl hover:bg-[#293249] transition-colors shrink-0"
              >
                {swap.outputToken?.logoURI ? (
                  <img 
                    src={swap.outputToken.logoURI} 
                    alt="" 
                    className="w-6 h-6 rounded-full"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                ) : (
                  <div className="w-6 h-6 rounded-full bg-gradient-to-br from-[#8b5cf6] to-[#3b82f6] flex items-center justify-center text-xs font-bold text-white">
                    {swap.outputToken?.symbol?.charAt(0) || '?'}
                  </div>
                )}
                <span className="font-medium text-white text-sm">{swap.outputToken?.symbol || 'Select'}</span>
                <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </div>
          </div>

          {/* Quote Info */}
          {swap.quote && !swap.isQuoting && (
            <div className="mt-3 p-3 bg-[#131A2A] rounded-xl text-sm space-y-1.5">
              <div className="flex items-center justify-between text-gray-500">
                <span>Price Impact</span>
                <span className={swap.quote.priceImpact > 3 ? 'text-red-400' : swap.quote.priceImpact > 1 ? 'text-yellow-400' : 'text-gray-400'}>
                  {swap.quote.priceImpact.toFixed(2)}%
                </span>
              </div>
              <div className="flex items-center justify-between text-gray-500">
                <span>Network Fee</span>
                <span className="text-green-400 flex items-center gap-1">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  Sponsored
                </span>
              </div>
              <div className="flex items-center justify-between text-gray-500">
                <span>Slippage Tolerance</span>
                <span>{swap.slippage}%</span>
              </div>
            </div>
          )}

          {/* Error Message */}
          {swap.error && (
            <div className="mt-3 p-3 bg-red-500/10 border border-red-500/20 rounded-xl">
              <p className="text-sm text-red-400 flex items-start gap-2">
                <svg className="w-4 h-4 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                <span>{swap.error}</span>
              </p>
            </div>
          )}

          {/* Swap Button */}
          <div className="mt-4">
            {swap.quote && swap.canSwap ? (
              <Transaction
                chainId={BASE_CHAIN_ID}
                calls={swap.quote.tx ? [{
                  to: swap.quote.tx.to,
                  data: swap.quote.tx.data,
                  value: BigInt(swap.quote.tx.value || '0'),
                }] : []}
                capabilities={{
                  paymasterService: { url: process.env.NEXT_PUBLIC_PAYMASTER_URL! },
                }}
                onSuccess={(data: any) => {
                  const txHash = data?.transactionReceipts?.[0]?.transactionHash || '';
                  setLastTxHash(txHash);
                  addToHistory({
                    id: txHash,
                    type: 'swap',
                    inputToken: swap.inputToken?.symbol,
                    outputToken: swap.outputToken?.symbol,
                    amountIn: swap.amountIn,
                    amountOut: swap.amountOut,
                    status: 'confirmed',
                    txHash,
                  });
                  swap.setAmountIn('');
                  refetchUserTokens();
                }}
                onError={(err: any) => {
                  console.error('Transaction failed:', err);
                }}
              >
                <TransactionButton
                  text={buttonState.text}
                  className="!w-full !py-4 !bg-[#3b82f6] hover:!bg-[#2563eb] !text-white !font-semibold !rounded-2xl !transition-colors !font-syne disabled:!bg-[#1B2236] disabled:!text-gray-500"
                />
                <TransactionStatus className="mt-2">
                  <TransactionStatusLabel className="text-sm text-gray-400" />
                  <TransactionStatusAction className="text-sm text-[#3b82f6]" />
                </TransactionStatus>
              </Transaction>
            ) : (
              <button
                onClick={() => {
                  if (!swap.quote && swap.inputToken && swap.outputToken && swap.amountIn && parseFloat(swap.amountIn) > 0) {
                    swap.getQuote(swap.inputToken, swap.outputToken, swap.amountIn);
                  }
                }}
                disabled={buttonState.disabled}
                className={`w-full py-4 font-semibold rounded-2xl transition-all font-syne ${
                  buttonState.disabled
                    ? 'bg-[#1B2236] text-gray-500 cursor-not-allowed'
                    : buttonState.action === 'retry'
                    ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                    : 'bg-[#3b82f6] text-white hover:bg-[#2563eb] active:scale-[0.98]'
                }`}
              >
                {swap.isQuoting ? (
                  <span className="flex items-center justify-center gap-2">
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Getting quote...
                  </span>
                ) : (
                  buttonState.text
                )}
              </button>
            )}
          </div>
        </div>

        {/* Footer Info */}
        <div className="mt-4 px-2 text-center">
          <p className="text-xs text-gray-600 flex items-center justify-center gap-1">
            <span>Powered by</span>
            <span className="text-[#ff007a] font-medium">Uniswap</span>
            <span>•</span>
            <span className="text-green-400">Gas sponsored</span>
            <span>•</span>
            <span>0.2% fee</span>
          </p>
        </div>
      </div>

      {/* Token Selector Modal */}
      <TokenSelector
        isOpen={showTokenSelector !== null}
        onClose={() => setShowTokenSelector(null)}
        onSelect={handleSelectToken}
        excludeToken={showTokenSelector === 'input' ? swap.outputToken : swap.inputToken}
        title={showTokenSelector === 'input' ? 'Select Token to Pay' : 'Select Token to Receive'}
      />

      {/* Transaction History Modal */}
      <TransactionHistory
        isOpen={showHistory}
        onClose={() => setShowHistory(false)}
      />
    </div>
  );
}
//g