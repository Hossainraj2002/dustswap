'use client';

import { useCallback, useEffect, useState } from 'react';
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseUnits, type Address, type Abi } from 'viem';

import burnVaultAbiJson from '@/abi/BurnVault.json';

const BURN_VAULT_ADDRESS = process.env.NEXT_PUBLIC_BURN_VAULT_ADDRESS as Address;

const burnVaultAbi = burnVaultAbiJson as Abi;

export type BurnToken = {
  tokenAddress: Address;
  amount: string;
  decimals: number;
};

export function useBurnVault() {
  const {
    writeContractAsync,
    data: hash,
    isPending,
    error,
  } = useWriteContract();

  const { isSuccess: txSuccess } = useWaitForTransactionReceipt({ hash });
  const [isSuccess, setSuccess] = useState(false);

  useEffect(() => {
    if (txSuccess) setSuccess(true);
  }, [txSuccess]);

  const burn = useCallback(
    async (token: BurnToken) => {
      if (!BURN_VAULT_ADDRESS) {
        throw new Error('Missing BURN_VAULT_ADDRESS in .env');
      }

      const amount = parseUnits(token.amount, token.decimals);

      // ✅ Fixed: burnTokens takes (address[], uint256[]) — wrap single token in arrays
      return writeContractAsync({
        address: BURN_VAULT_ADDRESS,
        abi: burnVaultAbi,
        functionName: 'burnTokens',
        args: [[token.tokenAddress], [amount]],
      });
    },
    [writeContractAsync],
  );

  return {
    burn,
    hash,
    isPending,
    isSuccess,
    error,
  };
}