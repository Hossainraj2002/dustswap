import { type Chain, defineChain } from "viem";
import { base, baseSepolia } from "viem/chains";
import { BASE_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID } from "@/core/constants";

/**
 * The one chain this build of memefun runs on. NEXT_PUBLIC_MEMEFUN_CHAIN_ID picks it: 8453 Base
 * (the default), 84532 Base Sepolia, or 31337 for a local base-anvil (development only). Every
 * "switch network" prompt, explorer link and transaction targets it.
 */
export const LOCAL_CHAIN_ID = 31337;

const localChain = defineChain({
  id: LOCAL_CHAIN_ID,
  name: "Local chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_MEMEFUN_LOCAL_RPC_URL || "http://127.0.0.1:8545"] } },
  testnet: true,
});

const CHAINS: Record<number, Chain> = {
  [BASE_CHAIN_ID]: base,
  [BASE_SEPOLIA_CHAIN_ID]: baseSepolia,
  [LOCAL_CHAIN_ID]: localChain,
};

function parseChainId(value: string | undefined): number {
  const id = Number(value?.trim() || BASE_CHAIN_ID);
  return CHAINS[id] ? id : BASE_CHAIN_ID;
}

export const TARGET_CHAIN_ID = parseChainId(process.env.NEXT_PUBLIC_MEMEFUN_CHAIN_ID);
export const TARGET_CHAIN: Chain = CHAINS[TARGET_CHAIN_ID] ?? base;
export const IS_TESTNET = TARGET_CHAIN_ID !== BASE_CHAIN_ID;

/** "Base", "Base Sepolia" or "Local chain", for "Switch to ..." prompts. */
export const CHAIN_NAME = TARGET_CHAIN_ID === BASE_CHAIN_ID ? "Base" : TARGET_CHAIN.name;

const EXPLORERS: Record<number, string> = {
  [BASE_CHAIN_ID]: "https://basescan.org",
  [BASE_SEPOLIA_CHAIN_ID]: "https://sepolia.basescan.org",
};

/** Basescan link for a token, address or transaction; null on a local chain. */
export function explorerUrl(kind: "token" | "address" | "tx", value: string): string | null {
  const root = EXPLORERS[TARGET_CHAIN_ID];
  return root ? `${root}/${kind}/${value}` : null;
}
