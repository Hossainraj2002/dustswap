import type { CreateConnectorFn } from "wagmi";
import { createConfig } from "wagmi";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { INITIAL_WAGMI_CHAINS, getWagmiTransports } from "@/config/web3";
import { DATA_SUFFIX } from "@/lib/builderCode";

export const projectId =
  process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID || process.env.NEXT_PUBLIC_WC_PROJECT_ID || "e3ac88268c575d561fc945ca1e2a2874";

export const wagmiConnectors: CreateConnectorFn[] = [
  injected({ shimDisconnect: true }),
  coinbaseWallet({
    appName: "DustSwap",
    appLogoUrl: "https://dustswap.vercel.app/logo.png",
    preference: "all",
  }),
  walletConnect({
    projectId,
    metadata: {
      name: "DustSwap",
      description: "DustSwap DEX & Yield",
      url: "https://dustswap.vercel.app",
      icons: ["https://dustswap.vercel.app/logo.png"],
    },
    showQrModal: false,
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

