'use client';

import { useState } from 'react';
import { useAccount } from 'wagmi';
import { useBurnVault, type BurnToken } from '@/hooks/useBurnVault';

export default function BurnPage() {
  const { address } = useAccount();
  const { burn, isPending, isSuccess, error } = useBurnVault();

  const [tokenAddress, setTokenAddress] = useState<string>('');
  const [amount, setAmount] = useState('');
  const [decimals, setDecimals] = useState(18);

  const handleBurn = async () => {
    if (!address) return alert('Connect wallet');
    const token: BurnToken = { 
  tokenAddress: tokenAddress as `0x${string}`, 
  decimals 
};
    burn({ token, amount: BigInt(amount) });
  };

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <h1 className="text-3xl font-bold mb-4">Burn Tokens</h1>
      <div className="max-w-md mx-auto p-6 bg-gray-900 border border-gray-800 rounded-xl">
        <input
          type="text"
          placeholder="Token address"
          value={tokenAddress}
          onChange={(e) => setTokenAddress(e.target.value)}
          className="w-full mb-4 px-4 py-2 bg-gray-800 border border-gray-700 rounded"
        />
        <input
          type="number"
          placeholder="Amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="w-full mb-4 px-4 py-2 bg-gray-800 border border-gray-700 rounded"
        />
        <input
          type="number"
          placeholder="Decimals"
          value={decimals}
          onChange={(e) => setDecimals(Number(e.target.value))}
          className="w-full mb-4 px-4 py-2 bg-gray-800 border border-gray-700 rounded"
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
    </div>
  );
}