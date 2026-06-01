"use client";

import { type ReactNode, useState } from "react";
import { usePathname } from "next/navigation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type Chain as PrivyChain } from "@privy-io/chains";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider as PrivyWagmiProvider } from "@privy-io/wagmi";
import { WagmiProvider as BaseWagmiProvider } from "wagmi";
import {
  PRIVY_WALLET_LIST,
  WalletConnectionProvider,
} from "@/hooks/useWalletConnection";
import { INITIAL_WAGMI_CHAINS } from "@/config/web3";
import { useSwapCapture } from "@/hooks/useSwapCapture";
import { fallbackWagmiConfig, wagmiConfig } from "@/wagmi";

import { WalletInterceptor } from "@/components/WalletInterceptor";
import { ThemeProvider, useTheme } from "@/components/theme/ThemeProvider";

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://app.dustswap.wtf";
const appName = "Dustswap";
const appLogoUrl = `${appUrl}/logo.png`;
const appChainIds = INITIAL_WAGMI_CHAINS.map((chain) => chain.id);
const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim() || "";
const hasPrivyAppId = privyAppId.length > 0;
const privySupportedChains = INITIAL_WAGMI_CHAINS as unknown as PrivyChain[];
const walletConnectCloudProjectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ||
  process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID ||
  process.env.NEXT_PUBLIC_WC_PROJECT_ID;

interface ProvidersProps {
  children: ReactNode;
}

function SwapCaptureBootstrap() {
  useSwapCapture();
  return null;
}

function AppProviders({ children }: ProvidersProps) {
  const pathname = usePathname();
  const isMaintenancePage = pathname === "/maintenance";
  const { resolvedTheme } = useTheme();
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

  const appContent = hasPrivyAppId ? (
    <PrivyProvider
      appId={privyAppId}
      config={{
        appearance: {
          logo: appLogoUrl,
          showWalletLoginFirst: true,
          theme: resolvedTheme,
          walletChainType: "ethereum-only",
          walletList: PRIVY_WALLET_LIST,
        },
        defaultChain: privySupportedChains[0],
        loginMethods: ["wallet"],
        supportedChains: privySupportedChains,
        walletConnectCloudProjectId,
        externalWallets: {
          baseAccount: {
            config: {
              appName,
              appLogoUrl,
              appChainIds,
            },
          },
          coinbaseWallet: {
            config: {
              appName,
              appLogoUrl,
              appChainIds,
            },
          },
        },
      }}
    >
      <PrivyWagmiProvider config={wagmiConfig} reconnectOnMount>
        <WalletConnectionProvider enabled>
          {!isMaintenancePage && <SwapCaptureBootstrap />}
          <WalletInterceptor />
          {children}
        </WalletConnectionProvider>
      </PrivyWagmiProvider>
    </PrivyProvider>
  ) : (
    <BaseWagmiProvider config={fallbackWagmiConfig} reconnectOnMount>
      <WalletConnectionProvider enabled={false}>
        {!isMaintenancePage && <SwapCaptureBootstrap />}
        <WalletInterceptor />
        {children}
      </WalletConnectionProvider>
    </BaseWagmiProvider>
  );

  return (
    <QueryClientProvider client={queryClient}>{appContent}</QueryClientProvider>
  );
}

export function Providers({ children }: ProvidersProps) {
  return (
    <ThemeProvider>
      <AppProviders>{children}</AppProviders>
    </ThemeProvider>
  );
}
