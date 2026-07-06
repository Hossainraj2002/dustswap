import { base, mainnet } from "wagmi/chains";
import type { Chain } from "wagmi/chains";
import { type Address } from "viem";
import { type Token } from "@/types/dustsweep";

/**
 * Frontend per-chain sweep configuration for DustSweep.
 *
 * ADDITIVE + NON-BREAKING: chainId 8453 (Base) reproduces every value the hook uses today, so the
 * Base sweep flow is unchanged. Ethereum mainnet (chainId 1) is fully described here and is only
 * ever reachable when NEXT_PUBLIC_DUST_SWEEP_ENABLED_CHAINS lists it (default: Base only → the
 * chain selector is hidden and the hook stays pinned to Base).
 */

export const BASE_CHAIN_ID = 8453;
export const ETHEREUM_CHAIN_ID = 1;

const NATIVE_TOKEN_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;

export type SweepChain = {
  id: number;
  key: "base" | "ethereum";
  label: string;
  chain: Chain;
  weth: Address;
  usdc: Address;
  /** Per-chain output token list; USDC first = the default tokenOut. */
  outputTokens: Token[];
  explorerUrl: string;
  /** Env holding this chain's deployed DustSwapSweepRouter V3 address (the owned-lane spender). */
  routerV3Env: string;
  /** Env holding this chain's manual/auto selection cap. */
  selectLimitEnv: string;
  /** Coinbase paymaster is Base-only; never attempt it elsewhere. */
  paymasterEligible: boolean;
  /** How long to wait for approval allowances to clear before the sweep (mainnet blocks are slower). */
  approvalWaitTimeoutMs: number;
};

const BASE_OUTPUT_TOKENS: Token[] = [
  {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    logoURI: "https://basescan.org/token/images/centre-usdc_28.png",
  },
  {
    address: NATIVE_TOKEN_SENTINEL,
    symbol: "ETH",
    name: "Ethereum",
    decimals: 18,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
    isNative: true,
  },
  {
    address: "0x4200000000000000000000000000000000000006" as Address,
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
  },
  {
    address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" as Address,
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png",
  },
];

const ETHEREUM_OUTPUT_TOKENS: Token[] = [
  {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png",
  },
  {
    address: NATIVE_TOKEN_SENTINEL,
    symbol: "ETH",
    name: "Ethereum",
    decimals: 18,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
    isNative: true,
  },
  {
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address,
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
  },
  {
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Address,
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png",
  },
];

export const SWEEP_CHAINS: SweepChain[] = [
  {
    id: BASE_CHAIN_ID,
    key: "base",
    label: "Base",
    chain: base,
    weth: "0x4200000000000000000000000000000000000006" as Address,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
    outputTokens: BASE_OUTPUT_TOKENS,
    explorerUrl: "https://basescan.org",
    routerV3Env: "NEXT_PUBLIC_DUST_SWEEP_ROUTER_V3_ADDRESS",
    selectLimitEnv: "NEXT_PUBLIC_DUST_SWEEP_AUTO_SELECT_LIMIT",
    paymasterEligible: true,
    approvalWaitTimeoutMs: 90_000,
  },
  {
    id: ETHEREUM_CHAIN_ID,
    key: "ethereum",
    label: "Ethereum",
    chain: mainnet,
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address,
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
    outputTokens: ETHEREUM_OUTPUT_TOKENS,
    explorerUrl: "https://etherscan.io",
    routerV3Env: "NEXT_PUBLIC_DUST_SWEEP_ROUTER_V3_ADDRESS_1",
    selectLimitEnv: "NEXT_PUBLIC_DUST_SWEEP_AUTO_SELECT_LIMIT_1",
    paymasterEligible: false,
    approvalWaitTimeoutMs: 180_000,
  },
];

// NEXT_PUBLIC_* envs are inlined at build time, so read them explicitly (not via a dynamic key).
function readSelectLimit(chainId: number): number | null {
  const raw =
    chainId === ETHEREUM_CHAIN_ID
      ? process.env.NEXT_PUBLIC_DUST_SWEEP_AUTO_SELECT_LIMIT_1
      : process.env.NEXT_PUBLIC_DUST_SWEEP_AUTO_SELECT_LIMIT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function readRouterV3(chainId: number): Address | null {
  const raw =
    chainId === ETHEREUM_CHAIN_ID
      ? process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER_V3_ADDRESS_1
      : process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER_V3_ADDRESS;
  return raw && /^0x[0-9a-fA-F]{40}$/.test(raw) ? (raw as Address) : null;
}

export function getSweepSelectLimit(chainId: number): number | null {
  return readSelectLimit(chainId);
}

export function getSweepRouterV3(chainId: number): Address | null {
  return readRouterV3(chainId);
}

export function getEnabledSweepChainIds(): number[] {
  const raw = String(process.env.NEXT_PUBLIC_DUST_SWEEP_ENABLED_CHAINS || String(BASE_CHAIN_ID));
  const ids = raw
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((id) => SWEEP_CHAINS.some((chain) => chain.id === id));
  return ids.length > 0 ? Array.from(new Set(ids)) : [BASE_CHAIN_ID];
}

export function getEnabledSweepChains(): SweepChain[] {
  const enabled = getEnabledSweepChainIds();
  return SWEEP_CHAINS.filter((chain) => enabled.includes(chain.id));
}

/** Resolve a sweep chain by id, falling back to Base. */
export function getSweepChain(chainId: number): SweepChain {
  return SWEEP_CHAINS.find((chain) => chain.id === chainId) ?? SWEEP_CHAINS[0]!;
}

/** Gas-to-basket warn threshold (fraction). Above this, the UI flags the sweep as gas-heavy. */
export function getGasWarnRatio(): number {
  const parsed = Number(process.env.NEXT_PUBLIC_DUST_SWEEP_GAS_WARN_RATIO);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.25;
}
