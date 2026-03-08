'use client';

/**
 * useUniswapSwap Hook
 * ====================
 * 
 * Pure Uniswap Trading API integration - NO custom smart contracts.
 * Uses UniswapX for gasless swaps via Permit2 off-chain signatures.
 * 
 * Fee Collection: 0.2% fee is collected via the Uniswap API's routing parameters.
 * The fee is built into the quote output - no separate contract calls needed.
 * 
 * Security: No proxy contracts, no direct fund transfers. Users sign intents
 * and Uniswap fillers execute the swaps atomically.
 */

import { useState, useCallback, useEffect } from 'react';
import { useAccount, useWalletClient, usePublicClient } from 'wagmi';
import { parseUnits, formatUnits, encodeFunctionData, erc20Abi, type Address } from 'viem';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Token {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  balance?: bigint;
  balanceFormatted?: string;
  priceUsd?: number;
  usdValue?: number;
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
  route: string[];
  fee: {
    amount: string;
    percent: number;
    recipient: Address;
  };
  expiresAt: number;
  permit2?: {
    permitData: {
      permitted: {
        token: Address;
        amount: string;
      };
      spender: Address;
      nonce: string;
      deadline: string;
    };
    signature: string;
  };
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

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_CHAIN_ID = 8453;
const PERMIT2_ADDRESS: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const UNIVERSAL_ROUTER_ADDRESS: Address = '0x198EF79F1F515F2d04ad51765e8DD4d30938C81a';
const WETH_ADDRESS: Address = '0x4200000000000000000000000000000000000006';
const NATIVE_ETH: Address = '0x0000000000000000000000000000000000000000';

const FEE_BPS = 20; // 0.2%
const FEE_RECIPIENT: Address = (process.env.NEXT_PUBLIC_FEE_RECIPIENT || '0xd4a1D777e2882487d47c96bc23A47CeaB4f4f18A') as Address;

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

// ─── Hook Implementation ──────────────────────────────────────────────────────

export function useUniswapSwap() {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const [state, setState] = useState<SwapState>({
    inputToken: null,
    outputToken: null,
    amountIn: '',
    amountOut: '',
    quote: null,
    isQuoting: false,
    isApproving: false,
    isSigning: false,
    isSwapping: false,
    error: null,
    slippage: 0.5,
  });

  useEffect(() => {
    setState(prev => ({ ...prev, error: null, quote: null }));
  }, [state.inputToken, state.outputToken, state.amountIn]);

  const calculateFee = useCallback((amountOut: bigint): { userAmount: bigint; feeAmount: bigint } => {
    const feeAmount = (amountOut * BigInt(FEE_BPS)) / BigInt(10000);
    const userAmount = amountOut - feeAmount;
    return { userAmount, feeAmount };
  }, []);

  const ensurePermit2Allowance = useCallback(async (
    tokenAddress: Address,
    amount: bigint
  ): Promise<boolean> => {
    if (!address || !walletClient || !publicClient) {
      throw new Error('Wallet not connected');
    }

    if (tokenAddress.toLowerCase() === NATIVE_ETH.toLowerCase() || 
        tokenAddress.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
      return true;
    }

    const allowance = await publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [address, PERMIT2_ADDRESS],
    });

    if (allowance >= amount) {
      return true;
    }

    setState(prev => ({ ...prev, isApproving: true, error: null }));

    try {
      const maxUint256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
      
      const approveTx = await walletClient.sendTransaction({
        to: tokenAddress,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [PERMIT2_ADDRESS, maxUint256],
        }),
        capabilities: {
          paymasterService: {
            url: process.env.NEXT_PUBLIC_PAYMASTER_URL!,
          },
        },
      } as any);

      await publicClient.waitForTransactionReceipt({ hash: approveTx });
      setState(prev => ({ ...prev, isApproving: false }));
      return true;
    } catch (err: any) {
      setState(prev => ({ 
        ...prev, 
        isApproving: false, 
        error: `Approval failed: ${err.shortMessage || err.message}` 
      }));
      return false;
    }
  }, [address, walletClient, publicClient]);

  const getQuote = useCallback(async (
    inputToken: Token,
    outputToken: Token,
    amountIn: string
  ): Promise<SwapQuote | null> => {
    if (!address || !amountIn || parseFloat(amountIn) <= 0) {
      return null;
    }

    setState(prev => ({ ...prev, isQuoting: true, error: null }));

    try {
      const rawAmountIn = parseUnits(amountIn, inputToken.decimals).toString();

      const response = await fetch(`${API_BASE}/api/swap/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenIn: inputToken.address,
          tokenOut: outputToken.address,
          amountIn: rawAmountIn,
          swapper: address,
          slippageBps: Math.floor(state.slippage * 100),
          feeBps: FEE_BPS,
          feeRecipient: FEE_RECIPIENT,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Quote failed: ${response.status}`);
      }

      const data = await response.json();

      const quote: SwapQuote = {
        quoteId: data.quoteId || '',
        inputToken,
        outputToken,
        amountIn: rawAmountIn,
        amountOut: data.amountOut || '0',
        amountOutMin: data.amountOutMin || '0',
        gasEstimate: data.gasEstimate || '0',
        priceImpact: parseFloat(data.priceImpact || '0'),
        route: data.route || [],
        fee: {
          amount: data.fee?.amount || '0',
          percent: FEE_BPS / 100,
          recipient: FEE_RECIPIENT,
        },
        expiresAt: data.expiresAt || Date.now() + 30000,
        permit2: data.permit2,
        tx: data.tx,
      };

      const amountOutFormatted = formatUnits(BigInt(quote.amountOut), outputToken.decimals);

      setState(prev => ({
        ...prev,
        quote,
        amountOut: amountOutFormatted,
        isQuoting: false,
      }));

      return quote;
    } catch (err: any) {
      setState(prev => ({
        ...prev,
        isQuoting: false,
        error: `Quote failed: ${err.message}`,
      }));
      return null;
    }
  }, [address, state.slippage]);

  const executeSwap = useCallback(async (): Promise<SwapResult> => {
    const { inputToken, outputToken, quote } = state;

    if (!address || !walletClient || !publicClient || !inputToken || !outputToken || !quote) {
      return { success: false, error: 'Missing required parameters' };
    }

    setState(prev => ({ ...prev, isSwapping: true, error: null }));

    try {
      const amountIn = BigInt(quote.amountIn);
      const isNativeInput = inputToken.address.toLowerCase() === NATIVE_ETH.toLowerCase() ||
                           inputToken.address.toLowerCase() === WETH_ADDRESS.toLowerCase();

      if (!isNativeInput) {
        const approved = await ensurePermit2Allowance(inputToken.address, amountIn);
        if (!approved) {
          return { success: false, error: 'Token approval failed' };
        }
      }

      if (!quote.tx) {
        return { success: false, error: 'No transaction data in quote' };
      }

      setState(prev => ({ ...prev, isSigning: true }));

      const txHash = await walletClient.sendTransaction({
        to: quote.tx.to,
        data: quote.tx.data,
        value: BigInt(quote.tx.value || '0'),
        capabilities: {
          paymasterService: {
            url: process.env.NEXT_PUBLIC_PAYMASTER_URL!,
          },
        },
      } as any);

      setState(prev => ({ ...prev, isSigning: false, isSwapping: true }));

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status === 'success') {
        await recordSwap(txHash);

        setState(prev => ({
          ...prev,
          isSwapping: false,
          amountIn: '',
          amountOut: '',
          quote: null,
        }));

        return { success: true, txHash };
      } else {
        throw new Error('Transaction reverted');
      }
    } catch (err: any) {
      const errorMsg = err.shortMessage || err.message || 'Swap failed';
      setState(prev => ({
        ...prev,
        isSigning: false,
        isSwapping: false,
        error: errorMsg,
      }));
      return { success: false, error: errorMsg };
    }
  }, [state, address, walletClient, publicClient, ensurePermit2Allowance]);

  const signUniswapXOrder = useCallback(async (): Promise<SwapResult> => {
    const { inputToken, outputToken, quote } = state;

    if (!address || !walletClient || !inputToken || !outputToken || !quote) {
      return { success: false, error: 'Missing required parameters' };
    }

    setState(prev => ({ ...prev, isSigning: true, error: null }));

    try {
      const amountIn = BigInt(quote.amountIn);
      const isNativeInput = inputToken.address.toLowerCase() === NATIVE_ETH.toLowerCase() ||
                           inputToken.address.toLowerCase() === WETH_ADDRESS.toLowerCase();

      if (!isNativeInput) {
        const approved = await ensurePermit2Allowance(inputToken.address, amountIn);
        if (!approved) {
          return { success: false, error: 'Token approval failed' };
        }
      }

      const signResponse = await fetch(`${API_BASE}/api/swap/sign-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteId: quote.quoteId,
          swapper: address,
          inputToken: inputToken.address,
          outputToken: outputToken.address,
          amountIn: quote.amountIn,
          amountOut: quote.amountOut,
          feeBps: FEE_BPS,
          feeRecipient: FEE_RECIPIENT,
        }),
      });

      if (!signResponse.ok) {
        const errorData = await signResponse.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to prepare order');
      }

      const signData = await signResponse.json();

      const signature = await walletClient.signTypedData({
        domain: signData.domain,
        types: signData.types,
        message: signData.message,
        primaryType: signData.primaryType,
      });

      const submitResponse = await fetch(`${API_BASE}/api/swap/submit-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderHash: signData.orderHash,
          signature,
          encodedOrder: signData.encodedOrder,
          chainId: BASE_CHAIN_ID,
        }),
      });

      if (!submitResponse.ok) {
        const errorData = await submitResponse.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to submit order');
      }

      const submitData = await submitResponse.json();

      await recordSwap(undefined, submitData.orderHash);

      setState(prev => ({
        ...prev,
        isSigning: false,
        amountIn: '',
        amountOut: '',
        quote: null,
      }));

      return { success: true, orderId: submitData.orderHash };
    } catch (err: any) {
      const errorMsg = err.shortMessage || err.message || 'Order signing failed';
      setState(prev => ({
        ...prev,
        isSigning: false,
        error: errorMsg,
      }));
      return { success: false, error: errorMsg };
    }
  }, [state, address, walletClient, ensurePermit2Allowance]);

  const recordSwap = useCallback(async (txHash?: string, orderId?: string) => {
    if (!address) return;

    try {
      await fetch(`${API_BASE}/api/points/record-swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          txHash,
          orderId,
          inputToken: state.inputToken?.address,
          outputToken: state.outputToken?.address,
          amountIn: state.amountIn,
          amountOut: state.amountOut,
        }),
      });

      const history = JSON.parse(localStorage.getItem('swapHistory') || '[]');
      history.unshift({
        id: txHash || orderId,
        type: 'swap',
        inputToken: state.inputToken?.symbol,
        outputToken: state.outputToken?.symbol,
        amountIn: state.amountIn,
        amountOut: state.amountOut,
        timestamp: Date.now(),
        status: txHash ? 'confirmed' : 'pending',
      });
      localStorage.setItem('swapHistory', JSON.stringify(history.slice(0, 50)));
    } catch (err) {
      console.error('Failed to record swap:', err);
    }
  }, [address, state.inputToken, state.outputToken, state.amountIn, state.amountOut]);

  useEffect(() => {
    if (!state.inputToken || !state.outputToken || !state.amountIn) {
      return;
    }

    const timeoutId = setTimeout(() => {
      getQuote(state.inputToken!, state.outputToken!, state.amountIn);
    }, 500);

    return () => clearTimeout(timeoutId);
  }, [state.inputToken, state.outputToken, state.amountIn, getQuote]);

  const setInputToken = useCallback((token: Token | null) => {
    setState(prev => ({ ...prev, inputToken: token, quote: null, amountOut: '' }));
  }, []);

  const setOutputToken = useCallback((token: Token | null) => {
    setState(prev => ({ ...prev, outputToken: token, quote: null, amountOut: '' }));
  }, []);

  const setAmountIn = useCallback((amount: string) => {
    setState(prev => ({ ...prev, amountIn: amount, quote: null, amountOut: '' }));
  }, []);

  const setSlippage = useCallback((slippage: number) => {
    setState(prev => ({ ...prev, slippage }));
  }, []);

  const switchTokens = useCallback(() => {
    setState(prev => ({
      ...prev,
      inputToken: prev.outputToken,
      outputToken: prev.inputToken,
      amountIn: prev.amountOut,
      amountOut: prev.amountIn,
      quote: null,
    }));
  }, []);

  const clearError = useCallback(() => {
    setState(prev => ({ ...prev, error: null }));
  }, []);

  return {
    ...state,
    setInputToken,
    setOutputToken,
    setAmountIn,
    setSlippage,
    switchTokens,
    getQuote,
    executeSwap,
    signUniswapXOrder,
    clearError,
    isConnected,
    isLoading: state.isQuoting || state.isApproving || state.isSigning || state.isSwapping,
    hasQuote: !!state.quote,
    canSwap: !!state.quote && !state.isLoading && parseFloat(state.amountIn) > 0,
  };
}

export function formatSwapAmount(value: string | number, decimals: number = 6): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '0';
  if (num === 0) return '0';
  if (num < 0.000001) return '<0.000001';
  if (num < 1) return num.toFixed(6);
  if (num < 1000) return num.toFixed(4);
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
