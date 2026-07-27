import { createPublicClient, custom, defineChain, type Chain } from "viem";
import { bsc, mainnet } from "viem/chains";
import {
  alchemyRpcRequest,
  baseRpcRequest,
  createBasePublicClient,
  getAlchemyRpcEndpoints,
  getBaseRpcEndpoints,
  RpcDeterministicError,
  RpcRateLimitError,
  RpcTransportError,
  type BaseRpcEndpoint,
  type RpcRequestOptions,
} from "./baseRpc";

/**
 * Multichain RPC dispatch for DustSweep.
 *
 * ADDITIVE + STANDALONE: chainId 8453 delegates 1:1 to the battle-tested `baseRpc.ts`
 * (same module state, same rotation counters — zero behavioral drift for Base). Other
 * chains get the SAME pool model (keyed Alchemy rotation → custom URLs → Blockscout
 * JSON-RPC → public fallback → optional Alchemy backstop) driven by per-chain env vars.
 *
 * Prod-incident caveat (2026-07-04): the generic eth_call pool must NEVER be led by
 * public RPCs. Keyed endpoints lead by default on every chain ("first" mode).
 */

export const ETHEREUM_CHAIN_ID = 1;
export const BSC_CHAIN_ID = 56;
export const ROBINHOOD_CHAIN_ID = 4663;
const BASE_CHAIN_ID = 8453;

// viem (2.46/2.52 in this workspace) ships no Robinhood Chain definition — define it locally.
// Native currency IS ETH (Arbitrum-stack L2). Verified live 2026-07-26: eth_chainId=0x1237.
const robinhoodChain: Chain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
});

const DEFAULT_ROTATION_CALLS = 100;
const DEFAULT_ALCHEMY_ROTATION_CALLS = 1;
const DEFAULT_ALCHEMY_HEDGE_COUNT = 2;

type RpcParams = ReadonlyArray<unknown> | Record<string, unknown>;

type AlchemyGenericPoolMode = "first" | "last" | "off";

type ChainRpcSettings = {
  chainId: number;
  /** viem chain object for createPublicClient. */
  chain: Chain;
  publicRpcUrl: string;
  alchemyHost: string; // e.g. eth-mainnet.g.alchemy.com
  /** Preferred keyed-Alchemy env names (comma lists), in priority order. */
  alchemyKeyEnvs: string[];
  /** Explicit Alchemy URL env names (comma lists). */
  alchemyUrlEnvs: string[];
  /** Custom RPC URL env names (comma lists). */
  rpcUrlEnvs: string[];
  rotationCallsEnv: string;
  publicFallbackEnv: string;
  dedicatedOnlyEnv: string;
  /**
   * Whether the hosted Blockscout JSON-RPC (api.blockscout.com/<chainId>/json-rpc) serves this
   * chain. BSC is NOT hosted there (verified live 2026-07-10: "Network not supported"), so its
   * pool must skip those endpoints instead of burning a failover hop on every request.
   */
  blockscoutSupported: boolean;
};

const CHAIN_RPC_SETTINGS: Record<number, ChainRpcSettings> = {
  [ETHEREUM_CHAIN_ID]: {
    chainId: ETHEREUM_CHAIN_ID,
    chain: mainnet,
    publicRpcUrl: "https://ethereum-rpc.publicnode.com",
    alchemyHost: "eth-mainnet.g.alchemy.com",
    // Deliberately NO fallback to the Base key pool: Ethereum discovery burns CU at a very
    // different rate, and a separate key set keeps the burn attributable per chain.
    alchemyKeyEnvs: ["ALCHEMY_ETHEREUM_RPC_KEYS", "ALCHEMY_ETHEREUM_RPC_KEY"],
    alchemyUrlEnvs: ["ALCHEMY_ETHEREUM_RPC_URLS", "ALCHEMY_ETHEREUM_RPC"],
    rpcUrlEnvs: ["ETHEREUM_RPC_URLS", "ETHEREUM_RPC_URL"],
    rotationCallsEnv: "ETHEREUM_RPC_ROTATION_CALLS",
    publicFallbackEnv: "ETHEREUM_RPC_PUBLIC_FALLBACK",
    dedicatedOnlyEnv: "ALCHEMY_ETHEREUM_RPC_DEDICATED_ONLY",
    blockscoutSupported: true,
  },
  [BSC_CHAIN_ID]: {
    chainId: BSC_CHAIN_ID,
    chain: bsc,
    publicRpcUrl: "https://bsc-dataseed.bnbchain.org",
    // Verified live 2026-07-10: bnb-mainnet serves eth_* AND alchemy_getTokenBalances. NOTE the
    // Alchemy app must have the BNB network enabled (dashboard → app → Networks) or every call
    // returns "BNB_MAINNET is not enabled for this app".
    alchemyHost: "bnb-mainnet.g.alchemy.com",
    // Same isolation rationale as Ethereum: a separate key set keeps CU burn attributable.
    alchemyKeyEnvs: ["ALCHEMY_BSC_RPC_KEYS", "ALCHEMY_BSC_RPC_KEY"],
    alchemyUrlEnvs: ["ALCHEMY_BSC_RPC_URLS", "ALCHEMY_BSC_RPC"],
    rpcUrlEnvs: ["BSC_RPC_URLS", "BSC_RPC_URL"],
    rotationCallsEnv: "BSC_RPC_ROTATION_CALLS",
    publicFallbackEnv: "BSC_RPC_PUBLIC_FALLBACK",
    dedicatedOnlyEnv: "ALCHEMY_BSC_RPC_DEDICATED_ONLY",
    blockscoutSupported: false,
  },
  [ROBINHOOD_CHAIN_ID]: {
    chainId: ROBINHOOD_CHAIN_ID,
    chain: robinhoodChain,
    // Public RPC is rate-limited — discovery/quoting must lead with keyed Alchemy endpoints.
    publicRpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    // Verified live 2026-07-26: the host exists (Alchemy edge answered the shared demo key with
    // 429). NOTE the Alchemy app must have the Robinhood network enabled (dashboard → app →
    // Networks) and alchemy_getTokenBalances confirmed before flipping the chain on.
    alchemyHost: "robinhood-mainnet.g.alchemy.com",
    // Same isolation rationale as Ethereum/BSC: a separate key set keeps CU burn attributable.
    alchemyKeyEnvs: ["ALCHEMY_ROBINHOOD_RPC_KEYS", "ALCHEMY_ROBINHOOD_RPC_KEY"],
    alchemyUrlEnvs: ["ALCHEMY_ROBINHOOD_RPC_URLS", "ALCHEMY_ROBINHOOD_RPC"],
    rpcUrlEnvs: ["ROBINHOOD_RPC_URLS", "ROBINHOOD_RPC_URL"],
    rotationCallsEnv: "ROBINHOOD_RPC_ROTATION_CALLS",
    publicFallbackEnv: "ROBINHOOD_RPC_PUBLIC_FALLBACK",
    dedicatedOnlyEnv: "ALCHEMY_ROBINHOOD_RPC_DEDICATED_ONLY",
    // Hosted api.blockscout.com/4663 answered 402 "proceed with API key" (2026-07-26) — i.e. it
    // ROUTES the chain (unlike BSC's flat "Network not supported") but could not be confirmed
    // with a working key (local keys were stale). Ship false so no failover hop is burned; flip
    // to true after one keyed eth_chainId test with the live Railway BLOCKSCOUT_API_KEYS (see
    // the Robinhood deploy runbook).
    blockscoutSupported: false,
  },
};

type RotationState = {
  activeIndex: number;
  activeCalls: number;
  alchemyActiveIndex: number;
  alchemyActiveCalls: number;
  blockscoutKeyOffset: number;
};

const rotationStates = new Map<number, RotationState>();
let requestId = 1;

function getRotationState(chainId: number): RotationState {
  let state = rotationStates.get(chainId);
  if (!state) {
    state = {
      activeIndex: 0,
      activeCalls: 0,
      alchemyActiveIndex: 0,
      alchemyActiveCalls: 0,
      blockscoutKeyOffset: 0,
    };
    rotationStates.set(chainId, state);
  }
  return state;
}

export function getChainRpcSettings(chainId: number): ChainRpcSettings | null {
  return CHAIN_RPC_SETTINGS[chainId] ?? null;
}

export function isChainRpcSupported(chainId: number): boolean {
  return chainId === BASE_CHAIN_ID || Boolean(CHAIN_RPC_SETTINGS[chainId]);
}

function splitEnv(value?: string) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitEnvs(names: string[]) {
  return names.flatMap((name) => splitEnv(process.env[name]));
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

function getRotationCalls(envValue: string | undefined, fallback: number) {
  const parsed = Number(envValue || fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function getAlchemyRotationCalls() {
  return getRotationCalls(process.env.ALCHEMY_RPC_ROTATION_CALLS, DEFAULT_ALCHEMY_ROTATION_CALLS);
}

function getAlchemyHedgeCount(endpointCount: number) {
  const parsed = Number(process.env.ALCHEMY_RPC_HEDGE_COUNT || DEFAULT_ALCHEMY_HEDGE_COUNT);
  if (!Number.isFinite(parsed) || parsed <= 1) return 1;
  return Math.max(1, Math.min(endpointCount, Math.floor(parsed)));
}

function getAlchemyGenericPoolMode(settings: ChainRpcSettings): AlchemyGenericPoolMode {
  const raw = String(process.env[settings.dedicatedOnlyEnv] || "").toLowerCase();
  if (["1", "true", "yes"].includes(raw)) return "off";
  if (raw === "last") return "last";
  return "first";
}

const ALCHEMY_BACKSTOP_LABEL = "alchemy-backstop";

function getPreferredAlchemyKeyUrls(settings: ChainRpcSettings) {
  return splitEnvs(settings.alchemyKeyEnvs).map(
    (key) => `https://${settings.alchemyHost}/v2/${key}`,
  );
}

function getAlchemyGenericPoolUrls(settings: ChainRpcSettings) {
  return unique(
    [...splitEnvs(settings.alchemyUrlEnvs), ...getPreferredAlchemyKeyUrls(settings)].filter(
      isHttpsUrl,
    ),
  );
}

const BLOCKSCOUT_RPC_MAX_PER_REQUEST = (() => {
  const parsed = Number.parseInt(process.env.BLOCKSCOUT_RPC_MAX_PER_REQUEST || "2", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 10) : 2;
})();

function getBlockscoutRpcEndpoints(settings: ChainRpcSettings): BaseRpcEndpoint[] {
  if (!settings.blockscoutSupported) return [];
  const keys = unique([
    ...splitEnv(process.env.BLOCKSCOUT_API_KEYS),
    ...splitEnv(process.env.BLOCKSCOUT_API_KEY),
  ]);
  if (keys.length === 0) return [];

  const state = getRotationState(settings.chainId);
  const take = Math.min(keys.length, BLOCKSCOUT_RPC_MAX_PER_REQUEST);
  const endpoints: BaseRpcEndpoint[] = [];
  for (let i = 0; i < take; i += 1) {
    const key = keys[(state.blockscoutKeyOffset + i) % keys.length];
    endpoints.push({
      url: `https://api.blockscout.com/${settings.chainId}/json-rpc`,
      headers: {
        Authorization: `Bearer ${key}`,
      },
      label: "blockscout",
    });
  }
  state.blockscoutKeyOffset = (state.blockscoutKeyOffset + take) % keys.length;

  return endpoints;
}

export function getChainAlchemyRpcEndpoints(chainId: number): BaseRpcEndpoint[] {
  if (chainId === BASE_CHAIN_ID) return getAlchemyRpcEndpoints();
  const settings = getChainRpcSettings(chainId);
  if (!settings) return [];

  const explicitAlchemyUrls = splitEnvs(settings.alchemyUrlEnvs).filter(
    (url) => isHttpsUrl(url) && url.includes("alchemy"),
  );

  return unique([...explicitAlchemyUrls, ...getPreferredAlchemyKeyUrls(settings)]).map((url) => ({
    url,
    label: "alchemy-dedicated",
  }));
}

export function getChainRpcEndpoints(chainId: number): BaseRpcEndpoint[] {
  if (chainId === BASE_CHAIN_ID) return getBaseRpcEndpoints();
  const settings = getChainRpcSettings(chainId);
  if (!settings) return [];

  const mode = getAlchemyGenericPoolMode(settings);
  const alchemyPoolUrls = mode === "first" ? getAlchemyGenericPoolUrls(settings) : [];

  const preferred = unique(
    [...alchemyPoolUrls, ...splitEnvs(settings.rpcUrlEnvs)].filter(isHttpsUrl),
  ).map((url) => ({
    url,
    label: url.includes("alchemy") ? "alchemy" : url.includes("blockscout") ? "blockscout" : "custom",
  }));

  const withBlockscout = [...preferred, ...getBlockscoutRpcEndpoints(settings)];
  const withPublicFallback =
    process.env[settings.publicFallbackEnv] !== "0"
      ? [...withBlockscout, { url: settings.publicRpcUrl, label: "public" }]
      : withBlockscout;

  const withAlchemyBackstop =
    mode === "last"
      ? [
          ...withPublicFallback,
          ...getAlchemyGenericPoolUrls(settings)
            .filter((url) => !withPublicFallback.some((endpoint) => endpoint.url === url))
            .map((url) => ({ url, label: ALCHEMY_BACKSTOP_LABEL })),
        ]
      : withPublicFallback;

  return withAlchemyBackstop.length > 0
    ? withAlchemyBackstop
    : [{ url: settings.publicRpcUrl, label: "public" }];
}

function isSameEndpoint(a: BaseRpcEndpoint, b: BaseRpcEndpoint) {
  return (
    a.url === b.url && JSON.stringify(a.headers || {}) === JSON.stringify(b.headers || {})
  );
}

function getRotatingChainRpcEndpoint(chainId: number): BaseRpcEndpoint {
  const settings = getChainRpcSettings(chainId);
  const endpoints = getChainRpcEndpoints(chainId);
  if (endpoints.length === 1) return endpoints[0];

  const rotationPool = endpoints.filter((endpoint) => endpoint.label !== ALCHEMY_BACKSTOP_LABEL);
  const pool = rotationPool.length > 0 ? rotationPool : endpoints;
  if (pool.length === 1) return pool[0];

  const state = getRotationState(chainId);
  const endpoint = pool[state.activeIndex % pool.length];
  state.activeCalls += 1;

  const rotationCalls = getRotationCalls(
    settings ? process.env[settings.rotationCallsEnv] : undefined,
    DEFAULT_ROTATION_CALLS,
  );
  if (state.activeCalls >= rotationCalls) {
    state.activeCalls = 0;
    state.activeIndex = (state.activeIndex + 1) % pool.length;
  }

  return endpoint;
}

function getOrderedChainRpcEndpoints(chainId: number): BaseRpcEndpoint[] {
  const endpoints = getChainRpcEndpoints(chainId);
  if (endpoints.length === 0) return [];
  const first = getRotatingChainRpcEndpoint(chainId);
  return [first, ...endpoints.filter((endpoint) => !isSameEndpoint(endpoint, first))];
}

function getOrderedChainAlchemyRpcEndpoints(chainId: number): BaseRpcEndpoint[] {
  const endpoints = getChainAlchemyRpcEndpoints(chainId);
  if (endpoints.length === 0) return [];
  if (endpoints.length === 1) return endpoints;

  const state = getRotationState(chainId);
  const first = endpoints[state.alchemyActiveIndex % endpoints.length];
  state.alchemyActiveCalls += 1;
  if (state.alchemyActiveCalls >= getAlchemyRotationCalls()) {
    state.alchemyActiveCalls = 0;
    state.alchemyActiveIndex = (state.alchemyActiveIndex + 1) % endpoints.length;
  }

  return [first, ...endpoints.filter((endpoint) => !isSameEndpoint(endpoint, first))];
}

async function requestEndpoint<T>(
  endpoint: BaseRpcEndpoint,
  method: string,
  params: RpcParams,
  opts: RpcRequestOptions,
  controller: AbortController,
  defaultTimeoutMs: number,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
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
      error?: { code?: number; message?: string };
    };

    if (payload.error) {
      if (isDeterministicRpcError(payload.error)) {
        throw new RpcDeterministicError(payload.error.message || "deterministic rpc error");
      }
      throw new RpcTransportError(payload.error.message || "rpc error");
    }

    return payload.result as T;
  } finally {
    clearTimeout(timeout);
  }
}

/** Generic-pool RPC request for any supported chain. chainId 8453 delegates to baseRpc. */
export async function chainRpcRequest<T>(
  chainId: number,
  method: string,
  params: RpcParams = [],
  opts: RpcRequestOptions = {},
): Promise<T> {
  if (chainId === BASE_CHAIN_ID) {
    return baseRpcRequest<T>(method, params, opts);
  }
  if (!getChainRpcSettings(chainId)) {
    throw new RpcTransportError(`No RPC configuration for chainId ${chainId}`);
  }

  let lastTransport: Error | null = null;
  const endpoints = getOrderedChainRpcEndpoints(chainId);

  for (const endpoint of endpoints) {
    const controller = new AbortController();
    try {
      return await requestEndpoint<T>(endpoint, method, params, opts, controller, 5_000);
    } catch (err) {
      if (err instanceof RpcDeterministicError) throw err;
      if (opts.signal?.aborted) throw err;
      lastTransport = err instanceof Error ? err : new Error(String(err));
      continue;
    }
  }

  throw lastTransport ?? new Error(`Chain ${chainId} RPC request failed`);
}

/**
 * Dedicated Alchemy lane (alchemy_getTokenBalances etc.) for any supported chain, with the
 * same hedging semantics as the Base lane. Falls back to the generic pool when no keyed
 * Alchemy endpoints are configured for the chain.
 */
export async function chainAlchemyRpcRequest<T>(
  chainId: number,
  method: string,
  params: RpcParams = [],
  opts: RpcRequestOptions = {},
): Promise<T> {
  if (chainId === BASE_CHAIN_ID) {
    return alchemyRpcRequest<T>(method, params, opts);
  }

  let endpoints = getOrderedChainAlchemyRpcEndpoints(chainId);
  if (endpoints.length === 0) {
    return chainRpcRequest<T>(chainId, method, params, opts);
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
            return await requestEndpoint<T>(endpoint, method, params, opts, controller, 10_000);
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
      return await requestEndpoint<T>(endpoint, method, params, opts, controller, 10_000);
    } catch (err) {
      if (err instanceof RpcDeterministicError) throw err;
      if (opts.signal?.aborted) throw err;
      lastTransport = err instanceof Error ? err : new Error(String(err));
      continue;
    }
  }

  throw lastTransport ?? new Error(`Chain ${chainId} Alchemy RPC request failed`);
}

// Typed as any to avoid cross-package viem client incompatibilities in this workspace.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createChainPublicClient(chainId: number, timeoutMs = 20_000): any {
  if (chainId === BASE_CHAIN_ID) {
    return createBasePublicClient(timeoutMs);
  }
  const settings = getChainRpcSettings(chainId);
  if (!settings) {
    throw new Error(`No RPC configuration for chainId ${chainId}`);
  }
  return createPublicClient({
    chain: settings.chain,
    transport: custom(
      {
        async request({ method, params }: { method: string; params?: RpcParams }) {
          return chainRpcRequest(chainId, method, normalizeRpcParams(params), { timeoutMs });
        },
      },
      {
        key: `chain-${chainId}-rotating-rpc`,
        name: `Chain ${chainId} Rotating RPC`,
        retryCount: 0,
      },
    ),
  });
}
