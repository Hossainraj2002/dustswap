'use client';

/**
 * providers.tsx
 *
 * Integrates THREE Base-specific UX improvements:
 *
 * 1. BATCH TRANSACTIONS
 *    Using Coinbase Smart Wallet + wagmi's useWriteContracts hook.
 *    Users approve all dust tokens AND execute the sweep in ONE signature.
 *    Docs: https://docs.base.org/base-account/improve-ux/batch-transactions
 *
 * 2. SPONSORED GAS (Paymaster)
 *    NEXT_PUBLIC_PAYMASTER_URL points to a Coinbase Paymaster endpoint.
 *    When set, the protocol pays gas so users pay $0 in ETH.
 *    Docs: https://docs.base.org/base-account/improve-ux/sponsor-gas/paymasters
 *
 * 3. BUILDER CODE
 *    NEXT_PUBLIC_BASE_BUILDER_CODE is appended to Alchemy RPC calls.
 *    This earns DustSweep a rebate on gas fees Base collects.
 *    Docs: https://docs.base.org/base-chain/builder-codes/app-developers
 */

import { OnchainKitProvider }              from '@coinbase/onchainkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createConfig, http, WagmiProvider } from 'wagmi';
import { base, baseSepolia }                from 'wagmi/chains';
import { coinbaseWallet }                   from 'wagmi/connectors';
import { ReactNode, useState }              from 'react';

import '@coinbase/onchainkit/styles.css';

// ─── Builder Code RPC helper ───────────────────────────────────────────────────
// Appends ?builderCode=<code> to every RPC URL so Base can attribute fees.
// See https://docs.base.org/base-chain/builder-codes/app-developers
function rpcWithBuilderCode(baseUrl: string): string {
  const code = process.env.NEXT_PUBLIC_BASE_BUILDER_CODE;
  if (!code) return baseUrl;
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}builderCode=${code}`;
}

// ─── Wagmi config ─────────────────────────────────────────────────────────────
// coinbaseWallet with preference: 'smartWalletOnly' enables:
//   • Batch transactions (wallet_sendCalls)
//   • Paymaster capabilities
const isTestnet = process.env.NEXT_PUBLIC_NETWORK !== 'mainnet';

const wagmiConfig = createConfig({
  chains: isTestnet ? [baseSepolia] : [base],
  ssr: true, // ✅ THIS IS THE FIX! Prevents Next.js build crash during static generation
  connectors: [
    coinbaseWallet({
      appName:    'DustSweep',
      appLogoUrl: 'https://dustsweep.xyz/logo.png',
      // smartWalletOnly: required for batch TX and paymaster support
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

// ─── Provider tree ────────────────────────────────────────────────────────────
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000 } },
  }));

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <OnchainKitProvider
          apiKey={process.env.NEXT_PUBLIC_ONCHAINKIT_API_KEY}
          chain={isTestnet ? baseSepolia : base}
        >
          {children}
        </OnchainKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

// ─── Export paymaster URL for hooks ──────────────────────────────────────────
// Hooks import this so they can attach paymaster capabilities to batch calls.
export const PAYMASTER_URL = process.env.NEXT_PUBLIC_PAYMASTER_URL ?? null;