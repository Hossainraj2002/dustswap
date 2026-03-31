"use client";

import { type ReactNode, useState } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAppKit } from "@reown/appkit/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { projectId, wagmiConfig, wagmiConnectors } from "@/wagmi";
import { INITIAL_WAGMI_CHAINS, getWagmiTransports } from "@/config/web3";
import { useSwapCapture } from "@/hooks/useSwapCapture";
import { DATA_SUFFIX } from "@/lib/builderCode";

let hasInitializedAppKit = false;
let wagmiAdapter: InstanceType<typeof WagmiAdapter> | null = null;

function getAppKitAdapter() {
  if (!wagmiAdapter) {
    wagmiAdapter = new WagmiAdapter({
      projectId,
      networks: INITIAL_WAGMI_CHAINS as any,
      connectors: wagmiConnectors,
      transports: getWagmiTransports(INITIAL_WAGMI_CHAINS) as any,
      dataSuffix: DATA_SUFFIX,
      ssr: false,
    });
  }

  return wagmiAdapter;
}

function ensureAppKit() {
  if (hasInitializedAppKit || typeof window === "undefined") {
    return;
  }

  createAppKit({
    adapters: [getAppKitAdapter()],
    projectId,
    networks: INITIAL_WAGMI_CHAINS as any,
    metadata: {
      name: "DustSwap",
      description: "DustSwap cross-chain swaps and bridges",
      url: "https://dustswap.xyz",
      icons: ["https://dustswap.xyz/logo.png"],
    },
    themeMode: "dark",
    features: {
      analytics: true,
      email: false,
      socials: [],
    },
    featuredWalletIds: [
      "fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa",
      "20459438007b75f4f4acb98bf29aa3bbf66a1f896f20405e27d5af5eb3008afa",
      "c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96",
      "c286eebc74233261a8cbd3df3d517c5b652a926d83cf43bbde80cb2b1a0e14a1",
    ],
  });

  hasInitializedAppKit = true;
}

interface ProvidersProps {
  children: ReactNode;
}

function SwapCaptureBootstrap() {
  useSwapCapture();
  return null;
}

export function Providers({ children }: ProvidersProps) {
  ensureAppKit();

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
        <SwapCaptureBootstrap />
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
