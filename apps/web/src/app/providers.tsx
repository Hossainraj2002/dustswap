"use client";

import { type ReactNode, useEffect, useState } from "react";
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

// Bug #2B: WalletConnect project id.
// Privy needs this to create WalletConnect sessions so OKX mobile (and any
// WC wallet) receives a deep link. Previously three env vars were OR'd together
// (NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID / _WALLET_CONNECT_ / _WC_), which let a
// stale id in .env shadow the intended one. Both .env and .env.local are
// gitignored, so on the Cloudflare build neither reaches the bundle and this
// hardcoded fallback is what actually ships. We now read ONLY the canonical
// var and fall back to the known-live id. Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
// in the Cloudflare dashboard to override it.
// NOTE: verify this project exists in Reown/WalletConnect Cloud with
// app.dustswap.wtf (and base.app, if used) in its Allowed Domains — a missing or
// domain-mismatched id is what produces "Waiting for OKX Wallet… try again".
const WALLETCONNECT_FALLBACK_PROJECT_ID = "6f242331a85fc3af5428da560ed78900";
const walletConnectEnvProjectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim();
const walletConnectCloudProjectId =
  walletConnectEnvProjectId || WALLETCONNECT_FALLBACK_PROJECT_ID;
const walletConnectProjectIdSource = walletConnectEnvProjectId
  ? "env"
  : "fallback";

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

  // Bug #2B: confirm which WalletConnect id is live without leaking the value.
  useEffect(() => {
    console.info(
      `[DustSwap] WalletConnect projectId resolved (length=${walletConnectCloudProjectId.length}, source=${walletConnectProjectIdSource})`
    );
  }, []);

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
      <PrivyWagmiProvider config={wagmiConfig} reconnectOnMount={false}>
        <WalletConnectionProvider enabled>
          {!isMaintenancePage && <SwapCaptureBootstrap />}
          <WalletInterceptor />
          {children}
        </WalletConnectionProvider>
      </PrivyWagmiProvider>
    </PrivyProvider>
  ) : (
    <BaseWagmiProvider config={fallbackWagmiConfig} reconnectOnMount={false}>
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
