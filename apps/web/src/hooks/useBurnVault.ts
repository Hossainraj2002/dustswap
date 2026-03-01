'use client';

import { useAccount, useWriteContract } from 'wagmi';
import { parseUnits } from 'viem';
import { useState } from 'react';

type BurnToken = {
  tokenAddress: `0x${string}`;
  decimals: number;
};

export function useBurnVault() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [loading, setLoading] = useState(false);

  async function burn(params: { token: BurnToken; amount: bigint }) {
    if (!address) throw new Error('Wallet not connected');

    setLoading(true);
    try {
      await writeContractAsync({
        address: params.token.tokenAddress,
        abi: [
          {
            name: 'burn',
            type: 'function',
            stateMutability: 'nonpayable',
            inputs: [{ name: 'amount', type: 'uint256' }],
            outputs: [],
          },
        ],
        functionName: 'burn',
        args: [params.amount],
      });
    } finally {
      setLoading(false);
    }
  }

  return { burn, loading };
}