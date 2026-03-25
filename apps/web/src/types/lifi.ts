import { type Address } from 'viem';

export interface Token {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  balance?: bigint;
  balanceFormatted?: string;
  usdValue?: number;
  priceUsd?: number;
  priceChange24h?: number;
}

export interface SwapQuote {
  quoteId: string;
  inputToken: Token;
  outputToken: Token;
  amountIn: string;
  amountOut: string;
  amountOutMin: string;
  gasEstimate: string;
  priceImpact: number;
  route: any[];
  fee: {
    amount: string;
    percent: number;
    recipient: Address;
  };
  expiresAt: number;
  permit2?: any;
  tx?: {
    to: Address;
    data: `0x${string}`;
    value: string;
    gas: string;
  };
}

export interface SwapState {
  inputToken: Token | null;
  outputToken: Token | null;
  amountIn: string;
  amountOut: string;
  quote: SwapQuote | null;
  isQuoting: boolean;
  isApproving: boolean;
  isSigning: boolean;
  isSwapping: boolean;
  error: string | null;
  slippage: number;
}

export interface SwapResult {
  success: boolean;
  txHash?: string;
  orderId?: string;
  error?: string;
}
