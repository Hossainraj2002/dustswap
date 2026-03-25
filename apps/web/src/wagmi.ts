import type { CreateConnectorFn } from "wagmi";
import { createConfig } from "wagmi";
import { coinbaseWallet, injected } from "wagmi/connectors";
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { INITIAL_WAGMI_CHAINS, getWagmiTransports } from "@/config/web3";
import { DATA_SUFFIX } from "@/lib/builderCode";

export const projectId =
  process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID || "1234567890abcdef1234567890abcdef"; // Default fallback if not defined

export const wagmiConnectors: CreateConnectorFn[] = [
  injected({ shimDisconnect: true }),
  coinbaseWallet({
    appName: "DustSwap",
    appLogoUrl: "https://dustswap.xyz/logo.png",
    preference: "all",
  }),
];

// Create original config with builder code suffix enabled
export const wagmiConfig = createConfig({
  chains: [...INITIAL_WAGMI_CHAINS] as any,
  connectors: wagmiConnectors,
  transports: getWagmiTransports(INITIAL_WAGMI_CHAINS) as any,
  dataSuffix: DATA_SUFFIX,
  ssr: true,
});

// Reown AppKit WagmiAdapter
export const wagmiAdapter = new WagmiAdapter({
  projectId,
  networks: INITIAL_WAGMI_CHAINS as any,
  wagmiConfig: wagmiConfig as any,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

