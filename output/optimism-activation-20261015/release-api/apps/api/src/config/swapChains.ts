import { createPublicClient, http, type PublicClient } from "viem";
import {
  arbitrum,
  avalanche,
  base,
  bsc,
  linea,
  mainnet,
  optimism,
  polygon,
  scroll,
  zksync,
  type Chain,
} from "viem/chains";
import { createBasePublicClient } from "../utils/baseRpc";

type SwapChainConfig = {
  id: number;
  key: string;
  label: string;
  chain: Chain;
  rpcEnv: string;
  openOceanSlug?: string;
  coinGeckoPlatformId?: string;
  nativeCoinGeckoId: string;
  wrappedNativeTokens?: readonly string[];
};

export const SUPPORTED_SWAP_CHAINS = [
  {
    id: base.id,
    key: "base",
    label: "Base",
    chain: base,
    rpcEnv: "BASE_RPC_URL",
    openOceanSlug: "base",
    coinGeckoPlatformId: "base",
    nativeCoinGeckoId: "ethereum",
    wrappedNativeTokens: ["0x4200000000000000000000000000000000000006"],
  },
  {
    id: mainnet.id,
    key: "ethereum",
    label: "Ethereum",
    chain: mainnet,
    rpcEnv: "ETHEREUM_RPC_URL",
    openOceanSlug: "eth",
    coinGeckoPlatformId: "ethereum",
    nativeCoinGeckoId: "ethereum",
    wrappedNativeTokens: ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"],
  },
  {
    id: arbitrum.id,
    key: "arbitrum",
    label: "Arbitrum",
    chain: arbitrum,
    rpcEnv: "ARBITRUM_RPC_URL",
    openOceanSlug: "arbitrum",
    coinGeckoPlatformId: "arbitrum-one",
    nativeCoinGeckoId: "ethereum",
    wrappedNativeTokens: ["0x82af49447d8a07e3bd95bd0d56f35241523fbab1"],
  },
  {
    id: optimism.id,
    key: "optimism",
    label: "Optimism",
    chain: optimism,
    rpcEnv: "OPTIMISM_RPC_URL",
    openOceanSlug: "optimism",
    coinGeckoPlatformId: "optimistic-ethereum",
    nativeCoinGeckoId: "ethereum",
    wrappedNativeTokens: ["0x4200000000000000000000000000000000000006"],
  },
  {
    id: polygon.id,
    key: "polygon",
    label: "Polygon",
    chain: polygon,
    rpcEnv: "POLYGON_RPC_URL",
    openOceanSlug: "polygon",
    coinGeckoPlatformId: "polygon-pos",
    nativeCoinGeckoId: "matic-network",
    wrappedNativeTokens: ["0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270"],
  },
  {
    id: bsc.id,
    key: "bsc",
    label: "BNB Chain",
    chain: bsc,
    rpcEnv: "BSC_RPC_URL",
    openOceanSlug: "bsc",
    coinGeckoPlatformId: "binance-smart-chain",
    nativeCoinGeckoId: "binancecoin",
    wrappedNativeTokens: ["0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"],
  },
  {
    id: avalanche.id,
    key: "avalanche",
    label: "Avalanche",
    chain: avalanche,
    rpcEnv: "AVALANCHE_RPC_URL",
    openOceanSlug: "avax",
    coinGeckoPlatformId: "avalanche",
    nativeCoinGeckoId: "avalanche-2",
    wrappedNativeTokens: ["0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7"],
  },
  {
    id: zksync.id,
    key: "zksync",
    label: "zkSync Era",
    chain: zksync,
    rpcEnv: "ZKSYNC_RPC_URL",
    openOceanSlug: "zksync",
    coinGeckoPlatformId: "zksync",
    nativeCoinGeckoId: "ethereum",
  },
  {
    id: linea.id,
    key: "linea",
    label: "Linea",
    chain: linea,
    rpcEnv: "LINEA_RPC_URL",
    openOceanSlug: "linea",
    coinGeckoPlatformId: "linea",
    nativeCoinGeckoId: "ethereum",
  },
  {
    id: scroll.id,
    key: "scroll",
    label: "Scroll",
    chain: scroll,
    rpcEnv: "SCROLL_RPC_URL",
    openOceanSlug: "scroll",
    coinGeckoPlatformId: "scroll",
    nativeCoinGeckoId: "ethereum",
  },
] as const satisfies readonly SwapChainConfig[];

const chainConfigById = new Map<number, SwapChainConfig>(
  SUPPORTED_SWAP_CHAINS.map((chain) => [chain.id, chain])
);
const clientByChainId = new Map<number, PublicClient>();

export function getSwapChainConfig(chainId: number) {
  return chainConfigById.get(chainId) ?? null;
}

export function getSupportedSwapChainIds() {
  return SUPPORTED_SWAP_CHAINS.map((chain) => chain.id);
}

export function isSupportedSwapChainId(chainId: number) {
  return chainConfigById.has(chainId);
}

function getRpcUrl(config: SwapChainConfig) {
  return (
    process.env[config.rpcEnv] ||
    process.env[`NEXT_PUBLIC_${config.rpcEnv}`] ||
    process.env[`RPC_URL_${config.id}`] ||
    process.env[`CHAIN_${config.id}_RPC_URL`] ||
    config.chain.rpcUrls.default.http[0]
  );
}

export function getPublicClientForSwapChain(chainId: number) {
  const config = getSwapChainConfig(chainId);
  if (!config) {
    return null;
  }

  const existing = clientByChainId.get(chainId);
  if (existing) {
    return existing;
  }

  const client =
    chainId === base.id
      ? createBasePublicClient()
      : createPublicClient({
          chain: config.chain,
          transport: http(getRpcUrl(config)),
        });

  clientByChainId.set(chainId, client as PublicClient);
  return client;
}
