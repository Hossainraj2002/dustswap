import { createConfig } from "@privy-io/wagmi";
import { cookieStorage, createStorage } from "wagmi";
import { INITIAL_WAGMI_CHAINS, getWagmiTransports } from "@/config/web3";

export const wagmiConfig = createConfig({
  chains: INITIAL_WAGMI_CHAINS as any,
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
  transports: getWagmiTransports(INITIAL_WAGMI_CHAINS) as any,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
