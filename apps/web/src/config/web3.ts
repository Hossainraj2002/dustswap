import { base, mainnet, arbitrum, optimism, polygon, bsc, avalanche } from "wagmi/chains";
import type { Chain } from "wagmi/chains";
import { http } from "wagmi";

export const DEFAULT_SOURCE_CHAIN_ID = base.id;

// Seed the app with a stable starter set for wallet/network support.
export const INITIAL_WAGMI_CHAINS = [
  base,
  mainnet,
  arbitrum,
  optimism,
  polygon,
  bsc,
  avalanche,
] as const satisfies readonly [Chain, ...Chain[]];

export const SUPPORTED_CHAINS = {
  base: base.id,
  ethereum: mainnet.id,
  arbitrum: arbitrum.id,
  optimism: optimism.id,
  polygon: polygon.id,
  bsc: bsc.id,
  avalanche: avalanche.id,
} as const;

const rpcUrlByChainId: Record<number, string | undefined> = {
  [base.id]: 
    process.env.NEXT_PUBLIC_BASE_RPC_URL || 
    (process.env.NEXT_PUBLIC_ALCHEMY_API_KEY 
      ? `https://base-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY}`
      : undefined),
  [mainnet.id]: process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL,
  [arbitrum.id]: process.env.NEXT_PUBLIC_ARBITRUM_RPC_URL,
  [optimism.id]: process.env.NEXT_PUBLIC_OPTIMISM_RPC_URL,
  [polygon.id]: process.env.NEXT_PUBLIC_POLYGON_RPC_URL,
  [bsc.id]: process.env.NEXT_PUBLIC_BSC_RPC_URL,
  [avalanche.id]: process.env.NEXT_PUBLIC_AVALANCHE_RPC_URL,
};

export function getRpcUrlForChain(chainId: number) {
  return rpcUrlByChainId[chainId];
}

export function getWagmiTransports(chains: readonly Chain[]) {
  return Object.fromEntries(
    chains.map((chain) => [chain.id, http(getRpcUrlForChain(chain.id))])
  );
}
