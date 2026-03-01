'use client';
import Link from 'next/link';
import { ConnectWallet } from '@coinbase/onchainkit/wallet';

const features = [
  {
    icon: '🧹',
    title: 'Dust Sweep',
    description: 'Select up to 25 dust tokens and convert them all to ETH or USDC in one Smart Wallet signature. No repetitive approvals.',
  },
  {
    icon: '🌉',
    title: 'Dust Bridge',
    description: 'Bridge dust from Ethereum, Arbitrum, Polygon, Optimism and more directly to Base — still in one flow.',
  },
  {
    icon: '🔥',
    title: 'Burn & Reclaim',
    description: 'Remove worthless scam tokens from your wallet. Reclaim later for 90% back if you change your mind.',
  },
  {
    icon: '✨',
    title: 'Earn $DUST',
    description: 'Every sweep, bridge, and burn earns Dust Particles. Gas is sponsored — sweeping costs you $0.',
  },
];

const stats = [
  { stat: '67%', label: 'of token positions are < $5' },
  { stat: '$2-5B', label: 'in aggregate dust across wallets' },
  { stat: '15-30', label: 'dust tokens per average wallet' },
  { stat: '~$0', label: 'gas cost (sponsored by DustSweep)' },
];

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Hero */}
      <div className="max-w-6xl mx-auto px-4 pt-24 pb-16 text-center">
        <div className="inline-flex items-center gap-2 bg-blue-700/50 rounded-full px-4 py-1.5 text-sm text-blue-300 mb-8">
          <span>⚡</span>
          <span>Built on Base · Gas sponsored · One signature</span>
        </div>

        <h1 className="text-5xl md:text-7xl font-bold mb-6 leading-tight">
          Turn Wallet Dust<br />
          Into <span className="text-yellow-400">Gold</span>
        </h1>

        <p className="text-xl text-gray-400 max-w-2xl mx-auto mb-10">
          Batch-sweep worthless micro-balances from your wallet. Convert 25 dust tokens into ETH or USDC with a single click — gas sponsored, no approvals pop-up storm.
        </p>

        <div className="flex flex-wrap gap-4 justify-center">
          <ConnectWallet className="bg-blue-600 hover:bg-blue-700 text-white px-8 py-4 rounded-xl text-lg font-semibold transition-colors">
            Connect Wallet
          </ConnectWallet>
          <Link
            href="/dust-sweep"
            className="bg-blue-600 hover:bg-blue-700 text-white px-8 py-4 rounded-xl text-lg font-semibold transition-colors"
          >
            🧹 Start Sweeping
          </Link>
          <Link
            href="/particles"
            className="border border-gray-700 hover:border-gray-600 text-gray-200 px-8 py-4 rounded-xl text-lg font-semibold transition-colors"
          >
            ✨ Earn Points
          </Link>
        </div>
      </div>

      {/* Features */}
      <div className="max-w-6xl mx-auto px-4 py-16">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map((f) => (
            <div key={f.title} className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-lg transition-all hover:bg-gray-800 hover:shadow-2xl">
              <div className="text-3xl mb-3">{f.icon}</div>
              <h3 className="font-semibold text-lg mb-2">{f.title}</h3>
              <p className="text-gray-400 text-sm">{f.description}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="max-w-4xl mx-auto px-4 py-16 text-center">
        <h2 className="text-3xl font-bold mb-12">The Dust Problem Is Real</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          {stats.map((s) => (
            <div key={s.stat}>
              <div className="text-4xl font-bold text-yellow-400">{s.stat}</div>
              <div className="text-sm text-gray-400 mt-2">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-gray-800 py-8 text-center text-gray-500 text-sm">
        DustSweep · Built on Base · Not financial advice
      </footer>
    </div>
  );
}