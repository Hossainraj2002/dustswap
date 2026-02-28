'use client';

/**
 * useBurnVault.ts
 *
 * Batch TX hook for the Burn & Reclaim feature.
 * Combines all approve calls + burnTokens into one wallet_sendCalls batch.
 */

import { useCallback } from 'react';
import { useAccount, useChainId } from 'wagmi';
import { useWriteContracts, useCallsStatus } from 'wagmi/experimental';
import { maxUint256 } from 'viem';
import { CONTRACT_ADDRESSES, BURN_VAULT_ABI, ERC20_ABI } from '@/lib/contracts';
import { PAYMASTER_URL } from '@/app/providers';

export interface BurnToken {
  tokenAddress: `0x${string}`;
  amount: bigint;
}

export function useBurnVault() {
  const { address } = useAccount();
  const chainId     = useChainId();

  const { writeContractsAsync, data: batchId, error, isPending } = useWriteContracts();

  const { data: callsStatus } = useCallsStatus({
    id: batchId as string,
    query: { enabled: !!batchId, refetchInterval: 2_000 },
  });

  const isConfirming = callsStatus?.status === 'PENDING';
  const isSuccess    = callsStatus?.status === 'CONFIRMED';
  const txHash       = callsStatus?.receipts?.[0]?.transactionHash;

  /**
   * Batch: approve all tokens + burnTokens in one signature
   */
  const burn = useCallback(async (tokens: BurnToken[]): Promise<string | undefined> => {
    if (!address || tokens.length === 0) return;

    const addrs = CONTRACT_ADDRESSES[chainId as keyof typeof CONTRACT_ADDRESSES];
    if (!addrs?.burnVault || addrs.burnVault === '0x0') {
      throw new Error('BurnVault not deployed. Check NEXT_PUBLIC_BURN_VAULT_ADDRESS.');
    }

    const approveCalls = tokens.map((tok) => ({
      address: tok.tokenAddress,
      abi: ERC20_ABI,
      functionName: 'approve' as const,
      args: [addrs.burnVault, maxUint256] as const,
    }));

    const burnCall = {
      address: addrs.burnVault,
      abi: BURN_VAULT_ABI,
      functionName: 'burnTokens' as const,
      args: [
        tokens.map(t => t.tokenAddress),
        tokens.map(t => t.amount),
      ] as const,
    };

    const capabilities = PAYMASTER_URL
      ? { paymasterService: { url: PAYMASTER_URL } }
      : undefined;

    return writeContractsAsync({
      contracts: [...approveCalls, burnCall],
      capabilities,
    });
  }, [address, chainId, writeContractsAsync]);

  /**
   * Reclaim previously burned tokens (no approval needed)
   */
  const reclaim = useCallback(async (burnId: `0x${string}`): Promise<string | undefined> => {
    if (!address) return;

    const addrs = CONTRACT_ADDRESSES[chainId as keyof typeof CONTRACT_ADDRESSES];
    if (!addrs?.burnVault || addrs.burnVault === '0x0') throw new Error('BurnVault not deployed');

    const capabilities = PAYMASTER_URL
      ? { paymasterService: { url: PAYMASTER_URL } }
      : undefined;

    return writeContractsAsync({
      contracts: [{
        address: addrs.burnVault,
        abi: BURN_VAULT_ABI,
        functionName: 'reclaimTokens' as const,
        args: [burnId] as const,
      }],
      capabilities,
    });
  }, [address, chainId, writeContractsAsync]);

  return { burn, reclaim, batchId, txHash, error, isPending, isConfirming, isSuccess };
}
