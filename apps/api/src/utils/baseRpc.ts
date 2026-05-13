const BASE_PUBLIC_RPC_URL = "https://mainnet.base.org";
const BASE_CHAIN_ID = 8453;
const DEFAULT_ROTATION_CALLS = 100;

let activeIndex = 0;
let activeCalls = 0;
let requestId = 1;

// ── Error classification ─────────────────────────────────────────────────────

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

// ── Types ─────────────────────────────────────────────────────────────────────

export type BaseRpcEndpoint = {
  url: string;
  headers?: Record<string, string>;
  /** Label for metrics/logging */
  label?: string;
};

export type RpcRequestOptions = {
  /** AbortSignal to cancel the request */
  signal?: AbortSignal;
  /** Timeout in milliseconds (default: 5000) */
  timeoutMs?: number;
  /** If false (default), deterministic errors are NOT retried across endpoints */
  retryDeterministic?: false;
  /** Provider label for metrics */
  providerLabel?: string;
};

// ── Env helpers ───────────────────────────────────────────────────────────────

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
    label: "blockscout",
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
    .map((url) => ({
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

function orderedRpcUrls() {
  const endpoints = getBaseRpcEndpoints();
  const first = getRotatingBaseRpcEndpoint();
  return [first, ...endpoints.filter((endpoint) => endpoint !== first)];
}

// ── Dedicated Alchemy RPC (for alchemy_* proprietary methods) ────────────────

function getAlchemyEndpoint(): BaseRpcEndpoint | null {
  const keys = [
    ...splitEnv(process.env.ALCHEMY_API_KEY),
    ...splitEnv(process.env.ALCHEMY_API_KEYS),
    ...splitEnv(process.env.ALCHEMY_BASE_RPC_KEYS),
  ];
  if (keys.length > 0) {
    return {
      url: `https://base-mainnet.g.alchemy.com/v2/${keys[0]}`,
      label: "alchemy-dedicated",
    };
  }

  // Check explicit URLs
  const urls = [
    ...splitEnv(process.env.ALCHEMY_BASE_RPC_URLS),
    ...splitEnv(process.env.ALCHEMY_BASE_RPC),
  ].filter((url) => url.includes("alchemy"));

  if (urls.length > 0) {
    return { url: urls[0], label: "alchemy-dedicated" };
  }

  return null;
}

/**
 * Dedicated Alchemy RPC for proprietary methods like `alchemy_getTokenBalances`.
 * Does NOT use general RPC rotation — Alchemy-only methods must go to Alchemy.
 * Falls back to general rotation only if no Alchemy endpoint is configured.
 */
export async function alchemyRpcRequest<T>(
  method: string,
  params: unknown[],
  opts: RpcRequestOptions = {},
): Promise<T> {
  const alchemyEndpoint = getAlchemyEndpoint();
  if (!alchemyEndpoint) {
    // No dedicated Alchemy — fall back to general rotation (may fail for alchemy_* methods)
    return baseRpcRequest<T>(method, params, opts);
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 10_000; // Alchemy balance calls can be slow
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // Use external signal if provided
  const combinedSignal = opts.signal
    ? AbortSignal.any([opts.signal, controller.signal])
    : controller.signal;

  try {
    const response = await fetch(alchemyEndpoint.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...alchemyEndpoint.headers },
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
  } finally {
    clearTimeout(timeout);
  }
}

// ── Core RPC request with error classification and retry ─────────────────────

export async function baseRpcRequest<T>(
  method: string,
  params: unknown[],
  opts: RpcRequestOptions = {},
): Promise<T> {
  let lastTransport: Error | null = null;
  const endpoints = orderedRpcUrls();

  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // Combine external signal with our timeout signal
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
          // Deterministic error: do NOT retry across endpoints
          throw new RpcDeterministicError(payload.error.message || "deterministic rpc error");
        }
        throw new RpcTransportError(payload.error.message || "rpc error");
      }

      return payload.result as T;
    } catch (err) {
      // Deterministic errors must not rotate — throw immediately
      if (err instanceof RpcDeterministicError) throw err;

      // External abort — throw immediately
      if (opts.signal?.aborted) throw err;

      lastTransport = err instanceof Error ? err : new Error(String(err));
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastTransport ?? new Error("Base RPC request failed");
}
