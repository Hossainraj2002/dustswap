'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { useDustSweep, type SweepToken } from '@/hooks/useDustSweep';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DustToken {
  tokenAddress:     string;
  symbol:           string;
  name:             string;
  formattedBalance: string;
  estimatedValueUsd: number;
  hasLiquidity:     boolean;
  selected:         boolean;
  logoUrl?:         string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function DustSweepPage() {
  const { address, isConnected } = useAccount();
  const { sweep, isPending, isConfirming, isSuccess, txHash, error } = useDustSweep();

  const [tokens,      setTokens]      = useState<DustToken[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [outputToken, setOutputToken] = useState<'USDC' | 'ETH' | 'WETH'>('USDC');

  // Fetch dust tokens from backend
  const fetchDust = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
      const r    = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/tokens/dust/84532/${address}`);
      const data = await r.json();
      if (data.success) {
        setTokens(data.dustTokens.map((t: Omit<DustToken, 'selected'>) => ({ ...t, selected: false })));
      }
    } catch (e) {
      console.error('Failed to fetch dust:', e);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => { if (address) fetchDust(); }, [address, fetchDust]);

  // Record points after successful sweep
  useEffect(() => {
    if (isSuccess && txHash && address) {
      const selected = tokens.filter(t => t.selected);
      fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/points/record-sweep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          txHash,
          tokenCount: selected.length,
          volumeUsd:  selected.reduce((s, t) => s + t.estimatedValueUsd, 0),
        }),
      });
    }
  }, [isSuccess, txHash, address, tokens]);

  // Selection helpers
  const toggle    = (i: number) => setTokens(p => { const n = [...p]; n[i] = { ...n[i], selected: !n[i].selected }; return n; });
  const autoSelect = (n: number) => setTokens(p => p.map((t, i) => ({ ...t, selected: t.hasLiquidity && i < n })));
  const clearAll   = () => setTokens(p => p.map(t => ({ ...t, selected: false })));

  // Computed
  const selected      = tokens.filter(t => t.selected);
  const totalValue    = selected.reduce((s, t) => s + t.estimatedValueUsd, 0);
  const estimatedFee  = totalValue * 0.01;
  const estimatedOut  = totalValue - estimatedFee;
  const pointsPreview = selected.length * 50 * 5;

  // Execute sweep
  async function handleSweep() {
    if (selected.length === 0) return;

    // Build SweepToken array — swapCalldata would come from backend in production
    // For now we pass empty bytes; the real implementation fetches Uniswap routes first
    const sweepTokens: SweepToken[] = selected.map(t => ({
  tokenAddress: t.tokenAddress as `0x${string}`,
  amount: t.formattedBalance,        // string
  decimals: t.decimals ?? 18,         // add decimals
}));

    const outputAddresses: Record<string, `0x${string}`> = {
      USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base USDC
      ETH:  '0x4200000000000000000000000000000000000006', // WETH on Base
      WETH: '0x4200000000000000000000000000000000000006',
    };

    try {
      await sweep(sweepTokens, outputAddresses[outputToken], 0n);
    } catch (e) {
      console.error('Sweep failed:', e);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
        <div className="text-6xl mb-4">🧹</div>
        <h1 className="text-3xl font-bold mb-3">Dust Sweep</h1>
        <p className="text-gray-400 max-w-sm">
          Connect your Coinbase Smart Wallet to scan for dust tokens and sweep them in one click.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-1">🧹 Dust Sweep</h1>
        <p className="text-gray-400 text-sm">
          Select tokens → one Smart Wallet signature → gas sponsored ✨
        </p>
      </div>

      {/* Quick select */}
      <div className="flex flex-wrap gap-2 mb-5">
        {[5, 10, 20].map(n => (
          <button key={n} onClick={() => autoSelect(n)}
            className="px-3 py-1.5 text-sm rounded-lg border border-gray-700 hover:border-blue-500 text-gray-300 hover:text-white transition-colors">
            Auto {n}
          </button>
        ))}
        <button onClick={clearAll}
          className="px-3 py-1.5 text-sm rounded-lg border border-gray-700 hover:border-gray-500 text-gray-300 hover:text-white transition-colors">
          Clear
        </button>
        <button onClick={fetchDust} disabled={loading}
          className="px-3 py-1.5 text-sm rounded-lg border border-gray-700 hover:border-blue-500 text-gray-300 hover:text-white transition-colors ml-auto">
          {loading ? 'Scanning…' : '🔄 Refresh'}
        </button>
      </div>

      {/* Token list */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden mb-5">
        {loading ? (
          <div className="p-10 text-center text-gray-500">Scanning wallet for dust tokens…</div>
        ) : tokens.length === 0 ? (
          <div className="p-10 text-center text-gray-500">
            No dust tokens found. Your wallet is clean! 🎉
          </div>
        ) : (
          <div>
            {/* Header row */}
            <div className="grid grid-cols-6 gap-3 px-4 py-2 text-xs font-medium text-gray-500 border-b border-gray-800">
              <div>✓</div>
              <div className="col-span-2">Token</div>
              <div>Balance</div>
              <div>Value</div>
              <div>Liq.</div>
            </div>
            {/* Token rows */}
            {tokens.map((tok, i) => (
              <div
                key={tok.tokenAddress}
                onClick={() => tok.hasLiquidity && toggle(i)}
                className={`grid grid-cols-6 gap-3 px-4 py-3 items-center text-sm border-b border-gray-800/60 last:border-0 transition-colors ${
                  tok.hasLiquidity ? 'cursor-pointer hover:bg-gray-800/40' : 'opacity-50 cursor-not-allowed'
                } ${tok.selected ? 'bg-blue-900/20' : ''}`}
              >
                <div className="flex items-center justify-center w-5 h-5 border border-gray-600 rounded">
                  {tok.selected && <span className="text-blue-400 text-xs">✓</span>}
                </div>
                <div className="col-span-2 font-medium">{tok.symbol}</div>
                <div className="text-gray-400 truncate">{parseFloat(tok.formattedBalance).toFixed(4)}</div>
                <div>${tok.estimatedValueUsd.toFixed(2)}</div>
                <div>{tok.hasLiquidity ? '✅' : '❌'}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Output token */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-5 flex items-center gap-3">
        <span className="text-sm text-gray-400 mr-auto">Receive as:</span>
        {(['USDC', 'ETH', 'WETH'] as const).map(t => (
          <button key={t} onClick={() => setOutputToken(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              outputToken === t ? 'bg-blue-600 text-white' : 'border border-gray-700 text-gray-400 hover:text-white'
            }`}>
            {t}
          </button>
        ))}
      </div>

      {/* Summary */}
      {selected.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5 space-y-2 text-sm">
          {[
            { label: 'Selected tokens',   value: `${selected.length}` },
            { label: 'Est. total value',  value: `$${totalValue.toFixed(2)}` },
            { label: 'Protocol fee (1%)', value: `-$${estimatedFee.toFixed(2)}`, red: true },
            { label: 'Gas cost',          value: '~$0 (sponsored)', green: true },
          ].map(row => (
            <div key={row.label} className="flex justify-between">
              <span className="text-gray-400">{row.label}</span>
              <span className={row.red ? 'text-red-400' : row.green ? 'text-green-400' : ''}>{row.value}</span>
            </div>
          ))}
          <hr className="border-gray-700 my-1" />
          <div className="flex justify-between font-semibold">
            <span>You receive</span>
            <span className="text-green-400">~{estimatedOut.toFixed(2)} {outputToken}</span>
          </div>
          <div className="flex justify-between text-yellow-400">
            <span>Points earned</span>
            <span>+{pointsPreview.toLocaleString()} ✨</span>
          </div>
        </div>
      )}

      {/* Status messages */}
      {isConfirming && (
        <div className="bg-blue-900/30 border border-blue-700 rounded-lg p-3 mb-4 text-sm text-blue-300">
          ⏳ Transaction submitted — waiting for confirmation…
        </div>
      )}
      {isSuccess && (
        <div className="bg-green-900/30 border border-green-700 rounded-lg p-3 mb-4 text-sm text-green-300">
          ✅ Sweep complete!
          {txHash && (
            <a href={`https://sepolia.basescan.org/tx/${txHash}`} target="_blank" rel="noreferrer"
              className="ml-2 underline">View TX</a>
          )}
        </div>
      )}
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 mb-4 text-sm text-red-300">
          ❌ {(error as Error).message}
        </div>
      )}

      {/* CTA */}
      <button
        onClick={handleSweep}
        disabled={selected.length === 0 || isPending || isConfirming}
        className="w-full h-14 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold text-lg transition-colors"
      >
        {isPending    ? '⏳ Confirm in wallet…'
         : isConfirming ? '⏳ Processing…'
         : selected.length === 0 ? '🧹 Select tokens to sweep'
         : `🧹 Sweep ${selected.length} tokens → ${outputToken}`}
      </button>

      {process.env.NEXT_PUBLIC_PAYMASTER_URL && (
        <p className="text-center text-xs text-green-400 mt-2">⚡ Gas sponsored — you pay $0</p>
      )}
    </div>
  );
}
