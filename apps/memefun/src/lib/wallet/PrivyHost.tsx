"use client";

import { useEffect, useMemo } from "react";
import { type Chain as PrivyChain } from "@privy-io/chains";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider as PrivyWagmiProvider } from "@privy-io/wagmi";
import { useAccount } from "wagmi";
import type { Address } from "@/core/types";
import { ensureOkxEip6963Shim } from "./ethereumProviders";
import { useBaseChainSwitch } from "./useBaseChainSwitch";
import { PRIVY_WALLET_LIST, WalletConnectionProvider, useWalletConnection } from "./useWalletConnection";
import { MEMEFUN_CHAINS, wagmiConfig } from "./wagmi";
import { consumePendingConnect, type MemefunWallet } from "./walletState";

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://memefun.dustswap.wtf";
const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim() || "";
// Same fallback as apps/web/src/app/providers.tsx; override in the deploy env.
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() || "6f242331a85fc3af5428da560ed78900";

interface PrivyHostProps {
  theme: "light" | "dark";
  onChange: (wallet: MemefunWallet) => void;
}

/**
 * The heavy wallet stack (Privy, wagmi, WalletConnect), loaded after first
 * paint as a sibling of the page rather than a wrapper around it. It reports
 * wallet state up through `onChange`, so pages never wait for it to download.
 */
export default function PrivyHost({ theme, onChange }: PrivyHostProps) {
  useEffect(() => {
    // OKX's in-app browser injects late and skips EIP-6963; announce it for Privy.
    ensureOkxEip6963Shim();
  }, []);
  const chainIds = MEMEFUN_CHAINS.map((chain) => chain.id);
  const icon = `${appUrl}/icon-192.png`;
  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        appearance: {
          logo: icon,
          showWalletLoginFirst: true,
          theme,
          walletChainType: "ethereum-only",
          walletList: PRIVY_WALLET_LIST,
          accentColor: "#0052FF",
        },
        defaultChain: MEMEFUN_CHAINS[0] as unknown as PrivyChain,
        loginMethods: ["wallet"],
        supportedChains: MEMEFUN_CHAINS as unknown as PrivyChain[],
        walletConnectCloudProjectId: walletConnectProjectId,
        externalWallets: {
          baseAccount: { config: { appName: "memefun", appLogoUrl: icon, appChainIds: chainIds } },
          coinbaseWallet: { config: { appName: "memefun", appLogoUrl: icon, appChainIds: chainIds } },
        },
      }}
    >
      <PrivyWagmiProvider config={wagmiConfig} reconnectOnMount={false}>
        <WalletConnectionProvider enabled>
          <Bridge onChange={onChange} />
        </WalletConnectionProvider>
      </PrivyWagmiProvider>
    </PrivyProvider>
  );
}

function Bridge({ onChange }: { onChange: (wallet: MemefunWallet) => void }) {
  const { address, status, chainId } = useAccount();
  const connection = useWalletConnection();
  const { isOnBase, isSwitching, switchToBase } = useBaseChainSwitch();

  const value = useMemo<MemefunWallet>(
    () => ({
      mode: "privy",
      status: status === "connected" ? "connected" : status === "connecting" || status === "reconnecting" ? "connecting" : "disconnected",
      address: (address as Address | undefined) ?? null,
      chainId: chainId ?? null,
      onBase: isOnBase,
      isSwitching,
      connect: () => connection.openWalletModal("Connect a wallet to trade and launch on memefun."),
      disconnect: connection.disconnectWallet,
      switchToBase: async () => {
        await switchToBase();
      },
    }),
    [address, chainId, connection, isOnBase, isSwitching, status, switchToBase],
  );

  useEffect(() => onChange(value), [onChange, value]);

  // A Connect tap that happened while this host was still loading.
  useEffect(() => {
    if (consumePendingConnect()) void connection.openWalletModal("Connect a wallet to trade and launch on memefun.");
  }, [connection]);

  return null;
}
