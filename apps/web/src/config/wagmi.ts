import { createConfig, http } from "wagmi";
import {
  base,
  mainnet,
  arbitrum,
  polygon,
  bsc,
  optimism,
  avalanche,
} from "wagmi/chains";
import { Attribution } from "ox/erc8021";

// Builder code for transaction attribution - appended to EVERY transaction
const DATA_SUFFIX = Attribution.toDataSuffix({
  codes: [process.env.NEXT_PUBLIC_BUILDER_CODE || "bc_ox7237gv"],
});

export const wagmiConfig = createConfig({
  chains: [base, mainnet, arbitrum, polygon, bsc, optimism, avalanche] as any,
  transports: {
    [base.id]: http(),
    [mainnet.id]: http(),
    [arbitrum.id]: http(),
    [polygon.id]: http(),
    [bsc.id]: http(),
    [optimism.id]: http(),
    [avalanche.id]: http(),
  },
  dataSuffix: DATA_SUFFIX, // Builder code appended to every tx automatically
  multiInjectedProviderDiscovery: true,
});

// Export chain ids for reference
export const SUPPORTED_CHAINS = {
  base: 8453,
  ethereum: 1,
  arbitrum: 42161,
  polygon: 137,
  bsc: 56,
  optimism: 10,
  avalanche: 43114,
};
