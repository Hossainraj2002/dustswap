"use client";

import { type ReactNode, useState } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OnchainKitProvider } from "@coinbase/onchainkit";
import { MiniKitProvider } from "@coinbase/onchainkit/minikit";
import { base } from "wagmi/chains";
import { wagmiAdapter, wagmiConfig, projectId } from "@/wagmi";
import { createAppKit } from "@reown/appkit/react";
import { INITIAL_WAGMI_CHAINS } from "@/config/web3";

const BASE_ACCOUNT_WALLET_ID = 'fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa';

export const modal = createAppKit({
  adapters: [wagmiAdapter],
  projectId,
  networks: INITIAL_WAGMI_CHAINS as any,
  metadata: {
    name: "DustSwap",
    description: "DustSwap cross-chain swaps and bridges",
    url: "https://dustswap.xyz",
    icons: ["https://dustswap.xyz/logo.png"],
  },
  themeMode: 'dark',
  features: {
    analytics: true,
  },
  featuredWalletIds: [BASE_ACCOUNT_WALLET_ID],
});

interface ProvidersProps {
  children: ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30 * 1000,
            gcTime: 5 * 60 * 1000,
            retry: 2,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  return (
    <WagmiProvider config={wagmiConfig} reconnectOnMount>
      <QueryClientProvider client={queryClient}>
        <OnchainKitProvider
          apiKey={process.env.NEXT_PUBLIC_ONCHAINKIT_API_KEY}
          projectId={process.env.NEXT_PUBLIC_ONCHAINKIT_API_KEY}
          chain={base}
          config={{
            appearance: {
              mode: "dark",
              theme: "cyberpunk",
            },
            paymaster: process.env.NEXT_PUBLIC_PAYMASTER_URL,
          }}
        >
          <MiniKitProvider chain={base}>
            {children}
          </MiniKitProvider>
        </OnchainKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
