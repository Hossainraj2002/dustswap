import { type Chain, defineChain, fallback, http, shouldThrow } from "viem";
import { base, baseSepolia } from "viem/chains";

import { envList, optionalEnv } from "./env";

export type ChainKey = "local" | "base-sepolia" | "base";

export interface ChainSettings {
  key: ChainKey;
  id: number;
  viemChain: Chain;
  rpcUrls: string[];
  /** How often Ponder polls for new blocks, in ms. Base makes a block every 2 s. */
  pollingIntervalMs: number;
  /** Blocks between ETH/USD price samples (about 5 minutes on Base). */
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

/** Ponder balances URL arrays across providers; a transport enforces ordered failover instead. */
export function chainRpcTransport(chain: ChainSettings, timeout = 10_000) {
  return fallback(chain.rpcUrls.map((url) => http(url, { timeout, retryCount: 0 })), {
    rank: false,
    retryCount: 0,
    shouldThrow(error) {
      // Ponder splits eth_getLogs into smaller ranges using the provider's original error.
      // Do not replace that useful limit with an expired fallback key's unrelated error.
      // Match range limits Ponder recognizes; unavailable archive state still fails over.
      const details = "details" in error ? String(error.details) : error.message;
      const rangeLimit = /limited to (?:a )?[\d,.]+.{0,20}block|(?:max(?:imum)?|exceeds max) block range|block range (?:is )?too (?:large|wide)|block range limit exceeded|please limit the query to at most [\d,.]+ blocks|requested too many blocks|maximum allowed number of requested blocks|query returned more than \d+ results|query exceeds max results|logs matched by query exceeds limit|backend response too large|response size should not greater than|ranges over \d+ blocks are not supported|(?:try with this|this) block range.{0,20}\[0x/i;
      return shouldThrow(error) || rangeLimit.test(details);
    },
  });
}
