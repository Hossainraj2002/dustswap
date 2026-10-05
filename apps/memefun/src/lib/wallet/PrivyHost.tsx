"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { type Chain as PrivyChain } from "@privy-io/chains";
import { PrivyProvider, type PrivyClientConfig } from "@privy-io/react-auth";
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
const chainIds = MEMEFUN_CHAINS.map((chain) => chain.id);
const icon = `${appUrl}/icon-192.png`;
const connectDescription = "Connect a wallet to trade and launch on memefun.";

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
  // Reporting account state must not rebuild Privy's connector configuration.
  const config = useMemo<PrivyClientConfig>(() => ({
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
  }), [theme]);
  return (
    <PrivyProvider
      appId={privyAppId}
      config={config}
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

  // SDK callbacks/context can change identity without an account change. Keep
  // public actions stable while invoking the latest committed implementations,
  // so the report effect cannot feed a fresh object back into its own parent.
  const actions = useRef({ connection, switchToBase });
  useLayoutEffect(() => {
    actions.current = { connection, switchToBase };
  }, [connection, switchToBase]);
  const connect = useCallback(() => actions.current.connection.openWalletModal(connectDescription), []);
  const disconnect = useCallback(() => actions.current.connection.disconnectWallet(), []);
  const switchChain = useCallback(async () => {
    await actions.current.switchToBase();
  }, []);

  const value = useMemo<MemefunWallet>(
    () => ({
      mode: "privy",
      status: status === "connected" ? "connected" : status === "connecting" || status === "reconnecting" ? "connecting" : "disconnected",
      address: (address as Address | undefined) ?? null,
      chainId: chainId ?? null,
      onBase: isOnBase,
      isSwitching,
      connect,
      disconnect,
      switchToBase: switchChain,
    }),
    [address, chainId, connect, disconnect, isOnBase, isSwitching, status, switchChain],
  );

  useEffect(() => onChange(value), [onChange, value]);

  // A Connect tap that happened while this host was still loading.
  useEffect(() => {
    if (consumePendingConnect()) void connect();
  }, [connect]);

  return null;
}
