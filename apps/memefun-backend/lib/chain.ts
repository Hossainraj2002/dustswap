import { type Chain, type EIP1193RequestFn, type Transport, BaseError, HttpRequestError, TimeoutError, createTransport, defineChain, fallback, http, shouldThrow } from "viem";
import { base, baseSepolia } from "viem/chains";
import { rateLimit } from "ponder";

import { envInt, envList, optionalEnv } from "./env";
import { createRpcPacer } from "./rpc-pacing";

export type ChainKey = "local" | "base-sepolia" | "base";

export interface ChainSettings {
  key: ChainKey;
  id: number;
  viemChain: Chain;
  rpcUrls: string[];
  /** How often Ponder polls for new blocks, in ms. Base produces 0.2 s blocks after Denim. */
  pollingIntervalMs: number;
  /** Blocks between ETH/USD price samples (30 seconds on Base after Denim). */
  priceIntervalBlocks: number;
}

export const LOCAL_CHAIN_ID = 31337;

export const localChain = defineChain({
  id: LOCAL_CHAIN_ID,
  name: "memefun local (base-anvil)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

const CHAINS: Record<ChainKey, Omit<ChainSettings, "rpcUrls">> = {
  local: { key: "local", id: LOCAL_CHAIN_ID, viemChain: localChain, pollingIntervalMs: 500, priceIntervalBlocks: 10 },
  "base-sepolia": { key: "base-sepolia", id: 84532, viemChain: baseSepolia, pollingIntervalMs: 1_000, priceIntervalBlocks: 150 },
  base: { key: "base", id: 8453, viemChain: base, pollingIntervalMs: 1_000, priceIntervalBlocks: 150 },
};

export function isChainKey(value: string): value is ChainKey {
  return value in CHAINS;
}

/**
 * The chain every process works on, from MEMEFUN_CHAIN (default `local`) and MEMEFUN_RPC_URLS.
 * Public RPCs serve normal reads; configured Alchemy URLs remain last as provider fallbacks.
 */
export function chainSettings(): ChainSettings {
  const key = optionalEnv("MEMEFUN_CHAIN") ?? "local";
  if (!isChainKey(key)) throw new Error(`MEMEFUN_CHAIN must be one of ${Object.keys(CHAINS).join(", ")}, got "${key}".`);
  const settings = CHAINS[key];
  const configured = envList("MEMEFUN_RPC_URLS");
  const defaults = key === "base"
    ? ["https://mainnet.base.org", "https://base-mainnet.public.blastapi.io", "https://base-pokt.nodies.app", "https://base.gateway.tenderly.co", "https://base-rpc.publicnode.com", "https://base.drpc.org"]
    : key === "base-sepolia" ? ["https://sepolia.base.org"] : ["http://127.0.0.1:8545"];
  const rpcUrls = key === "local" ? (configured.length > 0 ? [...new Set(configured)] : defaults) : [...new Set([
    ...configured.filter((url) => !isAlchemyUrl(url)),
    ...defaults,
    ...configured.filter(isAlchemyUrl),
  ])];
  return { ...settings, rpcUrls };
}

function isAlchemyUrl(url: string) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "alchemy.com" || hostname.endsWith(".alchemy.com") || hostname === "alchemyapi.io" || hostname.endsWith(".alchemyapi.io");
  } catch {
    return false;
  }
}

/** Ordered keeper reads/broadcasts; signing remains on the wallet's local account. */
export function keeperRpcTransport(chain: ChainSettings, timeout = 15_000) {
  return fallback(chain.rpcUrls.map((url) => http(url, { timeout })), {
    rank: false,
    shouldThrow(error) {
      // A transaction rejection needs the keeper's attention; another provider cannot fix
      // its signed fields. Keep the original error instead of replacing it with a later
      // fallback's billing error. HTTP/network failures still try the next public provider.
      const details = "details" in error && typeof error.details === "string" ? error.details : error.message;
      const transactionRejected = "code" in error && typeof error.code === "number"
        && /nonce too (?:low|high)|insufficient funds|(?:replacement )?transaction underpriced|already known|invalid sender|invalid signature|intrinsic gas too low/i.test(details);
      return shouldThrow(error) || transactionRejected;
    },
  });
}

function logRangeLimit(error: Error) {
  if (shouldThrow(error)) return false;
  const details = "details" in error ? String(error.details) : error.message;
  return /limited to (?:a )?[\d,.]+.{0,20}block|up to (?:a )?[\d,.]+.{0,20}block range|(?:max(?:imum)?|exceeds max) block range|block range (?:is )?too (?:large|wide)|block range limit exceeded|please limit the query to at most [\d,.]+ blocks|requested too many blocks|maximum allowed number of requested blocks|query returned more than \d+ results|query exceeds max results|logs matched by query exceeds limit|backend response too large|response size should not greater than|ranges over \d+ blocks are not supported|(?:try with this|this) block range.{0,20}\[0x/i.test(details);
}

function logRangeHint(error: Error): { blocks: bigint; hard: boolean } | undefined {
  const details = "details" in error ? String(error.details) : error.message;
  const count = details.match(/(?:limited to|up to|at most|ranges over) (?:a )?(\d[\d,]*)\s*blocks?/i)
    ?? details.match(/maximum block range(?: is|:)?\s*(\d[\d,]*)/i)
    ?? details.match(/maximum allowed is (\d[\d,]*) blocks/i);
  if (count) return { blocks: BigInt(count[1]!.replaceAll(",", "")), hard: true };
  const range = details.match(/\[(0x[\da-f]+),\s*(0x[\da-f]+)\]/i);
  if (range && BigInt(range[2]!) >= BigInt(range[1]!)) return { blocks: BigInt(range[2]!) - BigInt(range[1]!) + 1n, hard: false };
}

function actionableRangeError(error: Error, blocks: bigint): Error {
  const details = "details" in error ? String(error.details) : error.message;
  if (!/maximum allowed is \d[\d,]* blocks/i.test(details)) return error;
  // Keep the original response accessible without letting its unfamiliar wording hide
  // the canonical block-limit hint from Ponder's JSON-stringified retry helper.
  const normalized = new BaseError("RPC block range limit.", {
    details: `${details}\neth_getLogs is limited to ${blocks} blocks range`,
  });
  Object.defineProperty(normalized, "cause", { value: error, configurable: true });
  if ("code" in error && typeof error.code === "number") Object.assign(normalized, { code: error.code });
  return normalized;
}

function logBlockCount(request: { method: string; params?: unknown }): bigint | undefined {
  if (request.method !== "eth_getLogs" || !Array.isArray(request.params)) return;
  const filter: unknown = request.params[0];
  if (typeof filter !== "object" || filter === null || !("fromBlock" in filter) || !("toBlock" in filter)) return;
  if (typeof filter.fromBlock !== "string" || typeof filter.toBlock !== "string"
    || !/^0x[\da-f]+$/i.test(filter.fromBlock) || !/^0x[\da-f]+$/i.test(filter.toBlock)) return;
  const count = BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n;
  return count > 0n ? count : undefined;
}

function contradictoryRangeError(error: Error, request: { method: string; params?: unknown }, url: string): Error {
  if (request.method !== "eth_getLogs" || !logRangeLimit(error)) return error;
  const hint = logRangeHint(error);
  const requested = logBlockCount(request);
  if (!hint || requested === undefined || hint.blocks < requested) return error;
  // A larger/equal advertised limit cannot produce a smaller retry. Do not expose
  // its original range wording to Ponder, which could retry the same interval forever.
  const normalized = new HttpRequestError({
    body: request, url, status: 503, details: "RPC provider rejected a log query within its advertised block limit.",
  });
  Object.defineProperty(normalized, "cause", { value: error, configurable: true });
  return normalized;
}

function logAddressCount(request: { method: string; params?: unknown }): number | undefined {
  if (request.method !== "eth_getLogs" || !Array.isArray(request.params)) return;
  const filter: unknown = request.params[0];
  if (typeof filter !== "object" || filter === null || !("address" in filter)) return;
  return Array.isArray(filter.address) ? filter.address.length : typeof filter.address === "string" ? 1 : undefined;
}

function logAddressHint(error: Error): number | undefined {
  if (shouldThrow(error)) return;
  const details = "details" in error ? String(error.details) : error.message;
  const count = details.match(/(?:maximum(?: of)?|limited to|up to|at most) (?:a )?(\d[\d,]*) addresses/i);
  if (!count) return;
  const limit = Number(count[1]!.replaceAll(",", ""));
  return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

/** Ponder balances URL arrays across providers; keep its paid fallback outside that pool. */
export function chainRpcTransport(chain: ChainSettings, timeout = 10_000) {
  const fallbackOptions = { rank: false, retryCount: 0, shouldThrow };
  if (chain.key === "local") return fallback(chain.rpcUrls.map((url) => http(url, { timeout, retryCount: 0 })), {
    ...fallbackOptions, shouldThrow: (error) => shouldThrow(error) || logRangeLimit(error),
  });

  const transport: Transport = (options) => {
    const cooldowns = new Map<string, { until: number; error: Error; probing: boolean }>();
    const paidCircuits = new Map<string, { until: number; error: Error; probing: boolean }>();
    const rangeCaps = new Map<string, { until: number; blocks: bigint; error: Error }>();
    const addressCaps = new Map<string, { until: number; addresses: number; error: Error }>();
    const successfulRanges = new Map<string, { until: number; blocks: bigint }>();
    let nextPublic = 0;
    const publicUrls = chain.rpcUrls.filter((url) => !isAlchemyUrl(url));
    const paidUrls = chain.rpcUrls.filter(isAlchemyUrl);
    const pacers = new Map(publicUrls.map(url => [url, createRpcPacer()]));
    const inactivePaid = (error: Error) => {
      if (shouldThrow(error)) return false;
      const details = "details" in error ? String(error.details) : error.message;
      return (error instanceof HttpRequestError && error.status === 402)
        || /app is inactive|invalid api[- ]?key|api[- ]?key (?:is )?(?:invalid|disabled|revoked|expired)|(?:account|app|project) (?:is )?(?:disabled|suspended)|payment required|account overdue|billing.{0,40}(?:inactive|overdue|suspended|exhausted)/i.test(details);
    };
    const publicTransport = (url: string, onFailure: (error: Error) => void): Transport =>
      (parameters) => {
        const rpc = http(url, { timeout, retryCount: 0 })(parameters);
        return { ...rpc, request: (async (request, requestOptions) => {
          const key = `${url}\0${request.method}`;
          const addresses = logAddressCount(request);
          const blocks = logBlockCount(request);
          const available = () => {
            const addressCap = addressCaps.get(url);
            if (addressCap && addressCap.until > Date.now() && addresses !== undefined && addresses > addressCap.addresses) {
              onFailure(addressCap.error);
              throw addressCap.error;
            }
            const cap = rangeCaps.get(url);
            if (cap && cap.until > Date.now() && blocks !== undefined && blocks > cap.blocks) {
              onFailure(cap.error);
              throw cap.error;
            }
            const cooldown = cooldowns.get(key);
            // Rejected probes still fall through viem's normal public-first error policy.
            // Rate limits can be method-specific: a log-query limit must not disable headers.
            if (cooldown) {
              if (cooldown.until > Date.now() || cooldown.probing) {
                onFailure(cooldown.error);
                throw cooldown.error;
              }
            }
            return cooldown;
          };
          available();
          let release: () => void;
          try { release = await pacers.get(url)!.acquire(available); }
          catch (error) { if (error instanceof Error) onFailure(error); throw error; }
          try {
            // Another request may have learned a cap or cooldown while this one queued.
            const cooldown = available();
            if (cooldown) cooldown.probing = true;
            try {
              const result = await rpc.request(request, requestOptions);
              if (blocks !== undefined) {
                const shape = `${url}\0${addresses ?? "any"}`;
                const observed = successfulRanges.get(shape);
                if (!observed || observed.until <= Date.now() || blocks >= observed.blocks) {
                  successfulRanges.set(shape, { until: Date.now() + 300_000, blocks });
                }
              }
              if (cooldowns.get(key) === cooldown) cooldowns.delete(key);
              return result;
            } catch (caughtError) {
              const error = caughtError instanceof Error ? contradictoryRangeError(caughtError, request, url) : caughtError;
              if (request.method === "eth_getLogs" && error instanceof Error) {
                const addresses = logAddressHint(error);
                if (addresses !== undefined) addressCaps.set(url, { until: Date.now() + 300_000, addresses, error });
              }
              const transient = error instanceof TimeoutError || (error instanceof HttpRequestError
                && (error.status === undefined || error.status === 429 || error.status >= 500));
              const details = error instanceof Error && "details" in error ? String(error.details) : "";
              const rangeError = request.method === "eth_getLogs" && error instanceof Error && logRangeLimit(error);
              if (rangeError && error instanceof Error) {
                const hint = logRangeHint(error);
                if (hint?.hard && hint.blocks > 0n) rangeCaps.set(url, { until: Date.now() + 300_000, blocks: hint.blocks, error });
              }
              const limited = error instanceof Error && !fallbackOptions.shouldThrow(error) && !rangeError
                && "code" in error && typeof error.code === "number"
                && (error.code === 429 || /rate limit|too many requests|request limit|compute units per second/i.test(details));
              // Ponder recognizes status/code 429, not provider-specific -32011/-32005.
              // Retain the provider error as the cause while exposing its capacity signal.
              const failure = limited ? new HttpRequestError({ body: request, cause: error instanceof Error ? error : undefined, details, status: 429, url }) : error;
              if (error instanceof Error && (transient || limited)) {
                cooldowns.set(key, { until: Date.now() + 30_000, error: failure as Error, probing: false });
              } else if (cooldowns.get(key) === cooldown) cooldowns.delete(key);
              if (failure instanceof Error) onFailure(failure);
              throw failure;
            }
          } finally { release(); }
        }) as EIP1193RequestFn };
      };
    const paidTransport = (url: string, onFailure: (error: Error) => void): Transport => (parameters) => {
      const rpc = http(url, { timeout, retryCount: 0 })(parameters);
      return { ...rpc, request: (async (request, requestOptions) => {
        const circuit = paidCircuits.get(url);
        if (circuit) {
          if (circuit.until > Date.now() || circuit.probing) throw circuit.error;
          circuit.probing = true;
        }
        try {
          const result = await rpc.request(request, requestOptions);
          if (paidCircuits.get(url) === circuit) paidCircuits.delete(url);
          return result;
        } catch (caughtError) {
          const error = caughtError instanceof Error ? contradictoryRangeError(caughtError, request, url) : caughtError;
          if (error instanceof Error && inactivePaid(error)) {
            paidCircuits.set(url, { until: Date.now() + 120_000, error, probing: false });
          } else if (paidCircuits.get(url) === circuit) paidCircuits.delete(url);
          if (error instanceof Error) onFailure(error);
          throw error;
        }
      }) as EIP1193RequestFn };
    };
    return createTransport({
      key: "memefun-indexer",
      name: "MemeFun public indexer RPC pool",
      type: "fallback",
      retryCount: 0,
      request: (async (request) => {
        const start = nextPublic;
        nextPublic = (nextPublic + 1) % Math.max(1, publicUrls.length);
        let publicFailure: Error | undefined;
        let publicRangeFailure: { error: Error; blocks: bigint } | undefined;
        const publicRangeProviders = new Set<string>();
        let widerPeerFailure: { error: Error; blocks: bigint } | undefined;
        let rangeFailure: { error: Error; blocks: bigint } | undefined;
        const recordRange = (error: Error) => {
          if (request.method !== "eth_getLogs" || !logRangeLimit(error)) return false;
          const blocks = logRangeHint(error)?.blocks ?? 0n;
          const requested = logBlockCount(request);
          if (requested !== undefined && blocks >= requested) return false;
          if (!rangeFailure || blocks > rangeFailure.blocks) rangeFailure = { error, blocks };
          return true;
        };
        const priority = (error: Error) => error instanceof HttpRequestError && error.status === 429 ? 3
          : error instanceof TimeoutError ? 2
            : error instanceof HttpRequestError && (error.status === undefined || error.status === 408
              || (error.status >= 500 && error.status !== 501 && error.status !== 505)) ? 1 : 0;
        const publicTransports = publicUrls.map((url) => publicTransport(url, (error) => {
          if (recordRange(error)) {
            const hint = logRangeHint(error);
            if (hint) {
              publicRangeProviders.add(url);
              if (!publicRangeFailure || hint.blocks > publicRangeFailure.blocks) {
                publicRangeFailure = { error, blocks: hint.blocks };
              }
            }
            return;
          }
          if (priority(error) >= 2) {
            const observed = successfulRanges.get(`${url}\0${logAddressCount(request) ?? "any"}`);
            if (observed && observed.until > Date.now() && (!widerPeerFailure || observed.blocks > widerPeerFailure.blocks)) {
              widerPeerFailure = { error, blocks: observed.blocks };
            }
          }
          if (!publicFailure || priority(error) > priority(publicFailure)) publicFailure = error;
        }));
        const paidTransports = paidUrls.map((url) => paidTransport(url, recordRange));
        const rotation = publicUrls.map((_url, index) => (start + index) % publicUrls.length);
        const ready: number[] = [];
        const busy: number[] = [];
        for (const index of rotation) {
          (pacers.get(publicUrls[index]!)!.isReady() ? ready : busy).push(index);
        }
        const ordered = [...ready, ...busy].map(index => publicTransports[index]!);
        ordered.push(...paidTransports);
        try {
          return await fallback(ordered, fallbackOptions)(options).request(request);
        } catch (error) {
          // A single restrictive node must not reduce the range for the whole public pool.
          // Capacity failures mean another provider may still serve the original request.
          if (error instanceof Error && shouldThrow(error)) throw error;
          if (rangeFailure) {
            // Multiple explicit public limits establish an actionable pool range. A
            // permanently throttled peer must not prevent splitting 15k down to 10k.
            if (publicRangeProviders.size >= 2 && publicRangeFailure) {
              // A temporarily throttled peer recently proved this address-count shape
              // works at a wider range. Preserve its capacity signal until that evidence
              // expires instead of permanently pinning the native shared range lower.
              if (widerPeerFailure && widerPeerFailure.blocks > publicRangeFailure.blocks) throw widerPeerFailure.error;
              throw actionableRangeError(publicRangeFailure.error, publicRangeFailure.blocks);
            }
            if (publicFailure && priority(publicFailure) > 0) throw publicFailure;
            throw actionableRangeError(rangeFailure.error, rangeFailure.blocks);
          }
          if (publicFailure && error instanceof Error && inactivePaid(error)) throw publicFailure;
          throw error;
        }
      }) as EIP1193RequestFn,
    });
  };
  // Ponder treats this fallback as one adaptive provider and cannot see a public node's
  // throttling when a later node answers. Bound historical indexing throughput explicitly.
  // The limiter must wrap the whole fallback: viem recreates its inner transports on each
  // request, which would also recreate any limiter placed around an individual HTTP node.
  return rateLimit(transport, {
    // Base now produces five canonical blocks per second. Header reads plus historical
    // contract calls need headroom above that rate to recover a backlog, not fall behind it.
    requestsPerSecond: envInt("MEMEFUN_INDEXER_RPC_RPS", 30, { min: 1, max: 100 }),
    browser: false,
  });
}
