import { createConfig as createPrivyConfig } from "@privy-io/wagmi";
import {
  cookieStorage,
  createConfig as createWagmiConfig,
  createStorage,
} from "wagmi";
import { INITIAL_WAGMI_CHAINS, getWagmiTransports } from "@/config/web3";

const wagmiConfigParameters = {
  chains: INITIAL_WAGMI_CHAINS as any,
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
  transports: getWagmiTransports(INITIAL_WAGMI_CHAINS) as any,
} as const;

export const wagmiConfig = createPrivyConfig(wagmiConfigParameters);
export const fallbackWagmiConfig = createWagmiConfig(wagmiConfigParameters);

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
