'use client';

import { useCallback } from 'react';
import { useAccount } from 'wagmi';
import {
  useWriteContracts,
  useCallsStatus,
} from 'wagmi/experimental';
import { parseUnits, type Address, type Hex, type Abi } from 'viem';

// ✅ Fixed: use the correct ABI file name
import routerAbiJson from '@/abi/DustSweepRouter.json';

// ✅ Fixed: use the correct env variable (matches contracts.ts)
const ROUTER = process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER_ADDRESS as Address;

const routerAbi = routerAbiJson as Abi;

// Token addresses on Base mainnet
const TOKEN_ADDRESSES: Record<string, Address> = {
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  WETH: '0x4200000000000000000000000000000000000006',
  ETH:  '0x4200000000000000000000000000000000000006',
};

export type SweepToken = {
  tokenAddress: Address;
  amount: string;
  decimals: number;
  poolFee?: number; // optional; defaults to 3000 (0.3%)
};

export function useDustSweep() {
  const { address } = useAccount();

  const {
    writeContractsAsync,
    data: batchResult,
    isPending,
    error,
  } = useWriteContracts();

  const batchId = batchResult?.id;

  const { data: callsStatus } = useCallsStatus({
    id: batchId as Hex,
    query: { enabled: !!batchId, refetchInterval: 2000 },
  });

  const isSuccess = callsStatus?.status === 'success';
  const isConfirming = !!batchId && !isSuccess;
  const txHash = batchId;

  // ✅ Fixed: sweep now accepts outputToken param to match the page UI
  const sweep = useCallback(
    async (tokens: SweepToken[], outputToken: 'USDC' | 'ETH' | 'WETH' = 'USDC') => {
      if (!address) throw new Error('Wallet not connected');
      if (!ROUTER) throw new Error('Missing NEXT_PUBLIC_DUST_SWEEP_ROUTER_ADDRESS');

      // ✅ Fixed: build SwapOrder[] matching the contract struct
      const orders = tokens.map((t) => ({
        tokenIn:      t.tokenAddress,
        amountIn:     parseUnits(t.amount, t.decimals),
        poolFee:      t.poolFee ?? 3000,
        minAmountOut: 0n,
      }));

      // ✅ Fixed: call sweepDustToETH for ETH, sweepDust for ERC-20 output
      if (outputToken === 'ETH') {
        return writeContractsAsync({
          contracts: [{
            address: ROUTER,
            abi: routerAbi,
            functionName: 'sweepDustToETH',
            args: [orders, address],
          }],
        });
      }

      const tokenOut = TOKEN_ADDRESSES[outputToken];
      return writeContractsAsync({
        contracts: [{
          address: ROUTER,
          abi: routerAbi,
          functionName: 'sweepDust',
          args: [orders, tokenOut, address],
        }],
      });
    },
    [address, writeContractsAsync],
  );

  return {
    sweep,
    batchId,
    txHash,
    isPending,
    isConfirming,
    isSuccess,
    error,
  };
}