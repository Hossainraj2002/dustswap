import { createClient, custom, getAddress } from "viem";
import type { CreateConnectorFn } from "wagmi";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { INITIAL_WAGMI_CHAINS, getWagmiTransports } from "@/config/web3";
import { DATA_SUFFIX } from "@/lib/builderCode";

export const projectId =
  process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID || process.env.NEXT_PUBLIC_WC_PROJECT_ID || "e3ac88268c575d561fc945ca1e2a2874";

function withBuilderCodeClient(connectorFn: CreateConnectorFn): CreateConnectorFn {
  return (params) => {
    const connector = connectorFn(params);

    return {
      ...connector,
      async getClient({ chainId } = {}) {
        const provider = await connector.getProvider({ chainId });
        const accounts = await connector.getAccounts().catch(() => []);
        const resolvedChainId =
          chainId ?? (await connector.getChainId().catch(() => undefined));
        const chain = params.chains.find((candidate) => candidate.id === resolvedChainId);

        return createClient({
          account: accounts[0] ? getAddress(accounts[0]) : undefined,
          chain,
          dataSuffix: DATA_SUFFIX,
          name: "Builder Code Connector Client",
          transport: (options) => custom(provider as any)({ ...options, retryCount: 0 }),
        });
      },
    };
  };
}

export const wagmiConnectors: CreateConnectorFn[] = [
  withBuilderCodeClient(injected({ shimDisconnect: true })),
  withBuilderCodeClient(
    coinbaseWallet({
      appName: "DustSwap",
      appLogoUrl: "https://dustswap.vercel.app/logo.png",
      preference: { options: "all" },
    })
  ),
  withBuilderCodeClient(
    walletConnect({
      projectId,
      metadata: {
        name: "DustSwap",
        description: "DustSwap DEX & Yield",
        url: "https://dustswap.vercel.app",
        icons: ["https://dustswap.vercel.app/logo.png"],
      },
      showQrModal: false,
    })
  ),
];

// Reown creates its own Wagmi config internally, so the Builder Code must be
// configured on the adapter itself to cover every Reown/AppKit transaction path.
export const wagmiAdapter = new WagmiAdapter({
  projectId,
  networks: INITIAL_WAGMI_CHAINS as any,
  connectors: wagmiConnectors,
  transports: getWagmiTransports(INITIAL_WAGMI_CHAINS) as any,
  dataSuffix: DATA_SUFFIX,
  ssr: true,
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
