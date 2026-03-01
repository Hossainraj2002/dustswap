'use client';

/**
 * Swap page — uses OnchainKit <Swap /> component.
 * Gas sponsorship is picked up automatically via wagmi config.
 */

import { useAccount } from 'wagmi';
import { Swap, SwapAmountInput, SwapButton, SwapMessage, SwapToast } from '@coinbase/onchainkit/swap';
import { base, baseSepolia } from 'viem/chains';
import type { Token } from '@coinbase/onchainkit/token';

// Well-known Base tokens
const ETH: Token = {
  name:     'Ethereum',
  address:  '',
};
const USDC: Token = {
  name:     'USDC',
  address:  '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
};

export default function SwapPage() {
  const { isConnected } = useAccount();

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <h1 className="text-3xl font-bold mb-4">Swap Tokens</h1>
      {isConnected ? (
        <div className="max-w-md mx-auto p-6 bg-gray-900 border border-gray-800 rounded-xl">
          <Swap chain={base}>
            <SwapAmountInput label="From" swappableTokens={[ETH, USDC]} token={ETH} type="from" />
            <SwapAmountInput label="To"   swappableTokens={[ETH, USDC]} token={USDC} type="to"   />
            <SwapButton />
            <SwapMessage />
          </Swap>
          <p className="text-xs text-gray-500 text-center mt-4">
            Each swap earns +50 Dust Particles ✨
          </p>
          <SwapToast />
        </div>
      ) : (
        <p className="text-center text-gray-400">Connect your wallet to use the swap.</p>
      )}
    </div>
  );
}