import { isAddress, type Address } from "viem";

/**
 * DustSweep V3 (DustSwapSweepRouter) — verified Base (chainId 8453) DEX target registry.
 *
 * ADDITIVE + STANDALONE: this module does not import, replace, or alter the working V1/V2
 * DustSweep flow. It is the single source of truth for:
 *   1. the on-chain allowlist the owner sets on DustSwapSweepRouter after deploy
 *      (`setAllowedTarget` / `setAllowedSpender`), and
 *   2. which per-DEX calldata builder the app should use for each routable token.
 *
 * Every address below was confirmed live on Base via `eth_getCode` (contract present) and
 * cross-checked against the protocol's official docs / a verified BaseScan label on 2026-06-09.
 * See packages/contracts/remix/DustSwapSweepRouter-V3-Deploy.md for the source table.
 *
 * SPENDER MODEL (this is what makes exact, per-sweep approvals correct):
 *   - "permit2": the router pulls tokens through Permit2. Whitelist Permit2 as the spender and
 *     the DustSwapSweepRouter sets a transient Permit2 AllowanceTransfer approval == amountIn,
 *     reset to 0 after the swap. Used by Uniswap Universal Router (V3+V4) and Aerodrome's
 *     Universal Router (a Velodrome/Uniswap UR fork).
 *   - "self": the DEX pulls tokens via a plain ERC-20 allowance, so the DEX router IS the
 *     spender. DustSwapSweepRouter `forceApprove(router, amountIn)` then resets to 0.
 *
 * In BOTH models the approval is EXACTLY route.amountIn and returns to 0 after each route —
 * there is never a standing/unlimited allowance.
 */

export const BASE_CHAIN_ID = 8453;
export const ETHEREUM_CHAIN_ID = 1;

/** Canonical Permit2 (same address on every chain). Verified live on Base. */
export const PERMIT2_ADDRESS: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** WETH on Base. Verified live on Base. Constructor arg for DustSwapSweepRouter. */
export const WETH_ADDRESS: Address = "0x4200000000000000000000000000000000000006";

/** WETH on Ethereum mainnet. Constructor arg for the mainnet DustSwapSweepRouter. */
export const ETHEREUM_WETH_ADDRESS: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

export type DustSweepV3SpenderModel = "permit2" | "self";

export type DustSweepV3CalldataStyle =
  | "uniswap_universal_router" // UR commands + Permit2 (covers Uniswap V3 and V4 pools)
  | "uniswap_v3_swaprouter02" // exactInputSingle / exactInput
  | "aerodrome_universal_router" // Aerodrome UR commands (classic + Slipstream) + Permit2
  | "aerodrome_classic_router" // Solidly swapExactTokensForTokens(Route[]{from,to,stable,factory})
  | "aerodrome_slipstream_router" // Uniswap-V3-style exactInputSingle with tickSpacing
  | "pancake_smart_router" // PancakeSwap SmartRouter (V2 + V3 + stable)
  | "alienbase_smart_router" // AlienBase SmartRouter (V2 + stable + V3) — not on-chain quotable
  | "alienbase_v2_router" // AlienBase UniV2-style router (getAmountsOut / swapExactTokensForTokens)
  | "algebra_swaprouter" // QuickSwap Algebra Integral SwapRouter (exactInputSingle w/ deployer)
  | "dackie_smart_router" // DackieSwap SmartRouter
  | "baseswap_router"; // BaseSwap UniV2-style router

export type DustSweepV3Target = {
  id: string;
  name: string;
  /** The contract DustSwapSweepRouter calls — must be allowlisted via setAllowedTarget. */
  target: Address;
  /** The address that pulls the input token — must be allowlisted via setAllowedSpender. */
  spender: Address;
  spenderModel: DustSweepV3SpenderModel;
  calldataStyle: DustSweepV3CalldataStyle;
  /** UniV3-style fee tiers, in hundredths of a bip, where applicable. */
  feeTiers?: number[];
  enabled: boolean;
  /** Short provenance note for the verified-address table. */
  source: string;
};

/**
 * Verified Base targets for DustSweep V3. Order is the recommended quote/whitelist order
 * (deepest, most-reliable liquidity first). A token is "routable" if ANY enabled target quotes.
 */
export const BASE_DUSTSWEEP_V3_TARGETS: DustSweepV3Target[] = [
  {
    id: "uniswap-universal-router",
    name: "Uniswap Universal Router (V3+V4)",
    target: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
    spender: PERMIT2_ADDRESS,
    spenderModel: "permit2",
    calldataStyle: "uniswap_universal_router",
    feeTiers: [100, 500, 3000, 10000],
    enabled: true,
    source: "Uniswap official docs (developers.uniswap.org, Base deployments) + eth_getCode",
  },
  {
    id: "uniswap-v3-swaprouter02",
    name: "Uniswap V3 SwapRouter02",
    target: "0x2626664c2603336E57B271c5C0b26F421741e481",
    spender: "0x2626664c2603336E57B271c5C0b26F421741e481",
    spenderModel: "self",
    calldataStyle: "uniswap_v3_swaprouter02",
    feeTiers: [100, 500, 3000, 10000],
    enabled: true,
    source: "Uniswap official docs (Base v3 deployments) + eth_getCode; already used by V1/V2",
  },
  {
    id: "aerodrome-universal-router",
    name: "Aerodrome Universal Router (classic + Slipstream)",
    target: "0x6Cb442acF35158D5eDa88fe602221b67B400Be3E",
    spender: PERMIT2_ADDRESS,
    spenderModel: "permit2",
    calldataStyle: "aerodrome_universal_router",
    enabled: true,
    source: "BaseScan verified label 'Aerodrome: Universal Router' (5M+ txs) + eth_getCode",
  },
  {
    id: "aerodrome-classic-router",
    name: "Aerodrome Classic Router (Solidly)",
    target: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
    spender: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
    spenderModel: "self",
    calldataStyle: "aerodrome_classic_router",
    enabled: true,
    source: "Aerodrome docs/GitHub + eth_getCode; already used by V1/V2",
  },
  {
    id: "aerodrome-slipstream-router",
    name: "Aerodrome Slipstream SwapRouter (CL)",
    target: "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5",
    spender: "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5",
    spenderModel: "self",
    calldataStyle: "aerodrome_slipstream_router",
    enabled: true,
    source: "Aerodrome Slipstream docs + eth_getCode",
  },
  {
    id: "pancakeswap-smart-router",
    name: "PancakeSwap SmartRouter (V2+V3+stable)",
    target: "0x1b81D678ffb9C0263b24A97847620C99d213eB14",
    spender: "0x1b81D678ffb9C0263b24A97847620C99d213eB14",
    spenderModel: "self",
    calldataStyle: "pancake_smart_router",
    feeTiers: [100, 500, 2500, 10000],
    enabled: true,
    source: "PancakeSwap docs + eth_getCode; already used by V1/V2",
  },
  {
    id: "quickswap-algebra-swaprouter",
    name: "QuickSwap Algebra Integral SwapRouter",
    target: "0xe6c9bb24ddB4aE5c6632dbE0DE14e3E474c6Cb04",
    spender: "0xe6c9bb24ddB4aE5c6632dbE0DE14e3E474c6Cb04",
    spenderModel: "self",
    calldataStyle: "algebra_swaprouter",
    enabled: true,
    source:
      "QuickSwap Algebra Integral — verified live 2026-06-15: router.factory()=0xC539…9C7b, " +
      "poolDeployer()=0xE080…aA75, WNativeToken()=WETH; QuoterV2 0x23E0…7fb5 returns a live " +
      "WETH/USDC quote (pool 0x5a9A…be1a). App-side gated by DUST_SWEEP_ENABLE_ALGEBRA.",
  },
  {
    id: "hydrex-algebra-swaprouter",
    name: "Hydrex SwapRouter (Algebra Integral)",
    target: "0x6f4bE24d7dC93b6ffcBAb3Fd0747c5817Cea3F9e",
    spender: "0x6f4bE24d7dC93b6ffcBAb3Fd0747c5817Cea3F9e",
    spenderModel: "self",
    calldataStyle: "algebra_swaprouter",
    enabled: true,
    source:
      "Hydrex (Algebra Integral fork) — verified live 2026-07-03: router.factory()=0x3607…A29E, " +
      "poolDeployer()=0x1595…Ab94, WNativeToken()=WETH; QuoterV2 0x08b4…3Fdb answers the Integral " +
      "QuoterV2 struct (0xe94764c4) with live CHECK/WETH + WETH/USDC quotes. Addresses from " +
      "Hydrex's own app config, router cross-checked against the BaseScan 'Hydrex: Router' label. " +
      "App-side gated by DUST_SWEEP_ENABLE_HYDREX.",
  },
  {
    // AlienBase's SmartRouter (0xB20C…9411) is NOT on-chain quotable (no getAmountsOut), so the
    // app routes AlienBase through its UniV2-style router instead. Verified live 2026-06-15:
    // getAmountsOut(1 WETH→USDC) succeeds and factory()=0x3E84…FdE7 resolves.
    id: "alienbase-v2-router",
    name: "AlienBase Router (UniV2)",
    target: "0x8c1A3cF8f83074169FE5D7aD50B978e1cD6b37c7",
    spender: "0x8c1A3cF8f83074169FE5D7aD50B978e1cD6b37c7",
    spenderModel: "self",
    calldataStyle: "alienbase_v2_router",
    enabled: true,
    source:
      "AlienBase UniV2 router — verified live 2026-06-15 (getAmountsOut ok, factory() resolves). " +
      "App-side gated by DUST_SWEEP_ENABLE_ALIENBASE.",
  },
  {
    id: "dackieswap-smart-router",
    name: "DackieSwap SmartRouter",
    target: "0x195FBc5B8Fbd5Ac739C1BA57D4Ef6D5a704F34f7",
    spender: "0x195FBc5B8Fbd5Ac739C1BA57D4Ef6D5a704F34f7",
    spenderModel: "self",
    calldataStyle: "dackie_smart_router",
    enabled: true,
    source: "DackieSwap docs + eth_getCode",
  },
  {
    id: "baseswap-router",
    name: "BaseSwap Router",
    target: "0x327Df1E6de05895d2ab08513aaDD9313Fe505d86",
    spender: "0x327Df1E6de05895d2ab08513aaDD9313Fe505d86",
    spenderModel: "self",
    calldataStyle: "baseswap_router",
    enabled: true,
    source: "BaseSwap docs + eth_getCode; already used by V1/V2",
  },
];

/**
 * Verified Ethereum mainnet (chainId 1) targets for DustSweep V3.
 *
 * Native execution ships with Uniswap V3 + V2 + SushiSwap (deepest native liquidity); the
 * aggregator ladder (Kyber / 0x / LI.FI) covers Curve, Balancer, Pancake, Fluid, etc. via the
 * rescue path. OpenOcean + Odos are PRE-ALLOWLISTED but PARKED (enabled: false) — the on-chain
 * allowlist is inert until DUST_SWEEP_ENABLE_*_1 + DUST_SWEEP_ALLOWED_AGGREGATOR_TARGETS_1 open
 * them. Every address must be re-verified live via eth_getCode before the owner allowlist txs;
 * see packages/contracts/remix/DustSwapSweepRouter-Ethereum-Deploy.md.
 */
export const ETHEREUM_DUSTSWEEP_V3_TARGETS: DustSweepV3Target[] = [
  {
    id: "uniswap-v3-swaprouter02",
    name: "Uniswap V3 SwapRouter02",
    target: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    spender: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    spenderModel: "self",
    calldataStyle: "uniswap_v3_swaprouter02",
    feeTiers: [100, 500, 3000, 10000],
    enabled: true,
    source: "Uniswap official docs (mainnet v3 deployments); re-verify eth_getCode pre-allowlist",
  },
  {
    id: "uniswap-universal-router",
    name: "Uniswap Universal Router (V3+V4)",
    target: "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af",
    spender: PERMIT2_ADDRESS,
    spenderModel: "permit2",
    calldataStyle: "uniswap_universal_router",
    feeTiers: [100, 500, 3000, 10000],
    // Parked until the V4 native adapter ships on mainnet; allowlisted so it can be flipped on
    // without a new owner tx. V3-style routing already covered by SwapRouter02 above.
    enabled: false,
    source: "Uniswap official docs (mainnet UR v4); re-verify eth_getCode pre-allowlist",
  },
  {
    id: "uniswap-v2-router",
    name: "Uniswap V2 Router02",
    target: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    spender: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    spenderModel: "self",
    calldataStyle: "baseswap_router", // UniV2 getAmountsOut/swapExactTokensForTokens shape
    enabled: true,
    source: "Uniswap V2 canonical router (mainnet); re-verify eth_getCode pre-allowlist",
  },
  {
    id: "sushiswap-v2-router",
    name: "SushiSwap Router (UniV2)",
    target: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
    spender: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
    spenderModel: "self",
    calldataStyle: "baseswap_router",
    enabled: true,
    source: "SushiSwap canonical router (mainnet); re-verify eth_getCode pre-allowlist",
  },
  {
    id: "kyber-meta-aggregation-router-v2",
    name: "KyberSwap MetaAggregationRouterV2",
    target: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
    spender: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
    spenderModel: "self",
    calldataStyle: "uniswap_v3_swaprouter02", // GENERIC aggregator route; calldata is opaque
    enabled: true,
    source: "KyberSwap docs (same router address across chains); re-verify eth_getCode",
  },
  {
    id: "zerox-allowance-holder",
    name: "0x AllowanceHolder",
    target: "0x0000000000001fF3684f28c67538d4D072C22734",
    spender: "0x0000000000001fF3684f28c67538d4D072C22734",
    spenderModel: "self",
    calldataStyle: "uniswap_v3_swaprouter02",
    enabled: true,
    source: "0x docs (AllowanceHolder, same address across chains); re-verify eth_getCode",
  },
  {
    id: "lifi-diamond",
    name: "LI.FI Diamond",
    target: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
    spender: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
    spenderModel: "self",
    calldataStyle: "uniswap_v3_swaprouter02",
    enabled: true,
    source: "LI.FI docs (Diamond, same address across chains); re-verify eth_getCode",
  },
  {
    id: "openocean-exchange-proxy",
    name: "OpenOcean Exchange Proxy",
    target: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
    spender: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
    spenderModel: "self",
    calldataStyle: "uniswap_v3_swaprouter02",
    enabled: false, // PARKED — pre-allowlist on-chain, enable via DUST_SWEEP_ENABLE_OPENOCEAN_1
    source: "OpenOcean docs; parked pending enable + live quote verification",
  },
  {
    id: "odos-router-v2",
    name: "Odos RouterV2",
    target: "0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559",
    spender: "0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559",
    spenderModel: "self",
    calldataStyle: "uniswap_v3_swaprouter02",
    enabled: false, // PARKED — pre-allowlist on-chain, enable via DUST_SWEEP_ENABLE_ODOS_1
    source: "Odos docs; parked pending enable + API key + live quote verification",
  },
];

function unique(addresses: Address[]): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const addr of addresses) {
    const key = addr.toLowerCase();
    if (!seen.has(key) && isAddress(addr)) {
      seen.add(key);
      out.push(addr);
    }
  }
  return out;
}

export function getActiveBaseDustSweepV3Targets(): DustSweepV3Target[] {
  return BASE_DUSTSWEEP_V3_TARGETS.filter((t) => t.enabled);
}

/**
 * The exact owner-only allowlist the V3 router needs after deploy. Feed `targets` into
 * `setAllowedTarget(addr, true)` and `spenders` into `setAllowedSpender(addr, true)`.
 */
export function getBaseDustSweepV3Allowlist(): { targets: Address[]; spenders: Address[] } {
  const active = getActiveBaseDustSweepV3Targets();
  return {
    targets: unique(active.map((t) => t.target)),
    spenders: unique(active.map((t) => t.spender)),
  };
}

/** Resolve the deployed V3 router address from env (single switch value, no V2/V3 fallback). */
export function getDustSweepV3RouterAddress(): Address | null {
  const candidate = process.env.DUST_SWEEP_ROUTER_V3_ADDRESS;
  return candidate && isAddress(candidate) ? (candidate as Address) : null;
}

// ── Per-chain accessors (additive; Base callers keep using the Base-specific exports above) ──

/** All configured V3 targets for a chain (Base default). */
export function getDustSweepV3TargetsForChain(chainId: number): DustSweepV3Target[] {
  return chainId === ETHEREUM_CHAIN_ID ? ETHEREUM_DUSTSWEEP_V3_TARGETS : BASE_DUSTSWEEP_V3_TARGETS;
}

export function getActiveDustSweepV3TargetsForChain(chainId: number): DustSweepV3Target[] {
  return getDustSweepV3TargetsForChain(chainId).filter((t) => t.enabled);
}

/**
 * The exact owner-only allowlist a chain's V3 router needs after deploy.
 * NOTE: for Ethereum this INCLUDES parked (enabled:false) aggregator targets so the owner can
 * pre-allowlist them on-chain; app-side execution stays gated by the enable flags.
 */
export function getDustSweepV3AllowlistForChain(chainId: number): {
  targets: Address[];
  spenders: Address[];
} {
  const all = getDustSweepV3TargetsForChain(chainId);
  return {
    targets: unique(all.map((t) => t.target)),
    spenders: unique(all.map((t) => t.spender)),
  };
}
