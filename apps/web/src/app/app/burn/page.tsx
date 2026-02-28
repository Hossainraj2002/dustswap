'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { useBurnVault, type BurnToken } from '@/hooks/useBurnVault';

interface DustToken {
  tokenAddress:     string;
  symbol:           string;
  name:             string;
  formattedBalance: string;
  estimatedValueUsd: number;
  selected:         boolean;
}

export default function BurnPage() {
  const { address, isConnected } = useAccount();
  const { burn, isPending, isConfirming, isSuccess, txHash, error } = useBurnVault();

  const [tokens,  setTokens]  = useState<DustToken[]>([]);
  const [loading, setLoading] = useState(false);

  const API = process.env.NEXT_PUBLIC_API_URL;

  const fetchDust = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
      const r    = await fetch(`${API}/api/tokens/dust/84532/${address}`);
      const data = await r.json();
      if (data.success) setTokens(data.dustTokens.map((t: Omit<DustToken, 'selected'>) => ({ ...t, selected: false })));
    } finally {
      setLoading(false);
    }
  }, [address, API]);

  useEffect(() => { if (address) fetchDust(); }, [address, fetchDust]);

  // Record points after burn
  useEffect(() => {
    if (isSuccess && txHash && address) {
      const sel = tokens.filter(t => t.selected);
      fetch(`${API}/api/points/record-burn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, txHash, tokenCount: sel.length }),
      });
    }
  }, [isSuccess, txHash, address, tokens, API]);

  const toggle = (i: number) => setTokens(p => { const n = [...p]; n[i] = { ...n[i], selected: !n[i].selected }; return n; });

  const selected     = tokens.filter(t => t.selected);
  const pointsPreview = selected.length * 50 * 2;

  async function handleBurn() {
    if (selected.length === 0) return;
    const burnTokens: BurnToken[] = selected.map(t => ({
      tokenAddress: t.tokenAddress as `0x${string}`,
      amount: BigInt(Math.floor(parseFloat(t.formattedBalance) * 1e18)),
    }));
    try { await burn(burnTokens); } catch (e) { console.error(e); }
  }

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
        <div className="text-5xl mb-4">🔥</div>
        <h1 className="text-3xl font-bold mb-3">Burn & Reclaim</h1>
        <p className="text-gray-400">Connect your wallet to burn unwanted tokens</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold mb-2">🔥 Burn & Reclaim</h1>
      <p className="text-gray-400 text-sm mb-6">
        Remove worthless / scam tokens from your wallet. You can reclaim them later for 90% back.
        Gas is sponsored.
      </p>

      {/* Token list */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden mb-5">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading…</div>
        ) : tokens.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No dust tokens found</div>
        ) : tokens.map((tok, i) => (
          <div
            key={tok.tokenAddress}
            onClick={() => toggle(i)}
            className={`flex items-center gap-4 px-4 py-3 border-b border-gray-800 last:border-0 cursor-pointer text-sm transition-colors ${
              tok.selected ? 'bg-red-900/20' : 'hover:bg-gray-800/40'
            }`}
          >
            <div className={`w-5 h-5 border rounded flex items-center justify-center ${tok.selected ? 'border-red-500 bg-red-900/40' : 'border-gray-600'}`}>
              {tok.selected && <span className="text-red-400 text-xs">✓</span>}
            </div>
            <span className="flex-1 font-medium">{tok.symbol}</span>
            <span className="text-gray-400">{parseFloat(tok.formattedBalance).toFixed(4)}</span>
            <span className="text-gray-500">${tok.estimatedValueUsd.toFixed(2)}</span>
          </div>
        ))}
      </div>

      {/* Summary */}
      {selected.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5 text-sm space-y-2">
          <div className="flex justify-between"><span className="text-gray-400">Tokens to burn</span><span>{selected.length}</span></div>
          <div className="flex justify-between text-yellow-400"><span>Points earned</span><span>+{pointsPreview.toLocaleString()} ✨</span></div>
          <div className="flex justify-between text-gray-400 text-xs pt-1"><span>Reclaim tax (if you reclaim)</span><span>10%</span></div>
        </div>
      )}

      {/* Status */}
      {isSuccess && <div className="bg-green-900/30 border border-green-700 rounded-lg p-3 mb-4 text-sm text-green-300">✅ Burned!{txHash && <a href={`https://sepolia.basescan.org/tx/${txHash}`} target="_blank" rel="noreferrer" className="ml-2 underline">View TX</a>}</div>}
      {error && <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 mb-4 text-sm text-red-300">❌ {(error as Error).message}</div>}

      <button
        onClick={handleBurn}
        disabled={selected.length === 0 || isPending || isConfirming}
        className="w-full h-14 rounded-xl bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white font-semibold text-lg transition-colors"
      >
        {isPending || isConfirming ? '⏳ Processing…' : `🔥 Burn ${selected.length} token${selected.length !== 1 ? 's' : ''}`}
      </button>

      {process.env.NEXT_PUBLIC_PAYMASTER_URL && (
        <p className="text-center text-xs text-green-400 mt-2">⚡ Gas sponsored — you pay $0</p>
      )}
    </div>
  );
}
