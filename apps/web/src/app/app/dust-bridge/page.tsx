'use client';

import { useAccount } from 'wagmi';

const SUPPORTED_CHAINS = [
  { name: 'Ethereum',  icon: '⟠', status: 'soon'    },
  { name: 'Arbitrum',  icon: '🔵', status: 'soon'    },
  { name: 'Optimism',  icon: '🔴', status: 'soon'    },
  { name: 'Polygon',   icon: '🟣', status: 'soon'    },
  { name: 'Avalanche', icon: '🔺', status: 'planned' },
  { name: 'BNB Chain', icon: '🟡', status: 'planned' },
];

export default function DustBridgePage() {
  const { isConnected } = useAccount();

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold mb-2">🌉 Dust Bridge</h1>
      <p className="text-gray-400 text-sm mb-8">
        Bridge dust tokens from other chains to Base — one signature, gas sponsored.
        Coming in Phase 2!
      </p>

      <div className="bg-yellow-900/20 border border-yellow-700/50 rounded-xl p-5 mb-8">
        <h3 className="font-semibold text-yellow-300 mb-1">🚧 Phase 2 Feature</h3>
        <p className="text-yellow-400/80 text-sm">
          Dust Bridge is in development. We&apos;ll integrate Relay.link, Gas.zip, and LiFi
          to find the cheapest route for each source chain automatically.
        </p>
      </div>

      <h2 className="font-semibold mb-4 text-gray-300">Planned Source Chains</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {SUPPORTED_CHAINS.map(c => (
          <div key={c.name} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center gap-3">
            <span className="text-2xl">{c.icon}</span>
            <div>
              <p className="font-medium text-sm">{c.name}</p>
              <p className={`text-xs ${c.status === 'soon' ? 'text-yellow-400' : 'text-gray-500'}`}>
                {c.status === 'soon' ? 'Coming soon' : 'Planned'}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h3 className="font-semibold mb-2">How it will work</h3>
        <ol className="space-y-2 text-sm text-gray-400 list-decimal list-inside">
          <li>Connect your wallet on any supported chain</li>
          <li>DustSweep scans all chains for dust simultaneously</li>
          <li>Select tokens from any mix of chains</li>
          <li>We find the cheapest bridge route per chain</li>
          <li>Everything bridges to Base and sweeps in one coordinated flow</li>
          <li>Earn 10× points on bridged dust!</li>
        </ol>
      </div>
    </div>
  );
}
