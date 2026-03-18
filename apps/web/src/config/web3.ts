import {
  arbitrum,
  avalanche,
  base,
  bsc,
  mainnet,
  optimism,
  polygon,
} from "wagmi/chains";

export const SUPPORTED_EVM_CHAINS = [
  base,
  mainnet,
  arbitrum,
  polygon,
  bsc,
  optimism,
  avalanche,
] as const;

export const SUPPORTED_EVM_CHAIN_IDS = [
  base.id,
  mainnet.id,
  arbitrum.id,
  polygon.id,
  bsc.id,
  optimism.id,
  avalanche.id,
] as const;

export const DEFAULT_SOURCE_CHAIN_ID = base.id;

export const SUPPORTED_CHAINS = {
  base: base.id,
  ethereum: mainnet.id,
  arbitrum: arbitrum.id,
  polygon: polygon.id,
  bsc: bsc.id,
  optimism: optimism.id,
  avalanche: avalanche.id,
} as const;

export function getRpcUrlForChain(chainId: number) {
  switch (chainId) {
    case base.id:
      return process.env.NEXT_PUBLIC_BASE_RPC_URL;
    case mainnet.id:
      return process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL;
    case arbitrum.id:
      return process.env.NEXT_PUBLIC_ARBITRUM_RPC_URL;
    case polygon.id:
      return process.env.NEXT_PUBLIC_POLYGON_RPC_URL;
    case bsc.id:
      return process.env.NEXT_PUBLIC_BSC_RPC_URL;
    case optimism.id:
      return process.env.NEXT_PUBLIC_OPTIMISM_RPC_URL;
    case avalanche.id:
      return process.env.NEXT_PUBLIC_AVALANCHE_RPC_URL;
    default:
      return undefined;
  }
}

export function getLifiRpcUrls() {
  const rpcEntries = SUPPORTED_EVM_CHAIN_IDS.flatMap((chainId) => {
    const rpcUrl = getRpcUrlForChain(chainId);
    return rpcUrl ? [[chainId, [rpcUrl] as string[]]] : [];
  });

  return rpcEntries.length
    ? (Object.fromEntries(rpcEntries) as Record<number, string[]>)
    : undefined;
}
