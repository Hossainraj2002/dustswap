import React, { useEffect, useState } from 'react';
import { useAccount, useSendTransaction, useWaitForTransactionReceipt, useReadContract, useWriteContract } from 'wagmi';
import { erc20Abi, type Address } from 'viem';
import { Token } from '../../types/swap';
import { NATIVE_ETH } from '../../lib/tokens';

interface SwapButtonProps {
  quote: any;
  fromToken: Token | null;
  toToken: Token | null;
  amountIn: string;
  amountInRaw: bigint;
  isQuoting: boolean;
  error: string | null;
  onSuccess: () => void;
  isConnected: boolean;
  isDisabled?: boolean;
}

export function SwapButton({ 
  quote, 
  fromToken, 
  toToken, 
  amountIn, 
  amountInRaw,
  isQuoting, 
  error, 
  onSuccess, 
  isConnected,
  isDisabled 
}: SwapButtonProps) {
  const { address } = useAccount();
  const [isApproving, setIsApproving] = useState(false);

  // Wagmi hooks for actual transaction sending
  const { sendTransaction, data: txHash, isPending: isSwapping, error: swapError } = useSendTransaction();
  
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  // ERC20 Approval Check for Permit2/Universal Router
  // OnchainKit getSwapQuote usually routes through a known contract on Base. 
  // Let's assume the quote returns a required 'to' address
  // For standard V4 or Uniswap we need to approve the 'to' address from the quote.
  const spender = quote?.transaction?.to || quote?.to; 

  const isNative = fromToken?.address.toLowerCase() === NATIVE_ETH.toLowerCase();

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: isNative ? undefined : fromToken?.address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address && spender ? [address, spender as Address] : undefined,
    query: {
      enabled: !!address && !!spender && !isNative,
    }
  });

  const { writeContractAsync: approve } = useWriteContract();

  const needsApproval = !isNative && allowance !== undefined && allowance < amountInRaw;

  useEffect(() => {
    if (isSuccess) {
      onSuccess();
    }
  }, [isSuccess, onSuccess]);

  if (!isConnected) return <button className="w-full py-4 rounded-xl bg-[#1B2236] text-gray-400 font-bold" disabled>Connect Wallet</button>;
  if (!fromToken || !toToken) return <button className="w-full py-4 rounded-xl bg-[#1B2236] text-gray-400 font-bold" disabled>Select Tokens</button>;
  if (!amountIn || amountIn === '0' || amountInRaw <= 0n) return <button className="w-full py-4 rounded-xl bg-[#1B2236] text-gray-400 font-bold" disabled>Enter Amount</button>;
  if (isDisabled) return <button className="w-full py-4 rounded-xl bg-[#1B2236] text-gray-400 font-bold" disabled>Insufficient Balance</button>;
  if (isQuoting) return <button className="w-full py-4 rounded-xl bg-[#1B2236] text-orange-400 font-bold" disabled>Fetching Quote...</button>;
  if (error || swapError) return (
    <div className="flex flex-col gap-2">
      <button className="w-full py-4 rounded-xl bg-red-500/10 text-red-500 font-bold overflow-hidden text-ellipsis whitespace-nowrap px-4" disabled>
        {error || swapError?.message?.split('\\n')[0] || 'Error occurred'}
      </button>
    </div>
  );
  if (!quote) return <button className="w-full py-4 rounded-xl bg-[#1B2236] text-gray-400 font-bold" disabled>Loading...</button>;

  const capabilities = process.env.NEXT_PUBLIC_PAYMASTER_URL ? {
    paymasterService: { url: process.env.NEXT_PUBLIC_PAYMASTER_URL },
  } : undefined;

  const handleApprove = async () => {
    if (!fromToken || !spender) return;
    setIsApproving(true);
    try {
      await approve({
        address: fromToken.address,
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender as Address, 115792089237316195423570985008687907853269984665640564039457584007913129639935n], // max uint256
      });
      // Wait a moment then refetch allowance
      setTimeout(() => refetchAllowance(), 2000);
    } catch (e) {
      console.error(e);
    } finally {
      setIsApproving(false);
    }
  };

  const handleSwap = () => {
    const tx = quote.transaction || quote;
    sendTransaction({
      to: tx.to,
      data: tx.data,
      value: BigInt(tx.value || '0'),
      capabilities: capabilities as any, // Only works natively if wagmi connector supports EIP-5792
    });
  };

  if (isApproving || isSwapping || isConfirming) {
    return (
      <div className="w-full mt-2">
        <button 
          className="w-full min-h-[56px] py-4 bg-orange-500/50 text-white font-bold rounded-2xl flex items-center justify-center gap-2 cursor-wait"
          disabled
        >
          <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
          {isApproving ? 'Approving...' : isConfirming ? 'Confirming in wallet...' : 'Swapping...'}
        </button>
      </div>
    );
  }

  if (needsApproval) {
    return (
      <div className="w-full mt-2">
        <button 
          onClick={handleApprove}
          className="w-full min-h-[56px] py-4 bg-orange-500 hover:bg-orange-600 text-white font-bold rounded-2xl text-lg transition-colors shadow-lg shadow-orange-500/20"
        >
          Approve {fromToken.symbol}
        </button>
      </div>
    );
  }

  return (
    <div className="w-full mt-2">
      <button 
        onClick={handleSwap}
        className="w-full min-h-[56px] py-4 bg-orange-500 hover:bg-orange-600 text-white font-bold rounded-2xl text-lg transition-colors shadow-lg shadow-orange-500/20"
      >
        Swap
      </button>
      {txHash && (
        <a 
          href={`https://basescan.org/tx/${txHash}`} 
          target="_blank" 
          rel="noopener noreferrer"
          className="block w-full text-center mt-3 text-sm text-[#3b82f6] hover:underline"
        >
          View on BaseScan ↗
        </a>
      )}
    </div>
  );
}
