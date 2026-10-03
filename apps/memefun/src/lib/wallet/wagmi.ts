import { createConfig as createPrivyConfig } from "@privy-io/wagmi";
import { cookieStorage, createConfig as createWagmiConfig, createStorage, http } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import type { Chain } from "wagmi/chains";

/**
 * Base only (plus Base Sepolia for Phase 4 testing). Adapted from
 * apps/web/src/config/web3.ts: keyed Alchemy URLs rotate and fail over on
 * 429/5xx. Unlike apps/web there is deliberately no retry on "allowance"
 * errors, which would stall a reverted trade for several seconds.
 */
export const MEMEFUN_CHAINS = [base, baseSepolia] as const satisfies readonly [Chain, ...Chain[]];

const ROTATION_CALLS = 100;

function splitEnv(value?: string) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

const rpcUrlsByChainId: Record<number, string[]> = {
  [base.id]: unique([
    ...[...splitEnv(process.env.NEXT_PUBLIC_ALCHEMY_BASE_RPC_KEYS), ...splitEnv(process.env.NEXT_PUBLIC_ALCHEMY_API_KEY)].map(
      (key) => `https://base-mainnet.g.alchemy.com/v2/${key}`,
    ),
    ...splitEnv(process.env.NEXT_PUBLIC_BASE_RPC_URLS),
    ...splitEnv(process.env.NEXT_PUBLIC_BASE_RPC_URL),
  ]),
  [baseSepolia.id]: unique(splitEnv(process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URLS)),
};

export function getRpcUrlsForChain(chainId: number) {
  return rpcUrlsByChainId[chainId] ?? [];
}

export function getRpcUrlForChain(chainId: number) {
  return getRpcUrlsForChain(chainId)[0];
}

const rotation = new Map<string, { index: number; calls: number }>();

function orderedUrls(urls: string[]) {
  if (urls.length <= 1) return urls;
  const key = urls.join("|");
  const state = rotation.get(key) ?? { index: Math.floor(Math.random() * urls.length), calls: 0 };
  const first = urls[state.index % urls.length] as string;
  state.calls += 1;
  if (state.calls >= ROTATION_CALLS) {
    state.calls = 0;
    state.index = (state.index + 1) % urls.length;
  }
  rotation.set(key, state);
  return [first, ...urls.filter((url) => url !== first)];
}

function rotatingFetch(urls: string[]) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const fallback = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const candidates = urls.length > 0 ? orderedUrls(urls) : [fallback];
    let lastError: unknown = null;
    for (let i = 0; i < candidates.length; i += 1) {
      try {
        const response = await fetch(candidates[i] as string, init);
        if ((response.status === 429 || response.status >= 500) && i < candidates.length - 1) continue;
        return response;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("RPC request failed");
  };
}

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
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
  transports: transports() as Record<(typeof MEMEFUN_CHAINS)[number]["id"], ReturnType<typeof http>>,
} as const;

export const wagmiConfig = createPrivyConfig(parameters);
export const fallbackWagmiConfig = createWagmiConfig(parameters);

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
