'use client';

import { useCallback, useEffect, useState } from 'react';
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseUnits, type Address, type Abi } from 'viem';

import burnVaultAbiJson from '@/abi/BurnVault.json';

const BURN_VAULT_ADDRESS = process.env.NEXT_PUBLIC_BURN_VAULT_ADDRESS as Address;

// ✅ cast JSON ABI to Abi (prevents wagmi type errors)
const burnVaultAbi = burnVaultAbiJson as Abi;

// ✅ MUST BE EXPORTED
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

      return writeContractAsync({
        address: BURN_VAULT_ADDRESS,
        abi: burnVaultAbi,
        functionName: 'burn',
        args: [token.tokenAddress, amount],
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