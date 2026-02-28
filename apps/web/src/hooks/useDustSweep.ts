'use client';

import { useCallback } from 'react';
import { useAccount } from 'wagmi'; // ✅ correct import
import {
  useWriteContracts,
  useCallsStatus,
} from 'wagmi/experimental';
import { parseUnits, type Address, type Hex } from 'viem';

import routerAbi from '@/abi/Router.json';

const ROUTER = process.env.NEXT_PUBLIC_ROUTER_ADDRESS as Address;

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

  const sweep = useCallback(
    async (tokens: SweepToken[]) => {
      if (!address) throw new Error('Wallet not connected');
      if (!ROUTER) throw new Error('Missing NEXT_PUBLIC_ROUTER_ADDRESS');

      const calls = tokens.map((t) => ({
        address: ROUTER,
        abi: routerAbi,
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
    isPending,
    isSuccess,
    error,
  };
}