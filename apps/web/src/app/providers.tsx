"use client";

import { type ReactNode, useState } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAppKit } from "@reown/appkit/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { BASE_ACCOUNT_WALLET_ID, projectId, wagmiConfig, wagmiConnectors } from "@/wagmi";
import { INITIAL_WAGMI_CHAINS, getWagmiTransports } from "@/config/web3";
import { useSwapCapture } from "@/hooks/useSwapCapture";
import { DATA_SUFFIX } from "@/lib/builderCode";

let hasInitializedAppKit = false;
let wagmiAdapter: InstanceType<typeof WagmiAdapter> | null = null;
const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://app.dustswap.wtf";

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
      name: "Dustswap",
      description:
        "Swap and bridge aggregator with social quests and rewards for the Base community.",
      url: appUrl,
      icons: [`${appUrl}/logo.png`],
    },
    themeMode: "light",
    features: {
      analytics: true,
      connectMethodsOrder: ["wallet", "email", "social"],
      email: false,
      socials: [],
    },
    featuredWalletIds: [BASE_ACCOUNT_WALLET_ID],
    includeWalletIds: [BASE_ACCOUNT_WALLET_ID],
    allWallets: "SHOW",
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
