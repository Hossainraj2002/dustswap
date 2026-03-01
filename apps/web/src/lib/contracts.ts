// apps/web/src/lib/contracts.ts

// ─── Chain Configuration ───────────────────────────────────────────────────────

export const BASE_CHAIN = {
  chainId: 8453,
  name: "Base",
  network: "base",
  rpcUrl: process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org",
  blockExplorer: "https://basescan.org",
  nativeCurrency: {
    name: "Ether",
    symbol: "ETH",
    decimals: 18,
  },
} as const;

// ─── DustSwap Deployed Contract Addresses ──────────────────────────────────────

export const DUSTSWAP_CONTRACTS = {
  DustSweepRouter: process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER_ADDRESS as `0x${string}`,
  BurnVault: process.env.NEXT_PUBLIC_BURN_VAULT_ADDRESS as `0x${string}`,
  FeeCollector: process.env.NEXT_PUBLIC_FEE_COLLECTOR_ADDRESS as `0x${string}`,
} as const;

// ─── Uniswap V3 Addresses on Base Mainnet ─────────────────────────────────────

export const UNISWAP_V3 = {
  SwapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481" as `0x${string}`,
  QuoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as `0x${string}`,
  Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as `0x${string}`,
} as const;

// ─── Common Token Addresses on Base Mainnet ────────────────────────────────────

export interface TokenInfo {
  address: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
}

export const COMMON_TOKENS: Record<string, TokenInfo> = {
  WETH: {
    address: "0x4200000000000000000000000000000000000006",
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    logoURI: "/tokens/weth.png",
  },
  USDC: {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    logoURI: "/tokens/usdc.png",
  },
  DAI: {
    address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
    symbol: "DAI",
    name: "Dai Stablecoin",
    decimals: 18,
    logoURI: "/tokens/dai.png",
  },
} as const;

// ─── Fee Constants (must match on-chain values) ────────────────────────────────

export const FEES = {
  /** Fee deducted from each token during sweepDust / sweepDustToETH (2%) */
  DUST_SWEEP_FEE_BPS: 200,

  /** Fee deducted on singleSwap (0.1%) */
  SWAP_FEE_BPS: 10,

  /** Tax deducted when reclaiming a burned token from BurnVault (10%) */
  RECLAIM_TAX_BPS: 1000,

  /** Basis-point denominator */
  BPS_DENOMINATOR: 10_000,
} as const;

// ─── Uniswap V3 Pool Fee Tiers ────────────────────────────────────────────────

export const POOL_FEES = {
  LOWEST: 100,   // 0.01%
  LOW: 500,      // 0.05%
  MEDIUM: 3000,  // 0.30%
  HIGH: 10000,   // 1.00%
} as const;

export type PoolFee = (typeof POOL_FEES)[keyof typeof POOL_FEES];

// ─── Helper: get explorer link ─────────────────────────────────────────────────

export function explorerTxUrl(txHash: string): string {
  return `${BASE_CHAIN.blockExplorer}/tx/${txHash}`;
}

export function explorerAddressUrl(address: string): string {
  return `${BASE_CHAIN.blockExplorer}/address/${address}`;
}

export function explorerTokenUrl(address: string): string {
  return `${BASE_CHAIN.blockExplorer}/token/${address}`;
}