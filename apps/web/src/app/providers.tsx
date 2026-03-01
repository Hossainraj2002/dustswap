'use client';

import { OnchainKitProvider }              from '@coinbase/onchainkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createConfig, http, WagmiProvider } from 'wagmi';
import { base, baseSepolia }                from 'wagmi/chains';
import { coinbaseWallet }                   from 'wagmi/connectors';
import { type ReactNode, useState, useEffect } from 'react';

import '@coinbase/onchainkit/styles.css';

// ─── Builder Code RPC helper ──────────────────────────────────────────────
function rpcWithBuilderCode(baseUrl: string): string {
  const code = process.env.NEXT_PUBLIC_BASE_BUILDER_CODE;
  if (!code) return baseUrl;
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}builderCode=${code}`;
}

// ─── Wagmi config ─────────────────────────────────────────────────────────
const isTestnet = process.env.NEXT_PUBLIC_NETWORK !== 'mainnet';

const wagmiConfig = createConfig({
  chains: isTestnet ? [baseSepolia] : [base],
  ssr: true,
  connectors: [
    coinbaseWallet({
      appName: 'DustSweep',
      appLogoUrl: 'https://dustsweep.xyz/logo.png',
      preference: 'smartWalletOnly',
    }),
  ],
  transports: {
    [baseSepolia.id]: http(
      rpcWithBuilderCode(
        `https://base-sepolia.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY}`
      )
    ),
    [base.id]: http(
      rpcWithBuilderCode(
        `https://base-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY}`
      )
    ),
  },
});

// ─── Provider tree ────────────────────────────────────────────────────────
export function Providers({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [queryClient] = useState(() =>
    new QueryClient({
      defaultOptions: { queries: { staleTime: 30_000 } },
    })
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <OnchainKitProvider
          apiKey={process.env.NEXT_PUBLIC_ONCHAINKIT_API_KEY}
          chain={isTestnet ? baseSepolia : base}
        >
          {mounted ? (
            children
          ) : (
            <div className="min-h-screen flex items-center justify-center bg-gray-950 text-white">
              Loading…
            </div>
          )}
        </OnchainKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export const PAYMASTER_URL = process.env.NEXT_PUBLIC_PAYMASTER_URL ?? null;