import { http } from "wagmi";
import { base, mainnet, arbitrum, optimism, polygon, bsc, avalanche } from "wagmi/chains";
import type { Chain } from "wagmi/chains";
import { robinhood } from "./robinhoodChain";

export const DEFAULT_SOURCE_CHAIN_ID = base.id;
const DEFAULT_RPC_ROTATION_CALLS = 100;
const RPC_ENDPOINT_TIMEOUT_MS = 3_000;

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

function isHttpRpcUrl(url: string) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function isAlchemyUrl(url: string) {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "alchemy.com" || hostname.endsWith(".alchemy.com") ||
      hostname === "alchemyapi.io" || hostname.endsWith(".alchemyapi.io");
  } catch {
    return false;
  }
}

const DEFAULT_PUBLIC_RPC_URLS: Record<number, string[]> = {
  [base.id]: [
    "https://mainnet.base.org",
    "https://base-mainnet.public.blastapi.io",
    "https://base.gateway.tenderly.co",
  ],
  [mainnet.id]: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
  [arbitrum.id]: ["https://arb1.arbitrum.io/rpc", "https://arbitrum.drpc.org"],
  [optimism.id]: ["https://mainnet.optimism.io", "https://optimism.drpc.org"],
  [bsc.id]: ["https://bsc-dataseed.bnbchain.org", "https://bsc-rpc.publicnode.com"],
};

// Always retain public endpoints, even when a deployment only supplies an Alchemy URL.
// Alchemy is a final backstop and must never enter the normal request rotation.
function publicFirstRpcUrls(chain: Chain, configuredUrls: string[], alchemyUrls: string[] = []) {
  const publicDefaults = DEFAULT_PUBLIC_RPC_URLS[chain.id] || chain.rpcUrls.default.http;
  const urls = unique([...configuredUrls, ...publicDefaults, ...alchemyUrls]
    .map((url) => url.trim()).filter(isHttpRpcUrl));
  return [...urls.filter((url) => !isAlchemyUrl(url)), ...urls.filter(isAlchemyUrl)];
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

  return publicFirstRpcUrls(base, explicitUrls, alchemyUrls);
}

function toRpcUrlList(...values: Array<string | undefined>) {
  return values.flatMap(splitEnv);
}

// A dedicated Ethereum key set remains available only after the public endpoints fail.
function getEthereumRpcUrls() {
  const alchemyUrls = splitEnv(process.env.NEXT_PUBLIC_ALCHEMY_ETHEREUM_RPC_KEYS).map(
    (key) => `https://eth-mainnet.g.alchemy.com/v2/${key}`,
  );
  const explicitUrls = [
    ...splitEnv(process.env.NEXT_PUBLIC_ETHEREUM_RPC_URLS),
    ...toRpcUrlList(process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL),
  ];
  return publicFirstRpcUrls(mainnet, explicitUrls, alchemyUrls);
}

const rpcUrlsByChainId: Record<number, string[]> = {
  [base.id]: getBaseRpcUrls(),
  [mainnet.id]: getEthereumRpcUrls(),
  // Public RPC only in the NEXT_PUBLIC bundle — paid Alchemy Arbitrum keys are server-side.
  [arbitrum.id]: publicFirstRpcUrls(arbitrum, [
    ...splitEnv(process.env.NEXT_PUBLIC_ARBITRUM_RPC_URLS),
    ...toRpcUrlList(process.env.NEXT_PUBLIC_ARBITRUM_RPC_URL),
  ]),
  // Public RPC only in the browser bundle; paid Optimism discovery keys stay on the API.
  [optimism.id]: publicFirstRpcUrls(optimism, [
    ...splitEnv(process.env.NEXT_PUBLIC_OPTIMISM_RPC_URLS),
    ...toRpcUrlList(process.env.NEXT_PUBLIC_OPTIMISM_RPC_URL),
  ]),
  [polygon.id]: publicFirstRpcUrls(polygon, toRpcUrlList(process.env.NEXT_PUBLIC_POLYGON_RPC_URL)),
  [bsc.id]: publicFirstRpcUrls(bsc, toRpcUrlList(process.env.NEXT_PUBLIC_BSC_RPC_URL)),
  [avalanche.id]: publicFirstRpcUrls(avalanche, toRpcUrlList(process.env.NEXT_PUBLIC_AVALANCHE_RPC_URL)),
  // Public RPC only in the NEXT_PUBLIC bundle — paid Alchemy Robinhood keys are server-side.
  [robinhood.id]: publicFirstRpcUrls(robinhood, [
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

  const publicUrls = rpcUrls.filter((url) => !isAlchemyUrl(url));
  const alchemyUrls = rpcUrls.filter(isAlchemyUrl);
  const rotationPool = publicUrls.length > 0 ? publicUrls : alchemyUrls;
  const backstopUrls = publicUrls.length > 0 ? alchemyUrls : [];
  const key = rotationPool.join("|");
  const existing = rpcRotationStateByKey.get(key);
  const state =
    existing ||
    {
      activeIndex: Math.floor(Math.random() * rotationPool.length),
      activeCalls: 0,
    };

  const first = rotationPool[state.activeIndex % rotationPool.length];
  state.activeCalls += 1;

  if (state.activeCalls >= getRpcRotationCalls()) {
    state.activeCalls = 0;
    state.activeIndex = (state.activeIndex + 1) % rotationPool.length;
  }

  rpcRotationStateByKey.set(key, state);
  return [first, ...rotationPool.filter((url) => url !== first), ...backstopUrls];
}

async function fetchWithEndpointTimeout(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const callerSignal = init?.signal;
  const abort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abort();
  else callerSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("RPC endpoint timed out")), RPC_ENDPOINT_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    let data;
    try {
      data = await response.clone().json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      // Keep non-JSON responses available for HTTP failover classification.
    }
    return { response, data };
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abort);
  }
}

async function fetchWithAllowanceRetry(
  url: string,
  init?: RequestInit,
) {
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    const { response, data } = await fetchWithEndpointTimeout(url, init);
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
    return response;
  }
  return (await fetchWithEndpointTimeout(url, init)).response;
}

async function shouldRetryRpcResponse(response: Response) {
  if (response.status === 401 || response.status === 402 || response.status === 403 || response.status === 408 ||
      response.status === 429 || response.status >= 500) return true;
  if (!response.ok) return false;
  try {
    const data = await response.clone().json();
    const entries = Array.isArray(data) ? data : [data];
    if (entries.length === 0) return true;
    return entries.some((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true;
      const error = entry.error;
      if (!error) return !Object.prototype.hasOwnProperty.call(entry, "result");
      if (typeof error !== "object" || typeof error.code !== "number" || typeof error.message !== "string") return true;
      const message = String(error.message || "");
      // Public providers can return capacity/method errors with HTTP 200. Contract reverts
      // stay authoritative, so a failed simulation is not replayed against every provider.
      if (error.code === 3 || /\brevert(?:ed)?\b|insufficient funds|invalid opcode/i.test(message)) return false;
      return [429, -32002, -32004, -32005, -32601, -32603].includes(error.code) ||
        /rate.?limit|too many requests|quota|capacity|credits|billing|temporarily unavailable|timed? out|timeout|method .*not (?:available|supported)/i.test(message);
    });
  } catch {
    return true;
  }
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
        if (await shouldRetryRpcResponse(response) && i < orderedUrls.length - 1) {
          continue;
        }
        return response;
      } catch (error) {
        if (init?.signal?.aborted) throw error;
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
              // Leave enough total time for a hung public node to time out and fail over.
              timeout: Math.max(10_000, rpcUrls.length * RPC_ENDPOINT_TIMEOUT_MS + 1_000),
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
