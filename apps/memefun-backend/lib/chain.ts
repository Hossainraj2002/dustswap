import { type Chain, type EIP1193RequestFn, type Transport, HttpRequestError, TimeoutError, createTransport, defineChain, fallback, http, shouldThrow } from "viem";
import { base, baseSepolia } from "viem/chains";
import { rateLimit } from "ponder";

import { envInt, envList, optionalEnv } from "./env";

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
    ? ["https://mainnet.base.org", "https://base-mainnet.public.blastapi.io", "https://base-pokt.nodies.app", "https://base.gateway.tenderly.co"]
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

/** Ponder balances URL arrays across providers; keep its paid fallback outside that pool. */
export function chainRpcTransport(chain: ChainSettings, timeout = 10_000) {
  const fallbackOptions = {
    rank: false,
    retryCount: 0,
    shouldThrow(error: Error) {
      // Ponder splits eth_getLogs into smaller ranges using the provider's original error.
      // Do not replace that useful limit with an expired fallback key's unrelated error.
      // Match range limits Ponder recognizes; unavailable archive state still fails over.
      const details = "details" in error ? String(error.details) : error.message;
      const rangeLimit = /limited to (?:a )?[\d,.]+.{0,20}block|(?:max(?:imum)?|exceeds max) block range|block range (?:is )?too (?:large|wide)|block range limit exceeded|please limit the query to at most [\d,.]+ blocks|requested too many blocks|maximum allowed number of requested blocks|query returned more than \d+ results|query exceeds max results|logs matched by query exceeds limit|backend response too large|response size should not greater than|ranges over \d+ blocks are not supported|(?:try with this|this) block range.{0,20}\[0x/i;
      return shouldThrow(error) || rangeLimit.test(details);
    },
  };
  if (chain.key === "local") return fallback(chain.rpcUrls.map((url) => http(url, { timeout, retryCount: 0 })), fallbackOptions);

  const transport: Transport = (options) => {
    const cooldowns = new Map<string, { until: number; error: Error; probing: boolean }>();
    let nextPublic = 0;
    const publicTransports: Transport[] = [];
    const paidTransports: Transport[] = [];
    for (const url of chain.rpcUrls) {
      if (isAlchemyUrl(url)) {
        paidTransports.push(http(url, { timeout, retryCount: 0 }));
        continue;
      }
      publicTransports.push((parameters) => {
        const rpc = http(url, { timeout, retryCount: 0 })(parameters);
        return { ...rpc, request: (async (request, requestOptions) => {
          const cooldown = cooldowns.get(url);
          // Rejected probes still fall through viem's normal public-first error policy.
          // Only one request probes an expired cooldown; other requests use healthy peers.
          if (cooldown) {
            if (cooldown.until > Date.now() || cooldown.probing) throw cooldown.error;
            cooldown.probing = true;
          }
          try {
            const result = await rpc.request(request, requestOptions);
            if (cooldowns.get(url) === cooldown) cooldowns.delete(url);
            return result;
          } catch (error) {
            const transient = error instanceof TimeoutError || (error instanceof HttpRequestError
              && (error.status === undefined || error.status === 429 || error.status >= 500));
            const details = error instanceof Error && "details" in error ? String(error.details) : "";
            const limited = error instanceof Error && "code" in error && typeof error.code === "number"
              && /rate limit|too many requests|request limit|compute units per second/i.test(details);
            if (error instanceof Error && (transient || limited)) {
              cooldowns.set(url, { until: Date.now() + 30_000, error, probing: false });
            } else if (cooldowns.get(url) === cooldown) cooldowns.delete(url);
            throw error;
          }
        }) as EIP1193RequestFn };
      });
    }
    return createTransport({
      key: "memefun-indexer",
      name: "MemeFun public indexer RPC pool",
      type: "fallback",
      retryCount: 0,
      request: ((request) => {
        const start = nextPublic;
        nextPublic = (nextPublic + 1) % Math.max(1, publicTransports.length);
        const ordered = [...publicTransports.slice(start), ...publicTransports.slice(0, start), ...paidTransports];
        return fallback(ordered, fallbackOptions)(options).request(request);
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
