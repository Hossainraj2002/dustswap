import { useState, useCallback } from 'react';
import { Token } from '../types/lifi';

export function useLifiQuote() {
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
      const params = new URLSearchParams({
        tokenIn: fromToken.address,
        tokenOut: toToken.address,
        amountIn: amountInStr,
        decimalsIn: String(fromToken.decimals),
        decimalsOut: String(toToken.decimals),
        slippage: String(slippage),
      });

      const res = await fetch(`/api/lifi-quote?${params.toString()}`);
      const response = await res.json();

      if (!res.ok || response.error || !response.amountOutRaw) {
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
