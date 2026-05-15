import { createPublicClient, fallback, http } from "viem";
import { base } from "viem/chains";

const BASE_PUBLIC_RPC_URL = "https://mainnet.base.org";
const BASE_CHAIN_ID = 8453;
const DEFAULT_ROTATION_CALLS = 100;

let activeIndex = 0;
let activeCalls = 0;
let alchemyActiveIndex = 0;
let alchemyActiveCalls = 0;
let requestId = 1;

export class RpcDeterministicError extends Error {
  override name = "RpcDeterministicError" as const;
}

export class RpcTransportError extends Error {
  override name = "RpcTransportError" as const;
}

export class RpcRateLimitError extends Error {
  override name = "RpcRateLimitError" as const;
}

function isDeterministicRpcError(error?: { code?: number; message?: string }): boolean {
  const msg = String(error?.message || "").toLowerCase();
  return (
    msg.includes("execution reverted") ||
    msg.includes("revert") ||
    msg.includes("no pool") ||
    msg.includes("insufficient liquidity") ||
    msg.includes("method not found") ||
    msg.includes("invalid opcode") ||
    msg.includes("out of gas") ||
    msg.includes("stack underflow") ||
    msg.includes("invalid jump") ||
    msg.includes("invalid method") ||
    (error?.code !== undefined && (error.code === -32601 || error.code === -32000 || error.code === 3))
  );
}

export type BaseRpcEndpoint = {
  url: string;
  headers?: Record<string, string>;
  label?: string;
};

export type RpcRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  retryDeterministic?: false;
  providerLabel?: string;
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

function isSameEndpoint(a: BaseRpcEndpoint, b: BaseRpcEndpoint) {
  return (
    a.url === b.url &&
    JSON.stringify(a.headers || {}) === JSON.stringify(b.headers || {})
  );
}

function getPreferredAlchemyKeyUrls() {
  const preferredKeys = [
    ...splitEnv(process.env.ALCHEMY_BASE_RPC_KEYS),
    ...splitEnv(process.env.ALCHEMY_API_KEYS),
  ];
  const fallbackKeys = splitEnv(process.env.ALCHEMY_API_KEY);

  return [...preferredKeys, ...fallbackKeys].map(
    (key) => `https://base-mainnet.g.alchemy.com/v2/${key}`,
  );
}

function getPreferredBaseRpcUrls() {
  return unique(
    [
      ...splitEnv(process.env.ALCHEMY_BASE_RPC_URLS),
      ...splitEnv(process.env.ALCHEMY_BASE_RPC),
      ...getPreferredAlchemyKeyUrls(),
      ...splitEnv(process.env.BASE_RPC_URLS),
      ...splitEnv(process.env.BASE_RPC_URL),
    ].filter(isHttpsUrl),
  );
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
    label: "blockscout",
  }));
}

export function getAlchemyRpcEndpoints(): BaseRpcEndpoint[] {
  const explicitAlchemyUrls = [
    ...splitEnv(process.env.ALCHEMY_BASE_RPC_URLS),
    ...splitEnv(process.env.ALCHEMY_BASE_RPC),
  ].filter((url) => isHttpsUrl(url) && url.includes("alchemy"));

  return unique([
    ...explicitAlchemyUrls,
    ...getPreferredAlchemyKeyUrls(),
  ]).map((url) => ({
    url,
    label: "alchemy-dedicated",
  }));
}

export function getBaseRpcEndpoints(): BaseRpcEndpoint[] {
  const endpoints: BaseRpcEndpoint[] = getPreferredBaseRpcUrls().map((url) => ({
    url,
    label: url.includes("alchemy") ? "alchemy" : url.includes("blockscout") ? "blockscout" : "custom",
  }));
  const withBlockscout = [...endpoints, ...getBlockscoutRpcEndpoints()];
  const withPublicFallback = shouldUsePublicFallback()
    ? [...withBlockscout, { url: BASE_PUBLIC_RPC_URL, label: "public" }]
    : withBlockscout;

  return withPublicFallback.length > 0 ? withPublicFallback : [{ url: BASE_PUBLIC_RPC_URL, label: "public" }];
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

export function getOrderedBaseRpcEndpoints() {
  const endpoints = getBaseRpcEndpoints();
  const first = getRotatingBaseRpcEndpoint();
  return [first, ...endpoints.filter((endpoint) => !isSameEndpoint(endpoint, first))];
}

export function getRotatingAlchemyRpcEndpoint() {
  const endpoints = getAlchemyRpcEndpoints();
  if (endpoints.length === 0) return null;
  if (endpoints.length === 1) return endpoints[0];

  const endpoint = endpoints[alchemyActiveIndex % endpoints.length];
  alchemyActiveCalls += 1;

  if (alchemyActiveCalls >= getRotationCalls()) {
    alchemyActiveCalls = 0;
    alchemyActiveIndex = (alchemyActiveIndex + 1) % endpoints.length;
  }

  return endpoint;
}

function getOrderedAlchemyRpcEndpoints() {
  const endpoints = getAlchemyRpcEndpoints();
  const first = getRotatingAlchemyRpcEndpoint();
  if (!first) return [];
  return [first, ...endpoints.filter((endpoint) => !isSameEndpoint(endpoint, first))];
}

// Typed as any to avoid cross-package viem client incompatibilities in this workspace.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createBasePublicClient(timeoutMs = 20_000): any {
  const transports = getOrderedBaseRpcEndpoints().map((endpoint) =>
    http(endpoint.url, {
      timeout: timeoutMs,
      fetchOptions: endpoint.headers
        ? {
            headers: endpoint.headers,
          }
        : undefined,
    }),
  );

  return createPublicClient({
    chain: base,
    transport: transports.length === 1 ? transports[0] : fallback(transports),
  });
}

export async function alchemyRpcRequest<T>(
  method: string,
  params: unknown[],
  opts: RpcRequestOptions = {},
): Promise<T> {
  const endpoints = getOrderedAlchemyRpcEndpoints();
  if (endpoints.length === 0) {
    return baseRpcRequest<T>(method, params, opts);
  }

  let lastTransport: Error | null = null;

  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const combinedSignal = opts.signal
      ? AbortSignal.any([opts.signal, controller.signal])
      : controller.signal;

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
        signal: combinedSignal,
      });

      if (!response.ok) {
        if (response.status === 429) {
          throw new RpcRateLimitError(`Alchemy rate limited (${response.status})`);
        }
        throw new RpcTransportError(`Alchemy ${response.status}`);
      }

      const payload = (await response.json()) as {
        result?: T;
        error?: { code?: number; message?: string };
      };

      if (payload.error) {
        if (isDeterministicRpcError(payload.error)) {
          throw new RpcDeterministicError(payload.error.message || "Alchemy deterministic error");
        }
        throw new RpcTransportError(payload.error.message || "Alchemy RPC error");
      }

      return payload.result as T;
    } catch (err) {
      if (err instanceof RpcDeterministicError) throw err;
      if (opts.signal?.aborted) throw err;

      lastTransport = err instanceof Error ? err : new Error(String(err));
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastTransport ?? new Error("Alchemy RPC request failed");
}

export async function baseRpcRequest<T>(
  method: string,
  params: unknown[],
  opts: RpcRequestOptions = {},
): Promise<T> {
  let lastTransport: Error | null = null;
  const endpoints = getOrderedBaseRpcEndpoints();

  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const combinedSignal = opts.signal
      ? AbortSignal.any([opts.signal, controller.signal])
      : controller.signal;

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
        signal: combinedSignal,
      });

      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) {
          throw new RpcRateLimitError(`RPC ${response.status} from ${endpoint.label || endpoint.url}`);
        }
        throw new RpcTransportError(`RPC ${response.status} from ${endpoint.label || endpoint.url}`);
      }

      const payload = (await response.json()) as {
        result?: T;
        error?: { code?: number; message?: string };
      };

      if (payload.error) {
        if (isDeterministicRpcError(payload.error)) {
          throw new RpcDeterministicError(payload.error.message || "deterministic rpc error");
        }
        throw new RpcTransportError(payload.error.message || "rpc error");
      }

      return payload.result as T;
    } catch (err) {
      if (err instanceof RpcDeterministicError) throw err;
      if (opts.signal?.aborted) throw err;

      lastTransport = err instanceof Error ? err : new Error(String(err));
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastTransport ?? new Error("Base RPC request failed");
}
