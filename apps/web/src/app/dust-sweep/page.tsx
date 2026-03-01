'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { useDustSweep, type SweepToken } from '@/hooks/useDustSweep';

interface DustToken {
  tokenAddress: string;
  symbol: string;
  name: string;
  formattedBalance: string;
  estimatedValueUsd: number;
  hasLiquidity: boolean;
  selected: boolean;
  logoUrl?: string;
}

export default function DustSweepPage() {
  const { address } = useAccount();
  const { sweep, isPending, isConfirming, outputToken } = useDustSweep();

  const [tokens, setTokens] = useState<DustToken[]>([]);
  const [selected, setSelected] = useState<DustToken[]>([]);

  const fetchDust = useCallback(async () => {
    if (!address) return;
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/tokens/dust/84532/${address}`);
      const data = await res.json();
      if (data.success) {
        setTokens(data.dustTokens.map((t: any) => ({ ...t, selected: false })));
      }
    } catch {
      // handle error
    }
  }, [address]);

  useEffect(() => {
    fetchDust();
  }, [fetchDust]);

  const toggleSelect = (token: DustToken) => {
    setSelected((prev) =>
      prev.some((t) => t.tokenAddress === token.tokenAddress)
        ? prev.filter((t) => t.tokenAddress !== token.tokenAddress)
        : [...prev, token]
    );
    setTokens((prev) =>
      prev.map((t) =>
        t.tokenAddress === token.tokenAddress
          ? { ...t, selected: !t.selected }
          : t
      )
    );
  };

  const handleSweep = () => {
    if (!address) return alert('Connect wallet');
    sweep({ tokens: selected.map((t) => ({ address: t.tokenAddress } as SweepToken)) });
  };

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <h1 className="text-3xl font-bold mb-4">Dust Sweep</h1>
      <div className="max-w-lg mx-auto p-6 bg-gray-900 border border-gray-800 rounded-xl">
        {tokens.map((t) => (
          <div
            key={t.tokenAddress}
            onClick={() => toggleSelect(t)}
            className={`p-2 mb-2 cursor-pointer rounded ${t.selected ? 'bg-blue-600' : 'bg-gray-800'}`}
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{t.symbol}</p>
                <p className="text-gray-400 text-sm">{t.name}</p>
              </div>
              <p className="text-sm">{t.formattedBalance}</p>
            </div>
          </div>
        ))}
        <button
          onClick={handleSweep}
          disabled={selected.length === 0 || isPending || isConfirming}
          className="w-full h-14 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold text-lg transition-colors"
        >
          {isPending
            ? '⏳ Confirm in wallet…'
            : isConfirming
            ? '⏳ Processing…'
            : selected.length === 0
            ? '🧹 Select tokens to sweep'
            : `🧹 Sweep ${selected.length} tokens → ${outputToken}`}
        </button>

        {process.env.NEXT_PUBLIC_PAYMASTER_URL && (
          <p className="text-center text-xs text-green-400 mt-2">⚡ Gas sponsored — you pay $0</p>
        )}
      </div>
    </div>
  );
}