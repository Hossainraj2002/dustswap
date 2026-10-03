import { base, baseSepolia } from "viem/chains";
import { LOCAL_CHAIN_ID } from "@/lib/chain";

/**
 * RPC endpoints per chain, shared by the wallet (wagmi) and the app's own reads. Adapted from
 * apps/web/src/config/web3.ts: keyed Alchemy URLs rotate and fail over on 429/5xx. Unlike apps/web
 * there is deliberately no retry on "allowance" errors, which would stall a reverted trade for
 * several seconds.
 */
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

const alchemyKeys = unique([...splitEnv(process.env.NEXT_PUBLIC_ALCHEMY_BASE_RPC_KEYS), ...splitEnv(process.env.NEXT_PUBLIC_ALCHEMY_API_KEY)]);

const rpcUrlsByChainId: Record<number, string[]> = {
  [base.id]: unique([
    ...alchemyKeys.map((key) => `https://base-mainnet.g.alchemy.com/v2/${key}`),
    ...splitEnv(process.env.NEXT_PUBLIC_BASE_RPC_URLS),
    ...splitEnv(process.env.NEXT_PUBLIC_BASE_RPC_URL),
  ]),
  [baseSepolia.id]: unique([
    ...alchemyKeys.map((key) => `https://base-sepolia.g.alchemy.com/v2/${key}`),
    ...splitEnv(process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URLS),
  ]),
  [LOCAL_CHAIN_ID]: [process.env.NEXT_PUBLIC_MEMEFUN_LOCAL_RPC_URL || "http://127.0.0.1:8545"],
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

/** A fetch that tries each URL in turn, moving on after a rate limit, a 5xx or a network error. */
export function rotatingFetch(urls: string[]) {
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
