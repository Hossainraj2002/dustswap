'use client';

import { useCallback, useEffect, useState } from 'react';
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseUnits, type Address } from 'viem';
import burnVaultAbi from '@/abi/BurnVault.json'; // make sure file exists

// put your burn vault address in .env
const BURN_VAULT_ADDRESS = process.env
  .NEXT_PUBLIC_BURN_VAULT_ADDRESS as Address;

export type BurnToken = {
  tokenAddress: Address;
  amount: string; // user input
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
        functionName: 'burn', // change if your contract method name differs
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