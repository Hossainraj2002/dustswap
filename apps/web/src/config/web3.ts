import { http } from "wagmi";
import { base, mainnet, arbitrum, optimism, polygon, bsc, avalanche } from "wagmi/chains";
import type { Chain } from "wagmi/chains";
import { robinhood } from "./robinhoodChain";

export const DEFAULT_SOURCE_CHAIN_ID = base.id;
const DEFAULT_RPC_ROTATION_CALLS = 100;

export const INITIAL_WAGMI_CHAINS = [
  base,
  mainnet,
  arbitrum,
  optimism,
  polygon,
  bsc,
  avalanche,
  robinhood,
] as const satisfies readonly [Chain, ...Chain[]];

export const SUPPORTED_CHAINS = {
  base: base.id,
  ethereum: mainnet.id,
  arbitrum: arbitrum.id,
  optimism: optimism.id,
  polygon: polygon.id,
  bsc: bsc.id,
  avalanche: avalanche.id,
  robinhood: robinhood.id,
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

// Ethereum mainnet RPCs, keyed-Alchemy first (same rotation machinery as Base). A dedicated
// key set keeps mainnet CU burn attributable and off the Base pool.
function getEthereumRpcUrls() {
  const alchemyUrls = splitEnv(process.env.NEXT_PUBLIC_ALCHEMY_ETHEREUM_RPC_KEYS).map(
    (key) => `https://eth-mainnet.g.alchemy.com/v2/${key}`,
  );
  const explicitUrls = [
    ...splitEnv(process.env.NEXT_PUBLIC_ETHEREUM_RPC_URLS),
    ...toRpcUrlList(process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL),
  ];
  return unique([...alchemyUrls, ...explicitUrls]);
}

const rpcUrlsByChainId: Record<number, string[]> = {
  [base.id]: getBaseRpcUrls(),
  [mainnet.id]: getEthereumRpcUrls(),
  // Public RPC only in the NEXT_PUBLIC bundle — paid Alchemy Arbitrum keys are server-side.
  [arbitrum.id]: unique([
    ...splitEnv(process.env.NEXT_PUBLIC_ARBITRUM_RPC_URLS),
    ...toRpcUrlList(process.env.NEXT_PUBLIC_ARBITRUM_RPC_URL),
  ]),
  [optimism.id]: toRpcUrlList(process.env.NEXT_PUBLIC_OPTIMISM_RPC_URL),
  [polygon.id]: toRpcUrlList(process.env.NEXT_PUBLIC_POLYGON_RPC_URL),
  [bsc.id]: toRpcUrlList(process.env.NEXT_PUBLIC_BSC_RPC_URL),
  [avalanche.id]: toRpcUrlList(process.env.NEXT_PUBLIC_AVALANCHE_RPC_URL),
  // Public RPC only in the NEXT_PUBLIC bundle — paid Alchemy Robinhood keys are server-side.
  [robinhood.id]: unique([
    ...splitEnv(process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URLS),
    ...toRpcUrlList(process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL),
  ]),
};

export function getRpcUrlsForChain(chainId: number) {
  return rpcUrlsByChainId[chainId] || [];
}

export function getRpcUrlForChain(chainId: number) {
  return getRpcUrlsForChain(chainId)[0];
}

function getRpcRotationCalls() {
  const parsed = Number(
    process.env.NEXT_PUBLIC_BASE_RPC_ROTATION_CALLS || DEFAULT_RPC_ROTATION_CALLS,
  );
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_RPC_ROTATION_CALLS;
}

const rpcRotationStateByKey = new Map<
  string,
  {
    activeIndex: number;
    activeCalls: number;
  }
>();

function getOrderedRpcUrls(rpcUrls: string[]) {
  if (rpcUrls.length <= 1) {
    return rpcUrls;
  }

  const key = rpcUrls.join("|");
  const existing = rpcRotationStateByKey.get(key);
  const state =
    existing ||
    {
      activeIndex: Math.floor(Math.random() * rpcUrls.length),
      activeCalls: 0,
    };

  const first = rpcUrls[state.activeIndex % rpcUrls.length];
  state.activeCalls += 1;

  if (state.activeCalls >= getRpcRotationCalls()) {
    state.activeCalls = 0;
    state.activeIndex = (state.activeIndex + 1) % rpcUrls.length;
  }

  rpcRotationStateByKey.set(key, state);
  return [first, ...rpcUrls.filter((url) => url !== first)];
}

async function fetchWithAllowanceRetry(
  url: string,
  init?: RequestInit,
) {
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
}

function shouldRetryRpcResponse(response: Response) {
  return response.status === 429 || response.status >= 500;
}

function resolveFetchUrl(input: string | URL | globalThis.Request) {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function createRotatingRpcFetch(rpcUrls: string[]) {
  return async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const fallbackUrl = resolveFetchUrl(input);
    const orderedUrls = rpcUrls.length > 0 ? getOrderedRpcUrls(rpcUrls) : [fallbackUrl];
    let lastError: Error | null = null;

    for (let i = 0; i < orderedUrls.length; i++) {
      const rpcUrl = orderedUrls[i];

      try {
        const response = await fetchWithAllowanceRetry(rpcUrl, init);
        if (shouldRetryRpcResponse(response) && i < orderedUrls.length - 1) {
          continue;
        }
        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (lastError) {
      throw lastError;
    }

    return fetchWithAllowanceRetry(fallbackUrl, init);
  };
}

export function getWagmiTransports(chains: readonly Chain[]) {
  return Object.fromEntries(
    chains.map((chain) => {
      const rpcUrls = getRpcUrlsForChain(chain.id);
      const transport =
        rpcUrls.length > 0
          ? http(rpcUrls[0], {
              // @ts-ignore - viem supports fetchFn to override the default fetch
              fetchFn: createRotatingRpcFetch(rpcUrls),
            })
          : http(undefined, {
              // @ts-ignore - viem supports fetchFn to override the default fetch
              fetchFn: createRotatingRpcFetch([]),
            });

      return [chain.id, transport];
    }),
  );
}
