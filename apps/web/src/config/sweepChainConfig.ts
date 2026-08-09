import { arbitrum, base, bsc, mainnet } from "wagmi/chains";
import type { Chain } from "wagmi/chains";
import { type Address } from "viem";
import { type Token } from "@/types/dustsweep";
import { robinhood } from "./robinhoodChain";

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
export const BSC_CHAIN_ID = 56;
export const ROBINHOOD_CHAIN_ID = 4663;
export const ARBITRUM_CHAIN_ID = 42161;

const NATIVE_TOKEN_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;

export type SweepChain = {
  id: number;
  key: "base" | "ethereum" | "bsc" | "robinhood" | "arbitrum";
  label: string;
  chain: Chain;
  weth: Address;
  usdc: Address;
  /** Per-chain output token list; USDC first = the default tokenOut. */
  outputTokens: Token[];
  explorerUrl: string;
  /** Explorer brand name for UI copy ("Swept! View on …"). */
  explorerName: string;
  /** Env holding this chain's deployed DustSwapSweepRouter V3 address (the owned-lane spender). */
  routerV3Env: string;
  /** Env holding this chain's manual/auto selection cap. */
  selectLimitEnv: string;
  /** Coinbase paymaster is Base-only; never attempt it elsewhere. */
  paymasterEligible: boolean;
  /** How long to wait for approval allowances to clear before the sweep (mainnet blocks are slower). */
  approvalWaitTimeoutMs: number;
};

// ETH first = the DEFAULT output token on Base (the router swaps every input to WETH and unwraps
// to native ETH on settle). USDC remains available immediately below it.
const BASE_OUTPUT_TOKENS: Token[] = [
  {
    address: NATIVE_TOKEN_SENTINEL,
    symbol: "ETH",
    name: "Ethereum",
    decimals: 18,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
    isNative: true,
  },
  {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    logoURI: "https://basescan.org/token/images/centre-usdc_28.png",
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

// BSC gotcha: USDT/USDC are 18 DECIMALS here (unlike the 6-decimal Base/Ethereum versions).
// USDT is first (= default output) — it is by far the deepest stable on BSC. Native is BNB.
const BSC_OUTPUT_TOKENS: Token[] = [
  {
    address: "0x55d398326f99059fF775485246999027B3197955" as Address,
    symbol: "USDT",
    name: "Tether USD",
    decimals: 18,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/assets/0x55d398326f99059fF775485246999027B3197955/logo.png",
  },
  {
    address: NATIVE_TOKEN_SENTINEL,
    symbol: "BNB",
    name: "BNB",
    decimals: 18,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/info/logo.png",
    isNative: true,
  },
  {
    address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" as Address,
    symbol: "WBNB",
    name: "Wrapped BNB",
    decimals: 18,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/assets/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c/logo.png",
  },
  {
    address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" as Address,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 18,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/assets/0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d/logo.png",
  },
];

// Robinhood Chain gotchas: NO USDC/USDT/DAI exist there — the chain's USD stable is USDG
// ("Global Dollar", Paxos), 6 DECIMALS, live-verified 2026-07-26 (36k holders, $118M/day).
// The OTHER USDG-labeled token 0x0A3B…954F is a 2-holder test deploy — never list it.
// USDG is first (= default output); native is ETH (Arbitrum-stack L2, wrapped native is WETH).
const ROBINHOOD_OUTPUT_TOKENS: Token[] = [
  {
    address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address,
    symbol: "USDG",
    name: "Global Dollar",
    decimals: 6,
    logoURI: "https://assets.coingecko.com/coins/images/51281/standard/GDN_USDG_Token_200x200.png",
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
    address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address,
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
  },
];

// Arbitrum One gotchas: native gas token IS ETH (so ETH is first = the DEFAULT output, mirroring
// Base — the closest analogue: cheap L2, ETH gas, WETH passthrough). chain.usdc is NATIVE Circle
// USDC 0xaf88…5831 (6 dec), NOT the legacy bridged USDC.e 0xFF97…5CC8 — USDC.e is still fully
// sweepable as an ordinary token, it is just never a default output. The USDT slot reports
// symbol() = "USD₮0" on-chain (Tether migrated Arbitrum USDT to the USDT0 standard at the SAME
// address, still 6 decimals) — labelled here exactly as symbol() returns it so the UI never
// disagrees with what the API reads on-chain. All verified live 2026-08-07.
const ARBITRUM_OUTPUT_TOKENS: Token[] = [
  {
    address: NATIVE_TOKEN_SENTINEL,
    symbol: "ETH",
    name: "Ethereum",
    decimals: 18,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
    isNative: true,
  },
  {
    address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png",
  },
  {
    address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as Address,
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
  },
  {
    address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" as Address,
    symbol: "USD₮0",
    name: "USDT0",
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
    explorerName: "Basescan",
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
    explorerName: "Etherscan",
    routerV3Env: "NEXT_PUBLIC_DUST_SWEEP_ROUTER_V3_ADDRESS_1",
    selectLimitEnv: "NEXT_PUBLIC_DUST_SWEEP_AUTO_SELECT_LIMIT_1",
    paymasterEligible: false,
    approvalWaitTimeoutMs: 180_000,
  },
  {
    id: BSC_CHAIN_ID,
    key: "bsc",
    label: "BNB Chain",
    chain: bsc, // nativeCurrency BNB — drives wallet_addEthereumChain + native symbol display
    weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" as Address, // WBNB
    usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" as Address, // 18 decimals on BSC
    outputTokens: BSC_OUTPUT_TOKENS,
    explorerUrl: "https://bscscan.com",
    explorerName: "BscScan",
    routerV3Env: "NEXT_PUBLIC_DUST_SWEEP_ROUTER_V3_ADDRESS_56",
    selectLimitEnv: "NEXT_PUBLIC_DUST_SWEEP_AUTO_SELECT_LIMIT_56",
    paymasterEligible: false,
    approvalWaitTimeoutMs: 90_000, // ~3s blocks — Base-like cadence
  },
  {
    id: ROBINHOOD_CHAIN_ID,
    key: "robinhood",
    label: "Robinhood",
    chain: robinhood, // nativeCurrency ETH — drives wallet_addEthereumChain + native symbol
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address,
    usdc: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address, // USDG, 6 decimals
    outputTokens: ROBINHOOD_OUTPUT_TOKENS,
    explorerUrl: "https://robinhoodchain.blockscout.com",
    explorerName: "Blockscout",
    routerV3Env: "NEXT_PUBLIC_DUST_SWEEP_ROUTER_V3_ADDRESS_4663",
    selectLimitEnv: "NEXT_PUBLIC_DUST_SWEEP_AUTO_SELECT_LIMIT_4663",
    paymasterEligible: false,
    approvalWaitTimeoutMs: 90_000, // ~100ms blocks — Base-like cadence is more than enough
  },
  {
    id: ARBITRUM_CHAIN_ID,
    key: "arbitrum",
    label: "Arbitrum",
    chain: arbitrum, // nativeCurrency ETH — drives wallet_addEthereumChain + native symbol
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as Address,
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address, // native Circle USDC, 6 dec
    outputTokens: ARBITRUM_OUTPUT_TOKENS,
    explorerUrl: "https://arbiscan.io",
    explorerName: "Arbiscan",
    routerV3Env: "NEXT_PUBLIC_DUST_SWEEP_ROUTER_V3_ADDRESS_42161",
    selectLimitEnv: "NEXT_PUBLIC_DUST_SWEEP_AUTO_SELECT_LIMIT_42161",
    paymasterEligible: false,
    approvalWaitTimeoutMs: 90_000, // ~250ms blocks — Base-like cadence
  },
];

/**
 * Per-chain selection ceiling used when the chain's env is unset. Base/Ethereum/BSC keep their
 * historical behavior (no code default → fall back to the lane cap), so only Robinhood declares
 * one: a brand-new chain with thin liquidity, where 10 tokens per sweep keeps batches small and
 * predictable. This is a HARD cap on Auto, "Select all" AND manual adds (see useDustSweep).
 *
 * Arbitrum declares 10 for the same reason as Robinhood: small, predictable 7702 batches. This
 * MUST stay in sync with routeMaxCap in apps/api/src/config/sweepChains.ts (also 10) — the server
 * value is the authoritative cap returned to the UI as quote.routeMaxCap, and a mismatch would let
 * the UI offer more tokens than a sweep can actually carry.
 */
const DEFAULT_SELECT_LIMIT_BY_CHAIN: Record<number, number> = {
  [ROBINHOOD_CHAIN_ID]: 10,
  [ARBITRUM_CHAIN_ID]: 10,
};

// NEXT_PUBLIC_* envs are inlined at build time, so read them explicitly (not via a dynamic key).
function readSelectLimit(chainId: number): number | null {
  const raw =
    chainId === ETHEREUM_CHAIN_ID
      ? process.env.NEXT_PUBLIC_DUST_SWEEP_AUTO_SELECT_LIMIT_1
      : chainId === BSC_CHAIN_ID
        ? process.env.NEXT_PUBLIC_DUST_SWEEP_AUTO_SELECT_LIMIT_56
        : chainId === ROBINHOOD_CHAIN_ID
          ? process.env.NEXT_PUBLIC_DUST_SWEEP_AUTO_SELECT_LIMIT_4663
          : chainId === ARBITRUM_CHAIN_ID
            ? process.env.NEXT_PUBLIC_DUST_SWEEP_AUTO_SELECT_LIMIT_42161
            : process.env.NEXT_PUBLIC_DUST_SWEEP_AUTO_SELECT_LIMIT;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return DEFAULT_SELECT_LIMIT_BY_CHAIN[chainId] ?? null;
}

function readRouterV3(chainId: number): Address | null {
  const raw =
    chainId === ETHEREUM_CHAIN_ID
      ? process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER_V3_ADDRESS_1
      : chainId === BSC_CHAIN_ID
        ? process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER_V3_ADDRESS_56
        : chainId === ROBINHOOD_CHAIN_ID
          ? process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER_V3_ADDRESS_4663
          : chainId === ARBITRUM_CHAIN_ID
            ? process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER_V3_ADDRESS_42161
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
