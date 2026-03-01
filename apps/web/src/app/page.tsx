'use client';

import Link from 'next/link';
import { useAccount } from 'wagmi';

const FEATURES = [
  {
    icon: '🧹',
    title: 'Dust Sweep',
    description:
      'Select up to 25 dust tokens and convert them all to ETH or USDC in one Smart Wallet signature. No repetitive approvals.',
    href: '/dust-sweep',
    color: 'blue',
  },
  {
    icon: '🌉',
    title: 'Dust Bridge',
    description:
      'Bridge dust from Ethereum, Arbitrum, Polygon, Optimism and more directly to Base — still in one flow.',
    href: '/dust-bridge',
    color: 'purple',
  },
  {
    icon: '🔥',
    title: 'Burn & Reclaim',
    description:
      'Remove worthless scam tokens from your wallet. Reclaim later for 90% back if you change your mind.',
    href: '/burn',
    color: 'red',
  },
  {
    icon: '✨',
    title: 'Dust Particles',
    description:
      'Earn points for every action. Daily check-ins, quests, referrals. Points convert to $DUST at TGE.',
    href: '/particles',
    color: 'yellow',
  },
  {
    icon: '🔄',
    title: 'Swap',
    description:
      'Standard DEX swap powered by Uniswap. Trade any token on Base with 0.3% fees.',
    href: '/swap',
    color: 'green',
  },
];

const STATS = [
  { label: 'Tokens Swept', value: '0' },
  { label: 'Total Value Recovered', value: '$0' },
  { label: 'Wallets Connected', value: '0' },
  { label: 'Dust Particles Distributed', value: '0' },
];

const colorMap: Record<string, string> = {
  blue: 'border-blue-500/20 hover:border-blue-500/50 hover:bg-blue-500/5',
  purple: 'border-purple-500/20 hover:border-purple-500/50 hover:bg-purple-500/5',
  red: 'border-red-500/20 hover:border-red-500/50 hover:bg-red-500/5',
  yellow: 'border-yellow-500/20 hover:border-yellow-500/50 hover:bg-yellow-500/5',
  green: 'border-green-500/20 hover:border-green-500/50 hover:bg-green-500/5',
};

export default function HomePage() {
  const { isConnected } = useAccount();

  return (
    <div className="space-y-16">
      {/* Hero */}
      <section className="text-center pt-12 pb-4">
        <div className="text-5xl mb-4">⚡</div>
        <h1 className="text-4xl sm:text-5xl font-bold mb-4 bg-gradient-to-r from-blue-400 via-purple-400 to-blue-400 bg-clip-text text-transparent">
          Turn Wallet Dust
          <br />
          Into Gold
        </h1>
        <p className="text-gray-400 text-lg max-w-2xl mx-auto mb-8">
          Batch-sweep worthless micro-balances from your wallet. Convert 25 dust
          tokens into ETH or USDC with a single click ��� gas sponsored, no
          approvals pop-up storm.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          {isConnected ? (
            <>
              <Link
                href="/dust-sweep"
                className="px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold transition-colors"
              >
                🧹 Start Sweeping
              </Link>
              <Link
                href="/particles"
                className="px-6 py-3 rounded-xl border border-gray-700 hover:border-gray-500 text-gray-300 hover:text-white font-semibold transition-colors"
              >
                ✨ Earn Points
              </Link>
            </>
          ) : (
            <p className="text-gray-500 text-sm">
              Connect your wallet to get started ↗
            </p>
          )}
        </div>
      </section>

      {/* Stats */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {STATS.map((stat) => (
          <div
            key={stat.label}
            className="bg-gray-900/50 border border-gray-800 rounded-xl p-4 text-center"
          >
            <div className="text-2xl font-bold text-white">{stat.value}</div>
            <div className="text-xs text-gray-500 mt-1">{stat.label}</div>
          </div>
        ))}
      </section>

      {/* Features */}
      <section>
        <h2 className="text-2xl font-bold text-center mb-8">
          Everything You Need
        </h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map((feature) => (
            <Link
              key={feature.title}
              href={feature.href}
              className={`group block p-6 rounded-xl border transition-all duration-200 ${
                colorMap[feature.color]
              }`}
            >
              <div className="text-3xl mb-3">{feature.icon}</div>
              <h3 className="text-lg font-semibold text-white mb-2">
                {feature.title}
              </h3>
              <p className="text-sm text-gray-400 leading-relaxed">
                {feature.description}
              </p>
            </Link>
          ))}
        </div>
      </section>

      {/* Powered by */}
      <section className="text-center pb-8">
        <p className="text-xs text-gray-600">
          Built on Base ⬡ · Powered by Uniswap · Smart Wallet by Coinbase
        </p>
      </section>
    </div>
  );
}