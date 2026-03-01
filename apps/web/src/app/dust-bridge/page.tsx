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
    <div className="min-h-screen bg-gray-950 text-white">
      <h1 className="text-3xl font-bold mb-4">Dust Bridge</h1>
      {isConnected ? (
        <div className="max-w-lg mx-auto space-y-6">
          <p>Select any supported chain to bridge dust to Base:</p>
          <div className="grid grid-cols-2 gap-4">
            {SUPPORTED_CHAINS.map((chain) => (
              <div key={chain.name} className={`p-4 bg-gray-900 border border-gray-800 rounded-xl ${chain.status === 'soon' ? 'opacity-50 cursor-not-allowed' : ''}`}>
                <span className="text-2xl">{chain.icon}</span>
                <span className="ml-2">{chain.name}</span>
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
      ) : (
        <p className="text-center text-gray-400">Connect your wallet to see supported chains.</p>
      )}
    </div>
  );
}