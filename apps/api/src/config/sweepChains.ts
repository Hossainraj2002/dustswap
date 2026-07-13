import { isAddress, type Address } from "viem";
import {
  BSC_WBNB_ADDRESS,
  ETHEREUM_WETH_ADDRESS,
  PERMIT2_ADDRESS,
  WETH_ADDRESS as BASE_WETH_ADDRESS,
  getDustSweepV3TargetsForChain,
} from "./dustsweepV3Sources";

/**
 * Per-chain sweep configuration registry.
 *
 * ADDITIVE + NON-BREAKING: chainId 8453 (Base) keeps every existing constant/env exactly as
 * `dustsweep.ts` reads them today, so the Base path is byte-identical. Ethereum mainnet (chainId
 * 1) is described entirely by its own entry and is gated behind DUST_SWEEP_ENABLED_CHAIN_IDS.
 *
 * The `dustsweep.ts` request handlers resolve ONE `SweepChainConfig` per request and pass it to
 * the ~20 quote/discovery/build functions on the request path. Every such function keeps
 * `chain = BASE_CONFIG` as a default parameter, so any un-threaded call site behaves as before.
 */

export const BASE_CHAIN_ID = 8453;
export const ETHEREUM_CHAIN_ID = 1;
export const BSC_CHAIN_ID = 56;

export const NATIVE_TOKEN_SENTINEL =
  "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;

/** Native DEX adapter selector — which on-chain quoter/router pair to probe on this chain. */
export type NativeSourceKind =
  | "uniswap_v3" // exactInput/exactInputSingle via QuoterV2
  | "pancake_v3" // same QuoterV2 quote shape, but routes build against the Pancake SmartRouter ABI
  | "univ2"; // getAmountsOut via a UniswapV2Router02-compatible router

export type NativeSourceSpec = {
  kind: NativeSourceKind;
  dexName: string;
  /** The router the sweep executes against (also the ERC-20 spender for UniV2/self routers). */
  router: Address;
  /** Read-only quoter for uniswap_v3; UniV2 quotes off the router itself. */
  quoter?: Address;
  factory?: Address;
  feeTiers?: readonly number[];
};

export type SweepGasModel = {
  baseUnits: number;
  perRouteUnits: number;
} | null;

export type AggregatorEnableFlags = {
  kyber: boolean;
  zerox: boolean;
  lifi: boolean;
  openocean: boolean;
  odos: boolean;
};

export type SweepChainConfig = {
  chainId: number;
  slug: "base" | "ethereum" | "bsc";
  name: string;
  explorerUrl: string;

  // ── tokens ──
  weth: Address;
  usdc: Address;
  usdt: Address;
  dai: Address;
  wbtc: Address;
  /** Extra chain-native stables treated as safe output/whitelist (Base: USDbC). */
  extraStables: Address[];
  /**
   * Decimals of this chain's USDC. Base/Ethereum USDC is 6, but BSC's Binance-Peg USDC is 18 —
   * used wherever code would otherwise assume the 6-decimal convention.
   */
  usdcDecimals: number;

  // ── execution ──
  /** Env name that holds this chain's DustSwapSweepRouter V3 address. */
  routerV3Env: string;
  /** ETH is V3-only; Base still supports V1/V2 legacy lanes. */
  supportsLegacyLanes: boolean;
  /**
   * Whether this chain's deployed router supports WETH-as-passthrough (tokenIn == output token,
   * e.g. WETH swept into native ETH through the router). Requires the upgraded V3 contract. When
   * true, WETH is a first-class sweepable input; when false (Base, old contract), WETH stays
   * hidden and WETH->ETH uses the wallet-side unwrap.
   */
  supportsWethPassthrough: boolean;
  /** Server-side hard cap on tokens per sweep (min'd with the lane cap). */
  routeMaxCap: number;

  // ── discovery / economics ──
  /** Minimum per-token USD value to surface in discovery. */
  minValueUsd: number;
  /** null = use the legacy hardcoded Base gas display (zero behavior change on Base). */
  gasModel: SweepGasModel;

  // ── external service slugs ──
  kyberSlug: string; // kyberswap URL path segment
  openOceanSlug: string; // openocean v4/<slug>/swap
  dexscreenerSlug: string; // dexscreener tokens/v1/<slug>
  /** Default OpenOcean gasPrice hint in gwei for this chain. */
  openOceanGasPriceGwei: number;

  // ── aggregators ──
  aggregators: AggregatorEnableFlags;
  /** Env name that holds this chain's comma-separated aggregator target/spender allowlist. */
  allowedAggregatorTargetsEnv: string;

  // ── native DEX quoting ──
  /** null → use the existing Base native task list in getNativeQuoteCandidates (unchanged). */
  nativeSources: NativeSourceSpec[] | null;
};

function envAddress(name: string): Address {
  const value = process.env[name];
  return value && isAddress(value)
    ? (value as Address)
    : ("0x0000000000000000000000000000000000000000" as Address);
}

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes"].includes(raw.toLowerCase());
}

// ── Base (8453) ──────────────────────────────────────────────────────────────
// gasModel is null and nativeSources is null so the existing Base code paths run verbatim.
export const BASE_CONFIG: SweepChainConfig = {
  chainId: BASE_CHAIN_ID,
  slug: "base",
  name: "Base",
  explorerUrl: "https://basescan.org",
  weth: BASE_WETH_ADDRESS,
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
  usdt: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" as Address,
  dai: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" as Address,
  wbtc: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c" as Address,
  extraStables: ["0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA" as Address], // USDbC
  usdcDecimals: 6,
  routerV3Env: "DUST_SWEEP_ROUTER_V3_ADDRESS",
  supportsLegacyLanes: true,
  // Base still runs the ORIGINAL V3 contract (no passthrough) — keep WETH hidden + wallet-side unwrap.
  supportsWethPassthrough: false,
  routeMaxCap: 50,
  minValueUsd: Number(process.env.DUST_SWEEP_MIN_VALUE_USD || "0.01"),
  gasModel: null,
  kyberSlug: "base",
  openOceanSlug: "base",
  dexscreenerSlug: "base",
  openOceanGasPriceGwei: numberEnv("DUST_SWEEP_OPENOCEAN_GAS_PRICE_GWEI", 0.05, 0.001, 500),
  aggregators: {
    kyber: false, // resolved via existing kyberEnabled() gate on Base — see dustsweep.ts
    zerox: false,
    lifi: false,
    openocean: false,
    odos: false,
  },
  allowedAggregatorTargetsEnv: "DUST_SWEEP_ALLOWED_AGGREGATOR_TARGETS",
  nativeSources: null,
};

// ── Ethereum mainnet (1) ─────────────────────────────────────────────────────
// Native ladder: Uniswap V3 (deepest native liquidity) + Uniswap V2 + SushiSwap V2. Everything
// else on mainnet (Curve, Balancer, Pancake, Fluid, …) is reached via the aggregator rescue path.
// All addresses re-verified live via eth_getCode before enabling (see runbook).
function ethereumConfig(): SweepChainConfig {
  return {
    chainId: ETHEREUM_CHAIN_ID,
    slug: "ethereum",
    name: "Ethereum",
    explorerUrl: "https://etherscan.io",
    weth: ETHEREUM_WETH_ADDRESS,
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
    usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Address,
    dai: "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address,
    wbtc: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as Address,
    extraStables: [],
    usdcDecimals: 6,
    routerV3Env: "DUST_SWEEP_ROUTER_V3_ADDRESS_1",
    supportsLegacyLanes: false,
    // Ethereum deploys the UPGRADED V3 contract with WETH passthrough — WETH is first-class here.
    // Off until the passthrough-capable router is deployed (env override for staged rollout).
    supportsWethPassthrough: boolEnv("DUST_SWEEP_WETH_PASSTHROUGH_1", true),
    routeMaxCap: numberEnv("DUST_SWEEP_ROUTE_MAX_CAP_1", 15, 1, 50),
    minValueUsd: numberEnv("DUST_SWEEP_MIN_VALUE_USD_1", 1.0, 0, 1_000),
    gasModel: {
      baseUnits: numberEnv("DUST_SWEEP_GAS_UNITS_BASE_1", 120_000, 21_000, 5_000_000),
      perRouteUnits: numberEnv("DUST_SWEEP_GAS_UNITS_PER_ROUTE_1", 180_000, 21_000, 2_000_000),
    },
    kyberSlug: "ethereum",
    openOceanSlug: "eth",
    dexscreenerSlug: "ethereum",
    openOceanGasPriceGwei: numberEnv("DUST_SWEEP_OPENOCEAN_GAS_PRICE_GWEI_1", 1, 0.001, 5_000),
    aggregators: {
      kyber: boolEnv("DUST_SWEEP_ENABLE_KYBER_1", true),
      zerox: boolEnv("DUST_SWEEP_ENABLE_ZEROX_1", true),
      lifi: boolEnv("DUST_SWEEP_ENABLE_LIFI_1", true),
      openocean: boolEnv("DUST_SWEEP_ENABLE_OPENOCEAN_1", false),
      odos: boolEnv("DUST_SWEEP_ENABLE_ODOS_1", true),
    },
    allowedAggregatorTargetsEnv: "DUST_SWEEP_ALLOWED_AGGREGATOR_TARGETS_1",
    // Native ladder on Ethereum: Uniswap V3 (concentrated liquidity) + Uniswap V2 + SushiSwap
    // (UniswapV2 clones, via the chain-agnostic UNIV2_GENERIC calldata builder). These are the
    // deepest Uniswap-family venues. EVERYTHING else on mainnet — Curve, Balancer, PancakeSwap,
    // DODO, Fluid, Maverick, Pendle, Frax, +100 more — is reached (and price-optimized across) by
    // the aggregator rescue path (Kyber / 0x / LI.FI), whose calldata is returned by the aggregator
    // API and executed through the allowlisted aggregator routers. No per-DEX builder needed.
    nativeSources: [
      {
        kind: "uniswap_v3",
        dexName: "Uniswap V3",
        // SwapRouter02 (self-spender), QuoterV2, v3 factory — mainnet. *_1 env overrides allowed.
        router:
          process.env.UNISWAP_V3_SWAP_ROUTER_ADDRESS_1 &&
          isAddress(process.env.UNISWAP_V3_SWAP_ROUTER_ADDRESS_1)
            ? (process.env.UNISWAP_V3_SWAP_ROUTER_ADDRESS_1 as Address)
            : ("0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" as Address),
        quoter:
          process.env.UNISWAP_V3_QUOTER_ADDRESS_1 &&
          isAddress(process.env.UNISWAP_V3_QUOTER_ADDRESS_1)
            ? (process.env.UNISWAP_V3_QUOTER_ADDRESS_1 as Address)
            : ("0x61fFE014bA17989E743c5F6cB21bF9697530B21e" as Address),
        factory:
          process.env.UNISWAP_V3_FACTORY_ADDRESS_1 &&
          isAddress(process.env.UNISWAP_V3_FACTORY_ADDRESS_1)
            ? (process.env.UNISWAP_V3_FACTORY_ADDRESS_1 as Address)
            : ("0x1F98431c8aD98523631AE4a59f267346ea31F984" as Address),
        feeTiers: [500, 3000, 10000, 100],
      },
      {
        kind: "univ2",
        dexName: "Uniswap V2",
        router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" as Address,
        factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f" as Address,
      },
      {
        kind: "univ2",
        dexName: "SushiSwap",
        router: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F" as Address,
        factory: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac" as Address,
      },
    ],
  };
}

// ── BNB Smart Chain (56) ─────────────────────────────────────────────────────
// Native ladder (top venues by real 24h volume, DeFiLlama 2026-07-10): PancakeSwap V3 ($253M) +
// PancakeSwap V2 ($30M) + Uniswap V3 on BSC ($24.7M) + Biswap (UniV2, quotes competitively).
// Everything else on BSC — ApeSwap, BakerySwap, MDEX, THENA, DODO, Wombat, +more — is reached
// (and price-optimized across) by the aggregator rescue path (Kyber / 0x / LI.FI). All addresses
// verified live 2026-07-10 via eth_getCode + functional quote probes (see dustsweepV3Sources.ts).
//
// BSC gotchas encoded here:
//   - native token is BNB, NOT ETH → dustsweep.ts prices gas + the WBNB hint via
//     fetchNativeUsdPrice(chain), never fetchEthUsdPrice() directly.
//   - USDT/USDC/DAI are ALL 18 decimals on BSC (usdcDecimals: 18).
//   - weth = WBNB (wrapped native). Binance-Peg WETH 0x2170…33F8 is just a normal bridged ERC20.
function bscConfig(): SweepChainConfig {
  return {
    chainId: BSC_CHAIN_ID,
    slug: "bsc",
    name: "BNB Smart Chain",
    explorerUrl: "https://bscscan.com",
    weth: BSC_WBNB_ADDRESS,
    usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" as Address, // 18 decimals (Binance-Peg)
    usdt: "0x55d398326f99059fF775485246999027B3197955" as Address, // 18 decimals
    dai: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3" as Address, // 18 decimals
    wbtc: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c" as Address, // BTCB, 18 decimals
    extraStables: [], // BUSD is deprecated — deliberately excluded
    usdcDecimals: 18,
    routerV3Env: "DUST_SWEEP_ROUTER_V3_ADDRESS_56",
    supportsLegacyLanes: false,
    // BSC deploys the UPGRADED V3 contract (same source as Ethereum's) — WBNB is a first-class
    // sweepable input that unwraps to BNB via the router passthrough leg.
    supportsWethPassthrough: boolEnv("DUST_SWEEP_WETH_PASSTHROUGH_56", true),
    routeMaxCap: numberEnv("DUST_SWEEP_ROUTE_MAX_CAP_56", 10, 1, 50),
    minValueUsd: numberEnv("DUST_SWEEP_MIN_VALUE_USD_56", 0.1, 0, 1_000),
    gasModel: {
      baseUnits: numberEnv("DUST_SWEEP_GAS_UNITS_BASE_56", 120_000, 21_000, 5_000_000),
      perRouteUnits: numberEnv("DUST_SWEEP_GAS_UNITS_PER_ROUTE_56", 180_000, 21_000, 2_000_000),
    },
    kyberSlug: "bsc",
    openOceanSlug: "bsc",
    dexscreenerSlug: "bsc",
    openOceanGasPriceGwei: numberEnv("DUST_SWEEP_OPENOCEAN_GAS_PRICE_GWEI_56", 1, 0.001, 5_000),
    aggregators: {
      kyber: boolEnv("DUST_SWEEP_ENABLE_KYBER_56", true),
      zerox: boolEnv("DUST_SWEEP_ENABLE_ZEROX_56", true),
      lifi: boolEnv("DUST_SWEEP_ENABLE_LIFI_56", true),
      openocean: boolEnv("DUST_SWEEP_ENABLE_OPENOCEAN_56", false),
      odos: boolEnv("DUST_SWEEP_ENABLE_ODOS_56", false),
    },
    allowedAggregatorTargetsEnv: "DUST_SWEEP_ALLOWED_AGGREGATOR_TARGETS_56",
    nativeSources: [
      {
        kind: "pancake_v3",
        dexName: "PancakeSwap V3",
        // SmartRouter (self-spender), QuoterV2, v3 factory — BSC. *_56 env overrides allowed.
        router:
          process.env.PANCAKE_V3_SWAP_ROUTER_ADDRESS_56 &&
          isAddress(process.env.PANCAKE_V3_SWAP_ROUTER_ADDRESS_56)
            ? (process.env.PANCAKE_V3_SWAP_ROUTER_ADDRESS_56 as Address)
            : ("0x13f4EA83D0bd40E75C8222255bc855a974568Dd4" as Address),
        quoter:
          process.env.PANCAKE_V3_QUOTER_ADDRESS_56 &&
          isAddress(process.env.PANCAKE_V3_QUOTER_ADDRESS_56)
            ? (process.env.PANCAKE_V3_QUOTER_ADDRESS_56 as Address)
            : ("0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997" as Address),
        factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865" as Address,
        feeTiers: [100, 500, 2500, 10000],
      },
      {
        kind: "univ2",
        dexName: "PancakeSwap V2",
        router: "0x10ED43C718714eb63d5aA57B78B54704E256024E" as Address,
        factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73" as Address,
      },
      {
        kind: "uniswap_v3",
        dexName: "Uniswap V3",
        router:
          process.env.UNISWAP_V3_SWAP_ROUTER_ADDRESS_56 &&
          isAddress(process.env.UNISWAP_V3_SWAP_ROUTER_ADDRESS_56)
            ? (process.env.UNISWAP_V3_SWAP_ROUTER_ADDRESS_56 as Address)
            : ("0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2" as Address),
        quoter:
          process.env.UNISWAP_V3_QUOTER_ADDRESS_56 &&
          isAddress(process.env.UNISWAP_V3_QUOTER_ADDRESS_56)
            ? (process.env.UNISWAP_V3_QUOTER_ADDRESS_56 as Address)
            : ("0x78D78E420Da98ad378D7799bE8f4AF69033EB077" as Address),
        factory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7" as Address,
        feeTiers: [100, 500, 3000, 10000],
      },
      {
        kind: "univ2",
        dexName: "Biswap",
        router: "0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8" as Address,
        factory: "0x858E3312ed3A876947EA49d572A7C42DE08af7EE" as Address,
      },
    ],
  };
}

// Router-from-env is read lazily (envAddress) so a SwapRouter override doesn't require a rebuild.
// nativeSources.router for uniswap_v3 falls back to the literal when the *_1 override is 0x0.
function withResolvedRouters(config: SweepChainConfig): SweepChainConfig {
  if (!config.nativeSources) return config;
  const ZERO = "0x0000000000000000000000000000000000000000".toLowerCase();
  const nativeSources = config.nativeSources.map((source) => {
    if (source.kind === "uniswap_v3" && source.router.toLowerCase() === ZERO) {
      return { ...source, router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" as Address };
    }
    return source;
  });
  return { ...config, nativeSources };
}

const CHAIN_CONFIGS: Record<number, () => SweepChainConfig> = {
  [BASE_CHAIN_ID]: () => BASE_CONFIG,
  [ETHEREUM_CHAIN_ID]: () => withResolvedRouters(ethereumConfig()),
  [BSC_CHAIN_ID]: () => withResolvedRouters(bscConfig()),
};

/** Chains DustSweep will serve. Default: Base only. Flip DUST_SWEEP_ENABLED_CHAIN_IDS to open ETH. */
export function getEnabledSweepChainIds(): number[] {
  const raw = String(process.env.DUST_SWEEP_ENABLED_CHAIN_IDS || String(BASE_CHAIN_ID));
  const ids = raw
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((id) => Number.isInteger(id) && CHAIN_CONFIGS[id] !== undefined);
  return ids.length > 0 ? Array.from(new Set(ids)) : [BASE_CHAIN_ID];
}

export function isSweepChainEnabled(chainId: number): boolean {
  return getEnabledSweepChainIds().includes(chainId);
}

/** Resolve a chain config regardless of enablement (callers gate on isSweepChainEnabled first). */
export function getSweepChainConfig(chainId: number): SweepChainConfig | null {
  const factory = CHAIN_CONFIGS[chainId];
  return factory ? factory() : null;
}

/** The canonical Permit2 (same on every chain) re-exported for convenience. */
export { PERMIT2_ADDRESS };

/** Resolve this chain's DustSwapSweepRouter V3 address from its configured env, or null. */
export function getChainRouterV3Address(config: SweepChainConfig): Address | null {
  const value = process.env[config.routerV3Env];
  return value && isAddress(value) ? (value as Address) : null;
}

/** This chain's aggregator target/spender allowlist (lowercased set). */
export function getChainAllowedAggregatorAddresses(config: SweepChainConfig): Set<string> {
  const configured = String(process.env[config.allowedAggregatorTargetsEnv] || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => isAddress(item))
    .map((item) => item.toLowerCase());

  if (configured.length > 0) return new Set(configured);

  // Non-Base chains already have their verified V3 aggregator targets in code. Use that registry
  // as the default quote allowlist so Ethereum does not silently lose all aggregator routes when
  // DUST_SWEEP_ALLOWED_AGGREGATOR_TARGETS_1 is omitted. Base keeps its env-only behavior.
  if (config.chainId === BASE_CHAIN_ID) return new Set();

  const aggregatorIds = ["kyber", "zerox", "lifi", "openocean", "odos"];
  const addresses = getDustSweepV3TargetsForChain(config.chainId)
    .filter((target) => aggregatorIds.some((id) => target.id.includes(id)))
    .flatMap((target) => [target.target, target.spender])
    .filter((address) => isAddress(address))
    .map((address) => address.toLowerCase());

  return new Set(addresses);
}
