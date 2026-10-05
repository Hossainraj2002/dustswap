import { createConfig as createPrivyConfig } from "@privy-io/wagmi";
import { cookieStorage, createConfig as createWagmiConfig, createStorage, http } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import type { Chain } from "wagmi/chains";
import { LOCAL_CHAIN_ID, TARGET_CHAIN, TARGET_CHAIN_ID } from "@/lib/chain";
import { getRpcUrlsForChain, rotatingFetch } from "./rpc";
import { BUILDER_ATTRIBUTION } from "./builderCode";

export { getRpcUrlForChain, getRpcUrlsForChain } from "./rpc";

/**
 * The chain this build targets first (Privy's default), then Base and Base Sepolia. A local
 * base-anvil is only included when it is the target.
 */
export const MEMEFUN_CHAINS = [
  TARGET_CHAIN,
  ...[base, baseSepolia].filter((chain) => chain.id !== TARGET_CHAIN_ID && TARGET_CHAIN_ID !== LOCAL_CHAIN_ID),
] as unknown as readonly [Chain, ...Chain[]];

function transports() {
  return Object.fromEntries(
    MEMEFUN_CHAINS.map((chain) => {
      const urls = getRpcUrlsForChain(chain.id);
      return [chain.id, http(urls[0], { fetchFn: rotatingFetch(urls) })];
    }),
  );
}

const parameters = {
  chains: MEMEFUN_CHAINS,
  dataSuffix: BUILDER_ATTRIBUTION,
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
  transports: transports() as Record<number, ReturnType<typeof http>>,
} as const;

export const wagmiConfig = createPrivyConfig(parameters);
export const fallbackWagmiConfig = createWagmiConfig(parameters);

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
