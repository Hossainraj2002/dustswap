const BASE_PUBLIC_RPC_URL = "https://mainnet.base.org";
const BASE_CHAIN_ID = 8453;
const DEFAULT_ROTATION_CALLS = 100;

let activeIndex = 0;
let activeCalls = 0;
let requestId = 1;

export type BaseRpcEndpoint = {
  url: string;
  headers?: Record<string, string>;
};

function splitEnv(value?: string) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function isHttpsUrl(value: string) {
  return value.startsWith("https://");
}

function getRotationCalls() {
  const parsed = Number(process.env.BASE_RPC_ROTATION_CALLS || DEFAULT_ROTATION_CALLS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_ROTATION_CALLS;
}

function shouldUsePublicFallback() {
  return process.env.BASE_RPC_PUBLIC_FALLBACK !== "0";
}

function getBlockscoutRpcEndpoints(): BaseRpcEndpoint[] {
  const keys = unique([
    ...splitEnv(process.env.BLOCKSCOUT_API_KEYS),
    ...splitEnv(process.env.BLOCKSCOUT_API_KEY),
  ]);

  return keys.map((key) => ({
    url: `https://api.blockscout.com/${BASE_CHAIN_ID}/json-rpc`,
    headers: {
      Authorization: `Bearer ${key}`,
    },
  }));
}

export function getBaseRpcEndpoints(): BaseRpcEndpoint[] {
  const explicitUrls = [
    ...splitEnv(process.env.ALCHEMY_BASE_RPC_URLS),
    ...splitEnv(process.env.BASE_RPC_URLS),
    ...splitEnv(process.env.ALCHEMY_BASE_RPC),
    ...splitEnv(process.env.BASE_RPC_URL),
  ];
  const alchemyKeys = [
    ...splitEnv(process.env.ALCHEMY_BASE_RPC_KEYS),
    ...splitEnv(process.env.ALCHEMY_API_KEYS),
    ...splitEnv(process.env.ALCHEMY_API_KEY),
  ];
  const alchemyUrls = alchemyKeys.map(
    (key) => `https://base-mainnet.g.alchemy.com/v2/${key}`,
  );
  const endpoints: BaseRpcEndpoint[] = unique([...explicitUrls, ...alchemyUrls].filter(isHttpsUrl))
    .map((url) => ({ url }));
  const withBlockscout = [...endpoints, ...getBlockscoutRpcEndpoints()];
  const withPublicFallback = shouldUsePublicFallback()
    ? [...withBlockscout, { url: BASE_PUBLIC_RPC_URL }]
    : withBlockscout;

  return withPublicFallback.length > 0 ? withPublicFallback : [{ url: BASE_PUBLIC_RPC_URL }];
}

export function getBaseRpcUrls() {
  return getBaseRpcEndpoints().map((endpoint) => endpoint.url);
}

export function getRotatingBaseRpcEndpoint() {
  const endpoints = getBaseRpcEndpoints();
  if (endpoints.length === 1) return endpoints[0];

  const endpoint = endpoints[activeIndex % endpoints.length];
  activeCalls += 1;

  if (activeCalls >= getRotationCalls()) {
    activeCalls = 0;
    activeIndex = (activeIndex + 1) % endpoints.length;
  }

  return endpoint;
}

export function getRotatingBaseRpcUrl() {
  return getRotatingBaseRpcEndpoint().url;
}

function orderedRpcUrls() {
  const endpoints = getBaseRpcEndpoints();
  const first = getRotatingBaseRpcEndpoint();
  return [first, ...endpoints.filter((endpoint) => endpoint !== first)];
}

export async function baseRpcRequest<T>(method: string, params: unknown[]): Promise<T> {
  let lastError: Error | null = null;

  for (const endpoint of orderedRpcUrls()) {
    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...endpoint.headers },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId++,
          method,
          params,
        }),
      });

      if (!response.ok) {
        throw new Error(`Base RPC ${response.status}`);
      }

      const payload = (await response.json()) as {
        result?: T;
        error?: { code?: number; message?: string };
      };

      if (payload.error) {
        const message = payload.error.message || "Base RPC error";
        if (message.toLowerCase().includes("rate") || payload.error.code === 429) {
          throw new Error(message);
        }
        throw new Error(message);
      }

      return payload.result as T;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError || new Error("Base RPC request failed");
}
