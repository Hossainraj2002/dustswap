'use client';

import { useCallback } from 'react';
import { useAccount } from 'wagmi';
import {
  useWriteContracts,
  useCallsStatus,
} from 'wagmi/experimental';
import { parseUnits, type Address, type Hex, type Abi } from 'viem';

import routerAbiJson from '@/abi/Router.json';

const ROUTER = process.env.NEXT_PUBLIC_ROUTER_ADDRESS as Address;

// ✅ cast JSON ABI to Abi
const routerAbi = routerAbiJson as Abi;

export type SweepToken = {
  tokenAddress: Address;
  amount: string;
  decimals: number;
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

  const sweep = useCallback(
    async (tokens: SweepToken[]) => {
      if (!address) throw new Error('Wallet not connected');
      if (!ROUTER) throw new Error('Missing NEXT_PUBLIC_ROUTER_ADDRESS');

      const calls = tokens.map((t) => ({
        address: ROUTER,
        abi: routerAbi, // ✅ now typed correctly
        functionName: 'sweep',
        args: [t.tokenAddress, parseUnits(t.amount, t.decimals)],
      }));

      return writeContractsAsync({ contracts: calls });
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