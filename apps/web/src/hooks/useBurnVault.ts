'use client';

import { useCallback } from 'react';
import { useAccount, useChainId } from 'wagmi';
import { useWriteContracts } from 'wagmi'
import { maxUint256 } from 'viem';

import { CONTRACT_ADDRESSES, BURN_VAULT_ABI, ERC20_ABI } from '@/lib/contracts';
import { PAYMASTER_URL } from '@/app/providers';

export function useBurnVault() {
  const { address } = useAccount();
  const chainId = useChainId();

  const {
    writeContractsAsync,
    data: batchResult,
    error,
    isPending,
    isConfirming,
    isSuccess,
  } = useWriteContracts();

  const batchId =
    typeof batchResult === 'string'
      ? batchResult
      : batchResult?.id;

  const { data: callsStatus } = useCallsStatus({
    id: batchId ?? '',
    query: {
      enabled: !!batchId,
      refetchInterval: 2_000,
    },
  });

  const burn = useCallback(
    async (token: `0x${string}`, amount: bigint) => {
      if (!address || !chainId) return;

      const addrs = CONTRACT_ADDRESSES[chainId];

      return writeContractsAsync({
        contracts: [
          {
            address: token,
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [addrs.burnVault, maxUint256],
          },
          {
            address: addrs.burnVault,
            abi: BURN_VAULT_ABI,
            functionName: 'burn',
            args: [token, amount],
          },
        ],
        capabilities: PAYMASTER_URL
          ? { paymasterService: { url: PAYMASTER_URL } }
          : undefined,
      });
    },
    [address, chainId, writeContractsAsync]
  );

  const reclaim = useCallback(
    async (burnId: bigint) => {
      if (!address || !chainId) return;

      const addrs = CONTRACT_ADDRESSES[chainId as keyof typeof CONTRACT_ADDRESSES];

      return writeContractsAsync({
        contracts: [
          {
            address: addrs.burnVault,
            abi: BURN_VAULT_ABI,
            functionName: 'reclaimTokens',
            args: [burnId],
          },
        ],
        capabilities: PAYMASTER_URL
          ? { paymasterService: { url: PAYMASTER_URL } }
          : undefined,
      });
    },
    [address, chainId, writeContractsAsync]
  );

  return {
    burn,
    reclaim,
    batchId,
    callsStatus,
    error,
    isPending,
    isConfirming,
    isSuccess,
  };
}