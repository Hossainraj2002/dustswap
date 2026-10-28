import { createPublicClient, custom } from "viem";
import { base } from "viem/chains";

const BASE_PUBLIC_RPC_URL = "https://mainnet.base.org";
// Independent public operators keep a single throttled node from sending normal reads to
// Alchemy. All public endpoints are tried before the paid backstop.
export const DEFAULT_BASE_RPC_URLS = [
  BASE_PUBLIC_RPC_URL,
  "https://base-mainnet.public.blastapi.io",
  "https://base-pokt.nodies.app",
  "https://base.gateway.tenderly.co",
];
const BASE_CHAIN_ID = 8453;
const DEFAULT_ROTATION_CALLS = 1;
const DEFAULT_ALCHEMY_ROTATION_CALLS = 1;
const DEFAULT_ALCHEMY_HEDGE_COUNT = 2;

let activeIndex = 0;
let activeCalls = 0;
let alchemyActiveIndex = 0;
let alchemyActiveCalls = 0;
let requestId = 1;

export class RpcDeterministicError extends Error {
  override name = "RpcDeterministicError" as const;
  readonly code?: number;
  readonly data?: unknown;
  readonly details: string;

  constructor(message: string, error?: RpcErrorPayload) {
    super(message);
    this.code = error?.code;
    this.data = error?.data;
    this.details = message;
  }
}

export class RpcTransportError extends Error {
  override name = "RpcTransportError" as const;
}

export class RpcRateLimitError extends Error {
  override name = "RpcRateLimitError" as const;
}

export type RpcErrorPayload = { code?: number; message?: string; data?: unknown };

export function isDeterministicRpcError(error?: RpcErrorPayload, method?: string): boolean {
  // Unsupported methods and generic -32000 errors may be node capability/rate limits;
  // fall through to another public operator instead of treating those as contract results.
  const msg = String(error?.message || "").toLowerCase();
  // A rejected signed transaction cannot be repaired by changing providers. Preserve its
  // original rejection instead of walking every public node and ending on an overdue key.
  if (method === "eth_sendRawTransaction" || method === "eth_sendTransaction") {
    if (error?.code === -32003 || [
      "nonce too low",
      "nonce too high",
      "insufficient funds",
      "replacement transaction underpriced",
      "transaction underpriced",
      "already known",
      "invalid sender",
      "invalid signature",
      "intrinsic gas too low",
    ].some((fragment) => msg.includes(fragment))) return true;
  }
  return (
    msg.includes("execution reverted") ||
    msg.includes("revert") ||
    msg.includes("no pool") ||
    msg.includes("insufficient liquidity") ||
    msg.includes("invalid opcode") ||
    msg.includes("out of gas") ||
    msg.includes("stack underflow") ||
    msg.includes("invalid jump") ||
    error?.code === 3
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
  maxEndpointAttempts?: number;
  // Per-call hedge override. Hedging fires the SAME request at N endpoints simultaneously —
  // great for latency on cheap calls, but it MULTIPLIES key usage. Expensive methods
  // (alchemy_getTokenBalances) should pass 1 so a capacity-limited key set isn't burned twice.
  hedgeCount?: number;
};

type RpcParams = ReadonlyArray<unknown> | Record<string, unknown>;

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

function normalizeRpcParams(params?: RpcParams) {
  return params ?? [];
}

function getRotationCalls(envValue: string | undefined, fallback: number) {
  const parsed = Number(envValue || fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function getBaseRotationCalls() {
  return getRotationCalls(process.env.BASE_RPC_ROTATION_CALLS, DEFAULT_ROTATION_CALLS);
}

function getAlchemyRotationCalls() {
  return getRotationCalls(
    process.env.ALCHEMY_RPC_ROTATION_CALLS,
    DEFAULT_ALCHEMY_ROTATION_CALLS,
  );
}

function getAlchemyHedgeCount(endpointCount: number) {
  const parsed = Number(process.env.ALCHEMY_RPC_HEDGE_COUNT || DEFAULT_ALCHEMY_HEDGE_COUNT);
  if (!Number.isFinite(parsed) || parsed <= 1) return 1;
  return Math.max(1, Math.min(endpointCount, Math.floor(parsed)));
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
    ...splitEnv(process.env.ALCHEMY_BASE_RPC_KEY),
    ...splitEnv(process.env.ALCHEMY_API_KEYS),
  ];
  const fallbackKeys = [
    ...splitEnv(process.env.ALCHEMY_API_KEY),
    ...splitEnv(process.env.BASE_ALCHEMY_API_KEYS),
    ...splitEnv(process.env.BASE_ALCHEMY_API_KEY),
  ];

  return [...preferredKeys, ...fallbackKeys].map(
    (key) => `https://base-mainnet.g.alchemy.com/v2/${key}`,
  );
}

// Standard RPC always uses public nodes first, including deployments with legacy "first",
// false, or PUBLIC_FALLBACK=0 settings. =true still excludes Alchemy from the generic pool;
// all other values retain it as the final backstop. The dedicated Token/Transfers/4337 lane
// remains available independently of this setting.
type AlchemyGenericPoolMode = "last" | "off";

function getAlchemyGenericPoolMode(): AlchemyGenericPoolMode {
  const raw = String(process.env.ALCHEMY_BASE_RPC_DEDICATED_ONLY || "").toLowerCase();
  if (["1", "true", "yes"].includes(raw)) return "off";
  return "last";
}

const ALCHEMY_BACKSTOP_LABEL = "alchemy-backstop";

function getAlchemyGenericPoolUrls() {
  return unique(
    [
      ...splitEnv(process.env.ALCHEMY_BASE_RPC_URLS),
      ...splitEnv(process.env.ALCHEMY_BASE_RPC),
      ...splitEnv(process.env.BASE_RPC_URLS).filter(isAlchemyRpcUrl),
      ...splitEnv(process.env.BASE_RPC_URL).filter(isAlchemyRpcUrl),
      ...getAdditionalConfiguredRpcUrls().filter(isAlchemyRpcUrl),
      ...getPreferredAlchemyKeyUrls(),
    ].filter(isHttpsUrl),
  );
}

function getAdditionalConfiguredRpcUrls() {
  return [
    process.env.NEXT_PUBLIC_BASE_RPC_URL,
    process.env.RPC_URL_8453,
    process.env.CHAIN_8453_RPC_URL,
  ].flatMap(splitEnv);
}

export function isAlchemyRpcUrl(url: string) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "alchemy.com" || hostname.endsWith(".alchemy.com") ||
      hostname === "alchemyapi.io" || hostname.endsWith(".alchemyapi.io");
  } catch {
    return false;
  }
}

// How many Blockscout keyed entries join a SINGLE request's endpoint chain. Previously ALL
// (~115) keys were in every chain, so when api.blockscout.com was slow, one failing request
// could walk minutes of sequential retries before reaching a healthy endpoint — that stalls
// every RPC-dependent route at once. Keys still rotate ACROSS requests so the whole pool
// shares load; each individual request just sees a short, bounded chain.
const BLOCKSCOUT_RPC_MAX_PER_REQUEST = (() => {
  const parsed = Number.parseInt(process.env.BLOCKSCOUT_RPC_MAX_PER_REQUEST || "2", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 10) : 2;
})();
let blockscoutRpcKeyOffset = 0;

function getBlockscoutRpcEndpoints(): BaseRpcEndpoint[] {
  const keys = unique([
    ...splitEnv(process.env.BLOCKSCOUT_API_KEYS),
    ...splitEnv(process.env.BLOCKSCOUT_API_KEY),
  ]);
  if (keys.length === 0) return [];

  const take = Math.min(keys.length, BLOCKSCOUT_RPC_MAX_PER_REQUEST);
  const endpoints: BaseRpcEndpoint[] = [];
  for (let i = 0; i < take; i += 1) {
    const key = keys[(blockscoutRpcKeyOffset + i) % keys.length];
    endpoints.push({
      url: `https://api.blockscout.com/${BASE_CHAIN_ID}/json-rpc`,
      headers: {
        Authorization: `Bearer ${key}`,
      },
      label: "blockscout",
    });
  }
  blockscoutRpcKeyOffset = (blockscoutRpcKeyOffset + take) % keys.length;

  return endpoints;
}

export function getAlchemyRpcEndpoints(): BaseRpcEndpoint[] {
  const explicitAlchemyUrls = [
    ...splitEnv(process.env.ALCHEMY_BASE_RPC_URLS),
    ...splitEnv(process.env.ALCHEMY_BASE_RPC),
  ].filter((url) => isHttpsUrl(url) && isAlchemyRpcUrl(url));

  return unique([
    ...explicitAlchemyUrls,
    ...getPreferredAlchemyKeyUrls(),
    ...getAlchemyGenericPoolUrls().filter(isAlchemyRpcUrl),
  ]).map((url) => ({
    url,
    label: "alchemy-dedicated",
  }));
}

export function getBaseRpcEndpoints(): BaseRpcEndpoint[] {
  const publicUrls = unique(DEFAULT_BASE_RPC_URLS);
  const configuredUrls = unique([
    ...splitEnv(process.env.BASE_RPC_URLS),
    ...splitEnv(process.env.BASE_RPC_URL),
    ...getAdditionalConfiguredRpcUrls(),
  ].filter((url) => isHttpsUrl(url) && !isAlchemyRpcUrl(url) && !publicUrls.includes(url)));
  const endpoints: BaseRpcEndpoint[] = [
    ...publicUrls.map((url) => ({ url, label: "public" })),
    ...configuredUrls.map((url) => ({
      url,
      label: url.includes("blockscout") ? "blockscout" : "custom",
    })),
  ];
  const withBlockscout = [...endpoints, ...getBlockscoutRpcEndpoints()];

  // "last" mode: the paid Alchemy endpoints go AFTER even the public fallback — pure backstop.
  // They are excluded from rotation leadership below, so they only serve a request when every
  // free endpoint has already failed it.
  const withAlchemyBackstop =
    getAlchemyGenericPoolMode() === "last"
      ? [
          ...withBlockscout,
          ...getAlchemyGenericPoolUrls()
            .filter((url) => !withBlockscout.some((endpoint) => endpoint.url === url))
            .map((url) => ({ url, label: ALCHEMY_BACKSTOP_LABEL })),
        ]
      : withBlockscout;

  return withAlchemyBackstop.length > 0
    ? withAlchemyBackstop
    : [{ url: BASE_PUBLIC_RPC_URL, label: "public" }];
}

export function getBaseRpcUrls() {
  return getBaseRpcEndpoints().map((endpoint) => endpoint.url);
}

export function getRotatingBaseRpcEndpoint(endpoints = getBaseRpcEndpoints()) {
  if (endpoints.length === 1) return endpoints[0];

  // Backstop endpoints never LEAD a request — they only serve as the final failure fallback
  // via getOrderedBaseRpcEndpoints. Rotation cycles over the free pool only.
  const rotationPool = endpoints.filter(
    (endpoint) => endpoint.label === "public",
  );
  const pool = rotationPool.length > 0 ? rotationPool : endpoints;
  if (pool.length === 1) return pool[0];

  const endpoint = pool[activeIndex % pool.length];
  activeCalls += 1;

  if (activeCalls >= getBaseRotationCalls()) {
    activeCalls = 0;
    activeIndex = (activeIndex + 1) % pool.length;
  }

  return endpoint;
}

export function getRotatingBaseRpcUrl() {
  return getRotatingBaseRpcEndpoint().url;
}

export function getOrderedBaseRpcEndpoints() {
  const endpoints = getBaseRpcEndpoints();
  const first = getRotatingBaseRpcEndpoint(endpoints);
  return [first, ...endpoints.filter((endpoint) => !isSameEndpoint(endpoint, first))];
}

export function getRotatingAlchemyRpcEndpoint() {
  const endpoints = getAlchemyRpcEndpoints();
  if (endpoints.length === 0) return null;
  if (endpoints.length === 1) return endpoints[0];

  const endpoint = endpoints[alchemyActiveIndex % endpoints.length];
  alchemyActiveCalls += 1;

  if (alchemyActiveCalls >= getAlchemyRotationCalls()) {
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

async function requestAlchemyEndpoint<T>(
  endpoint: BaseRpcEndpoint,
  method: string,
  params: RpcParams,
  opts: RpcRequestOptions,
  controller: AbortController,
): Promise<T> {
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
        params: normalizeRpcParams(params),
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
      error?: RpcErrorPayload;
    };

    if (payload.error) {
      if (isDeterministicRpcError(payload.error, method)) {
        throw new RpcDeterministicError(payload.error.message || "Alchemy deterministic error", payload.error);
      }
      throw new RpcTransportError(payload.error.message || "Alchemy RPC error");
    }

    if (!Object.prototype.hasOwnProperty.call(payload, "result")) {
      throw new RpcTransportError("Malformed RPC response: missing result");
    }

    return payload.result as T;
  } finally {
    clearTimeout(timeout);
  }
}

// Typed as any to avoid cross-package viem client incompatibilities in this workspace.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createBasePublicClient(timeoutMs = 5_000): any {
  return createPublicClient({
    chain: base,
    transport: custom(
      {
        async request({
          method,
          params,
        }: {
          method: string;
          params?: RpcParams;
        }) {
          return baseRpcRequest(method, normalizeRpcParams(params), { timeoutMs });
        },
      },
      {
        key: "base-rotating-rpc",
        name: "Base Rotating RPC",
        retryCount: 0,
      },
    ),
  });
}

// ---------------------------------------------------------------------------
// FREE VERIFICATION LANE
// ---------------------------------------------------------------------------
// For server-side reads that confirm something already on-chain (tx, receipt, block, signature
// checks). They earn no fee, nobody is waiting on them, and they are low volume — so they run on
// free public nodes and only reach Alchemy if every one of those fails.
//
// Defaults live in code on purpose — no env var has to be set for this to work. Each URL was
// verified live on 2026-08-02 against eth_getTransactionByHash / eth_getTransactionReceipt /
// eth_getBlockByNumber: 30/30 sequential, 10/10 burst, >=24h of history, ~95 req/s combined.
export const DEFAULT_VERIFICATION_RPC_URLS = DEFAULT_BASE_RPC_URLS;

// base-rpc.publicnode.com rejected receipt reads with HTTP 403 during verification, and
// Blockscout's keyed RPC has a smaller rate limit. Skip both in this lane so a failed public
// receipt read moves directly to another verified public operator before the Alchemy backstop.
const VERIFICATION_EXCLUDED_URL_FRAGMENTS = ["base-rpc.publicnode.com", "blockscout"];

let verificationRotationIndex = 0;

function getVerificationRpcUrls() {
  const configured = splitEnv(process.env.BASE_VERIFICATION_RPC_URLS);
  return unique([
    ...DEFAULT_VERIFICATION_RPC_URLS,
    ...configured.filter((url) => !isAlchemyRpcUrl(url)),
  ]);
}

export function getVerificationRpcEndpoints(): BaseRpcEndpoint[] {
  const urls = unique(getVerificationRpcUrls().filter(isHttpsUrl));

  let free: BaseRpcEndpoint[] = [];
  if (urls.length > 0) {
    const offset = verificationRotationIndex % urls.length;
    verificationRotationIndex = (verificationRotationIndex + 1) % urls.length;
    free = [...urls.slice(offset), ...urls.slice(0, offset)].map((url) => ({
      url,
      label: "verification-public",
    }));
  }

  const shared = getBaseRpcEndpoints().filter(
    (endpoint) =>
      !VERIFICATION_EXCLUDED_URL_FRAGMENTS.some((fragment) =>
        endpoint.url.includes(fragment),
      ) && !free.some((candidate) => candidate.url === endpoint.url),
  );

  return [
    ...free,
    ...shared.filter((endpoint) => !endpoint.url.includes("alchemy")),
    ...shared.filter((endpoint) => endpoint.url.includes("alchemy")),
    ...splitEnv(process.env.BASE_VERIFICATION_RPC_URLS)
      .filter((url) => isHttpsUrl(url) && isAlchemyRpcUrl(url) && !shared.some((endpoint) => endpoint.url === url))
      .map((url) => ({ url, label: ALCHEMY_BACKSTOP_LABEL })),
  ];
}

// Public nodes do not implement every RPC (eth_getUserOperationReceipt is the obvious one).
// Unsupported methods fail over to the next node and eventually the Alchemy backstop; only
// an actual execution revert stops retries. Generic reads follow the same capability policy.
function isDeterministicVerificationError(error?: { code?: number; message?: string }) {
  const msg = String(error?.message || "").toLowerCase();
  return msg.includes("execution reverted") || msg.includes("revert") || error?.code === 3;
}

export async function baseVerificationRequest<T>(
  method: string,
  params: RpcParams = [],
  opts: RpcRequestOptions = {},
): Promise<T> {
  let lastTransport: Error | null = null;

  for (const endpoint of getVerificationRpcEndpoints()) {
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
          params: normalizeRpcParams(params),
        }),
        signal: combinedSignal,
      });

      if (!response.ok) {
        throw new RpcTransportError(
          `Verification RPC ${response.status} from ${endpoint.label || endpoint.url}`,
        );
      }

      const payload = (await response.json()) as {
        result?: T;
        error?: RpcErrorPayload;
      };

      if (payload.error) {
        if (isDeterministicVerificationError(payload.error)) {
          throw new RpcDeterministicError(payload.error.message || "deterministic rpc error", payload.error);
        }
        throw new RpcTransportError(payload.error.message || "rpc error");
      }

      if (!Object.prototype.hasOwnProperty.call(payload, "result")) {
        throw new RpcTransportError("Malformed RPC response: missing result");
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

  throw lastTransport ?? new Error("Base verification RPC request failed");
}

// Drop-in replacement for createBasePublicClient for confirmation-style reads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createBaseVerificationClient(timeoutMs = 20_000): any {
  return createPublicClient({
    chain: base,
    transport: custom(
      {
        async request({ method, params }: { method: string; params?: RpcParams }) {
          return baseVerificationRequest(method, normalizeRpcParams(params), { timeoutMs });
        },
      },
      {
        key: "base-verification-rpc",
        name: "Base Verification RPC",
        retryCount: 0,
      },
    ),
  });
}

export async function alchemyRpcRequest<T>(
  method: string,
  params: RpcParams = [],
  opts: RpcRequestOptions = {},
): Promise<T> {
  let endpoints = getOrderedAlchemyRpcEndpoints();
  if (endpoints.length === 0) {
    return baseRpcRequest<T>(method, params, opts);
  }

  if (Number.isFinite(opts.maxEndpointAttempts) && Number(opts.maxEndpointAttempts) > 0) {
    endpoints = endpoints.slice(
      0,
      Math.max(1, Math.min(endpoints.length, Math.floor(Number(opts.maxEndpointAttempts)))),
    );
  }

  let lastTransport: Error | null = null;
  let endpointsToTry = endpoints;
  const hedgeCount =
    Number.isFinite(opts.hedgeCount) && Number(opts.hedgeCount) >= 1
      ? Math.min(endpoints.length, Math.floor(Number(opts.hedgeCount)))
      : getAlchemyHedgeCount(endpoints.length);

  if (hedgeCount > 1) {
    const hedgedControllers: AbortController[] = [];
    let deterministicError: RpcDeterministicError | null = null;
    try {
      const result = await Promise.any(
        endpoints.slice(0, hedgeCount).map(async (endpoint) => {
          const controller = new AbortController();
          hedgedControllers.push(controller);
          try {
            return await requestAlchemyEndpoint<T>(endpoint, method, params, opts, controller);
          } catch (err) {
            if (err instanceof RpcDeterministicError && !deterministicError) {
              deterministicError = err;
            }
            throw err;
          }
        }),
      );
      for (const controller of hedgedControllers) controller.abort();
      return result;
    } catch (err) {
      for (const controller of hedgedControllers) controller.abort();
      if (deterministicError) throw deterministicError;
      lastTransport = err instanceof Error ? err : new Error(String(err));
      endpointsToTry = endpoints.slice(hedgeCount);
    }
  }

  for (const endpoint of endpointsToTry) {
    const controller = new AbortController();

    try {
      return await requestAlchemyEndpoint<T>(endpoint, method, params, opts, controller);
    } catch (err) {
      if (err instanceof RpcDeterministicError) throw err;
      if (opts.signal?.aborted) throw err;

      lastTransport = err instanceof Error ? err : new Error(String(err));
      continue;
    }
  }

  throw lastTransport ?? new Error("Alchemy RPC request failed");
}

export async function baseRpcRequest<T>(
  method: string,
  params: RpcParams = [],
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
          params: normalizeRpcParams(params),
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
        error?: RpcErrorPayload;
      };

      if (payload.error) {
        if (isDeterministicRpcError(payload.error, method)) {
          throw new RpcDeterministicError(payload.error.message || "deterministic rpc error", payload.error);
        }
        throw new RpcTransportError(payload.error.message || "rpc error");
      }

      if (!Object.prototype.hasOwnProperty.call(payload, "result")) {
        throw new RpcTransportError("Malformed RPC response: missing result");
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
