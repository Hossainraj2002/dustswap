import { createClient, custom, getAddress } from "viem";
import {
  cookieStorage,
  createConfig,
  createStorage,
  type CreateConnectorFn,
} from "wagmi";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";
import { INITIAL_WAGMI_CHAINS, getWagmiTransports } from "@/config/web3";
import { DATA_SUFFIX } from "@/lib/builderCode";

export const projectId =
  process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID || process.env.NEXT_PUBLIC_WC_PROJECT_ID || "e3ac88268c575d561fc945ca1e2a2874";
const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://app.dustswap.wtf";
const appIconUrl = `${appUrl}/logo.png`;

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
      appLogoUrl: appIconUrl,
      preference: { options: "all" },
    })
  ),
  withBuilderCodeClient(
    walletConnect({
      projectId,
      metadata: {
        name: "DustSwap",
        description: "DustSwap DEX & Yield",
        url: appUrl,
        icons: [appIconUrl],
      },
      showQrModal: false,
    })
  ),
];

export const wagmiConfig = createConfig({
  chains: INITIAL_WAGMI_CHAINS as any,
  connectors: wagmiConnectors,
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
  transports: getWagmiTransports(INITIAL_WAGMI_CHAINS) as any,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
