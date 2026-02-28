'use client';

import { useState } from 'react';
import { useAccount } from 'wagmi';
import { useBurnVault, type BurnToken } from '@/hooks/useBurnVault';

export default function BurnPage() {
  const { address } = useAccount();
  const { burn, isPending, isSuccess, error } = useBurnVault();

  const [tokenAddress, setTokenAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [decimals, setDecimals] = useState(18);

  const handleBurn = async () => {
    if (!address) return alert('Connect wallet');

    const token: BurnToken = {
      tokenAddress: tokenAddress as `0x${string}`,
      amount,
      decimals,
    };

    await burn(token);
  };

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Burn Tokens</h1>

      <input
        className="border p-2 mb-2 w-full"
        placeholder="Token address"
        value={tokenAddress}
        onChange={(e) => setTokenAddress(e.target.value)}
      />

      <input
        className="border p-2 mb-2 w-full"
        placeholder="Amount"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />

      <input
        className="border p-2 mb-4 w-full"
        placeholder="Decimals (default 18)"
        value={decimals}
        onChange={(e) => setDecimals(Number(e.target.value))}
      />

      <button
        onClick={handleBurn}
        className="bg-black text-white px-4 py-2 rounded"
        disabled={isPending}
      >
        {isPending ? 'Burning...' : 'Burn'}
      </button>

      {isSuccess && <p className="text-green-500 mt-2">Burn successful!</p>}
      {error && <p className="text-red-500 mt-2">{error.message}</p>}
    </div>
  );
}