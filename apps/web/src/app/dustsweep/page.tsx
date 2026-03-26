'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import { type Address } from 'viem';
import {
  useDustSweep,
  type ThresholdValue,
  type OutputTokenOption,
  type DustToken,
} from '@/hooks/useDustSweep';
import { DATA_SUFFIX } from '@/lib/builderCode';

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Constants Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

const THRESHOLDS: { value: ThresholdValue; label: string }[] = [
  { value: 1,  label: 'Under $1'  },
  { value: 2,  label: 'Under $2'  },
  { value: 5,  label: 'Under $5'  },
  { value: 10, label: 'Under $10' },
];

const OUTPUT_OPTIONS: { value: OutputTokenOption; label: string; icon: string; logoURI: string }[] = [
  { value: 'ETH',  label: 'ETH',  icon: 'ÃŽÅ¾', logoURI: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png' },
  { value: 'USDC', label: 'USDC', icon: '$', logoURI: 'https://basescan.org/token/images/centre-usdc_28.png' },
  { value: 'WETH', label: 'WETH', icon: 'ÃŽÅ¾', logoURI: 'https://basescan.org/token/images/weth_28.png' },
];

const MAX_SELECTED = 10;
const BASE_SCAN_URL = 'https://basescan.org/tx/';

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Confetti Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function ConfettiParticles() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const colors = ['#a855f7','#6366f1','#ec4899','#f59e0b','#10b981','#06b6d4','#8b5cf6','#f43f5e'];
    const particles = Array.from({ length: 120 }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height - canvas.height,
      vx: (Math.random() - 0.5) * 6,
      vy: Math.random() * 3 + 2,
      size: Math.random() * 8 + 3,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * 360,
      rotationSpeed: (Math.random() - 0.5) * 10,
      opacity: 1,
    }));

    let animationId: number;
    let frame = 0;
    const maxFrames = 180;

    function animate() {
      if (!ctx || !canvas) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      frame++;
      for (const p of particles) {
        p.x += p.vx; p.vy += 0.05; p.y += p.vy;
        p.rotation += p.rotationSpeed;
        p.opacity = Math.max(0, 1 - frame / maxFrames);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.globalAlpha = p.opacity;
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }
      if (frame < maxFrames) animationId = requestAnimationFrame(animate);
    }

    animate();
    return () => cancelAnimationFrame(animationId);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none z-50"
      style={{ width: '100vw', height: '100vh' }}
    />
  );
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Token Card Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function TokenCard({
  token,
  isSelected,
  onToggle,
  disabled,
}: {
  token: DustToken;
  isSelected: boolean;
  onToggle: (address: Address) => void;
  disabled: boolean;
}) {
  const hasLiquidity = token.hasLiquidity;

  return (
    <div
      className={`
        flex items-center justify-between p-4 rounded-xl border transition-all duration-200
        ${isSelected
          ? 'bg-purple-900/20 border-purple-500/50 shadow-lg shadow-purple-500/10'
          : 'bg-gray-900/80 border-gray-800 hover:border-gray-700'}
        ${!hasLiquidity ? 'opacity-60' : ''}
      `}
    >
      {/* Left: Icon + Name */}
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {token.logoURI ? (
          <img
            src={token.logoURI}
            alt={token.symbol}
            className="w-10 h-10 rounded-full bg-gray-800 flex-shrink-0"
            onError={(e) => {
              const img = e.target as HTMLImageElement;
              img.style.display = 'none';
              const sib = img.nextElementSibling as HTMLElement | null;
              if (sib) sib.classList.remove('hidden');
            }}
          />
        ) : null}
        <div
          className={`w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white font-bold text-sm flex-shrink-0 ${
            token.logoURI ? 'hidden' : ''
          }`}
        >
          {token.symbol?.charAt(0) || '?'}
        </div>
        <div className="min-w-0">
          <p className="text-white font-medium text-sm truncate">{token.name}</p>
          <p className="text-gray-400 text-xs">{token.symbol}</p>
        </div>
      </div>

      {/* Center: Balance + USD */}
      <div className="text-right px-3 flex-shrink-0">
        <p className="text-white text-sm font-mono">{formatBalance(token.balanceFormatted)}</p>
        <p className="text-gray-400 text-xs">${token.usdValue.toFixed(2)}</p>
      </div>

      {/* Right: Checkbox or Badge */}
      <div className="flex-shrink-0 ml-2">
        {hasLiquidity ? (
          <button
            onClick={() => onToggle(token.address)}
            disabled={disabled && !isSelected}
            className={`
              w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all duration-150
              ${isSelected
                ? 'bg-purple-600 border-purple-500'
                : disabled
                ? 'border-gray-700 cursor-not-allowed opacity-40'
                : 'border-gray-600 hover:border-purple-400'}
            `}
            aria-label={isSelected ? `Deselect ${token.symbol}` : `Select ${token.symbol}`}
          >
            {isSelected && (
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-xs bg-red-900/50 text-red-400 px-2 py-0.5 rounded-full border border-red-800/50 whitespace-nowrap">
              No Liquidity
            </span>
            <a
              href={`https://basescan.org/token/${token.address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-gray-500 hover:text-red-400 underline whitespace-nowrap"
            >
              Burn
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Success Modal Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function SuccessModal({
  data,
  onClose,
}: {
  data: { txHash: string; tokensSwept: number; amountReceived: string; outputSymbol: string; particlesEarned: number };
  onClose: () => void;
}) {
  return (
    <>
      <ConfettiParticles />
      <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-40 p-4">
        <div className="bg-gray-900 border border-gray-700 rounded-2xl p-8 max-w-md w-full shadow-2xl shadow-purple-500/20">
          <div className="text-center mb-6">
            <div className="text-6xl mb-3">Ã°Å¸Â§Â¹Ã¢Å“Â¨</div>
            <h2 className="text-2xl font-bold text-white">Dust Swept!</h2>
            <p className="text-gray-400 mt-1">Your wallet is cleaner now</p>
          </div>
          <div className="space-y-3 mb-6">
            <div className="flex justify-between items-center py-2 border-b border-gray-800">
              <span className="text-gray-400">Tokens Swept</span>
              <span className="text-white font-semibold">{data.tokensSwept}</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-gray-800">
              <span className="text-gray-400">Received</span>
              <span className="text-white font-semibold">{data.amountReceived} {data.outputSymbol}</span>
            </div>
            <div className="flex justify-between items-center py-2">
              <span className="text-gray-400">Dust Particles</span>
              <span className="text-purple-400 font-bold text-lg">+{data.particlesEarned} Ã¢Å“Â¨</span>
            </div>
          </div>
          <div className="space-y-3">
            <a
              href={`${BASE_SCAN_URL}${data.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full text-center py-3 px-4 rounded-xl bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 hover:text-white transition-colors text-sm"
            >
              View on BaseScan Ã¢â€ â€”
            </a>
            <button
              onClick={onClose}
              className="block w-full text-center py-3 px-4 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-semibold transition-all"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Sticky Sweep Panel (FIX 5) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function StickySweepPanel({
  selectedCount,
  totalValueUsd,
  outputToken,
  quote,
  isQuoting,
  quoteError,
  sweepCalls,
  isSending,
  onSweep,
  getQuote,
}: {
  selectedCount: number;
  totalValueUsd: number;
  outputToken: OutputTokenOption;
  quote: ReturnType<typeof useDustSweep>['quote'];
  isQuoting: boolean;
  quoteError: string | null;
  sweepCalls: ReturnType<typeof useDustSweep>['sweepCalls'];
  isSending: boolean;
  onSweep: () => void;
  getQuote: () => Promise<void>;
}) {
  if (selectedCount === 0) return null;

  const hasPartialTokens = quote?.perTokenQuotes.some(
    (pq) => (pq.maxSwappablePercent ?? 100) < 100
  );

  return (
    <div className="fixed md:bottom-0 bottom-[calc(64px+env(safe-area-inset-bottom))] left-0 right-0 z-40 bg-gray-950/95 backdrop-blur border-t border-gray-800 shadow-2xl shadow-black/50">
      <div className="max-w-2xl mx-auto px-4 py-4">

        {/* Ã¢â€â‚¬Ã¢â€â‚¬ Partial liquidity warning Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */}
        {hasPartialTokens && (
          <div className="mb-3 flex items-start gap-2 text-xs text-amber-400 bg-amber-900/20 border border-amber-800/40 rounded-lg px-3 py-2">
            <svg className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            Some tokens can only be partially swapped due to limited pool liquidity.
          </div>
        )}

        {/* Ã¢â€â‚¬Ã¢â€â‚¬ Summary row Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */}
        <div className="flex items-center gap-4">
          {/* Left: token count + value */}
          <div className="flex-1 min-w-0">
            <p className="text-white font-semibold text-sm">
              {selectedCount} token{selectedCount !== 1 ? 's' : ''} selected
            </p>
            <p className="text-gray-400 text-xs mt-0.5">
              {isQuoting ? (
                <span className="inline-flex items-center gap-1">
                  <span className="w-3 h-3 border border-purple-500 border-t-transparent rounded-full animate-spin inline-block" />
                  Getting quote...
                </span>
              ) : quote ? (
                <>
                  ~${quote.totalDustValueUsd.toFixed(2)} dust
                  {' Ã¢â€ â€™ '}
                  <span className="text-purple-400 font-medium whitespace-nowrap">
                    ~{Number(quote.estimatedOutputFormatted).toLocaleString(undefined, { maximumFractionDigits: 6 })} {quote.outputTokenSymbol}
                  </span>
                </>
              ) : quoteError ? (
                <span className="text-red-400">{quoteError}</span>
              ) : (
                `~$${totalValueUsd.toFixed(2)} total value`
              )}
            </p>
          </div>

          {/* Right: Sweep button */}
          <div className="flex-shrink-0">
            {sweepCalls.length > 0 && quote ? (
              <button
                type="button"
                onClick={onSweep}
                disabled={isSending}
                className="bg-gradient-to-r from-purple-600 to-indigo-600 px-6 py-3 text-sm font-semibold text-white rounded-xl shadow-lg shadow-purple-500/25 transition-all duration-200 whitespace-nowrap hover:from-purple-500 hover:to-indigo-500 disabled:cursor-wait disabled:opacity-70"
              >
                {isSending ? 'Sweeping...' : `Sweep ${selectedCount}`}
              </button>
            ) : (
              <button
                onClick={getQuote}
                disabled={isQuoting}
                className="py-3 px-6 rounded-xl bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400 hover:text-white font-semibold text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
              >
                {isQuoting ? 'Getting quote...' : quoteError ? 'Ã¢â€ Âº Retry Quote' : 'Get Quote'}
              </button>
            )}
          </div>
        </div>

        {/* Ã¢â€â‚¬Ã¢â€â‚¬ Fee note Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */}
        <p className="text-xs text-gray-600 mt-3 text-center">
          DustSwap charges a 2% fee Ã‚Â· Gas sponsored via Base Paymaster Ã‚Â· Earn Ã¢Å“Â¨ Dust Particles
        </p>
      </div>
    </div>
  );
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Helpers Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function formatBalance(value: string): string {
  const num = parseFloat(value);
  if (isNaN(num)) return '0';
  if (num < 0.0001) return '<0.0001';
  if (num < 1) return num.toFixed(4);
  if (num < 1000) return num.toFixed(2);
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Loading Skeleton Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function TokenSkeleton() {
  return (
    <div className="flex items-center justify-between p-4 rounded-xl bg-gray-900/80 border border-gray-800 animate-pulse">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-gray-700" />
        <div>
          <div className="w-24 h-4 bg-gray-700 rounded mb-1" />
          <div className="w-12 h-3 bg-gray-700 rounded" />
        </div>
      </div>
      <div className="text-right">
        <div className="w-16 h-4 bg-gray-700 rounded mb-1" />
        <div className="w-10 h-3 bg-gray-700 rounded" />
      </div>
      <div className="w-6 h-6 rounded-md bg-gray-700 ml-2" />
    </div>
  );
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Main Page Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

export default function DustSweepPage() {
  const { isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const {
    dustTokens,
    noLiquidityTokens,
    selectedTokens,
    threshold,
    setThreshold,
    toggleToken,
    selectAll,
    deselectAll,
    outputToken,
    setOutputToken,
    quote,
    getQuote,
    sweepCalls,
    isLoading,
    isQuoting,
    error,
    quoteError,
    handleSuccess,
    successData,
    clearSuccess,
  } = useDustSweep();

  const [outputDropdownOpen, setOutputDropdownOpen] = useState(false);
  const [isSendingSweep, setIsSendingSweep] = useState(false);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-output-dropdown]')) setOutputDropdownOpen(false);
    }
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const onTransactionSuccess = useCallback(
    (response: { transactionReceipts: Array<{ transactionHash: string }> }) => {
      const txHash = response?.transactionReceipts?.[0]?.transactionHash || '';
      handleSuccess(txHash);
    },
    [handleSuccess]
  );

  const onTransactionError = useCallback(
    (e: { code: string; error: string; message: string }) => {
      console.error('Transaction failed:', e.message);
    },
    []
  );

  const onSweep = useCallback(async () => {
    if (!walletClient || sweepCalls.length === 0) {
      return;
    }

    setIsSendingSweep(true);

    try {
      const { id } = await walletClient.sendCalls({
        calls: sweepCalls.map((call) => ({
          ...call,
          dataSuffix: DATA_SUFFIX,
        })),
        capabilities: process.env.NEXT_PUBLIC_PAYMASTER_URL
          ? {
              paymasterService: {
                url: process.env.NEXT_PUBLIC_PAYMASTER_URL,
              },
              dataSuffix: {
                value: DATA_SUFFIX,
                optional: true,
              },
            }
          : {
              dataSuffix: {
                value: DATA_SUFFIX,
                optional: true,
              },
            },
        experimental_fallback: true,
      } as any);

      const status = await walletClient.waitForCallsStatus({
        id,
        throwOnFailure: true,
        timeout: 120_000,
      });
      const receipts = status.receipts ?? [];

      onTransactionSuccess({
        transactionReceipts: receipts.map((receipt) => ({
          transactionHash: receipt.transactionHash,
        })),
      });
    } catch (error: any) {
      onTransactionError({
        code: error.code || 'UNKNOWN',
        error: error.name || 'Error',
        message: error.shortMessage || error.message || 'Transaction failed',
      });
    } finally {
      setIsSendingSweep(false);
    }
  }, [walletClient, sweepCalls, onTransactionSuccess, onTransactionError]);

  const allTokens = [...dustTokens, ...noLiquidityTokens];
  const selectedCount = selectedTokens.length;
  const isMaxSelected = selectedCount >= MAX_SELECTED;
  const hasSelectedTokens = selectedCount > 0;

  // Total USD value of selected tokens (for sticky panel)
  const totalSelectedValueUsd = selectedTokens.reduce((sum, t) => sum + t.usdValue, 0);

  // Ã¢â€â‚¬Ã¢â€â‚¬ Not Connected Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  if (!isConnected) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <div className="text-7xl mb-6">Ã°Å¸Â§Â¹</div>
          <h1 className="text-3xl font-bold text-white mb-3">Dust Sweep</h1>
          <p className="text-gray-400 mb-8">
            Connect your wallet to find and sweep dust tokens into one useful asset.
          </p>
          {/* @ts-ignore */}
          <appkit-button />
        </div>
      </div>
    );
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Main Render Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  return (
    <div className="min-h-screen bg-gray-950">
      {successData && <SuccessModal data={successData} onClose={clearSuccess} />}

      {/* Ã¢â€â‚¬Ã¢â€â‚¬ Add padding so sticky panel doesn't cover tokens, with extra room for mobile nav Ã¢â€â‚¬Ã¢â€â‚¬ */}
      <div className={`max-w-2xl mx-auto px-4 py-8 sm:py-12 ${hasSelectedTokens ? 'pb-48 md:pb-40' : ''}`}>

        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl sm:text-5xl font-bold text-white mb-2">Ã°Å¸Â§Â¹ Dust Sweep</h1>
          <p className="text-gray-400 text-lg">Select your dust tokens and sweep them into one</p>
        </div>

        {/* Threshold Selector */}
        <div className="mb-6">
          <label className="text-sm text-gray-400 mb-2 block font-medium">
            Token Value Threshold
          </label>
          <div className="grid grid-cols-4 gap-2">
            {THRESHOLDS.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => setThreshold(value)}
                className={`
                  py-2.5 px-3 rounded-xl text-sm font-medium transition-all duration-200
                  ${threshold === value
                    ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-lg shadow-purple-500/25'
                    : 'bg-gray-900 border border-gray-800 text-gray-400 hover:text-white hover:border-gray-600'}
                `}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Output Token Selector (shown when tokens selected) */}
        {hasSelectedTokens && (
          <div className="mb-6">
            <label className="text-sm text-gray-400 mb-2 block font-medium">Sweep Into</label>
            <div className="relative" data-output-dropdown>
              <button
                onClick={() => setOutputDropdownOpen(!outputDropdownOpen)}
                className="w-full flex items-center justify-between p-4 rounded-xl bg-gray-900/80 border border-gray-800 hover:border-gray-600 transition-colors"
              >
                <div className="flex items-center gap-3">
                  {OUTPUT_OPTIONS.find((o) => o.value === outputToken)?.logoURI ? (
                    <img 
                      src={OUTPUT_OPTIONS.find((o) => o.value === outputToken)?.logoURI} 
                      alt={outputToken}
                      className="w-8 h-8 rounded-full bg-gray-800"
                    />
                  ) : (
                    <span className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white font-bold text-sm">
                      {OUTPUT_OPTIONS.find((o) => o.value === outputToken)?.icon}
                    </span>
                  )}
                  <span className="text-white font-medium">
                    {OUTPUT_OPTIONS.find((o) => o.value === outputToken)?.label}
                  </span>
                </div>
                <svg
                  className={`w-5 h-5 text-gray-400 transition-transform ${outputDropdownOpen ? 'rotate-180' : ''}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {outputDropdownOpen && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-gray-900 border border-gray-700 rounded-xl overflow-hidden z-30 shadow-xl">
                  {OUTPUT_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => { setOutputToken(option.value); setOutputDropdownOpen(false); }}
                      className={`
                        w-full flex items-center gap-3 p-3 hover:bg-gray-800 transition-colors
                        ${outputToken === option.value ? 'bg-purple-900/20 text-white' : 'text-gray-300'}
                      `}
                    >
                      {option.logoURI ? (
                        <img src={option.logoURI} alt={option.label} className="w-7 h-7 rounded-full bg-gray-800" />
                      ) : (
                        <span className="w-7 h-7 rounded-full bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white font-bold text-xs">
                          {option.icon}
                        </span>
                      )}
                      <span className="font-medium">{option.label}</span>
                      {outputToken === option.value && (
                        <svg className="w-4 h-4 text-purple-400 ml-auto" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Error Banner */}
        {error && (
          <div className="mb-6 p-4 rounded-xl bg-red-900/20 border border-red-800/50 text-red-400 text-sm">
            <span className="font-medium">Error:</span> {error}
          </div>
        )}

        {/* Token List */}
        <div className="mb-6">


          {/* Select controls */}
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm text-gray-400">
              {isLoading ? 'Scanning wallet...' : (
                <>
                  <span className="text-white font-medium">{selectedCount}</span>
                  {' of '}
                  <span className="text-white font-medium">{MAX_SELECTED}</span>
                  {' max selected'}
                </>
              )}
            </p>
            {dustTokens.length > 0 && (
              <div className="flex gap-2">
                <button
                  onClick={selectAll}
                  className="text-xs text-purple-400 hover:text-purple-300 transition-colors px-2 py-1 rounded-lg hover:bg-purple-500/10"
                >
                  Select All
                </button>
                <button
                  onClick={deselectAll}
                  className="text-xs text-gray-500 hover:text-gray-300 transition-colors px-2 py-1 rounded-lg hover:bg-gray-500/10"
                >
                  Deselect All
                </button>
              </div>
            )}
          </div>

          {/* Max warning */}
          {isMaxSelected && (
            <div className="mb-3 p-3 rounded-lg bg-amber-900/20 border border-amber-800/50 text-amber-400 text-xs flex items-center gap-2">
              <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              Maximum of {MAX_SELECTED} tokens can be swept at once.
            </div>
          )}

          {/* Token cards */}
          <div className="space-y-2">
            {isLoading ? (
              <>
                <TokenSkeleton />
                <TokenSkeleton />
                <TokenSkeleton />
                <TokenSkeleton />
              </>
            ) : allTokens.length === 0 ? (
              <div className="text-center py-16">
                <div className="text-6xl mb-4">Ã¢Å“Â¨</div>
                <h3 className="text-xl font-semibold text-white mb-2">Your wallet is clean!</h3>
                <p className="text-gray-400">
                  No dust tokens found under ${threshold}. Try increasing the threshold.
                </p>
              </div>
            ) : (
              <>
                {/* Tokens with liquidity */}
                {dustTokens.map((token) => (
                  <TokenCard
                    key={token.address}
                    token={token}
                    isSelected={selectedTokens.some((t) => t.address === token.address)}
                    onToggle={toggleToken}
                    disabled={isMaxSelected}
                  />
                ))}

                {/* No liquidity section */}
                {noLiquidityTokens.length > 0 && (
                  <div className="mt-6">
                    <p className="text-xs text-gray-500 uppercase tracking-wider mb-2 px-1">
                      No Liquidity ({noLiquidityTokens.length})
                    </p>
                    {noLiquidityTokens.map((token) => (
                      <TokenCard
                        key={token.address}
                        token={token}
                        isSelected={false}
                        onToggle={() => {}}
                        disabled={true}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Quote detail card (visible when we have a quote but panel is the primary CTA) */}
        {hasSelectedTokens && quote && (
          <div className="mb-6 bg-gray-900/80 border border-gray-800 rounded-xl p-5">
            <h3 className="text-sm font-medium text-gray-300 mb-3">Quote Summary</h3>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Selected tokens</span>
                <span className="text-white">{quote.selectedCount}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Total dust value</span>
                <span className="text-white">~${quote.totalDustValueUsd.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Sweep fee ({quote.swapFeePercent}%)</span>
                <span className="text-amber-400">-${quote.swapFeeUsd.toFixed(2)}</span>
              </div>
              <div className="border-t border-gray-700 my-2" />
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Estimated output</span>
                <span className="text-white font-semibold text-base">
                  ~{quote.estimatedOutputFormatted} {quote.outputTokenSymbol}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Gas</span>
                <span className="inline-flex items-center gap-1 text-green-400 text-xs bg-green-900/20 px-2 py-0.5 rounded-full border border-green-800/30">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  Sponsored
                </span>
              </div>
            </div>
          </div>
        )}

      </div>

      {/* Ã¢â€â‚¬Ã¢â€â‚¬ FIX 5: Sticky bottom panel Ã¢â‚¬â€ always visible when tokens are selected Ã¢â€â‚¬Ã¢â€â‚¬ */}
      <StickySweepPanel
        selectedCount={selectedCount}
        totalValueUsd={totalSelectedValueUsd}
        outputToken={outputToken}
        quote={quote}
        isQuoting={isQuoting}
        quoteError={quoteError}
        sweepCalls={sweepCalls}
        isSending={isSendingSweep}
        onSweep={onSweep}
        getQuote={getQuote}
      />
    </div>
  );
}
