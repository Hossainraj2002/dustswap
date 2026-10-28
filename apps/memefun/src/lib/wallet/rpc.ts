import { http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { LOCAL_CHAIN_ID } from "@/lib/chain";

/**
 * RPC endpoints per chain, shared by the wallet (wagmi) and the app's own reads. Adapted from
 * apps/web/src/config/web3.ts: public URLs rotate, with Alchemy reserved for failover. Unlike apps/web
 * there is deliberately no retry on "allowance" errors, which would stall a reverted trade for
 * several seconds.
 */
const ROTATION_CALLS = 100;
const RPC_ENDPOINT_TIMEOUT_MS = 3_000;

function splitEnv(value?: string) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function normalizeRpcUrls(values: string[]) {
  return unique(values.flatMap((value) => {
    try {
      const url = new URL(value.trim());
      if (url.protocol !== "https:" && url.protocol !== "http:") return [];
      url.hash = "";
      if (!url.search) url.search = "";
      const normalized = url.toString();
      // A root slash is equivalent for HTTP RPCs; deduplicate configured defaults too.
      return [url.pathname === "/" && !url.search ? normalized.slice(0, -1) : normalized];
    } catch {
      return [];
    }
  }));
}

const alchemyKeys = unique([...splitEnv(process.env.NEXT_PUBLIC_ALCHEMY_BASE_RPC_KEYS), ...splitEnv(process.env.NEXT_PUBLIC_ALCHEMY_API_KEY)]);

function isAlchemyUrl(url: string) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "alchemy.com" || hostname.endsWith(".alchemy.com") || hostname === "alchemyapi.io" || hostname.endsWith(".alchemyapi.io");
  } catch {
    return false;
  }
}

function publicFirstUrls(configured: string[], defaults: string[], alchemy: string[]) {
  const urls = normalizeRpcUrls([...configured, ...defaults, ...alchemy]);
  return [...urls.filter((url) => !isAlchemyUrl(url)), ...urls.filter(isAlchemyUrl)];
}

const localRpcUrls = normalizeRpcUrls([process.env.NEXT_PUBLIC_MEMEFUN_LOCAL_RPC_URL || ""]);

const rpcUrlsByChainId: Record<number, string[]> = {
  [base.id]: publicFirstUrls(
    [...splitEnv(process.env.NEXT_PUBLIC_BASE_RPC_URLS), ...splitEnv(process.env.NEXT_PUBLIC_BASE_RPC_URL)],
    ["https://mainnet.base.org", "https://base-mainnet.public.blastapi.io", "https://base.gateway.tenderly.co"],
    alchemyKeys.map((key) => `https://base-mainnet.g.alchemy.com/v2/${key}`),
  ),
  [baseSepolia.id]: publicFirstUrls(
    [...splitEnv(process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URLS), ...splitEnv(process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL)],
    ["https://sepolia.base.org"],
    alchemyKeys.map((key) => `https://base-sepolia.g.alchemy.com/v2/${key}`),
  ),
  [LOCAL_CHAIN_ID]: localRpcUrls.length > 0 ? localRpcUrls : ["http://127.0.0.1:8545"],
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
  const publicUrls = urls.filter((url) => !isAlchemyUrl(url));
  const alchemyUrls = urls.filter(isAlchemyUrl);
  const rotationPool = publicUrls.length > 0 ? publicUrls : alchemyUrls;
  const key = urls.join("|");
  const state = rotation.get(key) ?? { index: Math.floor(Math.random() * rotationPool.length), calls: 0 };
  const first = rotationPool[state.index % rotationPool.length] as string;
  state.calls += 1;
  if (state.calls >= ROTATION_CALLS) {
    state.calls = 0;
    state.index = (state.index + 1) % rotationPool.length;
  }
  rotation.set(key, state);
  return [first, ...publicUrls.filter((url) => url !== first), ...alchemyUrls.filter((url) => url !== first)];
}

async function shouldFailOver(response: Response) {
  if ([401, 402, 403, 408, 429].includes(response.status) || response.status >= 500) return true;
  if (!response.ok) return false;
  try {
    const payload = await response.clone().json();
    const responses = Array.isArray(payload) ? payload : [payload];
    if (responses.length === 0) return true;
    return responses.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true;
      const error = item?.error;
      if (!error) return !Object.prototype.hasOwnProperty.call(item, "result");
      if (typeof error !== "object" || (!Object.prototype.hasOwnProperty.call(error, "code") && !Object.prototype.hasOwnProperty.call(error, "message"))) return true;
      const message = String(error.message || "");
      if (error.code === 3 || /revert|insufficient funds|nonce too low|intrinsic gas/i.test(message)) return false;
      return [-32603, -32601, -32002, -32004, -32005, 429].includes(error.code) || /rate.?limit|too many requests|quota|capacity|limit exceeded|method.*(unsupported|not supported|not available)|payment|overdue|temporarily unavailable|timed? out|timeout|missing trie node|header not found/i.test(message);
    });
  } catch {
    return true;
  }
}

async function fetchRpcEndpoint(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const callerSignal = init?.signal;
  callerSignal?.throwIfAborted();
  const abort = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("RPC endpoint timed out")), RPC_ENDPOINT_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    // Keep the deadline through body inspection: receiving headers does not mean the RPC
    // response has finished, and a stalled body must still move on to another provider.
    const retryable = await shouldFailOver(response);
    controller.signal.throwIfAborted();
    return { response, retryable };
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abort);
  }
}

/** Tries public endpoints before Alchemy on unavailable, rate-limited or unsupported RPCs. */
export function rotatingFetch(urls: string[]) {
  const normalizedUrls = normalizeRpcUrls(urls);
  return async (input: string | URL | Request, init?: RequestInit) => {
    const fallback = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const candidates = normalizedUrls.length > 0 ? orderedUrls(normalizedUrls) : [fallback];
    let lastError: unknown = null;
    for (let i = 0; i < candidates.length; i += 1) {
      try {
        const { response, retryable } = await fetchRpcEndpoint(candidates[i] as string, init);
        if (i < candidates.length - 1 && retryable) continue;
        return response;
      } catch (error) {
        if (init?.signal?.aborted) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("RPC request failed");
  };
}

/** Give viem's outer deadline enough room for every endpoint's own bounded attempt. */
export function createRpcTransport(urls: string[]) {
  const normalizedUrls = normalizeRpcUrls(urls);
  return http(normalizedUrls[0], {
    fetchFn: rotatingFetch(normalizedUrls),
    timeout: Math.max(1, normalizedUrls.length) * RPC_ENDPOINT_TIMEOUT_MS + 1_000,
    retryCount: 0,
  });
}
