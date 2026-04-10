"use client";

import { type ReactNode, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type Chain as PrivyChain } from "@privy-io/chains";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider } from "@privy-io/wagmi";
import { PRIVY_WALLET_LIST } from "@/hooks/useWalletConnection";
import { INITIAL_WAGMI_CHAINS } from "@/config/web3";
import { useSwapCapture } from "@/hooks/useSwapCapture";
import { wagmiConfig } from "@/wagmi";

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://app.dustswap.wtf";
const privySupportedChains = INITIAL_WAGMI_CHAINS as unknown as PrivyChain[];
const walletConnectCloudProjectId =
  process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID ||
  process.env.NEXT_PUBLIC_WC_PROJECT_ID;

interface ProvidersProps {
  children: ReactNode;
}

function SwapCaptureBootstrap() {
  useSwapCapture();
  return null;
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
    <PrivyProvider
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? ""}
      config={{
        appearance: {
          logo: `${appUrl}/logo.png`,
          showWalletLoginFirst: true,
          theme: "light",
          walletChainType: "ethereum-only",
          walletList: PRIVY_WALLET_LIST,
        },
        defaultChain: privySupportedChains[0],
        loginMethods: ["wallet"],
        supportedChains: privySupportedChains,
        walletConnectCloudProjectId,
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig} reconnectOnMount>
          <SwapCaptureBootstrap />
          {children}
        </WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
