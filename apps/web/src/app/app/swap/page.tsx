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
  symbol:   'ETH',
  decimals: 18,
  image:    'https://token-icons.s3.amazonaws.com/eth.png',
  chainId:  8453,
};

const USDC: Token = {
  name:     'USDC',
  address:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  symbol:   'USDC',
  decimals: 6,
  image:    'https://token-icons.s3.amazonaws.com/usdc.png',
  chainId:  8453,
};

export default function SwapPage() {
  const { address, isConnected } = useAccount();

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <div className="text-5xl mb-4">🔄</div>
        <h1 className="text-3xl font-bold mb-3">Swap</h1>
        <p className="text-gray-400">Connect your wallet to swap tokens</p>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto">
      <h1 className="text-3xl font-bold mb-6">🔄 Swap</h1>

      {/* OnchainKit Swap component handles everything */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <Swap
          onSuccess={(txReceipt) => {
            // Record swap points after successful transaction
            if (address) {
              fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/points/record-swap`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address, txHash: txReceipt.transactionHash }),
              });
            }
          }}
          onError={(error) => console.error('Swap error:', error)}
        >
          <SwapAmountInput label="From" swappableTokens={[ETH, USDC]} token={ETH}  type="from" />
          <SwapAmountInput label="To"   swappableTokens={[ETH, USDC]} token={USDC} type="to"   />
          <SwapButton />
          <SwapMessage />
        </Swap>
      </div>

      <p className="text-xs text-gray-500 text-center mt-4">
        Each swap earns +50 Dust Particles ✨
      </p>

      <SwapToast />
    </div>
  );
}
