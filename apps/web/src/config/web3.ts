import { fallback, http } from "wagmi";
import { base, mainnet, arbitrum, optimism, polygon, bsc, avalanche } from "wagmi/chains";
import type { Chain } from "wagmi/chains";

export const DEFAULT_SOURCE_CHAIN_ID = base.id;

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

function splitEnv(value?: string) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function getBaseRpcUrls() {
  const preferredAlchemyKeys = [
    ...splitEnv(process.env.NEXT_PUBLIC_ALCHEMY_BASE_RPC_KEYS),
    ...splitEnv(process.env.NEXT_PUBLIC_ALCHEMY_API_KEYS),
  ];
  const fallbackAlchemyKeys = splitEnv(process.env.NEXT_PUBLIC_ALCHEMY_API_KEY);
  const explicitUrls = [
    ...splitEnv(process.env.NEXT_PUBLIC_BASE_RPC_URLS),
    ...splitEnv(process.env.NEXT_PUBLIC_BASE_RPC_URL),
  ];
  const alchemyUrls = [...preferredAlchemyKeys, ...fallbackAlchemyKeys].map(
    (key) => `https://base-mainnet.g.alchemy.com/v2/${key}`,
  );

  return unique([...alchemyUrls, ...explicitUrls]);
}

function toRpcUrlList(...values: Array<string | undefined>) {
  return values.filter((value): value is string => Boolean(value && value.trim()));
}

const rpcUrlsByChainId: Record<number, string[]> = {
  [base.id]: getBaseRpcUrls(),
  [mainnet.id]: toRpcUrlList(process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL),
  [arbitrum.id]: toRpcUrlList(process.env.NEXT_PUBLIC_ARBITRUM_RPC_URL),
  [optimism.id]: toRpcUrlList(process.env.NEXT_PUBLIC_OPTIMISM_RPC_URL),
  [polygon.id]: toRpcUrlList(process.env.NEXT_PUBLIC_POLYGON_RPC_URL),
  [bsc.id]: toRpcUrlList(process.env.NEXT_PUBLIC_BSC_RPC_URL),
  [avalanche.id]: toRpcUrlList(process.env.NEXT_PUBLIC_AVALANCHE_RPC_URL),
};

export function getRpcUrlsForChain(chainId: number) {
  return rpcUrlsByChainId[chainId] || [];
}

export function getRpcUrlForChain(chainId: number) {
  return getRpcUrlsForChain(chainId)[0];
}

const customFetchFn = async (url: string | URL | globalThis.Request, init?: RequestInit) => {
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(url, init);
    const clone = response.clone();
    try {
      const data = await clone.json();
      if (
        data &&
        data.error &&
        typeof data.error.message === "string" &&
        (data.error.message.toLowerCase().includes("allowance") ||
          data.error.message.toLowerCase().includes("transfer amount exceeds"))
      ) {
        if (i < maxRetries - 1) {
          console.warn("[DustSwap RPC] Caught allowance error, retrying...", data.error.message);
          await new Promise((resolve) => setTimeout(resolve, 3000));
          continue;
        }
      }
    } catch {
      // Ignore JSON parse errors.
    }
    return response;
  }
  return fetch(url, init);
};

export function getWagmiTransports(chains: readonly Chain[]) {
  return Object.fromEntries(
    chains.map((chain) => {
      const rpcUrls = getRpcUrlsForChain(chain.id);
      const transports =
        rpcUrls.length > 0
          ? rpcUrls.map((url) =>
              http(url, {
                // @ts-ignore - viem supports fetchFn to override the default fetch
                fetchFn: customFetchFn,
              }),
            )
          : [
              http(undefined, {
                // @ts-ignore - viem supports fetchFn to override the default fetch
                fetchFn: customFetchFn,
              }),
            ];

      return [
        chain.id,
        transports.length === 1 ? transports[0] : fallback(transports),
      ];
    }),
  );
}
