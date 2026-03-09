'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { Wallet, ConnectWallet } from '@coinbase/onchainkit/wallet';
import { type Address, parseUnits, formatUnits } from 'viem';

// Definitions & Utils
import { Token } from '@/types/swap';
import { DEFAULT_TOKENS, DEFAULT_INPUT_TOKEN, DEFAULT_OUTPUT_TOKEN } from '@/lib/tokens';

// Subcomponents
import { SwapCard } from '@/components/swap/SwapCard';
import { TokenInput } from '@/components/swap/TokenInput';
import { PercentageButtons } from '@/components/swap/PercentageButtons';
import { TokenSelectorModal } from '@/components/swap/TokenSelectorModal';
import { SwapDetails } from '@/components/swap/SwapDetails';
import { SwapButton } from '@/components/swap/SwapButton';

// Hooks
import { useTokenBalances } from '@/hooks/useTokenBalances';
import { useSwapQuote } from '@/hooks/useSwapQuote';
import { useTokenSearch } from '@/hooks/useTokenSearch';

export default function SwapPage() {
  const { isConnected } = useAccount();

  // Load balances hooks explicitly built for mobile specifications
  const { tokens: userTokens, isLoading: balancesLoading, refetch: refetchBalances, getBalance } = useTokenBalances();

  // Ensure default tokens are properly selected
  const [fromToken, setFromToken] = useState<Token>(DEFAULT_INPUT_TOKEN);
  const [toToken, setToToken] = useState<Token>(DEFAULT_OUTPUT_TOKEN);

  // Input states
  const [fromAmount, setFromAmount] = useState<string>('');
  const [selectedPercent, setSelectedPercent] = useState<number | null>(null);

  // Quote hook
  const [slippage, setSlippage] = useState<number>(0.5);
  const { quote, isQuoting, error: quoteError, fetchQuote, clearQuote } = useSwapQuote();

  // Search logic for Modal
  const { results: searchResults, isSearching, search, clear: clearSearch } = useTokenSearch();
  const [selectorTarget, setSelectorTarget] = useState<'from' | 'to' | null>(null);

  // Settings visibility
  const [showSettings, setShowSettings] = useState(false);

  // Handle Input Changes & Quotes
  useEffect(() => {
    // Basic debounce handled simply using effect triggers timeout natively
    const timer = setTimeout(() => {
      if (fromAmount && parseFloat(fromAmount) > 0) {
        // Raw amount in string exactly matched to token decimal scale
        const amountInRawStr = parseUnits(fromAmount, fromToken.decimals).toString();
        fetchQuote(fromToken, toToken, amountInRawStr, slippage);
      } else {
        clearQuote();
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [fromAmount, fromToken, toToken, slippage, fetchQuote, clearQuote]);

  const handleFromAmountChange = useCallback((val: string) => {
    setFromAmount(val);
    setSelectedPercent(null);
  }, []);

  const handlePercentageSelect = useCallback((val: string, pct: number) => {
    setFromAmount(val);
    setSelectedPercent(pct);
  }, []);

  const switchTokens = () => {
    setFromToken(toToken);
    setToToken(fromToken);
    setFromAmount('');
    setSelectedPercent(null);
    clearQuote();
  };

  const handleTokenSelect = (token: Token) => {
    if (selectorTarget === 'from') {
      if (token.address === toToken.address) switchTokens();
      else setFromToken(token);
    } else {
      if (token.address === fromToken.address) switchTokens();
      else setToToken(token);
    }
  };

  // Derive metrics 
  const fromBalance = getBalance(fromToken.address as Address);
  const fromBalanceFormatted = userTokens.find(t => t.address === fromToken.address)?.balanceFormatted || '0';
  const fromUsdValue = userTokens.find(t => t.address === fromToken.address)?.priceUsd || 0;
  
  const toBalanceFormatted = userTokens.find(t => t.address === toToken.address)?.balanceFormatted || '0';
  const toUsdValue = userTokens.find(t => t.address === toToken.address)?.priceUsd || 0;

  const rawInput = fromAmount ? parseUnits(fromAmount, fromToken.decimals) : 0n;
  const isInsufficientSBalance = Number(fromAmount) > 0 && rawInput > fromBalance;

  // Process Quote data correctly based on OnchainKit outputs
  const displayToAmount = quote?.toAmount ? formatUnits(BigInt(quote.toAmount), toToken.decimals) : '';
  
  // Rate calculated natively from outputs
  const derivedRate = displayToAmount && fromAmount ? parseFloat(displayToAmount) / parseFloat(fromAmount) : 0;
  
  const minReceivedStr = quote?.rawOutputAmountMin || '0'; // this is usually inside standard exact inputs

  return (
    <SwapCard>
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-xl font-bold text-white pl-1">Swap</h1>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className={`p-2 rounded-full transition-colors min-h-[44px] min-w-[44px] ${showSettings ? 'bg-orange-500/20 text-orange-500' : 'text-gray-400 hover:text-white hover:bg-[#1B2236]'}`}
          aria-label="Settings"
        >
          <svg className="w-5 h-5 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>

      {showSettings && (
        <div className="mb-4 p-4 bg-[#131A2A] rounded-2xl border border-[#1B2236] animate-in fade-in slide-in-from-top-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-gray-400">Slippage Tolerance</span>
            <div className="flex items-center gap-1 bg-[#0D111C] p-1 rounded-xl">
              {[0.1, 0.5, 1.0].map(s => (
                <button
                  key={s}
                  onClick={() => setSlippage(s)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-bold min-h-[36px] transition-colors ${slippage === s ? 'bg-orange-500 text-white' : 'text-gray-400 hover:text-white hover:bg-[#1B2236]'}`}
                >
                  {s}%
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Inputs Configuration */}
      <div className="relative group">
        <TokenInput
          label="Sell"
          amount={fromAmount}
          onAmountChange={handleFromAmountChange}
          token={fromToken}
          onSelectToken={() => setSelectorTarget('from')}
          balanceFormatted={fromBalanceFormatted}
          usdValue={fromUsdValue * parseFloat(fromAmount || '0')}
          onMaxClick={() => handlePercentageSelect(fromBalanceFormatted, 100)}
        />
        
        {/* Switch Button */}
        <button
          onClick={switchTokens}
          className="swap-switch-button group"
          aria-label="Switch Tokens"
        >
          <svg className="w-5 h-5 group-hover:rotate-180 transition-transform duration-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
          </svg>
        </button>

        <div className="mt-2">
          <TokenInput
            label="Buy"
            amount={displayToAmount}
            token={toToken}
            onSelectToken={() => setSelectorTarget('to')}
            balanceFormatted={toBalanceFormatted}
            usdValue={toUsdValue * parseFloat(displayToAmount || '0')}
            readonly
          />
        </div>
      </div>

      {/* Percentage Shortcuts */}
      <PercentageButtons
        balance={fromBalance}
        decimals={fromToken.decimals}
        tokenAddress={fromToken.address as Address}
        onSelect={handlePercentageSelect}
        selectedPercent={selectedPercent}
      />

      {/* Quote Display Details */}
      {quote && (
        <SwapDetails
          rate={derivedRate}
          inputSymbol={fromToken.symbol}
          outputSymbol={toToken.symbol}
          priceImpact={quote.priceImpact || 0}
          minReceived={quote.toAmountMin ? formatUnits(BigInt(quote.toAmountMin), toToken.decimals) : minReceivedStr}
          networkFeeUsd={quote.feeUsd || undefined}
        />
      )}

      {/* Connect Or Execution Button */}
      <div className="mt-4 w-full">
        {!isConnected ? (
          <Wallet>
            <ConnectWallet className="w-full">
              <button className="w-full py-4 bg-[#3b82f6] hover:bg-[#2563eb] text-white font-bold rounded-2xl transition-colors min-h-[56px] shadow-lg shadow-blue-500/20 text-lg">
                Connect Wallet
              </button>
            </ConnectWallet>
          </Wallet>
        ) : (
          <SwapButton
            quote={quote}
            fromToken={fromToken}
            toToken={toToken}
            amountIn={fromAmount}
            amountInRaw={rawInput}
            isQuoting={isQuoting}
            error={quoteError}
            isConnected={isConnected}
            isDisabled={isInsufficientSBalance}
            onSuccess={() => {
              setFromAmount('');
              clearQuote();
              refetchBalances();
            }}
          />
        )}
      </div>

      {/* Modals outside document flow */}
      <TokenSelectorModal
        isOpen={Boolean(selectorTarget)}
        title={selectorTarget === 'from' ? 'Select sending token' : 'Select receiving token'}
        excludeToken={selectorTarget === 'from' ? toToken : fromToken}
        onClose={() => setSelectorTarget(null)}
        onSelect={handleTokenSelect}
        userTokens={userTokens}
        defaultTokens={DEFAULT_TOKENS}
        searchResults={searchResults}
        isSearching={isSearching}
        onSearch={search}
        onClearSearch={clearSearch}
      />
    </SwapCard>
  );
}
