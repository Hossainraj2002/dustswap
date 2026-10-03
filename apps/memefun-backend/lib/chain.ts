import { type Chain, defineChain } from "viem";
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
 * Public RPCs are refused on Base mainnet: indexing and keepers must use the paid endpoints.
 */
export function chainSettings(): ChainSettings {
  const key = optionalEnv("MEMEFUN_CHAIN") ?? "local";
  if (!isChainKey(key)) throw new Error(`MEMEFUN_CHAIN must be one of ${Object.keys(CHAINS).join(", ")}, got "${key}".`);
  const settings = CHAINS[key];
  const rpcUrls = envList("MEMEFUN_RPC_URLS");
  if (rpcUrls.length === 0) {
    if (key !== "local") throw new Error(`MEMEFUN_RPC_URLS is required for ${key}.`);
    rpcUrls.push("http://127.0.0.1:8545");
  }
  if (key === "base" && rpcUrls.some((url) => /mainnet\.base\.org/i.test(url))) {
    throw new Error("Base mainnet indexing must not use the public mainnet.base.org RPC; use the paid endpoints.");
  }
  return { ...settings, rpcUrls };
}
