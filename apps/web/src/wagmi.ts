import type { CreateConnectorFn } from "wagmi";
import { createConfig } from "wagmi";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";
import { INITIAL_WAGMI_CHAINS, getWagmiTransports } from "@/config/web3";
import { DATA_SUFFIX } from "@/lib/builderCode";

const walletConnectProjectId =
  process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID;

export const wagmiConnectors: CreateConnectorFn[] = [
  injected({ shimDisconnect: true }),
  ...(walletConnectProjectId
    ? [
        walletConnect({
          projectId: walletConnectProjectId,
          showQrModal: true,
          metadata: {
            name: "DustSwap",
            description: "DustSwap cross-chain swaps and bridges",
            url: "https://dustswap.xyz",
            icons: ["https://dustswap.xyz/logo.png"],
          },
        }),
      ]
    : []),
  coinbaseWallet({
    appName: "DustSwap",
    appLogoUrl: "https://dustswap.xyz/logo.png",
    preference: "all",
  }),
];

export const wagmiConfig = createConfig({
  chains: [...INITIAL_WAGMI_CHAINS],
  connectors: wagmiConnectors,
  transports: getWagmiTransports(INITIAL_WAGMI_CHAINS) as any,
  dataSuffix: DATA_SUFFIX,
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
