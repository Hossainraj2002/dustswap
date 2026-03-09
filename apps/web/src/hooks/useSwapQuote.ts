import { useState, useCallback } from 'react';
import { getSwapQuote } from '@coinbase/onchainkit/api';
import { Token } from '../types/swap';
import { BASE_CHAIN_ID } from '../lib/tokens';

export function useSwapQuote() {
  const [quote, setQuote] = useState<any>(null);
  const [isQuoting, setIsQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchQuote = useCallback(async (
    fromToken: Token,
    toToken: Token,
    amountInStr: string, // raw string mapping to BigInt
    slippage: number
  ) => {
    if (!amountInStr || amountInStr === '0') {
      setQuote(null);
      setError(null);
      return;
    }

    setIsQuoting(true);
    setError(null);

    try {
      const params = {
        from: {
          address: fromToken.address,
          chainId: 8453,
          decimals: fromToken.decimals,
          name: fromToken.name,
          symbol: fromToken.symbol,
          image: fromToken.logoURI || ''
        },
        to: {
          address: toToken.address,
          chainId: 8453,
          decimals: toToken.decimals,
          name: toToken.name,
          symbol: toToken.symbol,
          image: toToken.logoURI || ''
        },
        amount: amountInStr, // BigInt string
        chainId: 8453,
        slippage: slippage, // 0.5% default or user selected
      };
      
      const response = await getSwapQuote(params as any) as any;

      if (response.error || !response.toAmount) {
        setError(response.error?.message || response.error || 'Got invalid quote response');
        setQuote(null);
        return;
      }
      
      setQuote(response);
    } catch (err: any) {
      console.error('Quote error:', err);
      const msg = err.message?.toLowerCase();
      
      if (msg?.includes('liquidity')) {
        setError('Insufficient liquidity: Suggest different token pair');
      } else if (msg?.includes('low')) {
        setError('Amount too low: Increase minimum threshold');
      } else {
        setError(err.message || 'Network error: Retry quoting');
      }
      setQuote(null);
    } finally {
      setIsQuoting(false);
    }
  }, []);

  const clearQuote = useCallback(() => setQuote(null), []);

  return { quote, isQuoting, error, fetchQuote, clearQuote };
}
