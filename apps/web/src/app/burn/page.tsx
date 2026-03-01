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
    if (!tokenAddress.startsWith('0x')) return alert('Invalid token address');

    // ✅ Construct exactly what the hook expects
    const token: BurnToken = {
      tokenAddress: tokenAddress as `0x${string}`, // Cast to strict hex string
      amount: amount, // String (parseUnits in the hook will convert this correctly)
      decimals: decimals,
    };

    try {
      await burn(token);
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="max-w-xl mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">🔥 Burn Tokens</h1>

      <div className="flex flex-col gap-4">
        <input
          className="border border-gray-700 bg-gray-900 text-white p-3 rounded-lg"
          placeholder="Token Address (0x...)"
          value={tokenAddress}
          onChange={(e) => setTokenAddress(e.target.value)}
        />

        <input
          className="border border-gray-700 bg-gray-900 text-white p-3 rounded-lg"
          placeholder="Amount (e.g. 10.5)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />

        <input
          className="border border-gray-700 bg-gray-900 text-white p-3 rounded-lg"
          type="number"
          placeholder="Decimals (default 18)"
          value={decimals}
          onChange={(e) => setDecimals(Number(e.target.value))}
        />

        <button
          onClick={handleBurn}
          disabled={isPending || !tokenAddress || !amount}
          className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-semibold py-3 rounded-lg transition-colors mt-2"
        >
          {isPending ? '⏳ Confirming...' : '🔥 Burn Tokens'}
        </button>
      </div>

      {isSuccess && (
        <div className="bg-green-900/30 border border-green-700 rounded-lg p-4 mt-6 text-green-300">
          ✅ Burn successful!
        </div>
      )}
      
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 mt-6 text-red-300">
          ❌ {(error as Error).message}
        </div>
      )}
    </div>
  );
}