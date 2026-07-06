import { randomBytes } from "crypto";
import { Hono, type Context } from "hono";
import {
  concatHex,
  decodeAbiParameters,
  decodeEventLog,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  parseAbi,
  toEventSelector,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { postgresDb } from "../services/postgres";
import { pointsEngine } from "../services/pointsEngine";
import { questEngine } from "../services/questEngine";
import { runtimeCache } from "../utils/runtimeCache";
import { baseRpcRequest, alchemyRpcRequest, RpcDeterministicError, RpcTransportError } from "../utils/baseRpc";
import { isMaintenanceBlocking, maintenanceUnavailable } from "../utils/maintenance";
import {
  getBaseDustSweepV3Allowlist,
  getActiveDustSweepV3TargetsForChain,
  getDustSweepV3AllowlistForChain,
} from "../config/dustsweepV3Sources";
import {
  BASE_CONFIG,
  ETHEREUM_CHAIN_ID,
  getChainAllowedAggregatorAddresses,
  getChainRouterV3Address,
  getEnabledSweepChainIds,
  getSweepChainConfig,
  isSweepChainEnabled,
  type SweepChainConfig,
} from "../config/sweepChains";
import { chainRpcRequest, chainAlchemyRpcRequest } from "../utils/chainRpc";
import { getProxiedClientIp } from "../utils/clientIp";
import {
  governAggregatorCall,
  reportAggregatorHttpStatus,
  type AggregatorProviderId,
} from "../lib/aggregatorGovernor";
import { batchedEthCall, isMulticallBatchingEnabled } from "../lib/multicallBatcher";

const dustsweepRoutes = new Hono();

// Very generous, FAIL-OPEN per-IP throttle. Dustsweep is request-heavy (token
// discovery + balance scans + route finding can be 1000-2000 calls at peak), so
// the ceiling is ~4x that and it only ever catches an egregious single-IP flood.
// Keyed on the REAL browser IP forwarded by our Next proxy (each user = own
// bucket, so it never breaks concurrent sweeps); if no real IP can be resolved
// it does NOT limit at all — legitimate sweeps are never blocked.
const DUSTSWEEP_RATE_LIMIT = (() => {
  const parsed = Number.parseInt(process.env.DUSTSWEEP_RATE_LIMIT || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8000;
})();
const DUSTSWEEP_RATE_WINDOW_MS = (() => {
  const parsed = Number.parseInt(process.env.DUSTSWEEP_RATE_WINDOW_MS || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
})();

dustsweepRoutes.use("*", async (c, next) => {
  if (await isMaintenanceBlocking(c)) {
    return maintenanceUnavailable(c);
  }

  const clientIp = getProxiedClientIp(c);
  if (clientIp) {
    const limit = runtimeCache.consumeRateLimit(
      `dustsweep:ip:${clientIp}`,
      DUSTSWEEP_RATE_LIMIT,
      DUSTSWEEP_RATE_WINDOW_MS
    );
    if (!limit.allowed) {
      c.header("Retry-After", Math.max(1, Math.ceil(limit.retryAfterMs / 1000)).toString());
      return c.json(
        { success: false, error: "Too many requests. Please slow down." },
        429
      );
    }
  }

  return next();
});

const BASE_CHAIN_ID = 8453;
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as Address;
const NATIVE_TOKEN_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;
const PERMIT2_ADDRESS = (process.env.NEXT_PUBLIC_PERMIT2_ADDRESS ||
  process.env.PERMIT2_ADDRESS ||
  "0x000000000022D473030F116dDEE9F6B43aC78BA3") as Address;
const DUST_SWEEP_ROUTER_V1_ADDRESS = (process.env.DUST_SWEEP_ROUTER_V1_ADDRESS ||
  process.env.DUST_SWEEP_ROUTER_ADDRESS ||
  process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER ||
  process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER_ADDRESS ||
  "0x0000000000000000000000000000000000000000") as Address;
const DUST_SWEEP_ROUTER_V2_ADDRESS = (process.env.DUST_SWEEP_ROUTER_V2_ADDRESS ||
  process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER_V2_ADDRESS ||
  "0x0000000000000000000000000000000000000000") as Address;
// DustSweep V3 (DustSwapSweepRouter). When set, the owned_v2 lane transparently routes through
// V3 (single-env switch, no V2/V3 fallback): same route shape + allowlist, but V3's sweep() ABI,
// witness (binds feeBps + recipient) and exact-amount approvals. Leave unset to stay on V2.
const DUST_SWEEP_ROUTER_V3_ADDRESS = (process.env.DUST_SWEEP_ROUTER_V3_ADDRESS ||
  process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER_V3_ADDRESS ||
  "0x0000000000000000000000000000000000000000") as Address;
const UNISWAP_V3_SWAP_ROUTER_ADDRESS = (process.env.UNISWAP_V3_SWAP_ROUTER_ADDRESS ||
  "0x2626664c2603336E57B271c5C0b26F421741e481") as Address;
const UNISWAP_UNIVERSAL_ROUTER_ADDRESS = (process.env.UNISWAP_UNIVERSAL_ROUTER_ADDRESS ||
  "0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7") as Address;
// V4-capable Universal Router (handles the V4_SWAP command). This is a DIFFERENT contract from the
// legacy UR above; Uniswap V4 swaps must target THIS address. Verified live on Base + fork-tested.
const UNISWAP_V4_UNIVERSAL_ROUTER_ADDRESS = (process.env.UNISWAP_V4_UNIVERSAL_ROUTER_ADDRESS ||
  "0x6fF5693b99212Da76ad316178A184AB56D299b43") as Address;
const PANCAKE_V3_SWAP_ROUTER_ADDRESS = (process.env.PANCAKE_V3_SWAP_ROUTER_ADDRESS ||
  "0x1b81D678ffb9C0263b24A97847620C99d213eB14") as Address;
const UNISWAP_V3_QUOTER_ADDRESS = (process.env.UNISWAP_V3_QUOTER_ADDRESS ||
  "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a") as Address;
const PANCAKE_V3_QUOTER_ADDRESS = (process.env.PANCAKE_V3_QUOTER_ADDRESS ||
  "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997") as Address;
const AERODROME_ROUTER_ADDRESS = (process.env.AERODROME_ROUTER_ADDRESS ||
  "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43") as Address;
const AERODROME_FACTORY_ADDRESS = (process.env.AERODROME_FACTORY_ADDRESS ||
  "0x420DD381b31aEf6683db6B902084cB0FFECe40Da") as Address;
const BASESWAP_ROUTER_ADDRESS = (process.env.BASESWAP_ROUTER_ADDRESS ||
  "0x327Df1E6de05895d2ab08513aaDD9313Fe505d86") as Address;
// Aerodrome Slipstream (concentrated liquidity). Uniswap-V3-style but pools are keyed by
// tickSpacing (int24), not fee. Router + Quoter verified live on Base 2026-06-09 (BaseScan
// labels + a live WETH->USDC quote). Router is allowlisted on the V3 sweep router.
const AERODROME_SLIPSTREAM_ROUTER_ADDRESS = (process.env.AERODROME_SLIPSTREAM_ROUTER_ADDRESS ||
  "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5") as Address;
const AERODROME_SLIPSTREAM_QUOTER_ADDRESS = (process.env.AERODROME_SLIPSTREAM_QUOTER_ADDRESS ||
  "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0") as Address;
// Aerodrome CL tick spacings, deepest-liquidity-first. 1/50 = stable/correlated, 100/200/2000 = volatile.
const AERODROME_SLIPSTREAM_TICK_SPACINGS = [100, 200, 2000, 50, 1] as const;
// ── QuickSwap Algebra Integral (concentrated liquidity, dynamic fee) ──
// Verified live on Base 2026-06-15. Pools are keyed by (token0, token1, deployer); the default
// deployer is address(0). The QuoterV2 input struct carries that deployer field (selector
// 0xe94764c4) and amountOut is the first return word. App-side gated by DUST_SWEEP_ENABLE_ALGEBRA
// (default off) and requires the SwapRouter to be allowlisted on the V3 router.
const ALGEBRA_SWAP_ROUTER_ADDRESS = (process.env.ALGEBRA_SWAP_ROUTER_ADDRESS ||
  "0xe6c9bb24ddB4aE5c6632dbE0DE14e3E474c6Cb04") as Address;
const ALGEBRA_QUOTER_ADDRESS = (process.env.ALGEBRA_QUOTER_ADDRESS ||
  "0x23E0583a3a000d567bB3848115065c1890D87fb5") as Address;
// ── Hydrex (Algebra Integral fork — Base-native ve(3,3) MetaDEX) ──
// Verified live on Base 2026-07-03: router.factory()=0x3607…A29E, router.poolDeployer()=
// 0x1595…Ab94, router.WNativeToken()=WETH, and the QuoterV2 answers the SAME Integral QuoterV2
// struct (selector 0xe94764c4) used by QuickSwap above — confirmed with live CHECK/WETH and
// WETH/USDC quotes. Addresses come from Hydrex's own app config (www.hydrex.fi bundle) and the
// router is cross-checked against the BaseScan "Hydrex: Router" label. App-side gated by
// DUST_SWEEP_ENABLE_HYDREX (default off) and requires the SwapRouter to be allowlisted on the
// V3 router before enabling.
const HYDREX_SWAP_ROUTER_ADDRESS = (process.env.HYDREX_SWAP_ROUTER_ADDRESS ||
  "0x6f4bE24d7dC93b6ffcBAb3Fd0747c5817Cea3F9e") as Address;
const HYDREX_QUOTER_ADDRESS = (process.env.HYDREX_QUOTER_ADDRESS ||
  "0x08b46265643a5389529D6f6616FA4a0d66F13Fdb") as Address;
// ── AlienBase UniV2 router ── The AlienBase SmartRouter (0xB20C…9411) does NOT expose
// getAmountsOut, so we quote/execute through AlienBase's UniV2 router instead. Verified live
// 2026-06-15. App-side gated by DUST_SWEEP_ENABLE_ALIENBASE (default off).
const ALIENBASE_V2_ROUTER_ADDRESS = (process.env.ALIENBASE_V2_ROUTER_ADDRESS ||
  "0x8c1A3cF8f83074169FE5D7aD50B978e1cD6b37c7") as Address;
const ZEROX_ALLOWANCE_HOLDER = (process.env.ZEROX_ALLOWANCE_HOLDER ||
  "0x0000000000001fF3684f28c67538d4D072C22734") as Address;
const UNISWAP_V3_FACTORY_ADDRESS = (process.env.UNISWAP_V3_FACTORY_ADDRESS ||
  "0x33128a8fC17869897dcE68Ed026d694621f6FDfD") as Address;
const PANCAKE_V3_FACTORY_ADDRESS = (process.env.PANCAKE_V3_FACTORY_ADDRESS ||
  "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865") as Address;
const BASESWAP_FACTORY_ADDRESS = (process.env.BASESWAP_FACTORY_ADDRESS ||
  "0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB") as Address;
const USDBC_ADDRESS = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA" as Address;
const USDT_ADDRESS = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" as Address;
const WBTC_ADDRESS = "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c" as Address;
const DAI_ADDRESS = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" as Address;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const MAX_UINT128 = (1n << 128n) - 1n;
const UNISWAP_FEE_TIERS = [500, 3000, 10000, 100] as const;
const PANCAKE_FEE_TIERS = [500, 2500, 10000, 100] as const;
const TWO_HOP_FEE_PAIRS = [
  [3000, 500],
  [500, 500],
  [10000, 500],
  [3000, 3000],
  [2500, 500],
  [2500, 2500],
] as const;
/**
 * Resolve the target sweep chain for a request from `?chainId=` (GET) or `body.chainId` (POST),
 * defaulting to Base. Returns a 400 when the chain isn't in DUST_SWEEP_ENABLED_CHAIN_IDS, so
 * Ethereum stays fully dark until the flag is flipped. Base always resolves to BASE_CONFIG.
 */
function resolveSweepChain(
  c: Context,
  bodyChainId?: unknown,
):
  | { ok: true; chain: SweepChainConfig }
  | { ok: false; response: Response } {
  const raw = bodyChainId ?? c.req.query("chainId") ?? BASE_CHAIN_ID;
  const chainId = Number(raw);
  if (!Number.isInteger(chainId) || !isSweepChainEnabled(chainId)) {
    return {
      ok: false,
      response: c.json(
        errorJson(`DustSweep is not enabled on chain ${raw}`, {
          code: "CHAIN_NOT_ENABLED",
          enabledChains: getEnabledSweepChainIds(),
        }),
        400,
      ),
    };
  }
  const chain = getSweepChainConfig(chainId) ?? BASE_CONFIG;
  return { ok: true, chain };
}

function boundedEnvNumber(key: string, fallback: number, min: number, max: number) {
  const parsed = Number(process.env[key] || fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function optionalBoundedEnvNumber(key: string, min: number, max: number) {
  const raw = process.env[key]?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

const MIN_VALUE_USD = Number(process.env.DUST_SWEEP_MIN_VALUE_USD || "0.01");
const MIN_WL_LIQUIDITY_USD = Number(process.env.DUST_SWEEP_WHITELIST_MIN_LIQUIDITY_USD || "1000");
const ALCHEMY_TOKEN_BALANCE_PAGE_SIZE = 100;
const DISCOVERY_RUNTIME_CACHE_TTL_MS = boundedEnvNumber("DUST_SWEEP_RUNTIME_CACHE_TTL_MS", 30_000, 5_000, 300_000);
const DISCOVERY_DB_CACHE_TTL_MS = boundedEnvNumber("DUST_SWEEP_DB_CACHE_TTL_MS", 90_000, 30_000, 600_000);
const DISCOVERY_STALE_DB_CACHE_TTL_MS = boundedEnvNumber(
  "DUST_SWEEP_STALE_DB_CACHE_TTL_MS",
  24 * 60 * 60_000,
  5 * 60_000,
  7 * 24 * 60 * 60_000,
);
const DISCOVERY_MARKET_HINT_CONCURRENCY = boundedEnvNumber("DUST_SWEEP_MARKET_HINT_CONCURRENCY", 4, 1, 8);
const DISCOVERY_MARKET_HINT_TIMEOUT_MS = boundedEnvNumber("DUST_SWEEP_MARKET_HINT_TIMEOUT_MS", 3_500, 1_000, 8_000);
const DISCOVERY_BLOCKSCOUT_FAST_PRICING =
  process.env.DUST_SWEEP_BLOCKSCOUT_FAST_PRICING !== "false";
// Cap on EXTERNAL (DexScreener/CoinGecko) price lookups for tokens Blockscout didn't price.
// Discovery must show every token and then filter by the normal rules — an unpriced token gets
// hidden as UNKNOWN_PRICE, so this cap must comfortably cover a large dust wallet. DexScreener
// batches 30 addresses/call at concurrency 4, so even 1000 lookups add only a few seconds.
const DISCOVERY_BLOCKSCOUT_PRICELESS_MARKET_HINT_LIMIT = boundedEnvNumber(
  "DUST_SWEEP_BLOCKSCOUT_PRICELESS_MARKET_HINT_LIMIT",
  1_000,
  0,
  2_000,
);
const DISCOVERY_METADATA_CONCURRENCY = boundedEnvNumber("DUST_SWEEP_METADATA_CONCURRENCY", 10, 1, 24);
// Per-token quote parallelism + hard deadline. Quoting a large dust basket used
// to run at concurrency 4 with no per-token cap, so a handful of dead tokens
// (native miss → 0x → LI.FI fallback) could stall the whole quote for minutes
// and then time out. With a dedicated RPC we quote more tokens at once and cap
// each token so slow/dead tokens are skipped instead of blocking the rest.
const QUOTE_TOKEN_CONCURRENCY = boundedEnvNumber("DUST_SWEEP_QUOTE_CONCURRENCY", 10, 1, 50);
const QUOTE_TOKEN_TIMEOUT_MS = boundedEnvNumber("DUST_SWEEP_QUOTE_TOKEN_TIMEOUT_MS", 12_000, 3_000, 30_000);
// Concurrency for the build-tx pre-flight balance/allowance reads. These used to
// run one RPC call per token in series, so a 50-token sweep took ~a minute before
// the wallet prompt could even open. Reading them in parallel collapses that to
// roughly one round-trip's worth of latency.
const PREFLIGHT_READ_CONCURRENCY = boundedEnvNumber("DUST_SWEEP_PREFLIGHT_READ_CONCURRENCY", 25, 1, 50);
// Before quoting/building a sweep, simulate each token's transfer to the router
// and drop the ones whose pull would revert (transfer tax / max-tx / blacklist /
// honeypot). One such dust token reverts the WHOLE atomic sweep in the wallet's
// gas estimation AND breaks the batch preview on OKX/Coinbase, which is why 25-50
// token baskets fail while 10 clean tokens succeed. Default ON; set to "false" to
// disable the probe.
const PREFLIGHT_TRANSFER_PROBE_ENABLED =
  process.env.DUST_SWEEP_PREFLIGHT_TRANSFER_PROBE !== "false";
// The probe runs on every quote (debounced, frequent), so cache definite results
// briefly. Keyed by user+token+amount+recipient, so a balance change (new amount)
// naturally re-probes. Fail-open results (transient RPC) are NOT cached.
const TRANSFER_PROBE_CACHE_TTL_MS = boundedEnvNumber(
  "DUST_SWEEP_TRANSFER_PROBE_CACHE_TTL_MS",
  60_000,
  5_000,
  10 * 60_000,
);
const transferProbeCache = new Map<string, { pullable: boolean; expires: number }>();
const ERC20_METADATA_CACHE_TTL_MS = boundedEnvNumber("DUST_SWEEP_METADATA_CACHE_TTL_MS", 24 * 60 * 60_000, 60_000, 7 * 24 * 60 * 60_000);
const WHITELIST_CACHE_TTL_MS = boundedEnvNumber("DUST_SWEEP_WHITELIST_CACHE_TTL_MS", 5 * 60_000, 30_000, 30 * 60_000);
const DISCOVERY_MAX_ERC20_BALANCES = optionalBoundedEnvNumber(
  "DUST_SWEEP_DISCOVERY_MAX_ERC20_BALANCES",
  50,
  10_000,
);
const DISCOVERY_TARGET_NONZERO_BALANCES = optionalBoundedEnvNumber(
  "DUST_SWEEP_DISCOVERY_TARGET_NONZERO_BALANCES",
  1,
  10_000,
);
const DISCOVERY_ALCHEMY_MAX_PAGES = optionalBoundedEnvNumber(
  "DUST_SWEEP_ALCHEMY_MAX_PAGES",
  1,
  250,
);
const DISCOVERY_ALCHEMY_TIMEOUT_MS = boundedEnvNumber("DUST_SWEEP_ALCHEMY_TIMEOUT_MS", 4_000, 1_000, 15_000);
const DISCOVERY_ALCHEMY_MAX_ENDPOINT_ATTEMPTS = boundedEnvNumber(
  "DUST_SWEEP_ALCHEMY_MAX_ENDPOINT_ATTEMPTS",
  3,
  1,
  50,
);
// Discovery calls (alchemy_getTokenBalances) are the most CU-expensive Alchemy method — hedging
// fires every page at N keys simultaneously and MULTIPLIES burn on a capacity-limited key set
// (this is what trips Alchemy's "unusually high global traffic" 429). Default 1 = no hedge for
// discovery; other (cheap) Alchemy calls keep the global ALCHEMY_RPC_HEDGE_COUNT behavior.
const DISCOVERY_ALCHEMY_HEDGE_COUNT = boundedEnvNumber(
  "DUST_SWEEP_ALCHEMY_HEDGE_COUNT",
  1,
  1,
  4,
);
// When a full Alchemy discovery pass fails (typically ALL keys 429 on the Token API), skip
// Alchemy entirely for this cool-off window and go straight to Blockscout: faster first paint,
// no wasted attempts, and no further feeding of Alchemy's abuse heuristics.
const DISCOVERY_ALCHEMY_BREAKER_MS = boundedEnvNumber(
  "DUST_SWEEP_ALCHEMY_BREAKER_MS",
  120_000,
  10_000,
  1_800_000,
);
let alchemyDiscoveryBreakerUntil = 0;
const DISCOVERY_BLOCKSCOUT_BALANCE_FALLBACK_ENABLED =
  process.env.DUST_SWEEP_BLOCKSCOUT_BALANCE_FALLBACK !== "false";
const DISCOVERY_BLOCKSCOUT_BALANCE_TIMEOUT_MS = boundedEnvNumber(
  "DUST_SWEEP_BLOCKSCOUT_BALANCE_TIMEOUT_MS",
  20_000,
  2_000,
  30_000,
);
const DISCOVERY_BLOCKSCOUT_BALANCE_MAX_RETRIES = boundedEnvNumber(
  "DUST_SWEEP_BLOCKSCOUT_BALANCE_MAX_RETRIES",
  2,
  0,
  5,
);
const DISCOVERY_BLOCKSCOUT_BALANCE_RETRY_MS = boundedEnvNumber(
  "DUST_SWEEP_BLOCKSCOUT_BALANCE_RETRY_MS",
  1_500,
  250,
  10_000,
);
const DISCOVERY_BLOCKSCOUT_BALANCE_MAX_PAGES = optionalBoundedEnvNumber(
  "DUST_SWEEP_BLOCKSCOUT_BALANCE_MAX_PAGES",
  1,
  250,
);
const DEX = {
  UNISWAP_V3: 0,
  UNISWAP_V4: 1,
  AERODROME: 2,
  PANCAKESWAP_V3: 3,
  BASESWAP: 4,
  GENERIC: 5,
  AERODROME_SLIPSTREAM: 6,
  ALGEBRA: 7,
  ALIENBASE: 8,
  HYDREX: 9,
  // Chain-agnostic UniswapV2-style router with the router address embedded in dexData
  // (address router, address[] path). Lets one calldata builder serve any UniV2 clone on any
  // chain (Ethereum: Uniswap V2, SushiSwap, ShibaSwap) without a per-DEX enum + hardcoded target.
  UNIV2_GENERIC: 10,
  // No swap. tokenIn already IS the output token (WETH swept into native ETH). The upgraded V3
  // router pulls it and settles/unwraps it directly. target/spender/data are unused.
  PASSTHROUGH: 11,
} as const;

type DustSweepExecutionLane = "owned_v1" | "owned_v2" | "basket_aggregator";

function getExecutionLane(): DustSweepExecutionLane {
  const raw = String(process.env.DUST_SWEEP_EXECUTION_LANE || "owned_v1").toLowerCase();
  // owned_v3 is a clean alias for the modern owned lane: same approve + router
  // transferFrom flow, transparently routed through the V3 router when configured.
  // Normalize it to owned_v2 so every downstream check keeps working unchanged.
  if (raw === "owned_v2" || raw === "owned_v3") return "owned_v2";
  if (raw === "basket_aggregator") return "basket_aggregator";
  return "owned_v1";
}

// True for the modern owned lane (owned_v2 / owned_v3 alias). Use this instead of
// hard-coding `=== "owned_v2"` so V3 is decoupled from the V2 name.
function isOwnedModernLane(executionLane: DustSweepExecutionLane) {
  return executionLane === "owned_v2";
}

function getRouteMaxCap(executionLane: DustSweepExecutionLane) {
  return executionLane === "owned_v1" ? 10 : 50;
}

function isV3Active() {
  return (
    isAddress(DUST_SWEEP_ROUTER_V3_ADDRESS) &&
    DUST_SWEEP_ROUTER_V3_ADDRESS.toLowerCase() !== ZERO_ADDRESS.toLowerCase()
  );
}

function sumRouteMinAmountOut(routes: Array<Pick<DustSweepRoute, "amountOutMin">>) {
  return routes.reduce((sum, route) => sum + BigInt(route.amountOutMin), 0n);
}

function getRouterMinAmountOut(
  routes: Array<Pick<DustSweepRoute, "amountOutMin">>,
  executionLane: DustSweepExecutionLane,
  v3Active: boolean = isV3Active(),
) {
  if (!routes.length) return 0n;

  if (isOwnedModernLane(executionLane) && v3Active) {
    // V3 executes routes best-effort: every DEX leg still enforces its own
    // slippage floor, and failed legs are refunded. The router-level floor
    // should therefore only require at least one quoted leg to settle, not the
    // sum of every leg, otherwise one refunded dust route reverts the batch.
    return routes.reduce((min, route) => {
      const amount = BigInt(route.amountOutMin);
      return amount < min ? amount : min;
    }, BigInt(routes[0]!.amountOutMin));
  }

  return sumRouteMinAmountOut(routes);
}

function getRouterAddressForLane(executionLane: DustSweepExecutionLane) {
  if (isOwnedModernLane(executionLane)) {
    return isV3Active() ? DUST_SWEEP_ROUTER_V3_ADDRESS : DUST_SWEEP_ROUTER_V2_ADDRESS;
  }
  return DUST_SWEEP_ROUTER_V1_ADDRESS;
}

// Effective per-sweep fee for V3, passed as an EXPLICIT feeBpsOverride (never the sentinel) and
// bound into the V3 witness, so the fee the user signs == the fee charged (audit L-1). Capped to
// the contract's MAX_FEE_BPS so a misconfigured env can never make sweep() revert with FeeTooHigh.
const V3_MAX_FEE_BPS = 300;
function getV3FeeBps(chain: SweepChainConfig = BASE_CONFIG) {
  return Math.max(0, Math.min(V3_MAX_FEE_BPS, getFeeBps(chain)));
}

function parseAddressSet(value: string | undefined, fallback: Address[] = []) {
  const addresses = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => isAddress(item))
    .map((item) => normalizeAddress(item).toLowerCase());

  if (addresses.length === 0) {
    return new Set(fallback.map((item) => item.toLowerCase()));
  }

  return new Set(addresses);
}

function getAllowedV2Targets(chain: SweepChainConfig = BASE_CONFIG) {
  // Non-Base chains: the native DEX targets come from the chain's OWN V3 registry (no env needed),
  // plus its aggregator allowlist, plus an optional per-chain override env (DUST_SWEEP_ALLOWED_TARGETS_<id>).
  if (chain.chainId !== BASE_CHAIN_ID) {
    const targets = parseAddressSet(process.env[`DUST_SWEEP_ALLOWED_TARGETS_${chain.chainId}`], []);
    for (const address of getDustSweepV3AllowlistForChain(chain.chainId).targets) targets.add(address.toLowerCase());
    for (const address of getChainAllowedAggregatorAddresses(chain)) targets.add(address);
    return targets;
  }
  const targets = parseAddressSet(process.env.DUST_SWEEP_ALLOWED_TARGETS, [
    UNISWAP_V3_SWAP_ROUTER_ADDRESS,
    UNISWAP_UNIVERSAL_ROUTER_ADDRESS,
    PANCAKE_V3_SWAP_ROUTER_ADDRESS,
    AERODROME_ROUTER_ADDRESS,
    BASESWAP_ROUTER_ADDRESS,
  ]);
  for (const address of getAllowedAggregatorAddresses()) targets.add(address);
  // When V3 is active, always trust the verified V3 target registry (Slipstream, V4 Universal
  // Router, etc.) so this off-chain gate stays in sync with the on-chain allowlist without
  // requiring DUST_SWEEP_ALLOWED_TARGETS to be hand-edited for every new DEX.
  if (isV3Active()) {
    for (const address of getBaseDustSweepV3Allowlist().targets) targets.add(address.toLowerCase());
  }
  return targets;
}

function getAllowedV2Spenders(chain: SweepChainConfig = BASE_CONFIG) {
  if (chain.chainId !== BASE_CHAIN_ID) {
    const spenders = parseAddressSet(process.env[`DUST_SWEEP_ALLOWED_SPENDERS_${chain.chainId}`], [
      PERMIT2_ADDRESS,
    ]);
    for (const address of getDustSweepV3AllowlistForChain(chain.chainId).spenders) spenders.add(address.toLowerCase());
    for (const address of getChainAllowedAggregatorAddresses(chain)) spenders.add(address);
    return spenders;
  }
  const spenders = parseAddressSet(process.env.DUST_SWEEP_ALLOWED_SPENDERS, [
    UNISWAP_V3_SWAP_ROUTER_ADDRESS,
    PERMIT2_ADDRESS,
    PANCAKE_V3_SWAP_ROUTER_ADDRESS,
    AERODROME_ROUTER_ADDRESS,
    BASESWAP_ROUTER_ADDRESS,
  ]);
  for (const address of getAllowedAggregatorAddresses()) spenders.add(address);
  if (isV3Active()) {
    for (const address of getBaseDustSweepV3Allowlist().spenders) spenders.add(address.toLowerCase());
  }
  return spenders;
}

const DEFAULT_TOKEN_WHITELIST = [
  {
    address: USDC_ADDRESS,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    logoURI: "https://basescan.org/token/images/centre-usdc_28.png",
    liquidityUSD: 50_000_000,
    source: "default",
  },
  {
    address: WETH_ADDRESS,
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
    liquidityUSD: 50_000_000,
    source: "default",
  },
  {
    address: USDT_ADDRESS,
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png",
    liquidityUSD: 50_000_000,
    source: "default",
  },
  {
    address: WBTC_ADDRESS,
    symbol: "WBTC",
    name: "Wrapped BTC",
    decimals: 8,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png",
    liquidityUSD: 3_000_000,
    source: "default",
  },
] as const;

const QUOTER_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
        name: "params",
        type: "tuple",
      },
    ],
    name: "quoteExactInputSingle",
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "path", type: "bytes" },
      { name: "amountIn", type: "uint256" },
    ],
    name: "quoteExactInput",
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96AfterList", type: "uint160[]" },
      { name: "initializedTicksCrossedList", type: "uint32[]" },
      { name: "gasEstimate", type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const AERODROME_ROUTER_ABI = [
  {
    inputs: [
      { name: "amountIn", type: "uint256" },
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "stable", type: "bool" },
          { name: "factory", type: "address" },
        ],
      },
    ],
    name: "getAmountsOut",
    outputs: [{ name: "amounts", type: "uint256[]" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const BASESWAP_ROUTER_ABI = [
  {
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    name: "getAmountsOut",
    outputs: [{ name: "amounts", type: "uint256[]" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const V3_FACTORY_EVENT_ABI = parseAbi([
  "event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)",
]);
const V2_FACTORY_EVENT_ABI = parseAbi([
  "event PairCreated(address indexed token0,address indexed token1,address pair,uint256)",
]);
const AERODROME_FACTORY_EVENT_ABI = parseAbi([
  "event PairCreated(address indexed token0,address indexed token1,bool stable,address pair,uint256)",
]);
const V3_POOL_CREATED_TOPIC = toEventSelector(
  "PoolCreated(address,address,uint24,int24,address)",
);
const V2_PAIR_CREATED_TOPIC = toEventSelector(
  "PairCreated(address,address,address,uint256)",
);
const AERODROME_PAIR_CREATED_TOPIC = toEventSelector(
  "PairCreated(address,address,bool,address,uint256)",
);

// ── Real compiled ABI — matches DustSweepRouter.sol ──
// The contract has sweepDust (single-hop) and sweepDustMultiHop (multi-hop).
// We use sweepDustMultiHop as the canonical entry since it supports both single and multi-hop routes.
const DUST_SWEEP_ROUTER_ABI = [
  {
    name: "sweepDust",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "orders",
        type: "tuple[]",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "poolFee", type: "uint24" },
          { name: "minAmountOut", type: "uint256" },
        ],
      },
      { name: "tokenOut", type: "address" },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "sweepDustMultiHop",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "orders",
        type: "tuple[]",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "path", type: "bytes" },
          { name: "minAmountOut", type: "uint256" },
        ],
      },
      { name: "tokenOut", type: "address" },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "sweepDustToETH",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "orders",
        type: "tuple[]",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "poolFee", type: "uint24" },
          { name: "minAmountOut", type: "uint256" },
        ],
      },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "sweepDustMultiHopToETH",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "orders",
        type: "tuple[]",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "path", type: "bytes" },
          { name: "minAmountOut", type: "uint256" },
        ],
      },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "MAX_BATCH_SIZE",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const DUST_SWEEP_ROUTER_V2_ABI = [
  {
    name: "sweepWithAllowance",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "target", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
      { name: "outputToken", type: "address" },
      { name: "receiver", type: "address" },
      { name: "minAmountOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [
      { name: "grossAmountOut", type: "uint256" },
      { name: "feeAmount", type: "uint256" },
      { name: "netAmountOut", type: "uint256" },
    ],
  },
  {
    name: "sweepWithPermit2",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "target", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
      { name: "outputToken", type: "address" },
      { name: "receiver", type: "address" },
      { name: "minAmountOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
      {
        name: "permit",
        type: "tuple",
        components: [
          {
            name: "permitted",
            type: "tuple[]",
            components: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint256" },
            ],
          },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [
      { name: "grossAmountOut", type: "uint256" },
      { name: "feeAmount", type: "uint256" },
      { name: "netAmountOut", type: "uint256" },
    ],
  },
  {
    name: "allowedTargets",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "target", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allowedSpenders",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "spender", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// DustSweep V3 (DustSwapSweepRouter). Single sweep() entrypoint with a mode flag; routes use the
// identical tuple shape as V2, plus a SweepParams struct (recipient + per-sweep feeBpsOverride).
// allowedTargets/allowedSpenders share V2's selectors, so the V2 allowlist reader is reused.
const DUST_SWEEP_ROUTER_V3_ABI = [
  {
    name: "sweep",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "mode", type: "uint8" },
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "target", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "outputToken", type: "address" },
          { name: "recipient", type: "address" },
          { name: "minAmountOut", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "feeBpsOverride", type: "uint16" },
        ],
      },
      {
        name: "permit",
        type: "tuple",
        components: [
          {
            name: "permitted",
            type: "tuple[]",
            components: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint256" },
            ],
          },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [
      { name: "grossAmountOut", type: "uint256" },
      { name: "feeAmount", type: "uint256" },
      { name: "netAmountOut", type: "uint256" },
    ],
  },
] as const;

// V3 SweepMode enum (matches the contract).
const V3_SWEEP_MODE = { Permit2Signature: 0, Allowance: 1 } as const;

const SWAP_ROUTER_02_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    name: "exactInput",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "path", type: "bytes" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

const PANCAKE_V3_SWAP_ROUTER_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    name: "exactInput",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "path", type: "bytes" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

const AERODROME_SWAP_ABI = [
  {
    name: "swapExactTokensForTokens",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "stable", type: "bool" },
          { name: "factory", type: "address" },
        ],
      },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

const BASESWAP_SWAP_ABI = [
  {
    name: "swapExactTokensForTokens",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

const UNIVERSAL_ROUTER_ABI = [
  {
    name: "execute",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const V3_DEX_DATA_PARAMETERS = [
  {
    type: "tuple",
    components: [
      { name: "fee", type: "uint24" },
      { name: "isMultiHop", type: "bool" },
      { name: "path", type: "bytes" },
    ],
  },
] as const;

const V4_DEX_DATA_PARAMETERS = [
  { type: "uint24" },
  { type: "int24" },
] as const;

// Aerodrome Slipstream: a single int24 tickSpacing identifies the CL pool.
const SLIPSTREAM_DEX_DATA_PARAMETERS = [{ type: "int24" }] as const;

const SLIPSTREAM_QUOTER_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "tickSpacing", type: "int24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const SLIPSTREAM_SWAP_ROUTER_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "tickSpacing", type: "int24" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

// ── QuickSwap Algebra Integral ABIs ──
// Quoter input struct: (tokenIn, tokenOut, deployer, amountIn, limitSqrtPrice) — selector 0xe94764c4,
// confirmed live on Base. The return tuple is version-specific (6 words on Base), but amountOut is
// always the first word, so the adapter reads word[0] directly rather than decoding the full tuple.
const ALGEBRA_QUOTER_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "deployer", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "limitSqrtPrice", type: "uint160" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

const ALGEBRA_SWAP_ROUTER_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "deployer", type: "address" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "limitSqrtPrice", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

// Algebra single-hop dexData carries the pool deployer (address(0) = default deployer).
const ALGEBRA_DEX_DATA_PARAMETERS = [{ type: "address" }] as const;

const AERODROME_DEX_DATA_PARAMETERS = [
  {
    type: "tuple",
    components: [
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "stable", type: "bool" },
          { name: "factory", type: "address" },
        ],
      },
    ],
  },
] as const;

const GENERIC_DEX_DATA_PARAMETERS = [
  {
    type: "tuple",
    components: [
      { name: "target", type: "address" },
      { name: "spender", type: "address" },
      { name: "data", type: "bytes" },
    ],
  },
] as const;

type PriceConfidence = "HIGH" | "MEDIUM" | "LOW" | "NONE";
type TokenMarketHintSource = "canonical" | "coingecko" | "dexscreener" | "blockscout" | "none";

type TokenBalanceMetadataHint = {
  symbol?: string;
  name?: string;
  decimals?: number;
  logoURI?: string;
  priceUSD?: number;
  liquidityUSD?: number;
  bestDex?: string;
  priceSource?: TokenMarketHintSource;
  priceConfidence?: PriceConfidence;
};

type AlchemyBalance = {
  contractAddress: string;
  tokenBalance: string;
  metadata?: TokenBalanceMetadataHint;
};

type AlchemyTokenBalancesResponse = {
  tokenBalances?: AlchemyBalance[];
  pageKey?: string;
};

type AlchemyTokenBalanceDiscovery = {
  tokenBalances: AlchemyBalance[];
  pageCount: number;
  scannedBalanceCount: number;
  truncated: boolean;
  source: "alchemy" | "blockscout";
  providerError?: string;
};

type TokenWhitelistRow = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logo_uri?: string | null;
  liquidity_usd?: string | number | null;
  source?: string | null;
};

type TokenListToken = {
  chainId?: number;
  address?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  logoURI?: string;
  logo_uri?: string;
};

type DustSweepRoute = {
  tokenIn: Address;
  amountIn: string;
  amountOutMin: string;
  estimatedOut: string;
  dex: number;
  dexName: string;
  dexData: Hex;
  priceImpactBps: number;
  // True when priceImpactBps was computed from the token's market value vs the quoted output —
  // false means no reliable input price existed and priceImpactBps is NOT meaningful.
  priceImpactKnown?: boolean;
  poolFee?: number;
};

type DustSweepV2Route = {
  tokenIn: Address;
  amountIn: bigint;
  target: Address;
  spender: Address;
  value: bigint;
  data: Hex;
};

type Permit2Witness = {
  routeHash: Hex;
  outputToken: Address;
  receiver: Address;
  minAmountOut: string;
  deadline: string;
};

type QuoteCandidate = Omit<DustSweepRoute, "priceImpactBps"> & {
  amountOut: bigint;
  priceImpactBps?: number;
};

type QuoteSkippedToken = {
  token: Address;
  reason: "NO_LIQUIDITY" | "NOT_WHITELISTED" | "BELOW_THRESHOLD" | "BALANCE_CHANGED" | "QUOTE_FAILED" | "NATIVE_WRAP_REQUIRED" | "CANT_TRANSFER";
  message?: string;
};

type TokenDiscoveryStatus =
  | "DISCOVERED"
  | "PRICED"
  | "LIQUIDITY_PENDING"
  | "NOT_SWEEPABLE"
  | "HIDDEN"
  | "SPAM"
  | "UNKNOWN_PRICE"
  | "NO_LIQUIDITY"
  | "NATIVE_WRAP_REQUIRED"
  | "EXCLUDED_OUTPUT_ASSET";

type DiscoveryUnavailableReason =
  | "NO_LIQUIDITY"
  | "NOT_WHITELISTED"
  | "BELOW_THRESHOLD"
  | "BALANCE_CHANGED"
  | "QUOTE_FAILED"
  | "UNKNOWN_PRICE"
  | "SPAM_OR_DENYLISTED"
  | "NATIVE_WRAP_REQUIRED"
  | "OUTPUT_ASSET";

type TokenMarketHint = {
  priceUSD: number;
  liquidityUSD: number;
  bestDex: string;
  source: TokenMarketHintSource;
  confidence: PriceConfidence;
  logoURI?: string;
};

type TokenRiskResult = {
  riskScore: number;
  hiddenByDefault: boolean;
  blockedFromSweep: boolean;
  reasons: string[];
};

type DiscoveryTokenResult = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  balance: string;
  balanceFormatted: string;
  valueUSD: number;
  bestDex: string;
  liquidityUSD: number;
  status: TokenDiscoveryStatus;
  isNative?: boolean;
  wrapRequired?: boolean;
  sourceType: "native" | "wallet";
  priceUSD: number;
  priceSource: TokenMarketHint["source"];
  priceConfidence: PriceConfidence;
  riskScore: number;
  riskReasons: string[];
  reason?: DiscoveryUnavailableReason;
};

type Erc20Metadata = {
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
};

const erc20MetadataCache = new Map<string, { value: Erc20Metadata; expiresAt: number }>();
const whitelistCacheByChain = new Map<
  number,
  { value: Map<string, TokenWhitelistRow>; expiresAt: number }
>();
let ethUsdCache: { price: number; expiresAt: number } | null = null;

function getFeeBps(chain: SweepChainConfig = BASE_CONFIG) {
  // Per-chain fee: non-Base chains read DUST_SWEEP_FEE_BPS_<chainId> (falling back to the global
  // DUST_SWEEP_FEE_BPS), so Ethereum can charge a different fee than Base without affecting it.
  const raw =
    chain.chainId !== BASE_CHAIN_ID
      ? process.env[`DUST_SWEEP_FEE_BPS_${chain.chainId}`] ?? process.env.DUST_SWEEP_FEE_BPS
      : process.env.DUST_SWEEP_FEE_BPS;
  const parsed = Number(raw || "200");
  return Number.isFinite(parsed) ? parsed : 200;
}

// Above this computed (market-value vs quote) impact the quote response asks the UI to require an
// explicit user confirmation before sweeping. 0 disables the gate.
function getMaxImpactBps() {
  const parsed = Number(process.env.DUST_SWEEP_MAX_IMPACT_BPS || "1500");
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(10_000, Math.round(parsed));
}

// When the best NATIVE route loses more than this much of the token's market value, aggregators
// are also consulted ("rescue") and the global best amountOut wins. 0 disables rescue, restoring
// the strict fallback-only behavior. Healthy tokens never trigger it, so aggregator API load stays
// bounded to the tokens that are currently being misquoted.
function getAggregatorRescueImpactBps() {
  const parsed = Number(process.env.DUST_SWEEP_AGGREGATOR_RESCUE_IMPACT_BPS || "300");
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(10_000, Math.round(parsed));
}

class BalanceDiscoveryUnavailableError extends Error {
  readonly status = 503;
  readonly code = "BALANCE_DISCOVERY_UNAVAILABLE";
  readonly retryAfterSeconds = 30;

  constructor(message = "Balance discovery is temporarily unavailable. Please try again shortly.") {
    super(message);
    this.name = "BalanceDiscoveryUnavailableError";
  }
}

function errorJson(message: string, extra?: Record<string, unknown>) {
  return { success: false, error: message, ...(extra || {}) };
}

function normalizeAddress(value: string) {
  return getAddress(value);
}

function sanitizeDbText(value: unknown, fallback: string, maxLength: number) {
  const cleaned = String(value || fallback)
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, maxLength);

  return cleaned || fallback.slice(0, maxLength);
}

function bestDexFromSource(source?: string | null) {
  const normalized = String(source || "").toLowerCase();
  if (normalized.includes("aero")) return "AERODROME";
  if (normalized.includes("cake") || normalized.includes("pancake")) return "PANCAKESWAP_V3";
  if (normalized.includes("baseswap")) return "BASESWAP";
  if (normalized.includes("uni")) return "UNISWAP_V3";
  return "GENERIC";
}

async function alchemyRpc<T>(
  method: string,
  params: unknown[],
  chainId: number = BASE_CHAIN_ID,
): Promise<T> {
  return chainAlchemyRpcRequest<T>(chainId, method, params, {
    timeoutMs: DISCOVERY_ALCHEMY_TIMEOUT_MS,
    maxEndpointAttempts: DISCOVERY_ALCHEMY_MAX_ENDPOINT_ATTEMPTS,
    hedgeCount: DISCOVERY_ALCHEMY_HEDGE_COUNT,
  });
}

function discoveryErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown discovery error");
}

function reachedDiscoveryLimit(count: number, limit: number | null) {
  return limit !== null && count >= limit;
}

function discoveryLimitedBalances<T>(balances: T[]) {
  return DISCOVERY_MAX_ERC20_BALANCES === null
    ? balances
    : balances.slice(0, DISCOVERY_MAX_ERC20_BALANCES);
}

async function fetchAlchemyTokenBalances(
  holder: Address,
  chainId: number = BASE_CHAIN_ID,
): Promise<AlchemyTokenBalanceDiscovery> {
  const tokenBalances: AlchemyBalance[] = [];
  const seen = new Set<string>();
  let pageKey: string | undefined;
  let pageCount = 0;
  let scannedBalanceCount = 0;
  const targetNonZeroBalances =
    DISCOVERY_TARGET_NONZERO_BALANCES === null && DISCOVERY_MAX_ERC20_BALANCES === null
      ? null
      : Math.min(
          DISCOVERY_TARGET_NONZERO_BALANCES ?? Number.MAX_SAFE_INTEGER,
          DISCOVERY_MAX_ERC20_BALANCES ?? Number.MAX_SAFE_INTEGER,
        );

  while (
    !reachedDiscoveryLimit(tokenBalances.length, targetNonZeroBalances) &&
    !reachedDiscoveryLimit(pageCount, DISCOVERY_ALCHEMY_MAX_PAGES)
  ) {
    const remaining =
      targetNonZeroBalances === null
        ? ALCHEMY_TOKEN_BALANCE_PAGE_SIZE
        : Math.max(1, targetNonZeroBalances - tokenBalances.length);
    const maxCount = Math.min(
      ALCHEMY_TOKEN_BALANCE_PAGE_SIZE,
      remaining,
    );
    const options: { maxCount: number; pageKey?: string } = { maxCount };
    if (pageKey) options.pageKey = pageKey;

    const response = await alchemyRpc<AlchemyTokenBalancesResponse>(
      "alchemy_getTokenBalances",
      [holder, "erc20", options],
      chainId,
    );
    pageCount += 1;

    for (const balance of response.tokenBalances || []) {
      scannedBalanceCount += 1;
      if (!isAddress(balance.contractAddress)) continue;
      const key = balance.contractAddress.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        if (BigInt(balance.tokenBalance || "0") <= 0n) continue;
      } catch {
        continue;
      }
      tokenBalances.push(balance);
      if (reachedDiscoveryLimit(tokenBalances.length, targetNonZeroBalances)) break;
    }

    const nextPageKey =
      typeof response.pageKey === "string" && response.pageKey.trim().length > 0
        ? response.pageKey.trim()
        : undefined;
    if (!nextPageKey || nextPageKey === pageKey) {
      return { tokenBalances, pageCount, scannedBalanceCount, truncated: false, source: "alchemy" };
    }

    if (
      reachedDiscoveryLimit(tokenBalances.length, targetNonZeroBalances) ||
      reachedDiscoveryLimit(pageCount, DISCOVERY_ALCHEMY_MAX_PAGES)
    ) {
      return { tokenBalances, pageCount, scannedBalanceCount, truncated: true, source: "alchemy" };
    }

    pageKey = nextPageKey;
  }

  return { tokenBalances, pageCount, scannedBalanceCount, truncated: Boolean(pageKey), source: "alchemy" };
}

function normalizeTokenMetadataHint(
  tokenAddress: Address,
  metadata?: TokenBalanceMetadataHint,
): Erc20Metadata | null {
  if (!metadata) return null;

  const fallbackSymbol = `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`;
  const decimals = Number(metadata.decimals ?? 18);
  return {
    symbol: sanitizeDbText(String(metadata.symbol || fallbackSymbol), fallbackSymbol, 32),
    name: sanitizeDbText(String(metadata.name || metadata.symbol || fallbackSymbol), fallbackSymbol, 120),
    decimals: Number.isFinite(decimals) ? decimals : 18,
    logoURI: metadata.logoURI,
  };
}

type BlockscoutWalletTokenItem = {
  token?: {
    address_hash?: string;
    address?: string;
    name?: string | null;
    symbol?: string | null;
    decimals?: string | number | null;
    icon_url?: string | null;
    type?: string;
    reputation?: string | null;
    exchange_rate?: string | number | null;
  };
  value?: string | number | null;
};

type BlockscoutTokenListItem = {
  balance?: string | number | null;
  contractAddress?: string;
  decimals?: string | number | null;
  name?: string | null;
  symbol?: string | null;
  type?: string | null;
};

function shouldRetryBlockscoutBalanceStatus(status: number) {
  return status === 429 || status >= 500;
}

async function sleepForBlockscoutBalanceRetry(response: Response | null, attempt: number) {
  const retryAfterSeconds = Number(response?.headers.get("retry-after") || 0);
  const waitMs =
    retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : DISCOVERY_BLOCKSCOUT_BALANCE_RETRY_MS * Math.max(1, attempt + 1);
  await sleep(Math.min(waitMs, 30_000));
}

async function fetchBlockscoutWalletTokenPage(
  holder: Address,
  nextPageParams?: Record<string, unknown>,
) {
  const url = new URL(`${getBlockscoutApiV2BaseUrl()}/addresses/${holder}/tokens`);
  url.searchParams.set("type", "ERC-20");

  for (const [key, value] of Object.entries(nextPageParams || {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const apiKey = getBlockscoutApiKey();
  if (apiKey) url.searchParams.set("apikey", apiKey);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= DISCOVERY_BLOCKSCOUT_BALANCE_MAX_RETRIES; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "DustSwap/1.0 (+https://app.dustswap.wtf)",
        },
        signal: AbortSignal.timeout(DISCOVERY_BLOCKSCOUT_BALANCE_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < DISCOVERY_BLOCKSCOUT_BALANCE_MAX_RETRIES) {
        await sleepForBlockscoutBalanceRetry(null, attempt);
        continue;
      }
      throw new Error(`Blockscout wallet token discovery failed: ${lastError.message}`);
    }

    if (response.ok) {
      return (await response.json()) as {
        items?: BlockscoutWalletTokenItem[];
        next_page_params?: Record<string, unknown> | null;
      };
    }

    if (
      shouldRetryBlockscoutBalanceStatus(response.status) &&
      attempt < DISCOVERY_BLOCKSCOUT_BALANCE_MAX_RETRIES
    ) {
      await sleepForBlockscoutBalanceRetry(response, attempt);
      continue;
    }

    throw new Error(`Blockscout wallet token discovery failed with ${response.status}`);
  }

  throw lastError ?? new Error("Blockscout wallet token discovery failed");
}

async function fetchBlockscoutWalletTokenSnapshot(holder: Address) {
  const url = new URL(`${getBlockscoutApiV2BaseUrl()}/addresses/${holder}/token-balances`);
  const apiKey = getBlockscoutApiKey();
  if (apiKey) url.searchParams.set("apikey", apiKey);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= DISCOVERY_BLOCKSCOUT_BALANCE_MAX_RETRIES; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "DustSwap/1.0 (+https://app.dustswap.wtf)",
        },
        signal: AbortSignal.timeout(DISCOVERY_BLOCKSCOUT_BALANCE_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < DISCOVERY_BLOCKSCOUT_BALANCE_MAX_RETRIES) {
        await sleepForBlockscoutBalanceRetry(null, attempt);
        continue;
      }
      throw new Error(`Blockscout wallet token snapshot failed: ${lastError.message}`);
    }

    if (response.ok) {
      const payload = (await response.json()) as BlockscoutWalletTokenItem[] | {
        items?: BlockscoutWalletTokenItem[];
      };
      return Array.isArray(payload) ? payload : payload.items || [];
    }

    if (
      shouldRetryBlockscoutBalanceStatus(response.status) &&
      attempt < DISCOVERY_BLOCKSCOUT_BALANCE_MAX_RETRIES
    ) {
      await sleepForBlockscoutBalanceRetry(response, attempt);
      continue;
    }

    throw new Error(`Blockscout wallet token snapshot failed with ${response.status}`);
  }

  throw lastError ?? new Error("Blockscout wallet token snapshot failed");
}

async function fetchBlockscoutTokenListSnapshot(holder: Address) {
  const url = new URL(getBlockscoutApiV2BaseUrl().replace(/\/api\/v2\/?$/, "/api"));
  url.searchParams.set("module", "account");
  url.searchParams.set("action", "tokenlist");
  url.searchParams.set("address", holder);
  const apiKey = getBlockscoutApiKey();
  if (apiKey) url.searchParams.set("apikey", apiKey);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= DISCOVERY_BLOCKSCOUT_BALANCE_MAX_RETRIES; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "DustSwap/1.0 (+https://app.dustswap.wtf)",
        },
        signal: AbortSignal.timeout(DISCOVERY_BLOCKSCOUT_BALANCE_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < DISCOVERY_BLOCKSCOUT_BALANCE_MAX_RETRIES) {
        await sleepForBlockscoutBalanceRetry(null, attempt);
        continue;
      }
      throw new Error(`Blockscout token list snapshot failed: ${lastError.message}`);
    }

    if (response.ok) {
      const payload = (await response.json()) as {
        message?: string;
        result?: BlockscoutTokenListItem[] | string;
        status?: string;
      };
      if (Array.isArray(payload.result)) return payload.result;
      if (payload.status === "0" && typeof payload.result === "string") {
        throw new Error(payload.result);
      }
      return [];
    }

    if (
      shouldRetryBlockscoutBalanceStatus(response.status) &&
      attempt < DISCOVERY_BLOCKSCOUT_BALANCE_MAX_RETRIES
    ) {
      await sleepForBlockscoutBalanceRetry(response, attempt);
      continue;
    }

    throw new Error(`Blockscout token list snapshot failed with ${response.status}`);
  }

  throw lastError ?? new Error("Blockscout token list snapshot failed");
}

function addBlockscoutWalletTokenItem(
  item: BlockscoutWalletTokenItem,
  tokenBalances: AlchemyBalance[],
  seen: Set<string>,
) {
  const token = item.token;
  const rawAddress = token?.address_hash || token?.address;
  if (!rawAddress || !isAddress(rawAddress)) return;
  if (String(token?.type || "").toUpperCase() !== "ERC-20") return;

  const tokenAddress = normalizeAddress(rawAddress);
  const key = tokenAddress.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);

  let tokenBalance: string;
  try {
    tokenBalance = BigInt(String(item.value ?? "0")).toString();
  } catch {
    return;
  }
  if (BigInt(tokenBalance) <= 0n) return;

  const decimals = Number(token?.decimals ?? 18);
  const priceUSD = Number(token?.exchange_rate ?? 0);
  tokenBalances.push({
    contractAddress: tokenAddress,
    tokenBalance,
    metadata: {
      symbol: token?.symbol || undefined,
      name: token?.name || undefined,
      decimals: Number.isFinite(decimals) ? decimals : 18,
      logoURI: token?.icon_url || undefined,
      priceUSD: Number.isFinite(priceUSD) && priceUSD > 0 ? priceUSD : undefined,
      liquidityUSD: 0,
      bestDex: "GENERIC",
      priceSource: "blockscout",
      priceConfidence: "MEDIUM",
    },
  });
}

function addBlockscoutTokenListItem(
  item: BlockscoutTokenListItem,
  tokenBalances: AlchemyBalance[],
  seen: Set<string>,
) {
  const rawAddress = item.contractAddress;
  if (!rawAddress || !isAddress(rawAddress)) return;
  if (String(item.type || "").toUpperCase() !== "ERC-20") return;

  const tokenAddress = normalizeAddress(rawAddress);
  const key = tokenAddress.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);

  let tokenBalance: string;
  try {
    tokenBalance = BigInt(String(item.balance ?? "0")).toString();
  } catch {
    return;
  }
  if (BigInt(tokenBalance) <= 0n) return;

  const decimals = Number(item.decimals ?? 18);
  tokenBalances.push({
    contractAddress: tokenAddress,
    tokenBalance,
    metadata: {
      symbol: item.symbol || undefined,
      name: item.name || undefined,
      decimals: Number.isFinite(decimals) ? decimals : 18,
    },
  });
}

async function fetchBlockscoutWalletTokenBalances(holder: Address): Promise<AlchemyTokenBalanceDiscovery> {
  const tokenBalances: AlchemyBalance[] = [];
  const seen = new Set<string>();
  const seenCursors = new Set<string>();
  let nextPageParams: Record<string, unknown> | null | undefined;
  let pageCount = 0;
  let scannedBalanceCount = 0;
  let truncated = false;

  try {
    const snapshot = await Promise.any([
      fetchBlockscoutWalletTokenSnapshot(holder).then((items) => ({
        kind: "token-balances" as const,
        items,
      })),
      fetchBlockscoutTokenListSnapshot(holder).then((items) => ({
        kind: "tokenlist" as const,
        items,
      })),
    ]);

    for (const item of snapshot.items) {
      scannedBalanceCount += 1;
      if (snapshot.kind === "token-balances") {
        addBlockscoutWalletTokenItem(item as BlockscoutWalletTokenItem, tokenBalances, seen);
      } else {
        addBlockscoutTokenListItem(item as BlockscoutTokenListItem, tokenBalances, seen);
      }
    }

    return {
      tokenBalances,
      pageCount: snapshot.items.length > 0 ? 1 : 0,
      scannedBalanceCount,
      truncated: false,
      source: "blockscout",
    };
  } catch (snapshotError) {
    console.warn("[dustsweep/tokens] Blockscout token snapshot failed; falling back to paginated tokens", {
      message: discoveryErrorMessage(snapshotError),
    });
  }

  while (!reachedDiscoveryLimit(pageCount, DISCOVERY_BLOCKSCOUT_BALANCE_MAX_PAGES)) {
    const page = await fetchBlockscoutWalletTokenPage(holder, nextPageParams || undefined);
    pageCount += 1;

    for (const item of page.items || []) {
      scannedBalanceCount += 1;
      addBlockscoutWalletTokenItem(item, tokenBalances, seen);
    }

    nextPageParams = page.next_page_params;
    if (!nextPageParams) break;

    const cursorKey = JSON.stringify(nextPageParams);
    if (seenCursors.has(cursorKey)) {
      truncated = true;
      break;
    }
    seenCursors.add(cursorKey);
  }

  if (nextPageParams && reachedDiscoveryLimit(pageCount, DISCOVERY_BLOCKSCOUT_BALANCE_MAX_PAGES)) {
    truncated = true;
  }

  return {
    tokenBalances,
    pageCount,
    scannedBalanceCount,
    truncated,
    source: "blockscout",
  };
}

async function fetchWalletTokenBalances(
  holder: Address,
  chain: SweepChainConfig = BASE_CONFIG,
): Promise<AlchemyTokenBalanceDiscovery> {
  // The Blockscout REST balance snapshot is wired to Base only for now; non-Base chains rely on
  // their dedicated Alchemy keys as the sole discovery source (Alchemy failure → stale cache).
  const blockscoutFallbackEnabled =
    chain.chainId === BASE_CHAIN_ID && DISCOVERY_BLOCKSCOUT_BALANCE_FALLBACK_ENABLED;
  const alchemyBreakerOpen = Date.now() < alchemyDiscoveryBreakerUntil;

  if (!alchemyBreakerOpen || !blockscoutFallbackEnabled) {
    try {
      const result = await fetchAlchemyTokenBalances(holder, chain.chainId);
      if (chain.chainId === BASE_CHAIN_ID) alchemyDiscoveryBreakerUntil = 0;
      return result;
    } catch (alchemyError) {
      const alchemyMessage = discoveryErrorMessage(alchemyError);
      // Full Alchemy failure (typically ALL keys 429 on the Token API) — cool off so the next
      // scans go straight to Blockscout instead of re-burning the keys on every request.
      if (chain.chainId === BASE_CHAIN_ID) {
        alchemyDiscoveryBreakerUntil = Date.now() + DISCOVERY_ALCHEMY_BREAKER_MS;
      }
      console.warn("[dustsweep/tokens] Alchemy balance discovery failed — cooling off", {
        chainId: chain.chainId,
        message: alchemyMessage,
        coolOffMs: DISCOVERY_ALCHEMY_BREAKER_MS,
      });

      if (blockscoutFallbackEnabled) {
        try {
          const fallback = await fetchBlockscoutWalletTokenBalances(holder);
          return {
            ...fallback,
            providerError: `alchemy: ${alchemyMessage}`,
          };
        } catch (blockscoutError) {
          console.warn("[dustsweep/tokens] Blockscout balance discovery failed", {
            message: discoveryErrorMessage(blockscoutError),
          });
        }
      }

      throw new BalanceDiscoveryUnavailableError();
    }
  }

  // Alchemy is cooling off — Blockscout is the primary for this window (Base only).
  try {
    const fallback = await fetchBlockscoutWalletTokenBalances(holder);
    return { ...fallback, providerError: "alchemy: cooling off after rate limit" };
  } catch (blockscoutError) {
    console.warn("[dustsweep/tokens] Blockscout balance discovery failed", {
      message: discoveryErrorMessage(blockscoutError),
    });
    throw new BalanceDiscoveryUnavailableError();
  }
}

async function loadWhitelist(chain: SweepChainConfig = BASE_CONFIG) {
  const cached = whitelistCacheByChain.get(chain.chainId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const map = new Map<string, TokenWhitelistRow>();

  try {
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await postgresDb
        .from("tokens")
        .select("address,symbol,name,decimals,logo_uri,liquidity_usd,source")
        .eq("chain_id", chain.chainId)
        .eq("is_active", true)
        .range(from, from + pageSize - 1);

      if (error || !data?.length) break;

      for (const row of data as TokenWhitelistRow[]) {
        if (row.address && isAddress(row.address)) {
          map.set(row.address.toLowerCase(), row);
        }
      }

      if (data.length < pageSize) break;
    }
  } catch {
    // The app can run before the new whitelist migration is applied.
  }

  // DEFAULT_TOKEN_WHITELIST holds Base addresses only — seed it for Base. Other chains rely on
  // DB-seeded rows + runtime discovery (a missing hint just falls back to on-chain metadata).
  for (const token of chain.chainId === BASE_CHAIN_ID ? DEFAULT_TOKEN_WHITELIST : []) {
    if (!map.has(token.address.toLowerCase())) {
      map.set(token.address.toLowerCase(), {
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        logo_uri: token.logoURI,
        liquidity_usd: token.liquidityUSD,
        source: token.source,
      });
    }
  }

  whitelistCacheByChain.set(chain.chainId, {
    value: map,
    expiresAt: Date.now() + WHITELIST_CACHE_TTL_MS,
  });

  return map;
}

// Concurrency limiter for parallel async tasks
async function pLimit<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function fetchTokenPricesDexScreener(
  addresses: Address[],
  chain: SweepChainConfig = BASE_CONFIG,
): Promise<Record<string, number>> {
  const prices: Record<string, number> = {};
  // DexScreener accepts up to 30 addresses per call — free, no auth, fast
  const BATCH = 30;
  for (let i = 0; i < addresses.length; i += BATCH) {
    const batch = addresses.slice(i, i + BATCH);
    try {
      const response = await fetch(
        `https://api.dexscreener.com/tokens/v1/${chain.dexscreenerSlug}/${batch.join(",")}`,
        {
          headers: {
            Accept: "application/json",
            "User-Agent": "DustSwap/1.0 (+https://app.dustswap.wtf)",
          },
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!response.ok) continue;
      const data = (await response.json()) as
        | Array<{
            priceUsd?: string;
            baseToken?: { address?: string };
            quoteToken?: { address?: string };
            liquidity?: { usd?: number };
          }>
        | {
            pairs?: Array<{
              priceUsd?: string;
              baseToken?: { address?: string };
              quoteToken?: { address?: string };
              liquidity?: { usd?: number };
            }>;
          };
      const pairs = Array.isArray(data) ? data : data.pairs || [];
      // DexScreener returns pairs; use the highest-liquidity pair, not the highest price.
      const bestByToken = new Map<string, { price: number; liquidity: number }>();
      for (const pair of pairs) {
        const price = Number(pair.priceUsd || 0);
        if (!price) continue;
        const tokenAddr = (pair.baseToken?.address || "").toLowerCase();
        if (!tokenAddr) continue;
        const liquidity = Number(pair.liquidity?.usd || 0);
        const existing = bestByToken.get(tokenAddr);
        if (!existing || liquidity > existing.liquidity) {
          bestByToken.set(tokenAddr, {
            price,
            liquidity: Number.isFinite(liquidity) ? liquidity : 0,
          });
        }
      }
      for (const [addr, hint] of bestByToken) {
        prices[addr] = hint.price;
      }
    } catch {
      // ignore batch failure, try next batch
    }
  }
  return prices;
}

async function fetchTokenPrices(addresses: Address[], chain: SweepChainConfig = BASE_CONFIG) {
  const marketHints = await fetchTokenMarketHints(addresses, {}, null, chain);
  return Object.fromEntries(
    Object.entries(marketHints).map(([address, hint]) => [address, hint.priceUSD]),
  );

  const prices: Record<string, number> = {
    [USDC_ADDRESS.toLowerCase()]: 1,
    [USDBC_ADDRESS.toLowerCase()]: 1,
    [USDT_ADDRESS.toLowerCase()]: 1,
    [DAI_ADDRESS.toLowerCase()]: 1,
  };

  if (addresses.length === 0) return prices;

  // Filter out stablecoins already priced above
  const needed = addresses.filter((a) => !prices[a.toLowerCase()]);
  if (needed.length === 0) return prices;

  // Strategy A: DexScreener — free, no auth, best coverage for Base memecoins
  try {
    const dexPrices = await fetchTokenPricesDexScreener(needed);
    for (const [addr, price] of Object.entries(dexPrices)) {
      if (price > 0) prices[addr.toLowerCase()] = price;
    }
  } catch {
    // continue to fallback
  }

  // Strategy B: CoinGecko — for tokens DexScreener missed
  const stillMissing = needed.filter((a) => !prices[a.toLowerCase()]);
  if (stillMissing.length > 0) {
    try {
      const url = new URL("https://api.coingecko.com/api/v3/simple/token_price/base");
      url.searchParams.set("contract_addresses", stillMissing.map((a) => a.toLowerCase()).join(","));
      url.searchParams.set("vs_currencies", "usd");
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(6_000),
      });
      if (response.ok) {
        const data = (await response.json()) as Record<string, { usd?: number }>;
        for (const [address, value] of Object.entries(data)) {
          const priceUsd = Number(value.usd || 0);
          if (priceUsd > 0) {
            prices[address.toLowerCase()] = priceUsd;
          }
        }
      }
    } catch {
      // Prices are display-only; quoting can still proceed.
    }
  }

  return prices;
}

function emptyMarketHint(): TokenMarketHint {
  return {
    priceUSD: 0,
    liquidityUSD: 0,
    bestDex: "GENERIC",
    source: "none",
    confidence: "NONE",
  };
}

function setBestMarketHint(
  hints: Record<string, TokenMarketHint>,
  address: string,
  hint: TokenMarketHint,
) {
  const key = address.toLowerCase();
  const existing = hints[key];
  if (
    !existing ||
    hint.liquidityUSD > existing.liquidityUSD ||
    (existing.priceUSD <= 0 && hint.priceUSD > 0)
  ) {
    const logoURI = hint.logoURI || existing?.logoURI;
    hints[key] = { ...hint, logoURI };
  } else if (!existing.logoURI && hint.logoURI) {
    existing.logoURI = hint.logoURI;
  }
}

function getBalanceProviderMarketHints(balances: AlchemyBalance[]) {
  const hints: Record<string, TokenMarketHint> = {};

  for (const balance of balances) {
    if (!isAddress(balance.contractAddress)) continue;
    const metadata = balance.metadata;
    const priceUSD = Number(metadata?.priceUSD || 0);
    if (!Number.isFinite(priceUSD) || priceUSD <= 0) continue;

    setBestMarketHint(hints, balance.contractAddress, {
      priceUSD,
      liquidityUSD: Math.max(0, Number(metadata?.liquidityUSD || 0)),
      bestDex: metadata?.bestDex || "GENERIC",
      source: metadata?.priceSource || "blockscout",
      confidence: metadata?.priceConfidence || "MEDIUM",
      logoURI: metadata?.logoURI,
    });
  }

  return hints;
}

function isNativeTokenAddress(address: string) {
  return address.toLowerCase() === NATIVE_TOKEN_SENTINEL.toLowerCase();
}

function isOutputAssetAddress(address: string) {
  const key = address.toLowerCase();
  return (
    key === USDC_ADDRESS.toLowerCase() ||
    key === WETH_ADDRESS.toLowerCase() ||
    key === USDT_ADDRESS.toLowerCase() ||
    key === NATIVE_TOKEN_SENTINEL.toLowerCase()
  );
}

async function fetchTokenMarketHintsDexScreener(
  addresses: Address[],
  chain: SweepChainConfig = BASE_CONFIG,
): Promise<Record<string, TokenMarketHint>> {
  const hints: Record<string, TokenMarketHint> = {};
  const batchSize = 30;
  const batches: Address[][] = [];

  for (let i = 0; i < addresses.length; i += batchSize) {
    batches.push(addresses.slice(i, i + batchSize));
  }

  const batchResults = await pLimit(
    batches.map((batch) => async () => {
      const nextHints: Record<string, TokenMarketHint> = {};
      try {
        const response = await fetch(
          `https://api.dexscreener.com/tokens/v1/${chain.dexscreenerSlug}/${batch.join(",")}`,
          {
            headers: {
              Accept: "application/json",
              "User-Agent": "DustSwap/1.0 (+https://app.dustswap.wtf)",
            },
            signal: AbortSignal.timeout(DISCOVERY_MARKET_HINT_TIMEOUT_MS),
          },
        );
        if (!response.ok) return nextHints;

        const data = (await response.json()) as
          | Array<{
              priceUsd?: string;
              dexId?: string;
              baseToken?: { address?: string };
              liquidity?: { usd?: number };
              info?: { imageUrl?: string };
            }>
          | {
              pairs?: Array<{
                priceUsd?: string;
                dexId?: string;
                baseToken?: { address?: string };
                liquidity?: { usd?: number };
                info?: { imageUrl?: string };
              }>;
            };
        const pairs = Array.isArray(data) ? data : data.pairs || [];

        for (const pair of pairs) {
          const priceUSD = Number(pair.priceUsd || 0);
          const liquidityUSD = Number(pair.liquidity?.usd || 0);
          const tokenAddress = pair.baseToken?.address;
          if (!tokenAddress || !Number.isFinite(priceUSD) || priceUSD <= 0) continue;

          setBestMarketHint(nextHints, tokenAddress, {
            priceUSD,
            liquidityUSD: Number.isFinite(liquidityUSD) ? liquidityUSD : 0,
            bestDex: bestDexFromSource(`dexscreener:${pair.dexId || ""}`),
            source: "dexscreener",
            confidence: liquidityUSD >= MIN_WL_LIQUIDITY_USD ? "HIGH" : "MEDIUM",
            logoURI: pair.info?.imageUrl,
          });
        }
      } catch {
        // Discovery is fail-open. Quote validation still runs on demand.
      }
      return nextHints;
    }),
    DISCOVERY_MARKET_HINT_CONCURRENCY,
  );

  for (const result of batchResults) {
    for (const [address, hint] of Object.entries(result)) {
      setBestMarketHint(hints, address, hint);
    }
  }

  return hints;
}

async function fetchCoinGeckoTokenPrices(addresses: Address[]): Promise<Record<string, number>> {
  if (addresses.length === 0) return {};

  const prices: Record<string, number> = {};
  const batchSize = 75;
  const batches: Address[][] = [];

  for (let i = 0; i < addresses.length; i += batchSize) {
    batches.push(addresses.slice(i, i + batchSize));
  }

  const batchResults = await pLimit(
    batches.map((batch) => async () => {
      const nextPrices: Record<string, number> = {};
      try {
        const url = new URL("https://api.coingecko.com/api/v3/simple/token_price/base");
        url.searchParams.set("contract_addresses", batch.map((a) => a.toLowerCase()).join(","));
        url.searchParams.set("vs_currencies", "usd");
        const response = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(DISCOVERY_MARKET_HINT_TIMEOUT_MS),
        });
        if (!response.ok) return nextPrices;

        const data = (await response.json()) as Record<string, { usd?: number }>;
        for (const [address, value] of Object.entries(data)) {
          const priceUSD = Number(value.usd || 0);
          if (Number.isFinite(priceUSD) && priceUSD > 0) {
            nextPrices[address.toLowerCase()] = priceUSD;
          }
        }
      } catch {
        // Price discovery is best-effort; DexScreener and quote checks still apply.
      }
      return nextPrices;
    }),
    Math.min(3, DISCOVERY_MARKET_HINT_CONCURRENCY),
  );

  for (const result of batchResults) {
    Object.assign(prices, result);
  }

  return prices;
}

async function fetchTokenMarketHints(
  addresses: Address[],
  providerHints: Record<string, TokenMarketHint> = {},
  maxExternalAddresses: number | null = null,
  chain: SweepChainConfig = BASE_CONFIG,
): Promise<Record<string, TokenMarketHint>> {
  const hints: Record<string, TokenMarketHint> = {};
  const uniqueAddresses = Array.from(new Set(addresses.map((address) => address.toLowerCase())))
    .filter((address): address is Address => isAddress(address));

  if (uniqueAddresses.length === 0) return hints;

  for (const stable of [chain.usdc, chain.usdt, chain.dai, ...chain.extraStables]) {
    hints[stable.toLowerCase()] = {
      priceUSD: 1,
      liquidityUSD: 50_000_000,
      bestDex: "GENERIC",
      source: "canonical",
      confidence: "HIGH",
    };
  }

  if (
    uniqueAddresses.some(
      (address) =>
        address.toLowerCase() === chain.weth.toLowerCase() ||
        isNativeTokenAddress(address),
    )
  ) {
    const ethUsd = await fetchEthUsdPrice();
    const ethHint: TokenMarketHint = {
      priceUSD: ethUsd,
      liquidityUSD: 50_000_000,
      bestDex: "UNISWAP_V3",
      source: "canonical",
      confidence: "HIGH",
    };
    hints[chain.weth.toLowerCase()] = ethHint;
    hints[NATIVE_TOKEN_SENTINEL.toLowerCase()] = ethHint;
  }

  for (const [address, hint] of Object.entries(providerHints)) {
    setBestMarketHint(hints, address, hint);
  }

  let externalNeeded = uniqueAddresses.filter(
    (address) => !isNativeTokenAddress(address) && (hints[address.toLowerCase()]?.priceUSD || 0) === 0,
  );

  if (maxExternalAddresses !== null) {
    externalNeeded = externalNeeded.slice(0, Math.max(0, maxExternalAddresses));
  }

  const [dexHints, coingeckoPrices] = await Promise.all([
    fetchTokenMarketHintsDexScreener(externalNeeded, chain),
    fetchCoinGeckoTokenPrices(externalNeeded),
  ]);

  for (const [address, priceUSD] of Object.entries(coingeckoPrices)) {
    hints[address] = {
      ...emptyMarketHint(),
      priceUSD,
      source: "coingecko",
      confidence: "MEDIUM",
    };
  }

  for (const [address, hint] of Object.entries(dexHints)) {
    setBestMarketHint(hints, address, hint);
  }

  return hints;
}

// The dustsweep_token_cache table is keyed by `address` only, so multichain rows are namespaced
// in code as `${chainId}:${address}` (Base uses the bare address to preserve existing rows).
function tokenCacheKey(address: Address, chain: SweepChainConfig) {
  const lower = address.toLowerCase();
  return chain.chainId === BASE_CHAIN_ID ? lower : `${chain.chainId}:${lower}`;
}

async function getCachedTokenResult(
  address: Address,
  chain: SweepChainConfig = BASE_CONFIG,
  maxAgeMs = DISCOVERY_DB_CACHE_TTL_MS,
) {
  try {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const { data, error } = await postgresDb
      .from("dustsweep_token_cache")
      .select("payload,updated_at")
      .eq("address", tokenCacheKey(address, chain))
      .gte("updated_at", cutoff)
      .maybeSingle();

    if (!error && data?.payload) {
      return data.payload as unknown;
    }
  } catch {
    // Optional cache table.
  }

  return null;
}

function markTokenResultAsStale(payload: unknown, reason: string) {
  if (!payload || typeof payload !== "object") return payload;

  const typed = payload as Record<string, unknown>;
  const discovery =
    typed.discovery && typeof typed.discovery === "object"
      ? { ...(typed.discovery as Record<string, unknown>) }
      : {};

  return {
    ...typed,
    discovery: {
      ...discovery,
      stale: true,
      staleReason: reason,
    },
  };
}

async function setCachedTokenResult(
  address: Address,
  payload: unknown,
  chain: SweepChainConfig = BASE_CONFIG,
) {
  try {
    await postgresDb.from("dustsweep_token_cache").upsert(
      {
        address: tokenCacheKey(address, chain),
        payload,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "address" },
    );
  } catch {
    // Optional cache table.
  }
}

function getRiskClassification(args: {
  symbol: string;
  name: string;
  tokenAddress: Address;
  hasMetadata: boolean;
  priceUSD: number;
  liquidityUSD: number;
  isVerifiedHint: boolean;
}): TokenRiskResult {
  const reasons: string[] = [];
  let riskScore = 0;
  const label = `${args.symbol} ${args.name}`.toLowerCase();
  const fallbackSymbol = `${args.tokenAddress.slice(0, 6)}...${args.tokenAddress.slice(-4)}`.toLowerCase();

  if (!args.hasMetadata || args.symbol.toLowerCase() === fallbackSymbol) {
    riskScore += 25;
    reasons.push("missing_metadata");
  }

  if (args.priceUSD <= 0) {
    riskScore += 20;
    reasons.push("unknown_price");
  }

  if (args.liquidityUSD <= 0) {
    riskScore += 15;
    reasons.push("no_liquidity_hint");
  }

  if (!args.isVerifiedHint) {
    riskScore += 10;
    reasons.push("unverified_contract");
  }

  if (
    /airdrop|claim|reward|voucher|bonus|visit|http|www\.|\.com|\.xyz|\.top|\.vip|\.app|t\.me|telegram/.test(label)
  ) {
    riskScore += 80;
    reasons.push("spammy_name");
  }

  if (args.symbol.length > 24 || args.name.length > 80) {
    riskScore += 20;
    reasons.push("suspicious_metadata_length");
  }

  return {
    riskScore,
    hiddenByDefault: riskScore >= 45 || args.priceUSD <= 0,
    blockedFromSweep: riskScore >= 80,
    reasons,
  };
}

function roundUsd(value: number) {
  return Number.isFinite(value) ? Math.round(value * 10000) / 10000 : 0;
}

function sortByValueDesc(a: DiscoveryTokenResult, b: DiscoveryTokenResult) {
  return b.valueUSD - a.valueUSD;
}

async function callContract(
  to: Address,
  data: Hex,
  signal?: AbortSignal,
  chainId: number = BASE_CHAIN_ID,
) {
  // Concurrent probes are transparently packed into ONE Multicall3 eth_call (~90-95% fewer RPC
  // requests / Alchemy CU for quoting). Abort-aware callers keep the direct path — a shared
  // batch cannot honor per-call cancellation. On any batch failure the batcher itself re-runs
  // items as direct calls, so behavior is never worse than this direct path.
  // chainRpcRequest(8453, …) / batchedEthCall(…, 8453) delegate 1:1 to the Base path.
  if (!signal && isMulticallBatchingEnabled()) {
    return batchedEthCall(to, data, chainId);
  }
  // 5s timeout per RPC call so one slow node doesn't block the quote pipeline
  return chainRpcRequest<Hex>(chainId, "eth_call", [{ to, data }, "latest"], {
    signal,
    timeoutMs: 5_000,
  });
}

async function tryQuoteV3Single(
  quoter: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  fee: number,
  chainId: number = BASE_CHAIN_ID,
) {
  const data = encodeFunctionData({
    abi: QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
  });
  const result = await callContract(quoter, data, undefined, chainId);
  if (!result || result === "0x") return null;
  const decoded = decodeFunctionResult({
    abi: QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    data: result,
  });
  const amountOut = decoded[0];
  return amountOut > 0n ? amountOut : null;
}

async function tryQuoteV3Path(
  quoter: Address,
  path: Hex,
  amountIn: bigint,
  chainId: number = BASE_CHAIN_ID,
) {
  const data = encodeFunctionData({
    abi: QUOTER_ABI,
    functionName: "quoteExactInput",
    args: [path, amountIn],
  });
  const result = await callContract(quoter, data, undefined, chainId);
  if (!result || result === "0x") return null;
  const decoded = decodeFunctionResult({
    abi: QUOTER_ABI,
    functionName: "quoteExactInput",
    data: result,
  });
  const amountOut = decoded[0];
  return amountOut > 0n ? amountOut : null;
}

function encodeV3Path(tokenIn: Address, feeA: number, tokenMid: Address, feeB: number, tokenOut: Address) {
  return encodePacked(
    ["address", "uint24", "address", "uint24", "address"],
    [tokenIn, feeA, tokenMid, feeB, tokenOut],
  );
}

function encodeV3DexData(fee: number, path: Hex = "0x") {
  return encodeAbiParameters(V3_DEX_DATA_PARAMETERS, [
    { fee, isMultiHop: path !== "0x", path },
  ]);
}

async function getV3QuoteCandidates(args: {
  dex: typeof DEX.UNISWAP_V3 | typeof DEX.PANCAKESWAP_V3;
  dexName: string;
  quoter: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  feeTiers: readonly number[];
  // Per-chain overrides; default to Base so existing Base call sites are unchanged.
  chainId?: number;
  weth?: Address;
  usdc?: Address;
}): Promise<QuoteCandidate[]> {
  const candidates: QuoteCandidate[] = [];
  const chainId = args.chainId ?? BASE_CHAIN_ID;
  const weth = args.weth ?? WETH_ADDRESS;
  const usdc = args.usdc ?? USDC_ADDRESS;

  for (const fee of args.feeTiers) {
    try {
      const amountOut = await tryQuoteV3Single(
        args.quoter,
        args.tokenIn,
        args.tokenOut,
        args.amountIn,
        fee,
        chainId,
      );
      if (!amountOut) continue;
      candidates.push({
        tokenIn: args.tokenIn,
        amountIn: args.amountIn.toString(),
        amountOutMin: "0",
        estimatedOut: amountOut.toString(),
        dex: args.dex,
        dexName: args.dexName,
        dexData: encodeV3DexData(fee),
        poolFee: fee,
        amountOut,
      });
    } catch {
      // Try the next fee tier.
    }
  }

  if (candidates.length > 0 || args.tokenIn.toLowerCase() === weth.toLowerCase()) {
    return candidates;
  }

  // Two-hop: try WETH and USDC as intermediate tokens
  const intermediates: Array<{ mid: Address; label: string }> = [];
  if (args.tokenIn.toLowerCase() !== weth.toLowerCase() && args.tokenOut.toLowerCase() !== weth.toLowerCase()) {
    intermediates.push({ mid: weth, label: "WETH" });
  }
  if (args.tokenIn.toLowerCase() !== usdc.toLowerCase() && args.tokenOut.toLowerCase() !== usdc.toLowerCase()) {
    intermediates.push({ mid: usdc, label: "USDC" });
  }

  for (const { mid, label } of intermediates) {
    for (const [feeA, feeB] of TWO_HOP_FEE_PAIRS) {
      if (!args.feeTiers.includes(feeA) || !args.feeTiers.includes(feeB)) continue;
      try {
        const path = encodeV3Path(args.tokenIn, feeA, mid, feeB, args.tokenOut);
        const amountOut = await tryQuoteV3Path(args.quoter, path, args.amountIn, chainId);
        if (!amountOut) continue;
        candidates.push({
          tokenIn: args.tokenIn,
          amountIn: args.amountIn.toString(),
          amountOutMin: "0",
          estimatedOut: amountOut.toString(),
          dex: args.dex,
          dexName: `${args.dexName} via ${label}`,
          dexData: encodeV3DexData(feeA, path),
          poolFee: feeA,
          amountOut,
        });
      } catch {
        // Try the next path.
      }
    }
  }

  return candidates;
}

function encodeAerodromeRoutes(routes: Array<{ from: Address; to: Address; stable: boolean; factory: Address }>) {
  return encodeAbiParameters(AERODROME_DEX_DATA_PARAMETERS, [{ routes }]);
}

async function tryQuoteAerodromeRoutes(
  amountIn: bigint,
  routes: Array<{ from: Address; to: Address; stable: boolean; factory: Address }>,
) {
  const data = encodeFunctionData({
    abi: AERODROME_ROUTER_ABI,
    functionName: "getAmountsOut",
    args: [amountIn, routes],
  });
  const result = await callContract(AERODROME_ROUTER_ADDRESS, data);
  if (!result || result === "0x") return null;
  const decoded = decodeFunctionResult({
    abi: AERODROME_ROUTER_ABI,
    functionName: "getAmountsOut",
    data: result,
  });
  const amounts = decoded;
  const amountOut = amounts[amounts.length - 1] ?? 0n;
  return amountOut > 0n ? amountOut : null;
}

async function getAerodromeQuoteCandidates(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<QuoteCandidate[]> {
  const candidates: QuoteCandidate[] = [];
  const directRoutes = [false, true].map((stable) => [
    { from: tokenIn, to: tokenOut, stable, factory: AERODROME_FACTORY_ADDRESS },
  ]);

  // 2-hop via WETH and USDC intermediates
  const twoHopRoutes: Array<Array<{ from: Address; to: Address; stable: boolean; factory: Address }>> = [];
  const intermediates: Array<{ mid: Address; skip: boolean }> = [
    { mid: WETH_ADDRESS, skip: tokenIn.toLowerCase() === WETH_ADDRESS.toLowerCase() || tokenOut.toLowerCase() === WETH_ADDRESS.toLowerCase() },
    { mid: USDC_ADDRESS, skip: tokenIn.toLowerCase() === USDC_ADDRESS.toLowerCase() || tokenOut.toLowerCase() === USDC_ADDRESS.toLowerCase() },
  ];
  for (const { mid, skip } of intermediates) {
    if (skip) continue;
    for (const stable of [false, true]) {
      twoHopRoutes.push([
        { from: tokenIn, to: mid, stable: false, factory: AERODROME_FACTORY_ADDRESS },
        { from: mid, to: tokenOut, stable, factory: AERODROME_FACTORY_ADDRESS },
      ]);
    }
  }

  for (const routes of [...directRoutes, ...twoHopRoutes]) {
    try {
      const amountOut = await tryQuoteAerodromeRoutes(amountIn, routes);
      if (!amountOut) continue;
      candidates.push({
        tokenIn,
        amountIn: amountIn.toString(),
        amountOutMin: "0",
        estimatedOut: amountOut.toString(),
        dex: DEX.AERODROME,
        dexName: routes.length > 1 ? "Aerodrome via WETH" : routes[0].stable ? "Aerodrome Stable" : "Aerodrome",
        dexData: encodeAerodromeRoutes(routes),
        amountOut,
      });
    } catch {
      // Try next Aerodrome pool type/path.
    }
  }

  return candidates;
}

async function tryQuoteBaseSwapPath(amountIn: bigint, path: Address[]) {
  const data = encodeFunctionData({
    abi: BASESWAP_ROUTER_ABI,
    functionName: "getAmountsOut",
    args: [amountIn, path],
  });
  const result = await callContract(BASESWAP_ROUTER_ADDRESS, data);
  if (!result || result === "0x") return null;
  const decoded = decodeFunctionResult({
    abi: BASESWAP_ROUTER_ABI,
    functionName: "getAmountsOut",
    data: result,
  });
  const amounts = decoded;
  const amountOut = amounts[amounts.length - 1] ?? 0n;
  return amountOut > 0n ? amountOut : null;
}

async function getBaseSwapQuoteCandidates(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<QuoteCandidate[]> {
  const candidates: QuoteCandidate[] = [];
  const paths: Address[][] = [[tokenIn, tokenOut]];
  if (
    tokenIn.toLowerCase() !== WETH_ADDRESS.toLowerCase() &&
    tokenOut.toLowerCase() !== WETH_ADDRESS.toLowerCase()
  ) {
    paths.push([tokenIn, WETH_ADDRESS, tokenOut]);
  }

  for (const path of paths) {
    try {
      const amountOut = await tryQuoteBaseSwapPath(amountIn, path);
      if (!amountOut) continue;
      candidates.push({
        tokenIn,
        amountIn: amountIn.toString(),
        amountOutMin: "0",
        estimatedOut: amountOut.toString(),
        dex: DEX.BASESWAP,
        dexName: path.length > 2 ? "BaseSwap via WETH" : "BaseSwap",
        dexData: encodeAbiParameters([{ type: "address[]" }], [path]),
        amountOut,
      });
    } catch {
      // Try next BaseSwap path.
    }
  }

  return candidates;
}

function get0xApiKey() {
  return process.env.ZEROX_API_KEY || process.env.ZERO_EX_API_KEY || "";
}

function aggregatorsEnabled() {
  return (
    process.env.DUST_SWEEP_ENABLE_AGGREGATORS !== "false" &&
    Boolean(get0xApiKey()) &&
    getAllowedAggregatorAddresses().size > 0
  );
}

function getAllowedAggregatorAddresses(chain: SweepChainConfig = BASE_CONFIG) {
  if (chain.chainId !== BASE_CHAIN_ID) {
    return getChainAllowedAggregatorAddresses(chain);
  }
  return new Set(
    String(process.env.DUST_SWEEP_ALLOWED_AGGREGATOR_TARGETS || "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => isAddress(item))
      .map((item) => normalizeAddress(item).toLowerCase()),
  );
}

/**
 * The router/taker the aggregator calldata is built for (it holds the tokens during the sweep).
 * Base uses the lane-resolved router; other chains are V3-only and use their configured V3 router.
 */
function getSweepRouterForChain(chain: SweepChainConfig): Address {
  if (chain.chainId === BASE_CHAIN_ID) {
    return getRouterAddressForLane(getExecutionLane());
  }
  return getChainRouterV3Address(chain) ?? ZERO_ADDRESS;
}

async function get0xQuoteCandidate(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  slippageBps: number,
  chain: SweepChainConfig = BASE_CONFIG,
): Promise<QuoteCandidate | null> {
  const taker = getSweepRouterForChain(chain);
  const liveOnBase = chain.chainId !== BASE_CHAIN_ID || aggregatorsEnabled();
  if (!liveOnBase || !isAddress(taker) || taker === ZERO_ADDRESS) return null;

  try {
    const url = new URL("https://api.0x.org/swap/allowance-holder/quote");
    url.searchParams.set("chainId", String(chain.chainId));
    url.searchParams.set("sellToken", tokenIn);
    url.searchParams.set("buyToken", tokenOut);
    url.searchParams.set("sellAmount", amountIn.toString());
    url.searchParams.set("taker", taker);
    url.searchParams.set("recipient", taker);
    url.searchParams.set("slippageBps", String(slippageBps));

    const response = await fetch(url, {
      headers: {
        "0x-api-key": get0xApiKey(),
        "0x-version": "v2",
        Accept: "application/json",
      },
    });
    reportAggregatorHttpStatus("zerox", response.status, chain.chainId);
    if (!response.ok) return null;

    const quote = (await response.json()) as {
      liquidityAvailable?: boolean;
      buyAmount?: string;
      transaction?: { to?: string; data?: string; value?: string };
      issues?: { allowance?: { spender?: string } };
      allowanceTarget?: string;
    };

    if (quote.liquidityAvailable === false || !quote.buyAmount || !quote.transaction?.to || !quote.transaction?.data) {
      return null;
    }
    if (!isAddress(quote.transaction.to) || quote.transaction.value && BigInt(quote.transaction.value) > 0n) {
      return null;
    }

    const spenderRaw = quote.issues?.allowance?.spender || quote.allowanceTarget || ZEROX_ALLOWANCE_HOLDER;
    if (!isAddress(spenderRaw)) return null;
    const target = normalizeAddress(quote.transaction.to);
    const spender = normalizeAddress(spenderRaw);
    const allowedAggregatorAddresses = getAllowedAggregatorAddresses(chain);
    if (
      !allowedAggregatorAddresses.has(target.toLowerCase()) ||
      !allowedAggregatorAddresses.has(spender.toLowerCase())
    ) {
      return null;
    }

    const amountOut = BigInt(quote.buyAmount);
    if (amountOut <= 0n) return null;

    return {
      tokenIn,
      amountIn: amountIn.toString(),
      amountOutMin: "0",
      estimatedOut: amountOut.toString(),
      dex: DEX.GENERIC,
      dexName: "0x Aggregator",
      dexData: encodeAbiParameters(GENERIC_DEX_DATA_PARAMETERS, [
        {
          target,
          spender,
          data: quote.transaction.data as Hex,
        },
      ]),
      amountOut,
    };
  } catch {
    return null;
  }
}

function lifiEnabled() {
  return (
    process.env.DUST_SWEEP_ENABLE_AGGREGATORS !== "false" &&
    process.env.DUST_SWEEP_ENABLE_LIFI === "true" &&
    getAllowedAggregatorAddresses().size > 0
  );
}

// LI.FI is the SECOND aggregator fallback (after 0x), same-chain Base only. It is consulted only
// when no native DEX route exists. We bind taker = recipient = the sweep router, reject any route
// that bridges (chain id != Base) or requires native value, and gate the returned target/spender
// against the aggregator allowlist (DUST_SWEEP_ALLOWED_AGGREGATOR_TARGETS) exactly like 0x.
async function getLifiQuoteCandidate(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  slippageBps: number,
  chain: SweepChainConfig = BASE_CONFIG,
): Promise<QuoteCandidate | null> {
  const taker = getSweepRouterForChain(chain);
  const baseGate = chain.chainId !== BASE_CHAIN_ID || lifiEnabled();
  if (!baseGate || !isAddress(taker) || taker === ZERO_ADDRESS) return null;

  try {
    const url = new URL("https://li.quest/v1/quote");
    url.searchParams.set("fromChain", String(chain.chainId));
    url.searchParams.set("toChain", String(chain.chainId));
    url.searchParams.set("fromToken", tokenIn);
    url.searchParams.set("toToken", tokenOut);
    url.searchParams.set("fromAmount", amountIn.toString());
    url.searchParams.set("fromAddress", taker);
    url.searchParams.set("toAddress", taker);
    url.searchParams.set("slippage", String(Math.max(0, slippageBps) / 10_000));

    const headers: Record<string, string> = { Accept: "application/json" };
    const apiKey = process.env.LIFI_API_KEY || process.env.LIFI_API_KEYS;
    if (apiKey) headers["x-lifi-api-key"] = apiKey.split(",")[0]!.trim();

    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
    reportAggregatorHttpStatus("lifi", response.status, chain.chainId);
    if (!response.ok) return null;

    const quote = (await response.json()) as {
      estimate?: { toAmount?: string; approvalAddress?: string };
      action?: { fromChainId?: number; toChainId?: number };
      transactionRequest?: { to?: string; data?: string; value?: string; chainId?: number };
    };

    // Same-chain only — reject any bridge route.
    if (
      quote.action &&
      (Number(quote.action.fromChainId) !== chain.chainId ||
        Number(quote.action.toChainId) !== chain.chainId)
    ) {
      return null;
    }
    if (
      quote.transactionRequest?.chainId &&
      Number(quote.transactionRequest.chainId) !== chain.chainId
    ) {
      return null;
    }

    const toAmount = quote.estimate?.toAmount;
    const tx = quote.transactionRequest;
    const spenderRaw = quote.estimate?.approvalAddress;
    if (!toAmount || !tx?.to || !tx?.data || !spenderRaw) return null;
    if (!isAddress(tx.to) || !isAddress(spenderRaw)) return null;
    if (tx.value && BigInt(tx.value) > 0n) return null;

    const target = normalizeAddress(tx.to);
    const spender = normalizeAddress(spenderRaw);
    const allowedAggregatorAddresses = getAllowedAggregatorAddresses(chain);
    if (
      !allowedAggregatorAddresses.has(target.toLowerCase()) ||
      !allowedAggregatorAddresses.has(spender.toLowerCase())
    ) {
      return null;
    }

    const amountOut = BigInt(toAmount);
    if (amountOut <= 0n) return null;

    return {
      tokenIn,
      amountIn: amountIn.toString(),
      amountOutMin: "0",
      estimatedOut: amountOut.toString(),
      dex: DEX.GENERIC,
      dexName: "LI.FI Aggregator",
      dexData: encodeAbiParameters(GENERIC_DEX_DATA_PARAMETERS, [
        {
          target,
          spender,
          data: tx.data as Hex,
        },
      ]),
      amountOut,
    };
  } catch {
    return null;
  }
}

function openOceanEnabled() {
  return (
    process.env.DUST_SWEEP_ENABLE_AGGREGATORS !== "false" &&
    process.env.DUST_SWEEP_ENABLE_OPENOCEAN === "true" &&
    getAllowedAggregatorAddresses().size > 0
  );
}

// OpenOcean gas price (gwei) is now per-chain via chain.openOceanGasPriceGwei (fed to the v4 swap
// endpoint purely so it can weight gas cost when picking a route; the actual on-chain gas price is
// set by the outer sweep tx, not this calldata).

// OpenOcean is a same-chain aggregator fallback (consulted after 0x and LI.FI, only when no
// native DEX route exists). The v4 GET /swap endpoint returns ready-to-call calldata; we pin
// account = the sweep router so the swapped output is sent to the router, pass amountDecimals (raw
// base units, NEVER human units) and slippage as a percent (1 = 1%), reject any route that requires
// native value, and gate the returned router (target == spender == the OpenOcean exchange proxy)
// against the aggregator allowlist (DUST_SWEEP_ALLOWED_AGGREGATOR_TARGETS) exactly like 0x / LI.FI.
async function getOpenOceanQuoteCandidate(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  slippageBps: number,
  chain: SweepChainConfig = BASE_CONFIG,
): Promise<QuoteCandidate | null> {
  const taker = getSweepRouterForChain(chain);
  const baseGate = chain.chainId !== BASE_CHAIN_ID || openOceanEnabled();
  if (!baseGate || !isAddress(taker) || taker === ZERO_ADDRESS) return null;

  try {
    const url = new URL(`https://open-api.openocean.finance/v4/${chain.openOceanSlug}/swap`);
    url.searchParams.set("inTokenAddress", tokenIn);
    url.searchParams.set("outTokenAddress", tokenOut);
    url.searchParams.set("amountDecimals", amountIn.toString());
    url.searchParams.set("gasPrice", String(chain.openOceanGasPriceGwei));
    url.searchParams.set("slippage", String(Math.min(50, Math.max(0.05, slippageBps / 100))));
    url.searchParams.set("account", taker);

    const headers: Record<string, string> = { Accept: "application/json" };
    const apiKey = process.env.OPENOCEAN_API_KEY;
    if (apiKey) headers.apikey = apiKey.trim();

    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
    reportAggregatorHttpStatus("openocean", response.status, chain.chainId);
    if (!response.ok) return null;

    const quote = (await response.json()) as {
      code?: number;
      data?: {
        to?: string;
        data?: string;
        value?: string;
        outAmount?: string;
        chainId?: number;
      };
    };

    if (Number(quote.code) !== 200 || !quote.data) return null;
    const swap = quote.data;
    if (swap.chainId && Number(swap.chainId) !== chain.chainId) return null;
    if (!swap.to || !swap.data || !swap.outAmount) return null;
    if (!isAddress(swap.to) || !isHex(swap.data)) return null;
    if (swap.value && BigInt(swap.value) > 0n) return null;

    // OpenOcean: the router contract IS the spender — approve + call the same address.
    const target = normalizeAddress(swap.to);
    const spender = target;
    const allowedAggregatorAddresses = getAllowedAggregatorAddresses(chain);
    if (
      !allowedAggregatorAddresses.has(target.toLowerCase()) ||
      !allowedAggregatorAddresses.has(spender.toLowerCase())
    ) {
      return null;
    }

    const amountOut = BigInt(swap.outAmount);
    if (amountOut <= 0n) return null;

    return {
      tokenIn,
      amountIn: amountIn.toString(),
      amountOutMin: "0",
      estimatedOut: amountOut.toString(),
      dex: DEX.GENERIC,
      dexName: "OpenOcean Aggregator",
      dexData: encodeAbiParameters(GENERIC_DEX_DATA_PARAMETERS, [
        {
          target,
          spender,
          data: swap.data as Hex,
        },
      ]),
      amountOut,
    };
  } catch {
    return null;
  }
}

function odosEnabled() {
  return (
    process.env.DUST_SWEEP_ENABLE_AGGREGATORS !== "false" &&
    process.env.DUST_SWEEP_ENABLE_ODOS === "true" &&
    getAllowedAggregatorAddresses().size > 0
  );
}

// Odos is a same-chain Base aggregator fallback (consulted last, only when no native / 0x / LI.FI
// route exists). It is a TWO-step API: POST /sor/quote/v2 returns a pathId + outAmounts, then POST
// /sor/assemble turns that pathId into executable calldata. We pin userAddr = the sweep router so
// the input is pulled from msg.sender (== the router, which holds the approval) and the output is
// sent to userAddr (== the router); reject any route needing native value; and gate the assembled
// router (target == spender == the Odos router) against the aggregator allowlist exactly like 0x /
// LI.FI. A public IP is aggressively rate-limited — set ODOS_API_KEY for reliable server-side use.
async function getOdosQuoteCandidate(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  slippageBps: number,
  chain: SweepChainConfig = BASE_CONFIG,
): Promise<QuoteCandidate | null> {
  const taker = getSweepRouterForChain(chain);
  const baseGate = chain.chainId !== BASE_CHAIN_ID || odosEnabled();
  if (!baseGate || !isAddress(taker) || taker === ZERO_ADDRESS) return null;

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    const apiKey = process.env.ODOS_API_KEY;
    if (apiKey) headers["x-api-key"] = apiKey.trim();

    // Step 1 — quote. amount is in raw base units; slippageLimitPercent is a percent (1 = 1%).
    const quoteResponse = await fetch("https://api.odos.xyz/sor/quote/v2", {
      method: "POST",
      headers,
      body: JSON.stringify({
        chainId: chain.chainId,
        inputTokens: [{ tokenAddress: tokenIn, amount: amountIn.toString() }],
        outputTokens: [{ tokenAddress: tokenOut, proportion: 1 }],
        userAddr: taker,
        slippageLimitPercent: Math.min(50, Math.max(0.05, slippageBps / 100)),
        disableRFQs: true,
        compact: true,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    reportAggregatorHttpStatus("odos", quoteResponse.status, chain.chainId);
    if (!quoteResponse.ok) return null;

    const quote = (await quoteResponse.json()) as {
      pathId?: string;
      outAmounts?: string[];
    };
    if (!quote.pathId || !Array.isArray(quote.outAmounts) || !quote.outAmounts[0]) return null;

    // Step 2 — assemble the pathId into executable calldata (output goes to userAddr == router).
    const assembleResponse = await fetch("https://api.odos.xyz/sor/assemble", {
      method: "POST",
      headers,
      body: JSON.stringify({ userAddr: taker, pathId: quote.pathId, simulate: false }),
      signal: AbortSignal.timeout(8_000),
    });
    reportAggregatorHttpStatus("odos", assembleResponse.status, chain.chainId);
    if (!assembleResponse.ok) return null;

    const assembled = (await assembleResponse.json()) as {
      transaction?: { to?: string; data?: string; value?: string; chainId?: number };
    };
    const tx = assembled.transaction;
    if (!tx?.to || !tx?.data) return null;
    if (!isAddress(tx.to) || !isHex(tx.data)) return null;
    if (tx.chainId && Number(tx.chainId) !== chain.chainId) return null;
    if (tx.value && BigInt(tx.value) > 0n) return null;

    // Odos: the router contract IS the spender — approve + call the same address.
    const target = normalizeAddress(tx.to);
    const spender = target;
    const allowedAggregatorAddresses = getAllowedAggregatorAddresses(chain);
    if (
      !allowedAggregatorAddresses.has(target.toLowerCase()) ||
      !allowedAggregatorAddresses.has(spender.toLowerCase())
    ) {
      return null;
    }

    const amountOut = BigInt(quote.outAmounts[0]);
    if (amountOut <= 0n) return null;

    return {
      tokenIn,
      amountIn: amountIn.toString(),
      amountOutMin: "0",
      estimatedOut: amountOut.toString(),
      dex: DEX.GENERIC,
      dexName: "Odos Aggregator",
      dexData: encodeAbiParameters(GENERIC_DEX_DATA_PARAMETERS, [
        {
          target,
          spender,
          data: tx.data as Hex,
        },
      ]),
      amountOut,
    };
  } catch {
    return null;
  }
}

function kyberEnabled() {
  return (
    process.env.DUST_SWEEP_ENABLE_AGGREGATORS !== "false" &&
    process.env.DUST_SWEEP_ENABLE_KYBER === "true" &&
    getAllowedAggregatorAddresses().size > 0
  );
}

const KYBER_CLIENT_ID = process.env.DUST_SWEEP_KYBER_CLIENT_ID || "dustswap";

// KyberSwap is a keyless same-chain Base aggregator (public API, no API key required) with the
// widest long-tail pool coverage we've verified — it indexes secondary/clone CL factories that
// native routing can't reach. TWO-step API: GET /routes returns a routeSummary + routerAddress,
// then POST /route/build turns the summary into executable calldata. We pin sender = recipient =
// the sweep router, reject any route needing native value, and gate the returned router
// (target == spender == Kyber MetaAggregationRouterV2) against the aggregator allowlist exactly
// like 0x / LI.FI / OpenOcean / Odos.
async function getKyberQuoteCandidate(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  slippageBps: number,
  chain: SweepChainConfig = BASE_CONFIG,
): Promise<QuoteCandidate | null> {
  const taker = getSweepRouterForChain(chain);
  const baseGate = chain.chainId !== BASE_CHAIN_ID || kyberEnabled();
  if (!baseGate || !isAddress(taker) || taker === ZERO_ADDRESS) return null;

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "x-client-id": KYBER_CLIENT_ID,
    };

    // Step 1 — route summary.
    const url = new URL(`https://aggregator-api.kyberswap.com/${chain.kyberSlug}/api/v1/routes`);
    url.searchParams.set("tokenIn", tokenIn);
    url.searchParams.set("tokenOut", tokenOut);
    url.searchParams.set("amountIn", amountIn.toString());
    const routeResponse = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
    reportAggregatorHttpStatus("kyber", routeResponse.status, chain.chainId);
    if (!routeResponse.ok) return null;

    const routeJson = (await routeResponse.json()) as {
      code?: number;
      data?: {
        routeSummary?: { amountOut?: string } & Record<string, unknown>;
        routerAddress?: string;
      };
    };
    const routeSummary = routeJson.data?.routeSummary;
    const routerAddressRaw = routeJson.data?.routerAddress;
    if (Number(routeJson.code) !== 0 || !routeSummary || !routerAddressRaw) return null;
    if (!isAddress(routerAddressRaw)) return null;

    // Step 2 — build executable calldata from the summary.
    const buildResponse = await fetch(
      `https://aggregator-api.kyberswap.com/${chain.kyberSlug}/api/v1/route/build`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          routeSummary,
          sender: taker,
          recipient: taker,
          slippageTolerance: Math.max(1, Math.min(2_000, Math.round(slippageBps))),
          source: KYBER_CLIENT_ID,
        }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    reportAggregatorHttpStatus("kyber", buildResponse.status, chain.chainId);
    if (!buildResponse.ok) return null;

    const buildJson = (await buildResponse.json()) as {
      code?: number;
      data?: {
        data?: string;
        routerAddress?: string;
        amountOut?: string;
        transactionValue?: string;
      };
    };
    if (Number(buildJson.code) !== 0 || !buildJson.data?.data) return null;
    if (!isHex(buildJson.data.data)) return null;
    if (buildJson.data.transactionValue && BigInt(buildJson.data.transactionValue) > 0n) return null;

    // Kyber: the MetaAggregationRouterV2 pulls the input via allowance — it IS the spender.
    const target = normalizeAddress(buildJson.data.routerAddress || routerAddressRaw);
    const spender = target;
    const allowedAggregatorAddresses = getAllowedAggregatorAddresses(chain);
    if (
      !allowedAggregatorAddresses.has(target.toLowerCase()) ||
      !allowedAggregatorAddresses.has(spender.toLowerCase())
    ) {
      return null;
    }

    const amountOut = BigInt(buildJson.data.amountOut || routeSummary.amountOut || "0");
    if (amountOut <= 0n) return null;

    return {
      tokenIn,
      amountIn: amountIn.toString(),
      amountOutMin: "0",
      estimatedOut: amountOut.toString(),
      dex: DEX.GENERIC,
      dexName: "KyberSwap Aggregator",
      dexData: encodeAbiParameters(GENERIC_DEX_DATA_PARAMETERS, [
        {
          target,
          spender,
          data: buildJson.data.data as Hex,
        },
      ]),
      amountOut,
    };
  } catch {
    return null;
  }
}

// ── Uniswap V4 Quoting ──────────────────────────────────────────────────────
const UNISWAP_V4_QUOTER_ADDRESS = (process.env.UNISWAP_V4_QUOTER_ADDRESS ||
  "0x0d5e0f971ed27fbff6c2837bf31316121532048d") as Address;

// Deployed Base V4 Quoter (0x0d5e0f97…) interface, confirmed live 2026-06-09: no sqrtPriceLimitX96
// in params, returns (uint256 amountOut, uint256 gasEstimate). The older deltaAmounts[] ABI reverts.
const V4_QUOTER_ABI = [
  {
    inputs: [
      {
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
        name: "params",
        type: "tuple",
      },
    ],
    name: "quoteExactInputSingle",
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// V4 fee → tickSpacing mapping (standard Uniswap V4 defaults)
const V4_FEE_TICK_SPACING = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
] as const;
const UNIVERSAL_ROUTER_COMMAND_V4_SWAP = "0x10" as Hex;
const V4_ACTIONS_EXACT_IN_SINGLE = "0x060c0f" as Hex;

async function tryQuoteV4Single(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  fee: number,
  tickSpacing: number,
): Promise<bigint | null> {
  // V4 requires currency0 < currency1 (sorted numerically)
  const sorted = BigInt(tokenIn) < BigInt(tokenOut);
  const currency0 = sorted ? tokenIn : tokenOut;
  const currency1 = sorted ? tokenOut : tokenIn;
  const zeroForOne = sorted; // if tokenIn is currency0, we swap 0→1

  const data = encodeFunctionData({
    abi: V4_QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [{
      poolKey: {
        currency0,
        currency1,
        fee,
        tickSpacing,
        hooks: "0x0000000000000000000000000000000000000000" as Address,
      },
      zeroForOne,
      exactAmount: amountIn <= BigInt("170141183460469231731687303715884105727")
        ? amountIn
        : BigInt("170141183460469231731687303715884105727"), // uint128 max
      hookData: "0x" as Hex,
    }],
  });

  try {
    const result = await callContract(UNISWAP_V4_QUOTER_ADDRESS, data);
    if (!result || result === "0x") return null;
    const decoded = decodeFunctionResult({
      abi: V4_QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      data: result,
    });
    const amountOut = decoded[0]; // (amountOut, gasEstimate)
    return amountOut > 0n ? amountOut : null;
  } catch {
    return null;
  }
}

async function getV4QuoteCandidates(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<QuoteCandidate[]> {
  const candidates: QuoteCandidate[] = [];

  for (const { fee, tickSpacing } of V4_FEE_TICK_SPACING) {
    try {
      const amountOut = await tryQuoteV4Single(tokenIn, tokenOut, amountIn, fee, tickSpacing);
      if (!amountOut) continue;
      // V4 uses DEX.UNISWAP_V4 = 1 — encode dexData with fee + tickSpacing
      candidates.push({
        tokenIn,
        amountIn: amountIn.toString(),
        amountOutMin: "0",
        estimatedOut: amountOut.toString(),
        dex: DEX.UNISWAP_V4,
        dexName: "Uniswap V4",
        dexData: encodeAbiParameters(V4_DEX_DATA_PARAMETERS, [fee, tickSpacing]),
        poolFee: fee,
        amountOut,
      });
    } catch {
      // Try next fee tier.
    }
  }

  return candidates;
}

async function tryQuoteSlipstreamSingle(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  tickSpacing: number,
) {
  const data = encodeFunctionData({
    abi: SLIPSTREAM_QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn, tickSpacing, sqrtPriceLimitX96: 0n }],
  });
  const result = await callContract(AERODROME_SLIPSTREAM_QUOTER_ADDRESS, data);
  if (!result || result === "0x") return null;
  const decoded = decodeFunctionResult({
    abi: SLIPSTREAM_QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    data: result,
  });
  const amountOut = decoded[0];
  return amountOut > 0n ? amountOut : null;
}

async function getSlipstreamQuoteCandidates(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<QuoteCandidate[]> {
  const candidates: QuoteCandidate[] = [];
  for (const tickSpacing of AERODROME_SLIPSTREAM_TICK_SPACINGS) {
    try {
      const amountOut = await tryQuoteSlipstreamSingle(tokenIn, tokenOut, amountIn, tickSpacing);
      if (!amountOut) continue;
      candidates.push({
        tokenIn,
        amountIn: amountIn.toString(),
        amountOutMin: "0",
        estimatedOut: amountOut.toString(),
        dex: DEX.AERODROME_SLIPSTREAM,
        dexName: `Aerodrome Slipstream (ts ${tickSpacing})`,
        dexData: encodeAbiParameters(SLIPSTREAM_DEX_DATA_PARAMETERS, [tickSpacing]),
        poolFee: tickSpacing,
        amountOut,
      });
    } catch {
      // Try the next tick spacing.
    }
  }
  return candidates;
}

function algebraEnabled() {
  return process.env.DUST_SWEEP_ENABLE_ALGEBRA === "true";
}

function alienBaseEnabled() {
  return process.env.DUST_SWEEP_ENABLE_ALIENBASE === "true";
}

function hydrexEnabled() {
  return process.env.DUST_SWEEP_ENABLE_HYDREX === "true";
}

async function tryQuoteAlgebraSingle(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  deployer: Address,
  quoter: Address = ALGEBRA_QUOTER_ADDRESS,
) {
  const data = encodeFunctionData({
    abi: ALGEBRA_QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, deployer, amountIn, limitSqrtPrice: 0n }],
  });
  const result = await callContract(quoter, data);
  if (!result || result.length < 66) return null;
  // amountOut is the first 32-byte return word across Algebra quoter versions.
  const amountOut = BigInt(result.slice(0, 66) as Hex);
  return amountOut > 0n ? amountOut : null;
}

async function getAlgebraQuoteCandidates(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<QuoteCandidate[]> {
  // Single-hop only (deepest pool, default deployer). Multi-hop is left to the aggregator fallback.
  try {
    const amountOut = await tryQuoteAlgebraSingle(tokenIn, tokenOut, amountIn, ZERO_ADDRESS);
    if (!amountOut) return [];
    return [
      {
        tokenIn,
        amountIn: amountIn.toString(),
        amountOutMin: "0",
        estimatedOut: amountOut.toString(),
        dex: DEX.ALGEBRA,
        dexName: "QuickSwap (Algebra)",
        dexData: encodeAbiParameters(ALGEBRA_DEX_DATA_PARAMETERS, [ZERO_ADDRESS]),
        amountOut,
      },
    ];
  } catch {
    return [];
  }
}

// Hydrex is an Algebra Integral fork, so it reuses the exact QuickSwap quoting path with its own
// quoter/router. Single-hop only (deepest pool, default deployer) — multi-hop stays with the
// aggregator rescue/fallback.
async function getHydrexQuoteCandidates(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<QuoteCandidate[]> {
  try {
    const amountOut = await tryQuoteAlgebraSingle(
      tokenIn,
      tokenOut,
      amountIn,
      ZERO_ADDRESS,
      HYDREX_QUOTER_ADDRESS,
    );
    if (!amountOut) return [];
    return [
      {
        tokenIn,
        amountIn: amountIn.toString(),
        amountOutMin: "0",
        estimatedOut: amountOut.toString(),
        dex: DEX.HYDREX,
        dexName: "Hydrex",
        dexData: encodeAbiParameters(ALGEBRA_DEX_DATA_PARAMETERS, [ZERO_ADDRESS]),
        amountOut,
      },
    ];
  } catch {
    return [];
  }
}

async function tryQuoteUniV2Path(
  router: Address,
  amountIn: bigint,
  path: Address[],
  chainId: number = BASE_CHAIN_ID,
) {
  const data = encodeFunctionData({
    abi: BASESWAP_ROUTER_ABI,
    functionName: "getAmountsOut",
    args: [amountIn, path],
  });
  const result = await callContract(router, data, undefined, chainId);
  if (!result || result === "0x") return null;
  const decoded = decodeFunctionResult({
    abi: BASESWAP_ROUTER_ABI,
    functionName: "getAmountsOut",
    data: result,
  });
  const amountOut = decoded[decoded.length - 1] ?? 0n;
  return amountOut > 0n ? amountOut : null;
}

// Generic UniV2 (getAmountsOut / swapExactTokensForTokens) quote adapter, parameterized by router.
// Used for AlienBase (Base) and for Ethereum native UniV2 clones (Uniswap V2, SushiSwap).
// `embedRouter` picks the dexData shape:
//   - false (Base AlienBase): dexData = (address[] path); build-tx supplies the target from the enum.
//   - true  (chain-agnostic): dexData = (address router, address[] path) with dex = UNIV2_GENERIC,
//     so one calldata builder targets the embedded router on any chain.
async function getUniV2QuoteCandidates(args: {
  router: Address;
  dex: number;
  dexName: string;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  chain?: SweepChainConfig;
  embedRouter?: boolean;
}): Promise<QuoteCandidate[]> {
  const chain = args.chain ?? BASE_CONFIG;
  const weth = chain.weth;
  const usdc = chain.usdc;
  const candidates: QuoteCandidate[] = [];
  const paths: Address[][] = [[args.tokenIn, args.tokenOut]];
  if (
    args.tokenIn.toLowerCase() !== weth.toLowerCase() &&
    args.tokenOut.toLowerCase() !== weth.toLowerCase()
  ) {
    paths.push([args.tokenIn, weth, args.tokenOut]);
  }
  if (
    args.tokenIn.toLowerCase() !== usdc.toLowerCase() &&
    args.tokenOut.toLowerCase() !== usdc.toLowerCase()
  ) {
    paths.push([args.tokenIn, usdc, args.tokenOut]);
  }

  for (const path of paths) {
    try {
      const amountOut = await tryQuoteUniV2Path(args.router, args.amountIn, path, chain.chainId);
      if (!amountOut) continue;
      const midLabel =
        path.length > 2
          ? path[1].toLowerCase() === weth.toLowerCase()
            ? " via WETH"
            : " via USDC"
          : "";
      candidates.push({
        tokenIn: args.tokenIn,
        amountIn: args.amountIn.toString(),
        amountOutMin: "0",
        estimatedOut: amountOut.toString(),
        dex: args.embedRouter ? DEX.UNIV2_GENERIC : args.dex,
        dexName: `${args.dexName}${midLabel}`,
        dexData: args.embedRouter
          ? encodeAbiParameters([{ type: "address" }, { type: "address[]" }], [args.router, path])
          : encodeAbiParameters([{ type: "address[]" }], [path]),
        amountOut,
      });
    } catch {
      // Try the next path.
    }
  }

  return candidates;
}

async function getAlienBaseQuoteCandidates(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<QuoteCandidate[]> {
  return getUniV2QuoteCandidates({
    router: ALIENBASE_V2_ROUTER_ADDRESS,
    dex: DEX.ALIENBASE,
    dexName: "AlienBase",
    tokenIn,
    tokenOut,
    amountIn,
  });
}

// All native, on-chain DEX quote adapters. Aggregators (0x, LI.FI) are intentionally NOT here —
// they are only consulted as a fallback when these return nothing.
async function getNativeQuoteCandidates(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  chain: SweepChainConfig = BASE_CONFIG,
): Promise<QuoteCandidate[]> {
  // Non-Base chains describe their native ladder declaratively (chain.nativeSources). Base keeps
  // nativeSources === null and runs the original hardcoded task list below, byte-identical.
  if (chain.nativeSources) {
    const tasks: Array<Promise<QuoteCandidate[]>> = [];
    for (const source of chain.nativeSources) {
      if (source.kind === "uniswap_v3" && source.quoter) {
        tasks.push(
          getV3QuoteCandidates({
            dex: DEX.UNISWAP_V3,
            dexName: source.dexName,
            quoter: source.quoter,
            tokenIn,
            tokenOut,
            amountIn,
            feeTiers: source.feeTiers ?? UNISWAP_FEE_TIERS,
            chainId: chain.chainId,
            weth: chain.weth,
            usdc: chain.usdc,
          }),
        );
      } else if (source.kind === "univ2") {
        // Native UniswapV2-style router (Ethereum: Uniswap V2, SushiSwap). Router embedded in
        // dexData so build-tx targets exactly this router (DEX.UNIV2_GENERIC).
        tasks.push(
          getUniV2QuoteCandidates({
            router: source.router,
            dex: DEX.UNIV2_GENERIC,
            dexName: source.dexName,
            tokenIn,
            tokenOut,
            amountIn,
            chain,
            embedRouter: true,
          }),
        );
      }
    }
    return (await Promise.all(tasks)).flat();
  }

  const tasks: Array<Promise<QuoteCandidate[]>> = [
    getV3QuoteCandidates({
      dex: DEX.UNISWAP_V3,
      dexName: "Uniswap V3",
      quoter: UNISWAP_V3_QUOTER_ADDRESS,
      tokenIn,
      tokenOut,
      amountIn,
      feeTiers: UNISWAP_FEE_TIERS,
    }),
    getV3QuoteCandidates({
      dex: DEX.PANCAKESWAP_V3,
      dexName: "PancakeSwap V3",
      quoter: PANCAKE_V3_QUOTER_ADDRESS,
      tokenIn,
      tokenOut,
      amountIn,
      feeTiers: PANCAKE_FEE_TIERS,
    }),
    getV4QuoteCandidates(tokenIn, tokenOut, amountIn),
    getAerodromeQuoteCandidates(tokenIn, tokenOut, amountIn),
    getSlipstreamQuoteCandidates(tokenIn, tokenOut, amountIn),
    getBaseSwapQuoteCandidates(tokenIn, tokenOut, amountIn),
  ];

  // New native adapters — env-gated (default off) until allowlisted on the V3 router + fork-tested.
  if (algebraEnabled()) tasks.push(getAlgebraQuoteCandidates(tokenIn, tokenOut, amountIn));
  if (alienBaseEnabled()) tasks.push(getAlienBaseQuoteCandidates(tokenIn, tokenOut, amountIn));
  if (hydrexEnabled()) tasks.push(getHydrexQuoteCandidates(tokenIn, tokenOut, amountIn));

  return (await Promise.all(tasks)).flat();
}

function pickBestCandidate(candidates: QuoteCandidate[]) {
  return (
    candidates.sort((a, b) =>
      a.amountOut > b.amountOut ? -1 : a.amountOut < b.amountOut ? 1 : 0,
    )[0] || null
  );
}

// Market reference for a single quote: what the input amount is worth at the token's market price
// (DexScreener/CoinGecko — the same price the user sees on the token list) and how to value the
// quoted output. Used to compute REAL price impact and to decide when aggregator rescue fires.
type QuoteMarketContext = {
  expectedInUSD: number;
  outTokenPriceUSD: number;
  outDecimals: number;
};

// Real price impact of a quote vs the token's market value, in bps (0..10000), or null when no
// reliable reference price exists. Uses the GROSS quote output (platform fee is reported
// separately) so the fee is never double-counted as "impact".
function computeMarketImpactBps(amountOut: bigint, market?: QuoteMarketContext | null): number | null {
  if (!market) return null;
  if (!(market.expectedInUSD > 0.01) || !(market.outTokenPriceUSD > 0)) return null;
  const grossOutUSD = Number(formatUnits(amountOut, market.outDecimals)) * market.outTokenPriceUSD;
  if (!Number.isFinite(grossOutUSD)) return null;
  const impact = 1 - grossOutUSD / market.expectedInUSD;
  return Math.max(0, Math.min(10_000, Math.round(impact * 10_000)));
}

// Governed aggregator ladder — keyless/cheapest first. `enabled` is checked BEFORE the governor
// so disabled providers cost zero pacing latency; each candidate fn re-checks it internally too.
// Calls are paced + circuit-broken by the governor and cached by exact (in, out, amount).
type AggregatorFetchFn = (
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  slippageBps: number,
  chain: SweepChainConfig,
) => Promise<QuoteCandidate | null>;

const AGGREGATOR_LADDER: Array<{
  provider: AggregatorProviderId;
  /** Base gate (module env). Non-Base chains additionally require chain.aggregators[provider]. */
  enabled: () => boolean;
  fetch: AggregatorFetchFn;
}> = [
  { provider: "kyber", enabled: kyberEnabled, fetch: getKyberQuoteCandidate },
  { provider: "zerox", enabled: aggregatorsEnabled, fetch: get0xQuoteCandidate },
  { provider: "lifi", enabled: lifiEnabled, fetch: getLifiQuoteCandidate },
  { provider: "openocean", enabled: openOceanEnabled, fetch: getOpenOceanQuoteCandidate },
  { provider: "odos", enabled: odosEnabled, fetch: getOdosQuoteCandidate },
];

// Whether a provider is live for a given chain. Base: exactly the existing module gate (so Base
// behavior is unchanged). Non-Base: the chain's own enable flag AND the shared preconditions
// (API key / allowlist) that the module gate already checks via `baseEnabled`.
function isAggregatorLiveForChain(
  provider: AggregatorProviderId,
  baseEnabled: () => boolean,
  chain: SweepChainConfig,
): boolean {
  if (chain.chainId === BASE_CHAIN_ID) return baseEnabled();
  if (!chain.aggregators[provider]) return false;
  // Shared preconditions still apply per chain: a non-empty allowlist, and (for 0x) an API key.
  if (getChainAllowedAggregatorAddresses(chain).size === 0) return false;
  if (provider === "zerox" && !get0xApiKey()) return false;
  return true;
}

// Hard time budget for the rescue phase. The per-token quote task has a 12s hard timeout that
// would SKIP the token entirely — a rescue that overruns must degrade to the native route, never
// cost the user their quote.
const AGGREGATOR_RESCUE_BUDGET_MS = boundedEnvNumber(
  "DUST_SWEEP_AGGREGATOR_RESCUE_BUDGET_MS",
  6_000,
  1_000,
  20_000,
);

async function getGovernedAggregatorCandidate(
  provider: AggregatorProviderId,
  fetchCandidate: AggregatorFetchFn,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  slippageBps: number,
  chain: SweepChainConfig = BASE_CONFIG,
  onSkipped?: () => void,
) {
  const cacheKey = `${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}:${amountIn.toString()}:${slippageBps}`;
  return governAggregatorCall(
    provider,
    cacheKey,
    () => fetchCandidate(tokenIn, tokenOut, amountIn, slippageBps, chain),
    onSkipped,
    chain.chainId,
  );
}

async function getBestQuote(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  slippageBps: number,
  executionLane: DustSweepExecutionLane,
  market?: QuoteMarketContext | null,
  chain: SweepChainConfig = BASE_CONFIG,
) {
  // 1) Native DEX routers first.
  const nativeCandidates = (await getNativeQuoteCandidates(tokenIn, tokenOut, amountIn, chain)).filter(
    (candidate) => isCandidateExecutableInLane(candidate, executionLane),
  );
  const bestNative = pickBestCandidate(nativeCandidates);

  if (bestNative) {
    // Real (market-value based) price impact for the winning native route. Replaces the old
    // hardcoded 43 bps display fallback with an honest number whenever a reference price exists.
    const nativeImpactBps = computeMarketImpactBps(bestNative.amountOut, market);
    if (nativeImpactBps !== null) bestNative.priceImpactBps = nativeImpactBps;

    // Aggregator RESCUE — only when the native route measurably underpays vs market value
    // (e.g. the sole native pool is a micro-pool while real liquidity sits on venues only
    // aggregators index). Healthy tokens return here without any aggregator API call.
    const rescueBps = getAggregatorRescueImpactBps();
    if (nativeImpactBps === null || rescueBps <= 0 || nativeImpactBps <= rescueBps) {
      return bestNative;
    }
    // GENERIC aggregator routes can never execute in the legacy owned_v1 lane — skip the
    // ladder entirely instead of burning provider rate limits on unusable quotes.
    if (executionLane === "owned_v1") return bestNative;

    let bestRescue: QuoteCandidate | null = null;
    const rescueDeadline = Date.now() + AGGREGATOR_RESCUE_BUDGET_MS;
    for (const { provider, enabled, fetch: fetchCandidate } of AGGREGATOR_LADDER) {
      if (!isAggregatorLiveForChain(provider, enabled, chain)) continue;
      const remainingMs = rescueDeadline - Date.now();
      if (remainingMs <= 0) break; // over budget — the native route stands, token is never lost
      const candidate = await Promise.race([
        getGovernedAggregatorCandidate(
          provider,
          fetchCandidate,
          tokenIn,
          tokenOut,
          amountIn,
          slippageBps,
          chain,
        ),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), remainingMs)),
      ]);
      if (!candidate || !isCandidateExecutableInLane(candidate, executionLane)) continue;
      if (!bestRescue || candidate.amountOut > bestRescue.amountOut) bestRescue = candidate;
      // Early exit once a rescue quote is back inside the acceptable-impact band — no need to
      // burn further providers' rate limits chasing marginal improvements.
      const rescueImpactBps = computeMarketImpactBps(candidate.amountOut, market);
      if (rescueImpactBps !== null && rescueImpactBps <= rescueBps) break;
    }

    if (bestRescue && bestRescue.amountOut > bestNative.amountOut) {
      const rescueImpactBps = computeMarketImpactBps(bestRescue.amountOut, market);
      if (rescueImpactBps !== null) bestRescue.priceImpactBps = rescueImpactBps;
      console.info("[dustsweep/quote] aggregator rescue improved a poor native route", {
        tokenIn,
        dexName: bestRescue.dexName,
        nativeImpactBps,
        rescueImpactBps,
      });
      return bestRescue;
    }
    return bestNative;
  }

  // 2) Aggregator FALLBACK — only for tokens with no native quote. First executable quote wins,
  //    in ladder order (KyberSwap → 0x → LI.FI → OpenOcean → Odos). Each is env-gated and
  //    additive: later providers are only consulted when every earlier source returns nothing, so
  //    they strictly widen coverage of sweepable dust.
  let anyProviderSkipped = false;
  for (const { provider, enabled, fetch: fetchCandidate } of AGGREGATOR_LADDER) {
    if (!isAggregatorLiveForChain(provider, enabled, chain)) continue;
    const candidate = await getGovernedAggregatorCandidate(
      provider,
      fetchCandidate,
      tokenIn,
      tokenOut,
      amountIn,
      slippageBps,
      chain,
      () => {
        anyProviderSkipped = true;
      },
    );
    if (candidate && isCandidateExecutableInLane(candidate, executionLane)) {
      const impactBps = computeMarketImpactBps(candidate.amountOut, market);
      if (impactBps !== null) candidate.priceImpactBps = impactBps;
      return candidate;
    }
  }

  // A provider that was load-shed / cooling off never actually answered — this token is NOT
  // definitively unroutable. Throw a transient error so the caller records QUOTE_FAILED
  // (retryable, carry-forward eligible) instead of caching NO_ROUTE for minutes.
  if (anyProviderSkipped) {
    throw new Error("Aggregator quotes are busy right now; retry shortly.");
  }

  return null;
}

function isCandidateExecutableInLane(candidate: QuoteCandidate, executionLane: DustSweepExecutionLane) {
  if (executionLane === "owned_v1") {
    return candidate.dex === DEX.UNISWAP_V3;
  }

  if (executionLane === "owned_v2") {
    return true;
  }

  return true;
}

const SWEEP_ROUTE_TYPEHASH = keccak256(
  toHex("SweepRoute(address tokenIn,uint256 amountIn,address target,address spender,uint256 value,bytes32 dataHash)"),
);
const DUST_SWEEP_WITNESS_TYPEHASH = keccak256(
  toHex("DustSweepWitness(bytes32 routeHash,address outputToken,address receiver,uint256 minAmountOut,uint256 deadline)"),
);

function hashV2Route(route: DustSweepV2Route) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [
        SWEEP_ROUTE_TYPEHASH,
        route.tokenIn,
        route.amountIn,
        route.target,
        route.spender,
        route.value,
        keccak256(route.data),
      ],
    ),
  );
}

function hashV2Routes(routes: DustSweepV2Route[]) {
  return keccak256(concatHex(routes.map(hashV2Route)));
}

function hashDustSweepWitness(witness: Permit2Witness) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [
        DUST_SWEEP_WITNESS_TYPEHASH,
        witness.routeHash,
        witness.outputToken,
        witness.receiver,
        BigInt(witness.minAmountOut),
        BigInt(witness.deadline),
      ],
    ),
  );
}

function buildPermit2WitnessTypedData(args: {
  routes: DustSweepV2Route[];
  spender: Address;
  nonce: string;
  deadline: number;
  witness: Permit2Witness;
  chainId?: number;
}) {
  return {
    domain: {
      name: "Permit2",
      // MUST be the sweep chain — Permit2 verifies EIP-712 against its own chainId, so a Base
      // domain on Ethereum would make the user's signature invalid and the sweep revert.
      chainId: args.chainId ?? BASE_CHAIN_ID,
      verifyingContract: PERMIT2_ADDRESS,
    },
    types: {
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      DustSweepWitness: [
        { name: "routeHash", type: "bytes32" },
        { name: "outputToken", type: "address" },
        { name: "receiver", type: "address" },
        { name: "minAmountOut", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
      PermitBatchWitnessTransferFrom: [
        { name: "permitted", type: "TokenPermissions[]" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "witness", type: "DustSweepWitness" },
      ],
    },
    primaryType: "PermitBatchWitnessTransferFrom",
    message: {
      permitted: args.routes.map((route) => ({
        token: route.tokenIn,
        amount: route.amountIn.toString(),
      })),
      spender: args.spender,
      nonce: args.nonce,
      deadline: String(args.deadline),
      witness: args.witness,
    },
  };
}

// ── DustSweep V3 witness + calldata ──
// V3's witness binds `recipient` (not `receiver`) and the effective `feeBps`, so the user signs
// the exact fee. routeHash + the SweepRoute typehash are identical to V2, so hashV2Routes is reused.
type DustSweepV3Witness = {
  routeHash: Hex;
  outputToken: Address;
  recipient: Address;
  minAmountOut: string;
  deadline: string;
  feeBps: number;
};

function buildV3WitnessTypedData(args: {
  routes: DustSweepV2Route[];
  spender: Address;
  nonce: string;
  deadline: number;
  witness: DustSweepV3Witness;
  chainId?: number;
}) {
  return {
    domain: {
      name: "Permit2",
      // MUST be the sweep chain (see buildPermit2WitnessTypedData) — a wrong chainId makes the
      // signed Permit2 witness invalid on that chain and the sweep reverts.
      chainId: args.chainId ?? BASE_CHAIN_ID,
      verifyingContract: PERMIT2_ADDRESS,
    },
    types: {
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      DustSweepWitness: [
        { name: "routeHash", type: "bytes32" },
        { name: "outputToken", type: "address" },
        { name: "recipient", type: "address" },
        { name: "minAmountOut", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "feeBps", type: "uint16" },
      ],
      PermitBatchWitnessTransferFrom: [
        { name: "permitted", type: "TokenPermissions[]" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "witness", type: "DustSweepWitness" },
      ],
    },
    primaryType: "PermitBatchWitnessTransferFrom",
    message: {
      permitted: args.routes.map((route) => ({
        token: route.tokenIn,
        amount: route.amountIn.toString(),
      })),
      spender: args.spender,
      nonce: args.nonce,
      deadline: String(args.deadline),
      witness: args.witness,
    },
  };
}

function encodeV3SweepCalldata(args: {
  mode: number;
  v2Routes: DustSweepV2Route[];
  outputToken: Address;
  recipient: Address;
  minAmountOut: bigint;
  deadline: number;
  feeBpsOverride: number;
  nonce?: string;
  signature?: Hex;
}) {
  const permit = {
    permitted:
      args.mode === V3_SWEEP_MODE.Permit2Signature
        ? args.v2Routes.map((route) => ({ token: route.tokenIn, amount: route.amountIn }))
        : [],
    nonce: BigInt(args.nonce ?? "0"),
    deadline: BigInt(args.deadline),
  };
  return encodeFunctionData({
    abi: DUST_SWEEP_ROUTER_V3_ABI,
    functionName: "sweep",
    args: [
      args.mode,
      args.v2Routes,
      {
        outputToken: args.outputToken,
        recipient: args.recipient,
        minAmountOut: args.minAmountOut,
        deadline: BigInt(args.deadline),
        feeBpsOverride: args.feeBpsOverride,
      },
      permit,
      (args.signature ?? "0x") as Hex,
    ],
  });
}

function decodeV3DexData(dexData: Hex) {
  const [decoded] = decodeAbiParameters(V3_DEX_DATA_PARAMETERS, dexData);
  return decoded as { fee: number; isMultiHop: boolean; path: Hex };
}

function decodeV4DexData(dexData: Hex) {
  const [fee, tickSpacing] = decodeAbiParameters(V4_DEX_DATA_PARAMETERS, dexData);
  return { fee: Number(fee), tickSpacing: Number(tickSpacing) };
}

function buildV1Calldata(args: {
  routes: DustSweepRoute[];
  tokenOut: Address;
  receiver: Address;
  deadline: number;
}) {
  if (args.routes.some((route) => route.dex !== DEX.UNISWAP_V3)) {
    throw new Error("owned_v1 only supports Uniswap V3 routes. Refresh quote using the V1 lane.");
  }

  const orders = args.routes.map((route) => {
    const v3 = decodeV3DexData(route.dexData as Hex);
    const path = v3.isMultiHop
      ? v3.path
      : encodePacked(
          ["address", "uint24", "address"],
          [route.tokenIn, v3.fee, args.tokenOut],
        );

    return {
      tokenIn: route.tokenIn,
      amountIn: BigInt(route.amountIn),
      path,
      minAmountOut: BigInt(route.amountOutMin),
    };
  });

  return encodeFunctionData({
    abi: DUST_SWEEP_ROUTER_ABI,
    functionName: "sweepDustMultiHop",
    args: [orders, args.tokenOut, args.receiver, BigInt(args.deadline)],
  });
}

function assertConfiguredV2Route(route: DustSweepV2Route, chain: SweepChainConfig = BASE_CONFIG) {
  const allowedTargets = getAllowedV2Targets(chain);
  const allowedSpenders = getAllowedV2Spenders(chain);

  if (!allowedTargets.has(route.target.toLowerCase())) {
    throw new Error(`Swap target ${route.target} is not in the ${chain.name} allowlist`);
  }

  if (!allowedSpenders.has(route.spender.toLowerCase())) {
    throw new Error(`Swap spender ${route.spender} is not in the ${chain.name} allowlist`);
  }
}

async function readV2AllowedTarget(routerAddress: Address, target: Address, chainId: number = BASE_CHAIN_ID) {
  const data = encodeFunctionData({
    abi: DUST_SWEEP_ROUTER_V2_ABI,
    functionName: "allowedTargets",
    args: [target],
  });
  const result = await callContract(routerAddress, data, undefined, chainId);
  const allowed = decodeFunctionResult({
    abi: DUST_SWEEP_ROUTER_V2_ABI,
    functionName: "allowedTargets",
    data: result,
  });
  return allowed;
}

async function readV2AllowedSpender(routerAddress: Address, spender: Address, chainId: number = BASE_CHAIN_ID) {
  const data = encodeFunctionData({
    abi: DUST_SWEEP_ROUTER_V2_ABI,
    functionName: "allowedSpenders",
    args: [spender],
  });
  const result = await callContract(routerAddress, data, undefined, chainId);
  const allowed = decodeFunctionResult({
    abi: DUST_SWEEP_ROUTER_V2_ABI,
    functionName: "allowedSpenders",
    data: result,
  });
  return allowed;
}

async function assertOnchainV2RouterAllowlist(
  routerAddress: Address,
  routes: DustSweepV2Route[],
  chainId: number = BASE_CHAIN_ID,
) {
  const targets = Array.from(new Set(routes.map((route) => route.target.toLowerCase() as Lowercase<Address>)));
  const spenders = Array.from(new Set(routes.map((route) => route.spender.toLowerCase() as Lowercase<Address>)));

  const [targetChecks, spenderChecks] = await Promise.all([
    Promise.all(
      targets.map(async (target) => ({
        address: target,
        allowed: await readV2AllowedTarget(routerAddress, getAddress(target), chainId),
      })),
    ),
    Promise.all(
      spenders.map(async (spender) => ({
        address: spender,
        allowed: await readV2AllowedSpender(routerAddress, getAddress(spender), chainId),
      })),
    ),
  ]);

  const missingTargets = targetChecks.filter((check) => !check.allowed).map((check) => check.address);
  const missingSpenders = spenderChecks.filter((check) => !check.allowed).map((check) => check.address);

  if (missingTargets.length > 0 || missingSpenders.length > 0) {
    throw new Error(
      [
        `V2 router ${routerAddress} is not configured on-chain.`,
        missingTargets.length > 0 ? `Missing allowed target(s): ${missingTargets.join(", ")}` : "",
        missingSpenders.length > 0 ? `Missing allowed spender(s): ${missingSpenders.join(", ")}` : "",
        "Call setAllowedTarget/setAllowedSpender from the router owner, then retry.",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
}

function buildUniswapV4UniversalRouterCalldata(args: {
  route: DustSweepRoute;
  tokenOut: Address;
  amountIn: bigint;
  amountOutMin: bigint;
  deadline: number;
}) {
  if (args.amountIn > MAX_UINT128 || args.amountOutMin > MAX_UINT128) {
    throw new Error("Uniswap V4 route amount exceeds uint128");
  }

  const { fee, tickSpacing } = decodeV4DexData(args.route.dexData as Hex);
  const tokenInIsCurrency0 = BigInt(args.route.tokenIn) < BigInt(args.tokenOut);
  const currency0 = tokenInIsCurrency0 ? args.route.tokenIn : args.tokenOut;
  const currency1 = tokenInIsCurrency0 ? args.tokenOut : args.route.tokenIn;
  const poolKey = {
    currency0,
    currency1,
    fee,
    tickSpacing,
    hooks: ZERO_ADDRESS,
  };

  const swapParam = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    [
      {
        poolKey,
        zeroForOne: tokenInIsCurrency0,
        amountIn: args.amountIn,
        amountOutMinimum: args.amountOutMin,
        hookData: "0x" as Hex,
      },
    ],
  );
  const settleParam = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [args.route.tokenIn, args.amountIn],
  );
  const takeParam = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [args.tokenOut, args.amountOutMin],
  );
  const v4Input = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [V4_ACTIONS_EXACT_IN_SINGLE, [swapParam, settleParam, takeParam]],
  );

  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: "execute",
    args: [UNIVERSAL_ROUTER_COMMAND_V4_SWAP, [v4Input], BigInt(args.deadline)],
  });
}

// Native Uniswap V3 SwapRouter02 per chain. Base uses the module default; Ethereum uses the
// canonical mainnet SwapRouter02. Verified addresses; the owner must allowlist the ETH one.
const ETH_UNISWAP_V3_SWAP_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" as Address;

function buildV2Route(
  route: DustSweepRoute,
  tokenOut: Address,
  receiver: Address,
  deadline: number,
  chain: SweepChainConfig = BASE_CONFIG,
): DustSweepV2Route {
  const amountIn = BigInt(route.amountIn);
  const amountOutMin = BigInt(route.amountOutMin);

  if (route.tokenIn.toLowerCase() === NATIVE_TOKEN_SENTINEL.toLowerCase()) {
    throw new Error("Native ETH must be wrapped to WETH before using owned_v2.");
  }

  // Passthrough leg (WETH -> native ETH): NO swap. The upgraded V3 router pulls tokenIn (== the
  // output token) and unwraps it at settlement. target/spender/data are ignored on-chain, so we
  // set target/spender = tokenIn (non-zero, self) and empty data.
  if (route.dex === DEX.PASSTHROUGH) {
    return {
      tokenIn: route.tokenIn,
      amountIn,
      target: route.tokenIn,
      spender: route.tokenIn,
      value: 0n,
      data: "0x" as Hex,
    };
  }

  // Generic UniswapV2-style leg with the router embedded in dexData — used for Ethereum native
  // sources (Uniswap V2, SushiSwap). The embedded router is the target AND the spender.
  if (route.dex === DEX.UNIV2_GENERIC) {
    const [router, path] = decodeAbiParameters(
      [{ type: "address" }, { type: "address[]" }],
      route.dexData as Hex,
    );
    const data = encodeFunctionData({
      abi: BASESWAP_SWAP_ABI, // standard UniV2 swapExactTokensForTokens(uint,uint,address[],address,uint)
      functionName: "swapExactTokensForTokens",
      args: [amountIn, amountOutMin, path as Address[], receiver, BigInt(deadline)],
    });
    return { tokenIn: route.tokenIn, amountIn, target: router as Address, spender: router as Address, value: 0n, data };
  }

  if (route.dex === DEX.UNISWAP_V3) {
    const target =
      chain.chainId === ETHEREUM_CHAIN_ID ? ETH_UNISWAP_V3_SWAP_ROUTER : UNISWAP_V3_SWAP_ROUTER_ADDRESS;
    const v3 = decodeV3DexData(route.dexData as Hex);
    const data = v3.isMultiHop
      ? encodeFunctionData({
          abi: SWAP_ROUTER_02_ABI,
          functionName: "exactInput",
          args: [
            {
              path: v3.path,
              recipient: receiver,
              amountIn,
              amountOutMinimum: amountOutMin,
            },
          ],
        })
      : encodeFunctionData({
          abi: SWAP_ROUTER_02_ABI,
          functionName: "exactInputSingle",
          args: [
            {
              tokenIn: route.tokenIn,
              tokenOut,
              fee: v3.fee,
              recipient: receiver,
              amountIn,
              amountOutMinimum: amountOutMin,
              sqrtPriceLimitX96: 0n,
            },
          ],
        });

    return { tokenIn: route.tokenIn, amountIn, target, spender: target, value: 0n, data };
  }

  if (route.dex === DEX.PANCAKESWAP_V3) {
    const target = PANCAKE_V3_SWAP_ROUTER_ADDRESS;
    const v3 = decodeV3DexData(route.dexData as Hex);
    const data = v3.isMultiHop
      ? encodeFunctionData({
          abi: PANCAKE_V3_SWAP_ROUTER_ABI,
          functionName: "exactInput",
          args: [
            {
              path: v3.path,
              recipient: receiver,
              deadline: BigInt(deadline),
              amountIn,
              amountOutMinimum: amountOutMin,
            },
          ],
        })
      : encodeFunctionData({
          abi: PANCAKE_V3_SWAP_ROUTER_ABI,
          functionName: "exactInputSingle",
          args: [
            {
              tokenIn: route.tokenIn,
              tokenOut,
              fee: v3.fee,
              recipient: receiver,
              deadline: BigInt(deadline),
              amountIn,
              amountOutMinimum: amountOutMin,
              sqrtPriceLimitX96: 0n,
            },
          ],
        });

    return { tokenIn: route.tokenIn, amountIn, target, spender: target, value: 0n, data };
  }

  if (route.dex === DEX.UNISWAP_V4) {
    const data = buildUniswapV4UniversalRouterCalldata({
      route,
      tokenOut,
      amountIn,
      amountOutMin,
      deadline,
    });

    return {
      tokenIn: route.tokenIn,
      amountIn,
      target: UNISWAP_V4_UNIVERSAL_ROUTER_ADDRESS,
      spender: PERMIT2_ADDRESS,
      value: 0n,
      data,
    };
  }

  if (route.dex === DEX.AERODROME) {
    const [decoded] = decodeAbiParameters(AERODROME_DEX_DATA_PARAMETERS, route.dexData as Hex);
    const data = encodeFunctionData({
      abi: AERODROME_SWAP_ABI,
      functionName: "swapExactTokensForTokens",
      args: [amountIn, amountOutMin, decoded.routes, receiver, BigInt(deadline)],
    });

    return {
      tokenIn: route.tokenIn,
      amountIn,
      target: AERODROME_ROUTER_ADDRESS,
      spender: AERODROME_ROUTER_ADDRESS,
      value: 0n,
      data,
    };
  }

  if (route.dex === DEX.BASESWAP) {
    const [path] = decodeAbiParameters([{ type: "address[]" }], route.dexData as Hex);
    const data = encodeFunctionData({
      abi: BASESWAP_SWAP_ABI,
      functionName: "swapExactTokensForTokens",
      args: [amountIn, amountOutMin, path, receiver, BigInt(deadline)],
    });

    return {
      tokenIn: route.tokenIn,
      amountIn,
      target: BASESWAP_ROUTER_ADDRESS,
      spender: BASESWAP_ROUTER_ADDRESS,
      value: 0n,
      data,
    };
  }

  if (route.dex === DEX.AERODROME_SLIPSTREAM) {
    const [tickSpacing] = decodeAbiParameters(SLIPSTREAM_DEX_DATA_PARAMETERS, route.dexData as Hex);
    const data = encodeFunctionData({
      abi: SLIPSTREAM_SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: route.tokenIn,
          tokenOut,
          tickSpacing,
          recipient: receiver,
          deadline: BigInt(deadline),
          amountIn,
          amountOutMinimum: amountOutMin,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });

    return {
      tokenIn: route.tokenIn,
      amountIn,
      target: AERODROME_SLIPSTREAM_ROUTER_ADDRESS,
      spender: AERODROME_SLIPSTREAM_ROUTER_ADDRESS,
      value: 0n,
      data,
    };
  }

  if (route.dex === DEX.ALGEBRA || route.dex === DEX.HYDREX) {
    // Hydrex is an Algebra Integral fork — identical exactInputSingle struct, own router.
    const routerAddress =
      route.dex === DEX.HYDREX ? HYDREX_SWAP_ROUTER_ADDRESS : ALGEBRA_SWAP_ROUTER_ADDRESS;
    const [deployer] = decodeAbiParameters(ALGEBRA_DEX_DATA_PARAMETERS, route.dexData as Hex);
    const data = encodeFunctionData({
      abi: ALGEBRA_SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: route.tokenIn,
          tokenOut,
          deployer: isAddress(deployer) ? normalizeAddress(deployer) : ZERO_ADDRESS,
          recipient: receiver,
          deadline: BigInt(deadline),
          amountIn,
          amountOutMinimum: amountOutMin,
          limitSqrtPrice: 0n,
        },
      ],
    });

    return {
      tokenIn: route.tokenIn,
      amountIn,
      target: routerAddress,
      spender: routerAddress,
      value: 0n,
      data,
    };
  }

  if (route.dex === DEX.ALIENBASE) {
    const [path] = decodeAbiParameters([{ type: "address[]" }], route.dexData as Hex);
    const data = encodeFunctionData({
      abi: BASESWAP_SWAP_ABI,
      functionName: "swapExactTokensForTokens",
      args: [amountIn, amountOutMin, path, receiver, BigInt(deadline)],
    });

    return {
      tokenIn: route.tokenIn,
      amountIn,
      target: ALIENBASE_V2_ROUTER_ADDRESS,
      spender: ALIENBASE_V2_ROUTER_ADDRESS,
      value: 0n,
      data,
    };
  }

  if (route.dex === DEX.GENERIC) {
    const [decoded] = decodeAbiParameters(GENERIC_DEX_DATA_PARAMETERS, route.dexData as Hex);
    if (!isAddress(decoded.target) || !isAddress(decoded.spender) || !isHex(decoded.data)) {
      throw new Error("Malformed generic route data");
    }

    return {
      tokenIn: route.tokenIn,
      amountIn,
      target: normalizeAddress(decoded.target),
      spender: normalizeAddress(decoded.spender),
      value: 0n,
      data: decoded.data,
    };
  }

  throw new Error("This route is not executable in owned_v2 yet. Refresh quote or use another lane.");
}

function encodeV2SweepCalldata(args: {
  v2Routes: DustSweepV2Route[];
  tokenOut: Address;
  receiver: Address;
  minAmountOut: bigint;
  deadline: number;
  nonce: string;
  signature: Hex;
}) {
  const permit = {
    permitted: args.v2Routes.map((route) => ({
      token: route.tokenIn,
      amount: route.amountIn,
    })),
    nonce: BigInt(args.nonce),
    deadline: BigInt(args.deadline),
  };

  return encodeFunctionData({
    abi: DUST_SWEEP_ROUTER_V2_ABI,
    functionName: "sweepWithPermit2",
    args: [
      args.v2Routes,
      args.tokenOut,
      args.receiver,
      args.minAmountOut,
      BigInt(args.deadline),
      permit,
      args.signature,
    ],
  });
}

function encodeV2AllowanceSweepCalldata(args: {
  v2Routes: DustSweepV2Route[];
  tokenOut: Address;
  receiver: Address;
  minAmountOut: bigint;
  deadline: number;
}) {
  return encodeFunctionData({
    abi: DUST_SWEEP_ROUTER_V2_ABI,
    functionName: "sweepWithAllowance",
    args: [
      args.v2Routes,
      args.tokenOut,
      args.receiver,
      args.minAmountOut,
      BigInt(args.deadline),
    ],
  });
}

type GeckoToken = {
  id: string;
  type: string;
  attributes?: {
    address?: string;
    name?: string;
    symbol?: string;
    decimals?: number;
    image_url?: string;
  };
};

type GeckoPool = {
  relationships?: {
    base_token?: { data?: { id?: string } };
    quote_token?: { data?: { id?: string } };
    dex?: { data?: { id?: string } };
  };
  attributes?: {
    reserve_in_usd?: string;
  };
};

type RpcLog = {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
};

type OnchainPoolCandidate = {
  token: Address;
  quoteToken: Address;
  pool: Address;
  source: string;
  liquidityUSD: number;
};

type BlockscoutTokenItem = {
  address_hash?: string;
  address?: string;
  name?: string | null;
  symbol?: string | null;
  decimals?: string | number | null;
  icon_url?: string | null;
  type?: string;
  reputation?: string | null;
  circulating_market_cap?: string | number | null;
  volume_24h?: string | number | null;
  holders_count?: string | number | null;
};

type DexScreenerPair = {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  labels?: string[];
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; name?: string; symbol?: string };
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  info?: { imageUrl?: string };
};

type TokenUpsertResult = {
  written: number;
  skipped: number;
  errors: string[];
};

const DEFAULT_BLOCKSCOUT_MAX_REQUESTS_PER_KEY = 100;

let blockscoutKeyIndex = 0;
let blockscoutKeyCalls = 0;

const ONCHAIN_QUOTE_TOKENS = new Map<string, { address: Address; symbol: string; decimals: number; usd?: number }>([
  [USDC_ADDRESS.toLowerCase(), { address: USDC_ADDRESS, symbol: "USDC", decimals: 6, usd: 1 }],
  [USDBC_ADDRESS.toLowerCase(), { address: USDBC_ADDRESS, symbol: "USDbC", decimals: 6, usd: 1 }],
  [USDT_ADDRESS.toLowerCase(), { address: USDT_ADDRESS, symbol: "USDT", decimals: 6, usd: 1 }],
  [DAI_ADDRESS.toLowerCase(), { address: DAI_ADDRESS, symbol: "DAI", decimals: 18, usd: 1 }],
  [WETH_ADDRESS.toLowerCase(), { address: WETH_ADDRESS, symbol: "WETH", decimals: 18 }],
]);

function splitCsvEnv(value?: string) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getBlockscoutApiBaseUrl() {
  return process.env.BLOCKSCOUT_BASE_API_URL || "https://base.blockscout.com/api";
}

function getBlockscoutApiV2BaseUrl() {
  return (
    process.env.BLOCKSCOUT_BASE_API_V2_URL ||
    getBlockscoutApiBaseUrl().replace(/\/api\/?$/, "/api/v2")
  ).replace(/\/$/, "");
}

function getBlockscoutMaxRequestsPerKey() {
  const parsed = Number.parseInt(
    process.env.BLOCKSCOUT_MAX_REQUESTS_PER_KEY ||
      process.env.BASE_RPC_ROTATION_CALLS ||
      "",
    10,
  );

  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_BLOCKSCOUT_MAX_REQUESTS_PER_KEY;
}

function getBlockscoutApiKey() {
  const keys = [
    ...splitCsvEnv(process.env.BLOCKSCOUT_API_KEYS),
    ...splitCsvEnv(process.env.BLOCKSCOUT_API_KEY),
  ];
  if (keys.length === 0) return "";

  const key = keys[blockscoutKeyIndex % keys.length];
  blockscoutKeyCalls += 1;

  if (blockscoutKeyCalls >= getBlockscoutMaxRequestsPerKey()) {
    blockscoutKeyCalls = 0;
    blockscoutKeyIndex = (blockscoutKeyIndex + 1) % keys.length;
  }

  return key;
}

function getOnchainDexFactories() {
  return [
    {
      source: "onchain:uniswap-v3-base",
      factory: UNISWAP_V3_FACTORY_ADDRESS,
      eventType: "v3" as const,
      defaultFromBlock: Number(process.env.UNISWAP_V3_FACTORY_FROM_BLOCK || "1371000"),
    },
    {
      source: "onchain:pancakeswap-v3-base",
      factory: PANCAKE_V3_FACTORY_ADDRESS,
      eventType: "v3" as const,
      defaultFromBlock: Number(process.env.PANCAKE_V3_FACTORY_FROM_BLOCK || "0"),
    },
    {
      source: "onchain:aerodrome",
      factory: AERODROME_FACTORY_ADDRESS,
      eventType: "aerodrome" as const,
      defaultFromBlock: Number(process.env.AERODROME_FACTORY_FROM_BLOCK || "0"),
    },
    {
      source: "onchain:baseswap",
      factory: BASESWAP_FACTORY_ADDRESS,
      eventType: "v2" as const,
      defaultFromBlock: Number(process.env.BASESWAP_FACTORY_FROM_BLOCK || "0"),
    },
  ];
}

async function fetchGeckoPoolsPage(page: number) {
  const maxRetries = Math.max(0, Number(process.env.DUST_SWEEP_WHITELIST_MAX_RETRIES || "6"));
  const retryMs = Math.max(1000, Number(process.env.DUST_SWEEP_WHITELIST_RETRY_MS || "15000"));

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const url = new URL("https://api.geckoterminal.com/api/v2/networks/base/pools");
    url.searchParams.set("page", String(page));
    url.searchParams.set("include", "base_token,quote_token,dex");

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "DustSwap/1.0 (+https://app.dustswap.wtf)",
      },
    });

    if (response.ok) {
      return (await response.json()) as {
        data?: GeckoPool[];
        included?: GeckoToken[];
      };
    }

    if (response.status === 429 && attempt < maxRetries) {
      const retryAfterSeconds = Number(response.headers.get("retry-after") || 0);
      const waitMs = retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : retryMs * (attempt + 1);
      await sleep(waitMs);
      continue;
    }

    throw new Error(`GeckoTerminal sync failed with ${response.status}`);
  }

  throw new Error("GeckoTerminal sync failed after retries");
}

async function getLatestBaseBlockNumber() {
  const result = await baseRpcRequest<Hex>("eth_blockNumber", []);
  return Number(BigInt(result));
}

async function fetchEthUsdPrice() {
  if (ethUsdCache && ethUsdCache.expiresAt > Date.now()) {
    return ethUsdCache.price;
  }

  const cacheAndReturn = (price: number, ttlMs = 60_000) => {
    ethUsdCache = { price, expiresAt: Date.now() + ttlMs };
    return price;
  };

  const livePriceLookups = [
    async () => {
      const response = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(2_500),
      });
      if (!response.ok) throw new Error("Coinbase ETH price unavailable");
      const payload = (await response.json()) as { data?: { amount?: string } };
      return Number(payload.data?.amount || 0);
    },
    async () => {
      const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error("CoinGecko ETH price unavailable");
      const payload = (await response.json()) as { ethereum?: { usd?: number } };
      return Number(payload.ethereum?.usd || 0);
    },
    async () => {
      const quotes = await Promise.allSettled(
        UNISWAP_FEE_TIERS.map((fee) =>
          tryQuoteV3Single(
            UNISWAP_V3_QUOTER_ADDRESS,
            WETH_ADDRESS,
            USDC_ADDRESS,
            1_000_000_000_000_000_000n,
            fee,
          ),
        ),
      );
      const prices = quotes
        .map((result) =>
          result.status === "fulfilled" && result.value
            ? Number(formatUnits(result.value, 6))
            : 0,
        )
        .filter((price) => Number.isFinite(price) && price > 0);
      return prices.length > 0 ? Math.max(...prices) : 0;
    },
  ];

  for (const lookup of livePriceLookups) {
    try {
      const price = await lookup();
      if (Number.isFinite(price) && price > 0) {
        return cacheAndReturn(price);
      }
    } catch {
      // Continue to the next live source.
    }
  }

  const fallback = Number(process.env.DEFAULT_ETH_PRICE_USD || 0);
  if (Number.isFinite(fallback) && fallback > 0) {
    console.warn("[dustsweep] Using configured DEFAULT_ETH_PRICE_USD fallback", { fallback });
    return cacheAndReturn(fallback, 15_000);
  }

  ethUsdCache = { price: 0, expiresAt: Date.now() + 15_000 };
  return 0;
}

async function getLogsChunk(args: {
  address: Address;
  topic: Hex;
  fromBlock: number;
  toBlock: number;
}) {
  try {
    const url = new URL(getBlockscoutApiBaseUrl());
    url.searchParams.set("module", "logs");
    url.searchParams.set("action", "getLogs");
    url.searchParams.set("fromBlock", String(args.fromBlock));
    url.searchParams.set("toBlock", String(args.toBlock));
    url.searchParams.set("address", args.address);
    url.searchParams.set("topic0", args.topic);
    url.searchParams.set("page", "1");
    url.searchParams.set("offset", "10000");
    const apiKey = getBlockscoutApiKey();
    if (apiKey) url.searchParams.set("apikey", apiKey);

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "DustSwap/1.0 (+https://app.dustswap.wtf)",
      },
    });
    if (!response.ok) {
      throw new Error(`Blockscout ${response.status}`);
    }

    const payload = (await response.json()) as {
      status?: string;
      message?: string;
      result?: Array<{
        address?: string;
        topics?: Hex[];
        data?: Hex;
        blockNumber?: Hex;
        transactionHash?: Hex;
        logIndex?: Hex;
      }> | string;
    };

    if (Array.isArray(payload.result)) {
      return payload.result
        .filter(
          (log) =>
            log.address &&
            log.topics?.length &&
            log.data &&
            log.blockNumber &&
            log.transactionHash &&
            log.logIndex,
        )
        .map((log) => ({
          address: normalizeAddress(log.address as string),
          topics: log.topics as Hex[],
          data: log.data as Hex,
          blockNumber: log.blockNumber as Hex,
          transactionHash: log.transactionHash as Hex,
          logIndex: log.logIndex as Hex,
        }));
    }

    const message = String(payload.message || payload.result || "");
    if (message.toLowerCase().includes("no logs")) return [];
    throw new Error(message || "Blockscout logs unavailable");
  } catch {
    return baseRpcRequest<RpcLog[]>("eth_getLogs", [
      {
        address: args.address,
        fromBlock: toHex(args.fromBlock),
        toBlock: toHex(args.toBlock),
        topics: [args.topic],
      },
    ]);
  }
}

function decodePoolLog(log: RpcLog, eventType: "v2" | "v3" | "aerodrome") {
  const abi =
    eventType === "v3"
      ? V3_FACTORY_EVENT_ABI
      : eventType === "aerodrome"
        ? AERODROME_FACTORY_EVENT_ABI
        : V2_FACTORY_EVENT_ABI;
  const decoded = decodeEventLog({
    abi,
    data: log.data,
    topics: log.topics as [Hex, ...Hex[]],
  });
  const args = decoded.args as {
    token0?: Address;
    token1?: Address;
    pool?: Address;
    pair?: Address;
  };

  const pool = args.pool || args.pair;
  if (!args.token0 || !args.token1 || !pool) return null;

  return {
    token0: normalizeAddress(args.token0),
    token1: normalizeAddress(args.token1),
    pool: normalizeAddress(pool),
  };
}

async function scanOnchainPools(args: {
  fromBlock?: number;
  toBlock?: number;
  blockStep: number;
  delayMs: number;
}) {
  const latestBlock = await getLatestBaseBlockNumber();
  const toBlock = Math.min(args.toBlock || latestBlock, latestBlock);
  const pools: Array<{ token0: Address; token1: Address; pool: Address; source: string }> = [];
  const errors: string[] = [];

  for (const dex of getOnchainDexFactories()) {
    const fromBlock = Math.max(0, Math.floor(Number(args.fromBlock ?? dex.defaultFromBlock)));
    if (fromBlock > toBlock) continue;

    const topic =
      dex.eventType === "v3"
        ? V3_POOL_CREATED_TOPIC
        : dex.eventType === "aerodrome"
          ? AERODROME_PAIR_CREATED_TOPIC
          : V2_PAIR_CREATED_TOPIC;

    for (let start = fromBlock; start <= toBlock; start += args.blockStep) {
      const end = Math.min(toBlock, start + args.blockStep - 1);
      try {
        const logs = await getLogsChunk({
          address: dex.factory,
          topic,
          fromBlock: start,
          toBlock: end,
        });
        for (const log of logs) {
          const decoded = decodePoolLog(log, dex.eventType);
          if (decoded) pools.push({ ...decoded, source: dex.source });
        }
      } catch (error) {
        if (errors.length < 8) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(`${dex.source} ${start}-${end}: ${message}`);
        }
        // Some RPC providers reject busy ranges. Use a smaller blockStep and rerun
        // the same range if you need exact completeness for that window.
      }

      if (args.delayMs && end < toBlock) {
        await sleep(args.delayMs);
      }
    }
  }

  return { pools, errors };
}

async function readErc20Balance(token: Address, holder: Address, chainId: number = BASE_CHAIN_ID) {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder],
  });
  const result = await callContract(token, data, undefined, chainId);
  return decodeFunctionResult({
    abi: erc20Abi,
    functionName: "balanceOf",
    data: result,
  }) as bigint;
}

async function readErc20Allowance(
  token: Address,
  owner: Address,
  spender: Address,
  chainId: number = BASE_CHAIN_ID,
) {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
  const result = await callContract(token, data, undefined, chainId);
  return decodeFunctionResult({
    abi: erc20Abi,
    functionName: "allowance",
    data: result,
  }) as bigint;
}

async function findStaleRouteBalances(
  userAddress: Address,
  routes: DustSweepRoute[],
  chainId: number = BASE_CHAIN_ID,
) {
  const stale: Array<{
    token: Address;
    required: string;
    balance: string;
  }> = [];

  // Read every balance in parallel. This previously awaited one balanceOf per
  // token in series, which made a large (e.g. 50-token) build-tx spend ~a minute
  // on RPC round-trips before the wallet prompt could open.
  const items = routes.filter((route) => BigInt(route.amountIn || "0") > 0n);
  const balances = await pLimit(
    items.map((route) => () => readErc20Balance(route.tokenIn, userAddress, chainId)),
    PREFLIGHT_READ_CONCURRENCY,
  );

  items.forEach((route, index) => {
    const amountIn = BigInt(route.amountIn || "0");
    const balance = balances[index] ?? 0n;
    if (balance < amountIn) {
      stale.push({
        token: route.tokenIn,
        required: amountIn.toString(),
        balance: balance.toString(),
      });
    }
  });

  return stale;
}

// Simulate transfer(recipient, amountIn) FROM the user for each input token and
// return the tokens whose transfer deterministically reverts. The V3 router's
// allowance-mode pull runs transferFrom(user -> router, amountIn), which executes
// the same internal _transfer(user, router, amountIn) path. A transfer-restricted
// dust token — transfer tax to a non-whitelisted router, max-tx cap,
// blacklist/paused, or an outright honeypot — reverts here exactly as the on-chain
// pull would. Because the router pulls ALL inputs atomically (the best-effort
// guard only protects the swap legs, NOT the pull), one such token reverts the
// ENTIRE sweep during the wallet's gas estimation ("execution reverted" on
// Coinbase/Base, "not enough funds" in the Base App). Dropping these up front lets
// the rest of a 25-50 token basket sweep.
//
// Fails OPEN: a token is reported untransferable ONLY on a deterministic execution
// revert (RpcDeterministicError). Transient/transport RPC errors never drop a good
// token (and are not cached). Definite results are cached briefly.
async function isRoutePullable(
  user: Address,
  token: Address,
  amountIn: string,
  recipient: Address,
  chainId: number = BASE_CHAIN_ID,
): Promise<boolean> {
  if (BigInt(amountIn || "0") <= 0n) return true;

  const key = `${chainId}:${user.toLowerCase()}:${token.toLowerCase()}:${amountIn}:${recipient.toLowerCase()}`;
  const now = Date.now();
  const cached = transferProbeCache.get(key);
  if (cached && cached.expires > now) return cached.pullable;

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [recipient, BigInt(amountIn)],
  });

  let pullable = true;
  let definite = true;
  try {
    await chainRpcRequest<Hex>(
      chainId,
      "eth_call",
      [{ from: user, to: token, data }, "latest"],
      { timeoutMs: 5_000 },
    );
  } catch (error) {
    if (error instanceof RpcDeterministicError) {
      pullable = false; // genuine revert — the on-chain pull would revert too
    } else {
      definite = false; // transport/timeout — fail open, do not cache
    }
  }

  if (definite) {
    transferProbeCache.set(key, { pullable, expires: now + TRANSFER_PROBE_CACHE_TTL_MS });
  }
  return pullable;
}

// Probe a batch of routes and return the input tokens whose transferFrom pull would
// revert the atomic sweep. Shared by /quote (pre-screen → unavailable list) and
// /build-tx (last-second safety net).
async function findUntransferableRoutes(
  userAddress: Address,
  routes: Array<{ tokenIn: Address; amountIn: string }>,
  recipient: Address,
  chainId: number = BASE_CHAIN_ID,
): Promise<Address[]> {
  const items = routes.filter((route) => BigInt(route.amountIn || "0") > 0n);
  const probes = await pLimit(
    items.map((route) => async (): Promise<Address | null> => {
      const pullable = await isRoutePullable(userAddress, route.tokenIn, route.amountIn, recipient, chainId);
      return pullable ? null : route.tokenIn;
    }),
    PREFLIGHT_READ_CONCURRENCY,
  );
  return probes.filter((token): token is Address => token !== null);
}

async function findMissingPermit2Approvals(
  userAddress: Address,
  routes: DustSweepRoute[],
  chainId: number = BASE_CHAIN_ID,
) {
  return findMissingTokenApprovals(userAddress, routes, PERMIT2_ADDRESS, chainId);
}

async function findMissingTokenApprovals(
  userAddress: Address,
  routes: DustSweepRoute[],
  spender: Address,
  chainId: number = BASE_CHAIN_ID,
) {
  const requiredByToken = new Map<string, { token: Address; amount: bigint }>();

  for (const route of routes) {
    const amount = BigInt(route.amountIn || "0");
    if (amount <= 0n) continue;

    const key = route.tokenIn.toLowerCase();
    const current = requiredByToken.get(key);
    requiredByToken.set(key, {
      token: route.tokenIn,
      amount: (current?.amount || 0n) + amount,
    });
  }

  const approvals: Array<{
    token: Address;
    required: string;
    allowance: string;
    spender: Address;
  }> = [];

  // Parallel allowance reads (was one sequential RPC per token — the other half of
  // the pre-prompt delay on large sweeps).
  const items = Array.from(requiredByToken.values());
  const allowances = await pLimit(
    items.map((item) => () => readErc20Allowance(item.token, userAddress, spender, chainId)),
    PREFLIGHT_READ_CONCURRENCY,
  );

  items.forEach((item, index) => {
    const allowance = allowances[index] ?? 0n;
    if (allowance < item.amount) {
      approvals.push({
        token: item.token,
        required: item.amount.toString(),
        allowance: allowance.toString(),
        spender,
      });
    }
  });

  return approvals;
}

function getCachedErc20Metadata(token: Address) {
  const key = token.toLowerCase();
  const cached = erc20MetadataCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    erc20MetadataCache.delete(key);
    return null;
  }
  return cached.value;
}

function setCachedErc20Metadata(token: Address, value: Erc20Metadata) {
  erc20MetadataCache.set(token.toLowerCase(), {
    value,
    expiresAt: Date.now() + ERC20_METADATA_CACHE_TTL_MS,
  });
}

async function readErc20Metadata(token: Address): Promise<Erc20Metadata> {
  const cached = getCachedErc20Metadata(token);
  if (cached) return cached;

  const fallbackSymbol = `${token.slice(0, 6)}...${token.slice(-4)}`;
  const [symbolResult, nameResult, decimalsResult] = await Promise.allSettled([
    callContract(
      token,
      encodeFunctionData({ abi: erc20Abi, functionName: "symbol" }),
    ),
    callContract(
      token,
      encodeFunctionData({ abi: erc20Abi, functionName: "name" }),
    ),
    callContract(
      token,
      encodeFunctionData({ abi: erc20Abi, functionName: "decimals" }),
    ),
  ]);

  let symbol = fallbackSymbol;
  let name = fallbackSymbol;
  let decimals = 18;

  try {
    if (symbolResult.status === "fulfilled") {
      symbol = String(
        decodeFunctionResult({ abi: erc20Abi, functionName: "symbol", data: symbolResult.value }),
      ).slice(0, 32);
    }
  } catch {
    // Keep fallback.
  }
  try {
    if (nameResult.status === "fulfilled") {
      name = String(
        decodeFunctionResult({ abi: erc20Abi, functionName: "name", data: nameResult.value }),
      ).slice(0, 120);
    }
  } catch {
    // Keep fallback.
  }
  try {
    if (decimalsResult.status === "fulfilled") {
      decimals = Number(
        decodeFunctionResult({ abi: erc20Abi, functionName: "decimals", data: decimalsResult.value }),
      );
    }
  } catch {
    // Keep fallback.
  }

  const metadata = {
    symbol: sanitizeDbText(symbol, fallbackSymbol, 32),
    name: sanitizeDbText(name, symbol || fallbackSymbol, 120),
    decimals: Number.isFinite(decimals) ? decimals : 18,
  };
  setCachedErc20Metadata(token, metadata);
  return metadata;
}

function toTokenUpsertRow(row: TokenWhitelistRow) {
  const fallbackSymbol = `${row.address.slice(0, 6)}...${row.address.slice(-4)}`;
  return {
    address: row.address,
    symbol: sanitizeDbText(row.symbol, fallbackSymbol, 32),
    name: sanitizeDbText(row.name, row.symbol || fallbackSymbol, 120),
    decimals: Number.isFinite(Number(row.decimals)) ? Number(row.decimals) : 18,
    logo_uri: row.logo_uri ? sanitizeDbText(row.logo_uri, "", 500) || null : null,
    chain_id: BASE_CHAIN_ID,
    is_active: true,
    source: sanitizeDbText(row.source, "unknown", 180),
    liquidity_usd: Number.isFinite(Number(row.liquidity_usd)) ? Number(row.liquidity_usd) : null,
    last_checked: new Date().toISOString(),
  };
}

async function upsertTokenRows(rows: TokenWhitelistRow[]): Promise<TokenUpsertResult> {
  if (rows.length === 0) return { written: 0, skipped: 0, errors: [] };

  const payload = rows.map(toTokenUpsertRow);
  // Whitelist rows are chain-scoped: conflict on (chain_id, address), not address alone.
  const { error } = await postgresDb.from("tokens").upsert(payload, {
    onConflict: "chain_id,address",
  });

  if (!error) {
    return { written: rows.length, skipped: 0, errors: [] };
  }

  if (rows.length === 1) {
    return {
      written: 0,
      skipped: 1,
      errors: [`${rows[0].address}: ${error.message}`],
    };
  }

  const mid = Math.ceil(rows.length / 2);
  const [left, right] = await Promise.all([
    upsertTokenRows(rows.slice(0, mid)),
    upsertTokenRows(rows.slice(mid)),
  ]);

  return {
    written: left.written + right.written,
    skipped: left.skipped + right.skipped,
    errors: [...left.errors, ...right.errors].slice(0, 12),
  };
}

export async function syncWhitelistFromOnchainDexes(args: {
  fromBlock?: number;
  toBlock?: number;
  blockStep: number;
  maxTokens: number;
  minLiquidityUSD: number;
  replaceActive?: boolean;
  delayMs?: number;
}) {
  const ethUsd = await fetchEthUsdPrice();
  const scan = await scanOnchainPools({
    fromBlock: args.fromBlock,
    toBlock: args.toBlock,
    blockStep: args.blockStep,
    delayMs: args.delayMs || 0,
  });
  const pools = scan.pools;
  if (pools.length === 0 && scan.errors.length > 0) {
    throw new Error(`Onchain pool scan failed: ${scan.errors.join("; ")}`);
  }
  const bestByToken = new Map<string, OnchainPoolCandidate>();

  for (const pool of pools) {
    const token0Quote = ONCHAIN_QUOTE_TOKENS.get(pool.token0.toLowerCase());
    const token1Quote = ONCHAIN_QUOTE_TOKENS.get(pool.token1.toLowerCase());
    if (token0Quote && token1Quote) continue;
    const quote = token0Quote || token1Quote;
    if (!quote) continue;

    const token = token0Quote ? pool.token1 : pool.token0;
    try {
      const quoteBalance = await readErc20Balance(quote.address, pool.pool);
      const quoteAmount = Number(formatUnits(quoteBalance, quote.decimals));
      const quoteUsd = quote.usd ?? ethUsd;
      const liquidityUSD = quoteAmount * quoteUsd * 2;
      if (!Number.isFinite(liquidityUSD) || liquidityUSD < args.minLiquidityUSD) {
        continue;
      }

      const key = token.toLowerCase();
      const existing = bestByToken.get(key);
      if (!existing || existing.liquidityUSD < liquidityUSD) {
        bestByToken.set(key, {
          token,
          quoteToken: quote.address,
          pool: pool.pool,
          source: pool.source,
          liquidityUSD,
        });
      }
    } catch {
      // Ignore pools with non-standard quote token behavior.
    }

    if (args.delayMs) await sleep(args.delayMs);
  }

  const sortedCandidates = Array.from(bestByToken.values())
    .sort((a, b) => b.liquidityUSD - a.liquidityUSD);
  const selected = args.maxTokens > 0
    ? sortedCandidates.slice(0, args.maxTokens)
    : sortedCandidates;
  const rows: TokenWhitelistRow[] = [];

  for (const candidate of selected) {
    const metadata = await readErc20Metadata(candidate.token).catch(() => ({
      symbol: `${candidate.token.slice(0, 6)}...${candidate.token.slice(-4)}`,
      name: `${candidate.token.slice(0, 6)}...${candidate.token.slice(-4)}`,
      decimals: 18,
    }));
    rows.push({
      address: candidate.token,
      symbol: metadata.symbol,
      name: metadata.name,
      decimals: metadata.decimals,
      logo_uri: null,
      liquidity_usd: candidate.liquidityUSD,
      source: `${candidate.source}:${candidate.pool}`,
    });
  }

  if (args.replaceActive) {
    const { error } = await postgresDb
      .from("tokens")
      .update({
        is_active: false,
        last_checked: new Date().toISOString(),
      })
      .eq("chain_id", BASE_CHAIN_ID)
      .like("source", "onchain:%");
    if (error) throw new Error(error.message);
  }

  let tokensWritten = 0;
  let tokensSkipped = 0;
  const upsertErrors: string[] = [];

  for (let i = 0; i < rows.length; i += 500) {
    const chunkRows = rows.slice(i, i + 500);
    const existingByAddress = new Map<string, number>();
    const { data: existingRows } = await postgresDb
      .from("tokens")
      .select("address,liquidity_usd")
      .in("address", chunkRows.map((row) => row.address));
    for (const existing of (existingRows || []) as Array<{ address?: string; liquidity_usd?: string | number | null }>) {
      if (existing.address) {
        existingByAddress.set(existing.address.toLowerCase(), Number(existing.liquidity_usd || 0));
      }
    }

    const chunk = chunkRows
      .filter((row) => Number(row.liquidity_usd || 0) >= (existingByAddress.get(row.address.toLowerCase()) || 0))
      .map((row) => ({
        ...row,
        symbol: sanitizeDbText(row.symbol, `${row.address.slice(0, 6)}...${row.address.slice(-4)}`, 32),
        name: sanitizeDbText(row.name, row.symbol, 120),
        source: sanitizeDbText(row.source, "onchain", 180),
      }));

    if (chunk.length === 0) continue;

    const result = await upsertTokenRows(chunk);
    tokensWritten += result.written;
    tokensSkipped += result.skipped;
    upsertErrors.push(...result.errors);
  }

  return {
    poolsScanned: pools.length,
    logErrors: scan.errors,
    tokensConsidered: bestByToken.size,
    tokensUpserted: rows.length,
    tokensWritten,
    tokensSkipped,
    upsertErrors: upsertErrors.slice(0, 12),
  };
}

function getAllowedGeckoDexIds() {
  const configured = String(process.env.DUST_SWEEP_WHITELIST_DEX_IDS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  return new Set(
    configured.length > 0
      ? configured
      : [
          "aerodrome",
          "pancakeswap-v3-base",
          "baseswap",
          "uniswap-v3-base",
        ],
  );
}

function getDefaultTokenListUrls() {
  const configured = String(process.env.DUST_SWEEP_TOKEN_LIST_URLS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return Array.from(new Set([
    "https://tokens.uniswap.org/",
    "https://raw.githubusercontent.com/baseswapfi/default-token-list/main/build/baseswap-default.tokenlist.json",
    ...configured,
  ]));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDexScreenerDexSource(pair: DexScreenerPair) {
  const dexId = String(pair.dexId || "").toLowerCase();
  const labels = (pair.labels || []).map((label) => label.toLowerCase());

  if (dexId === "aerodrome") return "aerodrome";
  if (dexId === "baseswap") return "baseswap";
  if (dexId === "pancakeswap") return "pancakeswap-v3-base";
  if (dexId === "uniswap" && labels.includes("v3")) return "uniswap-v3-base";

  return null;
}

async function fetchBlockscoutTokenPage(nextPageParams?: Record<string, unknown>) {
  const url = new URL(`${getBlockscoutApiV2BaseUrl()}/tokens`);
  url.searchParams.set("type", "ERC-20");

  for (const [key, value] of Object.entries(nextPageParams || {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const apiKey = getBlockscoutApiKey();
  if (apiKey) url.searchParams.set("apikey", apiKey);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "DustSwap/1.0 (+https://app.dustswap.wtf)",
    },
  });
  if (!response.ok) {
    throw new Error(`Blockscout token list failed with ${response.status}`);
  }

  return (await response.json()) as {
    items?: BlockscoutTokenItem[];
    next_page_params?: Record<string, unknown> | null;
  };
}

async function fetchDexScreenerPairs(addresses: Address[]) {
  if (addresses.length === 0) return [];

  for (let attempt = 0; attempt <= getDexScreenerMaxRetries(); attempt++) {
    const response = await fetch(`https://api.dexscreener.com/tokens/v1/base/${addresses.join(",")}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "DustSwap/1.0 (+https://app.dustswap.wtf)",
      },
    });

    if (response.ok) {
      return (await response.json()) as DexScreenerPair[];
    }

    if ((response.status === 429 || response.status >= 500) && attempt < getDexScreenerMaxRetries()) {
      await sleepForDexScreenerRetry(response, attempt);
      continue;
    }

    throw new Error(`DexScreener token liquidity failed with ${response.status}`);
  }

  return [];
}

function getPairTokenAddresses(pair: DexScreenerPair) {
  return [
    pair.baseToken?.address,
    pair.quoteToken?.address,
  ]
    .filter((address): address is string => Boolean(address && isAddress(address)))
    .map((address) => normalizeAddress(address).toLowerCase());
}

function parsePositiveNumber(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getDexScreenerMaxRetries() {
  const parsed = Number(process.env.DUST_SWEEP_DEXSCREENER_MAX_RETRIES || "8");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 8;
}

function getDexScreenerRetryMs() {
  const parsed = Number(process.env.DUST_SWEEP_DEXSCREENER_RETRY_MS || "15000");
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 15_000;
}

async function sleepForDexScreenerRetry(response: Response, attempt: number) {
  const retryAfterSeconds = Number(response.headers.get("retry-after") || 0);
  const waitMs = retryAfterSeconds > 0
    ? retryAfterSeconds * 1000
    : getDexScreenerRetryMs() * Math.max(1, attempt + 1);
  await sleep(Math.min(waitMs, 120_000));
}

export async function syncWhitelistFromBlockscoutDexScreener(args: {
  maxPages: number;
  maxTokens: number;
  minLiquidityUSD: number;
  replaceActive?: boolean;
  delayMs?: number;
}) {
  const candidates = new Map<string, TokenWhitelistRow>();
  let nextPageParams: Record<string, unknown> | null | undefined;
  let pagesScanned = 0;

  for (let page = 1; page <= args.maxPages; page++) {
    const payload = await fetchBlockscoutTokenPage(nextPageParams || undefined);
    pagesScanned = page;

    for (const item of payload.items || []) {
      const rawAddress = item.address_hash || item.address;
      if (!rawAddress || !isAddress(rawAddress)) continue;
      if (String(item.type || "").toUpperCase() !== "ERC-20") continue;
      if (String(item.reputation || "").toLowerCase() === "spam") continue;

      const address = normalizeAddress(rawAddress);
      const decimals = Number(item.decimals ?? 18);
      const symbol = String(item.symbol || "TOKEN").slice(0, 32);
      candidates.set(address.toLowerCase(), {
        address,
        symbol,
        name: String(item.name || symbol || "Token").slice(0, 120),
        decimals: Number.isFinite(decimals) ? decimals : 18,
        logo_uri: item.icon_url || null,
        liquidity_usd: Math.max(
          parsePositiveNumber(item.volume_24h),
          parsePositiveNumber(item.circulating_market_cap),
        ),
        source: "blockscout:tokens",
      });
    }

    nextPageParams = payload.next_page_params;
    if (!nextPageParams || candidates.size >= args.maxTokens * 3) break;
    if (args.delayMs) await sleep(args.delayMs);
  }

  const candidateRows = Array.from(candidates.values());
  const bestByToken = new Map<string, TokenWhitelistRow>();
  let pairsScanned = 0;
  const dexScreenerErrors: string[] = [];
  const batchSize = 30;

  for (let i = 0; i < candidateRows.length; i += batchSize) {
    const batch = candidateRows.slice(i, i + batchSize);
    const tokenByAddress = new Map(batch.map((token) => [token.address.toLowerCase(), token]));
    const pairs = await fetchDexScreenerPairs(batch.map((token) => token.address as Address)).catch((error) => {
      if (dexScreenerErrors.length < 12) {
        dexScreenerErrors.push(`batch ${i}-${i + batch.length - 1}: ${(error as Error).message}`);
      }
      return [];
    });
    pairsScanned += pairs.length;

    for (const pair of pairs) {
      if (String(pair.chainId || "").toLowerCase() !== "base") continue;
      const dexSource = getDexScreenerDexSource(pair);
      if (!dexSource) continue;

      const liquidityUSD = parsePositiveNumber(pair.liquidity?.usd);
      if (liquidityUSD < args.minLiquidityUSD) continue;

      for (const tokenAddress of getPairTokenAddresses(pair)) {
        const token = tokenByAddress.get(tokenAddress);
        if (!token) continue;

        const existing = bestByToken.get(tokenAddress);
        if (existing && Number(existing.liquidity_usd || 0) >= liquidityUSD) continue;

        bestByToken.set(tokenAddress, {
          ...token,
          logo_uri: token.logo_uri || pair.info?.imageUrl || null,
          liquidity_usd: liquidityUSD,
          source: `dexscreener:${dexSource}:${pair.pairAddress || "unknown"}`,
        });
      }
    }

    if (args.delayMs && i + batchSize < candidateRows.length) {
      await sleep(args.delayMs);
    }
  }

  const rows = Array.from(bestByToken.values())
    .sort((a, b) => Number(b.liquidity_usd || 0) - Number(a.liquidity_usd || 0))
    .slice(0, args.maxTokens);

  if (args.replaceActive) {
    const { error } = await postgresDb
      .from("tokens")
      .update({
        is_active: false,
        last_checked: new Date().toISOString(),
      })
      .eq("chain_id", BASE_CHAIN_ID)
      .like("source", "dexscreener:%");
    if (error) throw new Error(error.message);
  }

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((row) => ({
      address: row.address,
      symbol: row.symbol,
      name: row.name,
      decimals: row.decimals,
      logo_uri: row.logo_uri,
      chain_id: BASE_CHAIN_ID,
      is_active: true,
      source: row.source,
      liquidity_usd: row.liquidity_usd,
      last_checked: new Date().toISOString(),
    }));

    const { error } = await postgresDb.from("tokens").upsert(chunk, {
      onConflict: "chain_id,address",
    });
    if (error) throw new Error(error.message);
  }

  return {
    pagesScanned,
    candidatesConsidered: candidateRows.length,
    pairsScanned,
    dexScreenerErrors,
    tokensWithLiquidity: bestByToken.size,
    tokensUpserted: rows.length,
  };
}

async function fetchTokenListRows(url: string) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "DustSwap/1.0 (+https://app.dustswap.wtf)",
    },
  });
  if (!response.ok) {
    throw new Error(`Token list ${url} failed with ${response.status}`);
  }

  const payload = (await response.json()) as {
    name?: string;
    tokens?: TokenListToken[];
  } | TokenListToken[];
  const tokens = Array.isArray(payload) ? payload : payload.tokens || [];
  const sourceName = Array.isArray(payload)
    ? new URL(url).hostname
    : sanitizeDbText(payload.name, new URL(url).hostname, 80);
  const rows: TokenWhitelistRow[] = [];

  for (const token of tokens) {
    if (Number(token.chainId) !== BASE_CHAIN_ID || !token.address || !isAddress(token.address)) {
      continue;
    }

    const address = normalizeAddress(token.address);
    const fallbackSymbol = `${address.slice(0, 6)}...${address.slice(-4)}`;
    rows.push({
      address,
      symbol: sanitizeDbText(token.symbol, fallbackSymbol, 32),
      name: sanitizeDbText(token.name, token.symbol || fallbackSymbol, 120),
      decimals: Number.isFinite(Number(token.decimals)) ? Number(token.decimals) : 18,
      logo_uri: token.logoURI || token.logo_uri || null,
      liquidity_usd: 0,
      source: `token-list:${sourceName}`,
    });
  }

  return rows;
}

export async function syncWhitelistFromTokenLists(args: {
  urls?: string[];
  maxTokens: number;
  minLiquidityUSD: number;
  replaceActive?: boolean;
  delayMs?: number;
}) {
  const candidateByAddress = new Map<string, TokenWhitelistRow>();
  const urls = Array.from(new Set(args.urls?.length ? args.urls : getDefaultTokenListUrls()));
  const listErrors: string[] = [];

  for (const url of urls) {
    try {
      const rows = await fetchTokenListRows(url);
      for (const row of rows) {
        const key = row.address.toLowerCase();
        const existing = candidateByAddress.get(key);
        candidateByAddress.set(key, {
          ...row,
          logo_uri: existing?.logo_uri || row.logo_uri || null,
          source: existing?.source ? `${existing.source},${row.source}` : row.source,
        });
      }
    } catch (error) {
      if (listErrors.length < 12) {
        listErrors.push(`${url}: ${(error as Error).message}`);
      }
    }

    if (args.delayMs) await sleep(args.delayMs);
  }

  const candidateRows = Array.from(candidateByAddress.values());
  const bestByToken = new Map<string, TokenWhitelistRow>();
  let pairsScanned = 0;
  const dexScreenerErrors: string[] = [];
  const batchSize = 30;

  for (let i = 0; i < candidateRows.length; i += batchSize) {
    const batch = candidateRows.slice(i, i + batchSize);
    const tokenByAddress = new Map(batch.map((token) => [token.address.toLowerCase(), token]));
    const pairs = await fetchDexScreenerPairs(batch.map((token) => token.address as Address)).catch((error) => {
      if (dexScreenerErrors.length < 12) {
        dexScreenerErrors.push(`batch ${i}-${i + batch.length - 1}: ${(error as Error).message}`);
      }
      return [];
    });
    pairsScanned += pairs.length;

    for (const pair of pairs) {
      if (String(pair.chainId || "").toLowerCase() !== "base") continue;
      const dexSource = getDexScreenerDexSource(pair);
      if (!dexSource) continue;

      const liquidityUSD = parsePositiveNumber(pair.liquidity?.usd);
      if (liquidityUSD < args.minLiquidityUSD) continue;

      for (const tokenAddress of getPairTokenAddresses(pair)) {
        const token = tokenByAddress.get(tokenAddress);
        if (!token) continue;

        const existing = bestByToken.get(tokenAddress);
        if (existing && Number(existing.liquidity_usd || 0) >= liquidityUSD) continue;

        bestByToken.set(tokenAddress, {
          ...token,
          logo_uri: token.logo_uri || pair.info?.imageUrl || null,
          liquidity_usd: liquidityUSD,
          source: `${token.source || "token-list"}:${dexSource}:${pair.pairAddress || "unknown"}`,
        });
      }
    }

    if (args.delayMs && i + batchSize < candidateRows.length) {
      await sleep(args.delayMs);
    }
  }

  const rows = Array.from(bestByToken.values())
    .sort((a, b) => Number(b.liquidity_usd || 0) - Number(a.liquidity_usd || 0))
    .slice(0, args.maxTokens);

  if (args.replaceActive) {
    const { error } = await postgresDb
      .from("tokens")
      .update({
        is_active: false,
        last_checked: new Date().toISOString(),
      })
      .eq("chain_id", BASE_CHAIN_ID)
      .like("source", "token-list:%");
    if (error) throw new Error(error.message);
  }

  let tokensWritten = 0;
  let tokensSkipped = 0;
  const upsertErrors: string[] = [];

  for (let i = 0; i < rows.length; i += 500) {
    const result = await upsertTokenRows(rows.slice(i, i + 500));
    tokensWritten += result.written;
    tokensSkipped += result.skipped;
    upsertErrors.push(...result.errors);
  }

  return {
    urlsScanned: urls,
    listErrors,
    candidatesConsidered: candidateRows.length,
    pairsScanned,
    dexScreenerErrors,
    tokensWithLiquidity: bestByToken.size,
    tokensUpserted: rows.length,
    tokensWritten,
    tokensSkipped,
    upsertErrors: upsertErrors.slice(0, 12),
  };
}

export async function syncWhitelistFromPoolEventsDexScreener(args: {
  fromBlock?: number;
  toBlock?: number;
  blockStep: number;
  maxTokens: number;
  minLiquidityUSD: number;
  replaceActive?: boolean;
  delayMs?: number;
}) {
  const scan = await scanOnchainPools({
    fromBlock: args.fromBlock,
    toBlock: args.toBlock,
    blockStep: args.blockStep,
    delayMs: 0,
  });
  const pools = scan.pools;
  if (pools.length === 0 && scan.errors.length > 0) {
    throw new Error(`Pool-event scan failed: ${scan.errors.join("; ")}`);
  }

  const tokenAddresses = Array.from(
    new Set(
      pools
        .flatMap((pool) => [pool.token0, pool.token1])
        .map((address) => normalizeAddress(address).toLowerCase()),
    ),
  ).map((address) => normalizeAddress(address));

  const bestByToken = new Map<string, TokenWhitelistRow>();
  let pairsScanned = 0;
  const dexScreenerErrors: string[] = [];
  const batchSize = 30;

  for (let i = 0; i < tokenAddresses.length; i += batchSize) {
    const batch = tokenAddresses.slice(i, i + batchSize);
    const pairs = await fetchDexScreenerPairs(batch).catch((error) => {
      if (dexScreenerErrors.length < 12) {
        dexScreenerErrors.push(`batch ${i}-${i + batch.length - 1}: ${(error as Error).message}`);
      }
      return [];
    });
    pairsScanned += pairs.length;

    for (const pair of pairs) {
      if (String(pair.chainId || "").toLowerCase() !== "base") continue;
      const dexSource = getDexScreenerDexSource(pair);
      if (!dexSource) continue;

      const liquidityUSD = parsePositiveNumber(pair.liquidity?.usd);
      if (liquidityUSD < args.minLiquidityUSD) continue;

      const pairTokens = [
        { token: pair.baseToken, usePairImage: true },
        { token: pair.quoteToken, usePairImage: false },
      ];

      for (const { token, usePairImage } of pairTokens) {
        if (!token?.address || !isAddress(token.address)) continue;

        const address = normalizeAddress(token.address);
        const key = address.toLowerCase();
        const existing = bestByToken.get(key);
        if (existing && Number(existing.liquidity_usd || 0) >= liquidityUSD) continue;

        const fallbackSymbol = `${address.slice(0, 6)}...${address.slice(-4)}`;
        bestByToken.set(key, {
          address,
          symbol: sanitizeDbText(token.symbol, fallbackSymbol, 32),
          name: sanitizeDbText(token.name, token.symbol || fallbackSymbol, 120),
          decimals: 18,
          logo_uri: usePairImage ? pair.info?.imageUrl || null : null,
          liquidity_usd: liquidityUSD,
          source: `pool-events:${dexSource}:${pair.pairAddress || "unknown"}`,
        });
      }
    }

    if (args.delayMs && i + batchSize < tokenAddresses.length) {
      await sleep(args.delayMs);
    }
  }

  const rows = Array.from(bestByToken.values())
    .sort((a, b) => Number(b.liquidity_usd || 0) - Number(a.liquidity_usd || 0))
    .slice(0, args.maxTokens);

  if (args.replaceActive) {
    const { error } = await postgresDb
      .from("tokens")
      .update({
        is_active: false,
        last_checked: new Date().toISOString(),
      })
      .eq("chain_id", BASE_CHAIN_ID)
      .like("source", "pool-events:%");
    if (error) throw new Error(error.message);
  }

  let tokensWritten = 0;
  let tokensSkipped = 0;
  const upsertErrors: string[] = [];

  for (let i = 0; i < rows.length; i += 500) {
    const chunkRows = rows.slice(i, i + 500);
    const existingByAddress = new Map<string, number>();
    const { data: existingRows } = await postgresDb
      .from("tokens")
      .select("address,liquidity_usd")
      .in("address", chunkRows.map((row) => row.address));

    for (const existing of (existingRows || []) as Array<{ address?: string; liquidity_usd?: string | number | null }>) {
      if (existing.address) {
        existingByAddress.set(existing.address.toLowerCase(), Number(existing.liquidity_usd || 0));
      }
    }

    const chunk = chunkRows.filter(
      (row) => Number(row.liquidity_usd || 0) >= (existingByAddress.get(row.address.toLowerCase()) || 0),
    );
    const result = await upsertTokenRows(chunk);
    tokensWritten += result.written;
    tokensSkipped += result.skipped;
    upsertErrors.push(...result.errors);
  }

  return {
    poolsScanned: pools.length,
    tokenCandidates: tokenAddresses.length,
    pairsScanned,
    dexScreenerErrors,
    logErrors: scan.errors,
    tokensWithLiquidity: bestByToken.size,
    tokensUpserted: rows.length,
    tokensWritten,
    tokensSkipped,
    upsertErrors: upsertErrors.slice(0, 12),
  };
}

export async function syncWhitelistFromGeckoTerminal(args: {
  startPage?: number;
  maxPages: number;
  maxTokens: number;
  minLiquidityUSD: number;
  replaceActive?: boolean;
  delayMs?: number;
}) {
  const allowedDexIds = getAllowedGeckoDexIds();
  const byAddress = new Map<string, TokenWhitelistRow>();
  const startPage = Math.max(1, Math.floor(Number(args.startPage || 1)));
  const endPage = startPage + args.maxPages - 1;

  for (let page = startPage; page <= endPage; page++) {
    const payload = await fetchGeckoPoolsPage(page);
    const tokensById = new Map<string, GeckoToken>();
    for (const token of payload.included || []) {
      if (token.id) tokensById.set(token.id, token);
    }

    for (const pool of payload.data || []) {
      const dexId = pool.relationships?.dex?.data?.id?.toLowerCase();
      const liquidityUSD = Number(pool.attributes?.reserve_in_usd || 0);
      if (!dexId || !allowedDexIds.has(dexId) || liquidityUSD < args.minLiquidityUSD) {
        continue;
      }

      const tokenIds = [
        pool.relationships?.base_token?.data?.id,
        pool.relationships?.quote_token?.data?.id,
      ].filter(Boolean) as string[];

      for (const tokenId of tokenIds) {
        const token = tokensById.get(tokenId);
        const address = token?.attributes?.address;
        if (!address || !isAddress(address)) continue;

        const normalized = normalizeAddress(address);
        const key = normalized.toLowerCase();
        const existing = byAddress.get(key);
        const nextLiquidity = Math.max(Number(existing?.liquidity_usd || 0), liquidityUSD);

        byAddress.set(key, {
          address: normalized,
          symbol: String(token?.attributes?.symbol || "TOKEN").slice(0, 32),
          name: String(token?.attributes?.name || token?.attributes?.symbol || "Token").slice(0, 120),
          decimals: Number(token?.attributes?.decimals ?? 18),
          logo_uri: token?.attributes?.image_url,
          liquidity_usd: nextLiquidity,
          source: `geckoterminal:${dexId}`,
        });
      }
    }

    if (args.delayMs && page < endPage) {
      await sleep(args.delayMs);
    }
  }

  const rows = Array.from(byAddress.values())
    .sort((a, b) => Number(b.liquidity_usd || 0) - Number(a.liquidity_usd || 0))
    .slice(0, args.maxTokens);

  if (args.replaceActive) {
    const { error } = await postgresDb
      .from("tokens")
      .update({
        is_active: false,
        last_checked: new Date().toISOString(),
      })
      .eq("chain_id", BASE_CHAIN_ID)
      .like("source", "geckoterminal:%");
    if (error) throw new Error(error.message);
  }

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((row) => ({
      address: row.address,
      symbol: row.symbol,
      name: row.name,
      decimals: row.decimals,
      logo_uri: row.logo_uri,
      chain_id: BASE_CHAIN_ID,
      is_active: true,
      source: row.source,
      liquidity_usd: row.liquidity_usd,
      last_checked: new Date().toISOString(),
    }));

    const { error } = await postgresDb.from("tokens").upsert(chunk, {
      onConflict: "chain_id,address",
    });
    if (error) throw new Error(error.message);
  }

  return {
    startPage,
    endPage,
    tokensConsidered: byAddress.size,
    tokensUpserted: rows.length,
  };
}

dustsweepRoutes.post("/admin/sync-whitelist", async (c) => {
  const expected = process.env.DUST_SWEEP_ADMIN_TOKEN || process.env.QUEST_ADMIN_TOKEN;
  if (!expected || c.req.header("x-admin-token") !== expected) {
    return c.json(errorJson("Unauthorized"), 401);
  }

  const body: {
    startPage?: number;
    maxPages?: number;
    maxTokens?: number;
    minLiquidityUSD?: number;
    replaceActive?: boolean;
    delayMs?: number;
  } = await c.req.json<{
    startPage?: number;
    maxPages?: number;
    maxTokens?: number;
    minLiquidityUSD?: number;
    replaceActive?: boolean;
    delayMs?: number;
  }>().catch(() => ({}));

  try {
    const result = await syncWhitelistFromGeckoTerminal({
      startPage: Math.max(1, Number(body.startPage || 1)),
      maxPages: Math.max(1, Math.min(250, Number(body.maxPages || 200))),
      maxTokens: Math.max(1, Math.min(50_000, Number(body.maxTokens || 4000))),
      minLiquidityUSD: Math.max(0, Number(body.minLiquidityUSD ?? MIN_WL_LIQUIDITY_USD)),
      replaceActive: Boolean(body.replaceActive),
      delayMs: Math.max(
        0,
        Math.min(5000, Number(body.delayMs ?? process.env.DUST_SWEEP_WHITELIST_SYNC_DELAY_MS ?? 0)),
      ),
    });

    return c.json({ success: true, ...result });
  } catch (error) {
    console.error("[dustsweep/admin/sync-whitelist] Error:", error);
    return c.json(errorJson((error as Error).message || "Failed to sync whitelist"), 500);
  }
});

dustsweepRoutes.get("/admin/token-counts", async (c) => {
  const expected = process.env.DUST_SWEEP_ADMIN_TOKEN || process.env.QUEST_ADMIN_TOKEN;
  if (!expected || c.req.header("x-admin-token") !== expected) {
    return c.json(errorJson("Unauthorized"), 401);
  }

  try {
    const countFor = async (sourceLike?: string) => {
      let query = postgresDb
        .from("tokens")
        .select("id", { count: "exact", head: true })
        .eq("chain_id", BASE_CHAIN_ID)
        .eq("is_active", true);

      if (sourceLike) {
        query = query.like("source", sourceLike);
      }

      const { count, error } = await query;
      if (error) throw new Error(error.message);
      return count || 0;
    };

    const [activeTotal, onchain, poolEvents, dexscreener, geckoterminal, defaults] = await Promise.all([
      countFor(),
      countFor("onchain:%"),
      countFor("pool-events:%"),
      countFor("dexscreener:%"),
      countFor("geckoterminal:%"),
      countFor("default"),
    ]);

    return c.json({
      success: true,
      activeTotal,
      sources: {
        onchain,
        poolEvents,
        dexscreener,
        geckoterminal,
        default: defaults,
      },
    });
  } catch (error) {
    console.error("[dustsweep/admin/token-counts] Error:", error);
    return c.json(errorJson((error as Error).message || "Failed to count whitelist tokens"), 500);
  }
});

dustsweepRoutes.post("/admin/sync-whitelist-blockscout", async (c) => {
  const expected = process.env.DUST_SWEEP_ADMIN_TOKEN || process.env.QUEST_ADMIN_TOKEN;
  if (!expected || c.req.header("x-admin-token") !== expected) {
    return c.json(errorJson("Unauthorized"), 401);
  }

  const body: {
    maxPages?: number;
    maxTokens?: number;
    minLiquidityUSD?: number;
    replaceActive?: boolean;
    delayMs?: number;
  } = await c.req.json<{
    maxPages?: number;
    maxTokens?: number;
    minLiquidityUSD?: number;
    replaceActive?: boolean;
    delayMs?: number;
  }>().catch(() => ({}));

  try {
    const result = await syncWhitelistFromBlockscoutDexScreener({
      maxPages: Math.max(1, Math.min(500, Number(body.maxPages || 120))),
      maxTokens: Math.max(1, Math.min(50_000, Number(body.maxTokens || 4000))),
      minLiquidityUSD: Math.max(0, Number(body.minLiquidityUSD ?? MIN_WL_LIQUIDITY_USD)),
      replaceActive: Boolean(body.replaceActive),
      delayMs: Math.max(
        0,
        Math.min(5000, Number(body.delayMs ?? process.env.DUST_SWEEP_BLOCKSCOUT_SYNC_DELAY_MS ?? 0)),
      ),
    });

    return c.json({ success: true, ...result });
  } catch (error) {
    console.error("[dustsweep/admin/sync-whitelist-blockscout] Error:", error);
    return c.json(errorJson((error as Error).message || "Failed to sync Blockscout whitelist"), 500);
  }
});

dustsweepRoutes.post("/admin/sync-whitelist-token-lists", async (c) => {
  const expected = process.env.DUST_SWEEP_ADMIN_TOKEN || process.env.QUEST_ADMIN_TOKEN;
  if (!expected || c.req.header("x-admin-token") !== expected) {
    return c.json(errorJson("Unauthorized"), 401);
  }

  const body: {
    urls?: string[];
    maxTokens?: number;
    minLiquidityUSD?: number;
    replaceActive?: boolean;
    delayMs?: number;
  } = await c.req.json<{
    urls?: string[];
    maxTokens?: number;
    minLiquidityUSD?: number;
    replaceActive?: boolean;
    delayMs?: number;
  }>().catch(() => ({}));

  try {
    const result = await syncWhitelistFromTokenLists({
      urls: Array.isArray(body.urls)
        ? body.urls.filter((url) => typeof url === "string" && url.startsWith("https://")).slice(0, 20)
        : undefined,
      maxTokens: Math.max(1, Math.min(50_000, Number(body.maxTokens || 4000))),
      minLiquidityUSD: Math.max(0, Number(body.minLiquidityUSD ?? MIN_WL_LIQUIDITY_USD)),
      replaceActive: Boolean(body.replaceActive),
      delayMs: Math.max(
        0,
        Math.min(5000, Number(body.delayMs ?? process.env.DUST_SWEEP_TOKEN_LIST_SYNC_DELAY_MS ?? 150)),
      ),
    });

    return c.json({ success: true, ...result });
  } catch (error) {
    console.error("[dustsweep/admin/sync-whitelist-token-lists] Error:", error);
    return c.json(errorJson((error as Error).message || "Failed to sync token-list whitelist"), 500);
  }
});

dustsweepRoutes.post("/admin/sync-whitelist-onchain", async (c) => {
  const expected = process.env.DUST_SWEEP_ADMIN_TOKEN || process.env.QUEST_ADMIN_TOKEN;
  if (!expected || c.req.header("x-admin-token") !== expected) {
    return c.json(errorJson("Unauthorized"), 401);
  }

  const body: {
    fromBlock?: number;
    toBlock?: number;
    blockStep?: number;
    maxTokens?: number;
    minLiquidityUSD?: number;
    replaceActive?: boolean;
    delayMs?: number;
  } = await c.req.json<{
    fromBlock?: number;
    toBlock?: number;
    blockStep?: number;
    maxTokens?: number;
    minLiquidityUSD?: number;
    replaceActive?: boolean;
    delayMs?: number;
  }>().catch(() => ({}));

  try {
    const result = await syncWhitelistFromOnchainDexes({
      fromBlock: body.fromBlock === undefined ? undefined : Math.max(0, Number(body.fromBlock)),
      toBlock: body.toBlock === undefined ? undefined : Math.max(0, Number(body.toBlock)),
      blockStep: Math.max(1_000, Math.min(250_000, Number(body.blockStep || 50_000))),
      maxTokens: Math.max(1, Math.min(50_000, Number(body.maxTokens || 4000))),
      minLiquidityUSD: Math.max(0, Number(body.minLiquidityUSD ?? MIN_WL_LIQUIDITY_USD)),
      replaceActive: Boolean(body.replaceActive),
      delayMs: Math.max(
        0,
        Math.min(5000, Number(body.delayMs ?? process.env.DUST_SWEEP_ONCHAIN_SYNC_DELAY_MS ?? 0)),
      ),
    });

    return c.json({ success: true, ...result });
  } catch (error) {
    console.error("[dustsweep/admin/sync-whitelist-onchain] Error:", error);
    return c.json(errorJson((error as Error).message || "Failed to sync onchain whitelist"), 500);
  }
});

dustsweepRoutes.post("/admin/sync-whitelist-pool-events", async (c) => {
  const expected = process.env.DUST_SWEEP_ADMIN_TOKEN || process.env.QUEST_ADMIN_TOKEN;
  if (!expected || c.req.header("x-admin-token") !== expected) {
    return c.json(errorJson("Unauthorized"), 401);
  }

  const body: {
    fromBlock?: number;
    toBlock?: number;
    blockStep?: number;
    maxTokens?: number;
    minLiquidityUSD?: number;
    replaceActive?: boolean;
    delayMs?: number;
  } = await c.req.json<{
    fromBlock?: number;
    toBlock?: number;
    blockStep?: number;
    maxTokens?: number;
    minLiquidityUSD?: number;
    replaceActive?: boolean;
    delayMs?: number;
  }>().catch(() => ({}));

  try {
    const result = await syncWhitelistFromPoolEventsDexScreener({
      fromBlock: body.fromBlock === undefined ? undefined : Math.max(0, Number(body.fromBlock)),
      toBlock: body.toBlock === undefined ? undefined : Math.max(0, Number(body.toBlock)),
      blockStep: Math.max(1_000, Math.min(250_000, Number(body.blockStep || 50_000))),
      maxTokens: Math.max(1, Math.min(50_000, Number(body.maxTokens || 50_000))),
      minLiquidityUSD: Math.max(0, Number(body.minLiquidityUSD ?? MIN_WL_LIQUIDITY_USD)),
      replaceActive: Boolean(body.replaceActive),
      delayMs: Math.max(
        0,
        Math.min(5000, Number(body.delayMs ?? process.env.DUST_SWEEP_POOL_EVENT_SYNC_DELAY_MS ?? 150)),
      ),
    });

    return c.json({ success: true, ...result });
  } catch (error) {
    console.error("[dustsweep/admin/sync-whitelist-pool-events] Error:", error);
    return c.json(errorJson((error as Error).message || "Failed to sync pool-event whitelist"), 500);
  }
});

async function loadDiscoveryMetadata(
  balances: AlchemyBalance[],
  whitelist: Map<string, TokenWhitelistRow>,
  marketHints: Record<string, TokenMarketHint>,
) {
  const metadataByAddress = new Map<string, Erc20Metadata>();
  const seen = new Set<string>();
  const tasks: Array<() => Promise<{ key: string; metadata: Erc20Metadata | null }>> = [];

  for (const balance of discoveryLimitedBalances(balances)) {
    if (!isAddress(balance.contractAddress)) continue;

    const tokenAddress = normalizeAddress(balance.contractAddress);
    const key = tokenAddress.toLowerCase();
    if (seen.has(key) || whitelist.has(key)) continue;
    seen.add(key);

    const metadataHint = normalizeTokenMetadataHint(tokenAddress, balance.metadata);
    if (metadataHint) {
      metadataByAddress.set(key, metadataHint);
      continue;
    }

    const market = marketHints[key];
    if (
      !market ||
      (market.priceUSD <= 0 && market.liquidityUSD <= 0 && !isOutputAssetAddress(tokenAddress))
    ) {
      continue;
    }

    const cached = getCachedErc20Metadata(tokenAddress);
    if (cached) {
      metadataByAddress.set(key, cached);
      continue;
    }

    tasks.push(async () => ({
      key,
      metadata: await readErc20Metadata(tokenAddress).catch(() => null),
    }));
  }

  const results = await pLimit(tasks, DISCOVERY_METADATA_CONCURRENCY);
  for (const result of results) {
    if (result.metadata) {
      metadataByAddress.set(result.key, result.metadata);
    }
  }

  return metadataByAddress;
}

async function handleDustSweepTokensRequest(c: Context, rawAddress?: string) {
  if (!rawAddress || !isAddress(rawAddress)) {
    return c.json(errorJson("A valid wallet address is required"), 400);
  }

  const resolved = resolveSweepChain(c);
  if (!resolved.ok) return resolved.response;
  const chain = resolved.chain;

  const userAddress = normalizeAddress(rawAddress);
  const runtimeKey = `dustsweep:tokens:${chain.chainId}:${userAddress.toLowerCase()}`;
  const forceRefresh =
    ["1", "true", "yes"].includes(String(c.req.query("refresh") || "").toLowerCase()) ||
    ["1", "true", "yes"].includes(String(c.req.query("force") || "").toLowerCase());

  try {
    if (forceRefresh) {
      runtimeCache.invalidate(runtimeKey);
    }

    const loadTokenResult = async () => {
      const startedAt = Date.now();
      if (!forceRefresh) {
        const cached = await getCachedTokenResult(userAddress, chain);
        if (cached) return cached;
      }

      // ── Wallet-first discovery: fetch ALL balances, not just whitelisted ──
      // Whitelist is used as metadata/liquidity HINTS, not a visibility gate.
      let whitelist: Map<string, TokenWhitelistRow>;
      let erc20Discovery: AlchemyTokenBalanceDiscovery;

      try {
        [whitelist, erc20Discovery] = await Promise.all([
          loadWhitelist(chain),
          fetchWalletTokenBalances(userAddress, chain),
        ]);
      } catch (error) {
        const stale = await getCachedTokenResult(userAddress, chain, DISCOVERY_STALE_DB_CACHE_TTL_MS);
        if (stale) {
          console.warn("[dustsweep/tokens] Serving stale token discovery cache", {
            address: userAddress,
            message: discoveryErrorMessage(error),
          });
          return markTokenResultAsStale(stale, "live-discovery-unavailable");
        }
        throw error;
      }

      const nonZero = erc20Discovery.tokenBalances.filter((balance) => {
        try {
          return BigInt(balance.tokenBalance || "0") > 0n;
        } catch {
          return false;
        }
      });

      // Fetch prices for ALL non-zero balances, not just whitelisted
      const allAddresses = nonZero
        .map((b) => b.contractAddress)
        .filter((a): a is Address => isAddress(a));
      const providerMarketHints = getBalanceProviderMarketHints(nonZero);
      const providerMarketHintCount = Object.keys(providerMarketHints).length;
      // Fast pricing on the Blockscout path CAPS how many still-priceless tokens get external
      // (DexScreener/CoinGecko) lookups — it must never zero them out just because Blockscout
      // priced SOME tokens, or every unpriced dust token gets hidden as UNKNOWN_PRICE.
      const maxExternalMarketHints =
        erc20Discovery.source === "blockscout" && DISCOVERY_BLOCKSCOUT_FAST_PRICING
          ? DISCOVERY_BLOCKSCOUT_PRICELESS_MARKET_HINT_LIMIT
          : null;
      const marketHints = await fetchTokenMarketHints(
        allAddresses,
        providerMarketHints,
        maxExternalMarketHints,
        chain,
      );
      const metadataByAddress = await loadDiscoveryMetadata(nonZero, whitelist, marketHints);

      const swappable: DiscoveryTokenResult[] = [];
      const unavailable: DiscoveryTokenResult[] = [];
      const hidden: DiscoveryTokenResult[] = [];
      const suspicious: DiscoveryTokenResult[] = [];
      const excludedOutputAssets: DiscoveryTokenResult[] = [];

      // ── Process ERC-20 balances ──
      for (const balance of discoveryLimitedBalances(nonZero)) {
        if (!isAddress(balance.contractAddress)) continue;

        const tokenAddress = normalizeAddress(balance.contractAddress);
        const key = tokenAddress.toLowerCase();
        const whitelistRow = whitelist.get(key);

        // Get metadata: prefer whitelist, fall back to on-chain read
        let decimals = 18;
        let symbol = `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`;
        let name = symbol;
        let logoURI: string | undefined;
        let liquidityUSD = 0;
        let bestDex: string = "GENERIC";
        let hasMetadata = false;

        if (whitelistRow) {
          decimals = Number(whitelistRow.decimals ?? 18);
          symbol = String(whitelistRow.symbol ?? "TOKEN");
          name = String(whitelistRow.name ?? symbol);
          logoURI = whitelistRow.logo_uri ?? undefined;
          liquidityUSD = Number(whitelistRow.liquidity_usd || 0);
          bestDex = bestDexFromSource(whitelistRow.source);
          hasMetadata = true;
        } else {
          const meta = metadataByAddress.get(key);
          if (meta) {
            decimals = meta.decimals;
            symbol = meta.symbol;
            name = meta.name;
            logoURI = meta.logoURI;
            hasMetadata = true;
          }
        }

        const rawBalance = BigInt(balance.tokenBalance).toString();
        const balanceFormatted = formatUnits(BigInt(rawBalance), decimals);
        const market = marketHints[key] || emptyMarketHint();
        const priceUSD = market.priceUSD;
        liquidityUSD = Math.max(liquidityUSD, market.liquidityUSD);
        bestDex = market.bestDex !== "GENERIC" ? market.bestDex : bestDex;
        logoURI = logoURI || market.logoURI;
        const valueUSD = Number(balanceFormatted) * priceUSD;
        const risk = getRiskClassification({
          symbol,
          name,
          tokenAddress,
          hasMetadata,
          priceUSD,
          liquidityUSD,
          isVerifiedHint: Boolean(whitelistRow),
        });

        const baseToken: DiscoveryTokenResult = {
          address: tokenAddress,
          symbol,
          name,
          decimals,
          logoURI,
          balance: rawBalance,
          balanceFormatted,
          valueUSD: roundUsd(valueUSD),
          bestDex,
          liquidityUSD,
          status: liquidityUSD > 0 ? "PRICED" : "LIQUIDITY_PENDING",
          sourceType: "wallet",
          priceUSD,
          priceSource: market.source,
          priceConfidence: market.confidence,
          riskScore: risk.riskScore,
          riskReasons: risk.reasons,
        };

        // ── Classification logic ──
        // USDC, USDT can be swept

        // WETH visibility is per-chain:
        //   - Passthrough chains (Ethereum, upgraded router): WETH is a FIRST-CLASS sweepable
        //     input — swappable to any ERC-20, and unwrapped to native ETH by the router.
        //   - Non-passthrough chains (Base, original router): WETH stays parked in the
        //     excluded-output-assets bucket (the in-bundle wallet-side unwrap flow still applies),
        //     exactly as before. Re-enable on those chains via DUST_SWEEP_EXCLUDE_WETH_INPUT=false.
        if (
          tokenAddress.toLowerCase() === chain.weth.toLowerCase() &&
          !chain.supportsWethPassthrough &&
          process.env.DUST_SWEEP_EXCLUDE_WETH_INPUT !== "false"
        ) {
          excludedOutputAssets.push({
            ...baseToken,
            status: "EXCLUDED_OUTPUT_ASSET",
            reason: "OUTPUT_ASSET",
          });
          continue;
        }

        // Token discovery only exposes assets that can be selected.
        // Sub-cent known-price balances stay hidden.
        if (risk.blockedFromSweep) {
          suspicious.push({
            ...baseToken,
            status: "SPAM",
            reason: "SPAM_OR_DENYLISTED",
          });
          continue;
        }

        if (baseToken.valueUSD < chain.minValueUsd && priceUSD > 0) {
          hidden.push({
            ...baseToken,
            status: "HIDDEN",
            reason: "BELOW_THRESHOLD",
          });
          continue;
        }

        // Unknown price — still show but classify
        if (priceUSD === 0) {
          hidden.push({
            ...baseToken,
            status: "UNKNOWN_PRICE",
            reason: "UNKNOWN_PRICE",
          });
          continue;
        }

        // Token has price and value — mark as swappable
        if (risk.hiddenByDefault) {
          suspicious.push({
            ...baseToken,
            status: "HIDDEN",
            reason: "SPAM_OR_DENYLISTED",
          });
          continue;
        }

        swappable.push({
          ...baseToken,
          status: liquidityUSD > 0 ? "PRICED" : "LIQUIDITY_PENDING",
        });
      }

      swappable.sort(sortByValueDesc);
      unavailable.sort(sortByValueDesc);
      hidden.sort(sortByValueDesc);
      suspicious.sort(sortByValueDesc);
      excludedOutputAssets.sort(sortByValueDesc);

      const payload = {
        chainId: chain.chainId,
        refreshedAt: new Date().toISOString(),
        discovery: {
          erc20BalanceCount: nonZero.length,
          alchemyScannedBalanceCount: erc20Discovery.scannedBalanceCount,
          alchemyPageCount: erc20Discovery.pageCount,
          truncated: erc20Discovery.truncated,
          source: erc20Discovery.source,
          providerError: erc20Discovery.providerError,
          maxErc20Balances: DISCOVERY_MAX_ERC20_BALANCES,
          targetNonZeroBalances: DISCOVERY_TARGET_NONZERO_BALANCES,
          maxAlchemyPages: DISCOVERY_ALCHEMY_MAX_PAGES,
          maxBlockscoutPages: DISCOVERY_BLOCKSCOUT_BALANCE_MAX_PAGES,
          providerMarketHintCount,
          maxExternalMarketHints,
          marketHintCount: Object.keys(marketHints).length,
          metadataReadCount: metadataByAddress.size,
          elapsedMs: Date.now() - startedAt,
        },
        swappable,
        unavailable,
        hidden,
        suspicious,
        excludedOutputAssets,
      };

      await setCachedTokenResult(userAddress, payload, chain);
      return payload;
    };

    const result = forceRefresh
      ? await loadTokenResult()
      : await runtimeCache.getOrSet(runtimeKey, DISCOVERY_RUNTIME_CACHE_TTL_MS, loadTokenResult);

    if (forceRefresh) {
      runtimeCache.set(runtimeKey, result, DISCOVERY_RUNTIME_CACHE_TTL_MS);
    }

    return c.json(result);
  } catch (error) {
    console.error("[dustsweep/tokens] Error:", error);
    if (error instanceof BalanceDiscoveryUnavailableError) {
      c.header("Retry-After", String(error.retryAfterSeconds));
      return c.json(
        errorJson(error.message, {
          code: error.code,
          retryAfterSeconds: error.retryAfterSeconds,
        }),
        error.status,
      );
    }
    return c.json(errorJson((error as Error).message || "Failed to load tokens"), 500);
  }
}

dustsweepRoutes.get("/tokens", async (c) => {
  return handleDustSweepTokensRequest(c, c.req.query("address"));
});

dustsweepRoutes.get("/tokens/:address", async (c) => {
  return handleDustSweepTokensRequest(c, c.req.param("address"));
});

// Live gas price per chain, short-cached. Base keeps its legacy hardcoded display (gasModel null),
// so this is only ever hit for chains with a real gas model (Ethereum), where the cost matters.
const gasPriceWeiCache = new Map<number, { wei: bigint; expiresAt: number }>();
async function getCachedGasPriceWei(chainId: number): Promise<bigint> {
  const cached = gasPriceWeiCache.get(chainId);
  if (cached && cached.expiresAt > Date.now()) return cached.wei;
  try {
    const hex = await chainRpcRequest<string>(chainId, "eth_gasPrice", [], { timeoutMs: 4_000 });
    const wei = BigInt(hex);
    gasPriceWeiCache.set(chainId, { wei, expiresAt: Date.now() + 15_000 });
    return wei;
  } catch {
    return cached?.wei ?? 0n;
  }
}

// Honest per-chain gas estimate for the sweep. Base preserves the historical display literals
// (gasModel === null → zero behavior change). Chains with a gasModel (Ethereum) compute
// gasUnits × live gasPrice × native USD so the UI can warn when gas dwarfs the basket value.
async function computeSweepGasEstimate(
  chain: SweepChainConfig,
  routeCount: number,
): Promise<{ eth: string; usd: number }> {
  if (!chain.gasModel) {
    return {
      eth: (0.0000015 + routeCount * 0.0000007).toFixed(8),
      usd: Math.round((0.004 + routeCount * 0.0015) * 100) / 100,
    };
  }
  const gasUnits = BigInt(
    Math.round(chain.gasModel.baseUnits + routeCount * chain.gasModel.perRouteUnits),
  );
  const [gasPriceWei, nativeUsd] = await Promise.all([
    getCachedGasPriceWei(chain.chainId),
    fetchEthUsdPrice().catch(() => 0),
  ]);
  const ethCost = Number(formatUnits(gasUnits * gasPriceWei, 18));
  const usd = nativeUsd > 0 && Number.isFinite(ethCost) ? ethCost * nativeUsd : 0;
  return { eth: ethCost.toFixed(8), usd: Math.round(usd * 100) / 100 };
}

dustsweepRoutes.post("/quote", async (c) => {
  const body = await c.req.json<{
    tokenIns?: string[];
    amounts?: string[];
    tokenOut?: string;
    slippageBps?: number;
    userAddress?: string;
    chainId?: number;
  }>();

  const resolved = resolveSweepChain(c, body.chainId);
  if (!resolved.ok) return resolved.response;
  const chain = resolved.chain;

  if (!body.tokenIns?.length || !body.amounts?.length || !body.tokenOut || !body.userAddress) {
    return c.json(errorJson("tokenIns, amounts, tokenOut, and userAddress are required"), 400);
  }
  if (body.tokenIns.length !== body.amounts.length) {
    return c.json(errorJson("tokenIns and amounts length mismatch"), 400);
  }

  // Chain-aware lane: Ethereum is V3-only (owned modern lane); Base honors DUST_SWEEP_EXECUTION_LANE.
  const executionLane: DustSweepExecutionLane =
    chain.chainId === BASE_CHAIN_ID ? getExecutionLane() : "owned_v2";
  // Enforce actual contract capability AND the per-chain economic cap (ETH default 15).
  const routeMaxCap = Math.min(getRouteMaxCap(executionLane), chain.routeMaxCap);

  if (body.tokenIns.length > routeMaxCap) {
    return c.json(errorJson(`Maximum ${routeMaxCap} tokens per sweep on ${chain.name}`), 400);
  }
  if (!isAddress(body.tokenOut) || !isAddress(body.userAddress)) {
    return c.json(errorJson("Invalid tokenOut or userAddress"), 400);
  }

  const tokenOut = normalizeAddress(body.tokenOut);
  const actualTokenOut = tokenOut.toLowerCase() === NATIVE_TOKEN_SENTINEL.toLowerCase() ? chain.weth : tokenOut;
  const isNativeOutput = isNativeTokenAddress(tokenOut);
  const slippageBps = Math.max(1, Math.min(3000, Number(body.slippageBps || 50)));
  let routes: DustSweepRoute[] = [];
  const skippedTokens: QuoteSkippedToken[] = [];
  const whitelist = await loadWhitelist(chain);
  const userAddress = normalizeAddress(body.userAddress);

  // Resolve output token decimals from whitelist, default to 6 for USDC, 18 otherwise
  const outputWhitelistRow = whitelist.get(tokenOut.toLowerCase());
  const outputDecimals = outputWhitelistRow
    ? Number(outputWhitelistRow.decimals ?? 18)
    : tokenOut.toLowerCase() === chain.usdc.toLowerCase()
      ? 6
      : 18;

  // ── Step 1: validate and parse all inputs (no whitelist gating) ─────────────
  type PendingToken = {
    tokenIn: Address;
    amountIn: bigint;
    index: number;
    bestDex?: string;
    // WETH selected with native-ETH output: a 1:1 WETH.withdraw() the user's wallet performs
    // directly. Never routed through the sweep router (the V3 contract reverts on
    // tokenIn == actualOutput) and never charged a protocol fee.
    unwrapToNative?: boolean;
  };
  const pending: PendingToken[] = [];

  for (let i = 0; i < body.tokenIns.length; i++) {
    const rawTokenIn = body.tokenIns[i];
    if (!isAddress(rawTokenIn)) continue;
    const tokenIn = normalizeAddress(rawTokenIn);
    if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) continue;

    // Skip native ETH placeholder — must be wrapped to WETH first
    if (tokenIn.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
      skippedTokens.push({
        token: tokenIn,
        reason: "NATIVE_WRAP_REQUIRED",
        message: "Native ETH must be wrapped to WETH before sweeping.",
      });
      continue;
    }

    const unwrapToNative =
      isNativeOutput && tokenIn.toLowerCase() === chain.weth.toLowerCase();

    let amountIn: bigint;
    try {
      amountIn = BigInt(body.amounts[i] || "0");
    } catch {
      continue;
    }
    if (amountIn <= 0n) {
      skippedTokens.push({ token: tokenIn, reason: "BELOW_THRESHOLD", message: "Token balance is too small to quote." });
      continue;
    }

    // Use whitelist as a bestDex hint — NOT a gate
    const whitelistRow = whitelist.get(tokenIn.toLowerCase());
    const bestDex = whitelistRow ? bestDexFromSource(whitelistRow.source) : "GENERIC";

    pending.push({ tokenIn, amountIn, index: i, bestDex, unwrapToNative });
  }

  // ── Step 2: check live balances in parallel ─────────────────────────────────
  const balanceChecks = await Promise.all(
    pending.map(({ tokenIn, amountIn }) =>
      readErc20Balance(tokenIn, userAddress, chain.chainId)
        .then((live) => ({ live, amountIn, ok: live >= amountIn }))
        .catch(() => ({ live: 0n, amountIn, ok: false })),
    ),
  );

  const readyToQuote: PendingToken[] = [];
  // WETH → native ETH handling:
  //   - Non-passthrough chains (Base): a 1:1 wallet-side unwrap, kept OUT of the router routes.
  //   - Passthrough chains (Ethereum, upgraded router): WETH rides INSIDE the router as a
  //     passthrough route — pulled with the rest, unwrapped to ETH at settlement, one atomic tx.
  let wethUnwrapAmount = 0n;
  for (let i = 0; i < pending.length; i++) {
    const item = pending[i]!;
    const check = balanceChecks[i]!;
    if (!check.ok) {
      skippedTokens.push({
        token: item.tokenIn,
        reason: "BALANCE_CHANGED",
        message: "Token balance changed. Refresh balances before sweeping this token.",
      });
    } else if (item.unwrapToNative && chain.supportsWethPassthrough) {
      // Passthrough leg: 1:1, no DEX. The contract detects tokenIn == actualOutput (WETH).
      routes.push({
        tokenIn: item.tokenIn,
        amountIn: item.amountIn.toString(),
        amountOutMin: item.amountIn.toString(),
        estimatedOut: item.amountIn.toString(),
        dex: DEX.PASSTHROUGH,
        dexName: "WETH → ETH",
        dexData: "0x" as Hex,
        priceImpactBps: 0, // 1:1 unwrap — zero impact
        priceImpactKnown: true,
      });
    } else if (item.unwrapToNative) {
      wethUnwrapAmount += item.amountIn;
    } else {
      readyToQuote.push(item);
    }
  }

  // ── Step 2.5: market reference prices (real price impact + aggregator rescue) ──
  // One cached batch fetch (DexScreener → CoinGecko market hints — the same prices the token
  // list shows the user). Advisory only: when a token has no reliable price, its impact is
  // reported as unknown and rescue never fires; quoting itself proceeds unchanged.
  //
  // CONFIDENCE GATE: only HIGH-confidence references may drive impact (canonical stables/ETH,
  // or a DexScreener pair with real liquidity). Dust tokens often carry a PHANTOM price from a
  // dead pool's last trade — comparing an honest quote against a phantom price produced false
  // "77% impact" alarms. Unknown beats wrong.
  let quoteMarketHints: Record<string, TokenMarketHint> = {};
  try {
    quoteMarketHints = await fetchTokenMarketHints([
      ...readyToQuote.map((item) => item.tokenIn),
      tokenOut,
    ]);
  } catch {
    // Quoting works without market prices — impact just stays unknown.
  }
  const outTokenPriceUSD =
    quoteMarketHints[tokenOut.toLowerCase()]?.priceUSD ||
    (tokenOut.toLowerCase() === USDC_ADDRESS.toLowerCase() ? 1 : 0);
  const marketContexts = new Map<string, QuoteMarketContext>();
  await Promise.all(
    readyToQuote.map(async ({ tokenIn, amountIn }) => {
      const hint = quoteMarketHints[tokenIn.toLowerCase()];
      if (!hint || hint.confidence !== "HIGH") return;
      const price = hint.priceUSD || 0;
      if (!(price > 0) || !(outTokenPriceUSD > 0)) return;
      let decimals: number | undefined = whitelist.get(tokenIn.toLowerCase())?.decimals;
      if (!Number.isFinite(Number(decimals))) {
        try {
          decimals = (await readErc20Metadata(tokenIn)).decimals;
        } catch {
          return;
        }
      }
      const expectedInUSD = Number(formatUnits(amountIn, Number(decimals))) * price;
      if (!Number.isFinite(expectedInUSD) || expectedInUSD <= 0) return;
      marketContexts.set(tokenIn.toLowerCase(), {
        expectedInUSD,
        outTokenPriceUSD,
        outDecimals: outputDecimals,
      });
    }),
  );

  // ── Step 3: routeability pre-screen with cache ─────────────────────────────
  const ROUTEABILITY_OK_TTL = 60_000;
  const ROUTEABILITY_NO_ROUTE_TTL = 30_000;

  const quoteTasks = readyToQuote.map(
    ({ tokenIn, amountIn }) =>
      async () => {
        const cacheKey = `routeability:${chain.chainId}:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`;

        // 1. Check runtime memory cache (fastest)
        const memCached = runtimeCache.get<{ status: string; checkedAt: number }>(cacheKey);
        if (memCached && memCached.status === "NO_ROUTE") {
          return { tokenIn, amountIn, best: null, error: null, cachedNoRoute: true };
        }

        // 2. Check DB persistent cache (survives restarts)
        const dbCached = await getDbRouteability(tokenIn, tokenOut, amountIn, chain.chainId);
        if (dbCached) {
          if (dbCached.status === "NO_ROUTE") {
            runtimeCache.set(cacheKey, { status: "NO_ROUTE", checkedAt: Date.now() }, ROUTEABILITY_NO_ROUTE_TTL);
            return { tokenIn, amountIn, best: null, error: null, cachedNoRoute: true };
          }
          // If status is OK, we still might want a fresh quote to get live price,
          // but we know a route exists. For now, we proceed to quote to be safe.
        }

        type QuoteTaskResult = {
          tokenIn: Address;
          amountIn: bigint;
          best: QuoteCandidate | null;
          error: string | null;
          cachedNoRoute: boolean;
        };

        const quotePromise: Promise<QuoteTaskResult> = getBestQuote(
          tokenIn,
          actualTokenOut,
          amountIn,
          slippageBps,
          executionLane,
          marketContexts.get(tokenIn.toLowerCase()) ?? null,
          chain,
        )
          .then(async (best) => {
            if (best) {
              runtimeCache.set(cacheKey, { status: "OK", checkedAt: Date.now() }, ROUTEABILITY_OK_TTL);
              await setDbRouteability(tokenIn, tokenOut, amountIn, "OK", ROUTEABILITY_OK_TTL * 10, best, chain.chainId);
            } else {
              runtimeCache.set(cacheKey, { status: "NO_ROUTE", checkedAt: Date.now() }, ROUTEABILITY_NO_ROUTE_TTL);
              await setDbRouteability(tokenIn, tokenOut, amountIn, "NO_ROUTE", ROUTEABILITY_NO_ROUTE_TTL * 10, undefined, chain.chainId);
            }
            return { tokenIn, amountIn, best, error: null as string | null, cachedNoRoute: false };
          })
          .catch(async (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            if (error instanceof RpcDeterministicError) {
              runtimeCache.set(cacheKey, { status: "NO_ROUTE", checkedAt: Date.now() }, ROUTEABILITY_NO_ROUTE_TTL);
              await setDbRouteability(tokenIn, tokenOut, amountIn, "NO_ROUTE", ROUTEABILITY_NO_ROUTE_TTL * 10, undefined, chain.chainId);
            }
            return {
              tokenIn,
              amountIn,
              best: null as QuoteCandidate | null,
              error: message,
              cachedNoRoute: false,
            };
          });

        // Hard per-token cap: a slow/dead token (native miss → aggregator
        // fallback) must never stall the whole basket. On timeout we skip just
        // this token; the quotePromise keeps running in the background so its
        // routeability cache still gets populated for the next quote.
        const timeoutPromise = new Promise<QuoteTaskResult>((resolve) =>
          setTimeout(
            () =>
              resolve({
                tokenIn,
                amountIn,
                best: null,
                error: "Quote timed out",
                cachedNoRoute: false,
              }),
            QUOTE_TOKEN_TIMEOUT_MS,
          ),
        );

        return Promise.race([quotePromise, timeoutPromise]);
      },
  );

  const quoteResults = await pLimit(quoteTasks, QUOTE_TOKEN_CONCURRENCY);

  for (const result of quoteResults) {
    if (result.error || !result.best) {
      if (result.cachedNoRoute) {
        skippedTokens.push({ token: result.tokenIn, reason: "NO_LIQUIDITY", message: "No route found (cached)." });
      } else if (result.error) {
        console.warn("[dustsweep/quote] quote source failed", { tokenIn: result.tokenIn, tokenOut, message: result.error });
        skippedTokens.push({ token: result.tokenIn, reason: "QUOTE_FAILED", message: "Quote source failed for this token." });
      } else {
        skippedTokens.push({ token: result.tokenIn, reason: "NO_LIQUIDITY", message: "No route found for this token." });
      }
      continue;
    }

    const best = result.best;
    const amountOutMin = (best.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
    // priceImpactBps is now the REAL market-value impact computed in getBestQuote (the old
    // hardcoded 43 bps fallback is gone). priceImpactKnown=false marks routes where no reliable
    // reference price existed — the UI must show "unknown", not 0%.
    const priceImpactKnown = typeof best.priceImpactBps === "number";
    routes.push({
      tokenIn: result.tokenIn,
      amountIn: result.amountIn.toString(),
      amountOutMin: amountOutMin.toString(),
      estimatedOut: best.estimatedOut,
      dex: best.dex,
      dexName: best.dexName,
      dexData: best.dexData,
      priceImpactBps: best.priceImpactBps ?? 0,
      priceImpactKnown,
      poolFee: best.poolFee,
    });
  }

  // ── Step 4: transfer-pull pre-screen ───────────────────────────────────────
  // A token can have liquidity (quotes fine) and sufficient balance, yet still
  // revert transferFrom to the sweep router (transfer tax to a non-whitelisted
  // recipient, max-tx cap, blacklist/paused, honeypot). The router pulls ALL
  // inputs atomically, so ONE such token reverts the WHOLE sweep — and breaks the
  // batch preview on OKX/Coinbase. Surface these on the unavailable list now, at
  // quote time, so the basket the user opens in their wallet is already clean.
  if (PREFLIGHT_TRANSFER_PROBE_ENABLED && routes.length > 0) {
    const sweepRouter = getRouterAddressForLane(executionLane);
    if (isAddress(sweepRouter) && sweepRouter !== "0x0000000000000000000000000000000000000000") {
      const untransferable = await findUntransferableRoutes(
        userAddress,
        routes.map((route) => ({ tokenIn: route.tokenIn, amountIn: route.amountIn })),
        sweepRouter,
      );
      if (untransferable.length > 0) {
        const dropSet = new Set(untransferable.map((token) => token.toLowerCase()));
        for (const token of untransferable) {
          skippedTokens.push({
            token,
            reason: "CANT_TRANSFER",
            message:
              "This token can't be transferred to the sweep router (transfer tax, max-tx limit, or blocked transfers).",
          });
        }
        routes = routes.filter((route) => !dropSet.has(route.tokenIn.toLowerCase()));
      }
    }
  }

  if (routes.length === 0 && wethUnwrapAmount === 0n) {
    return c.json(
      errorJson("No swappable route found for the selected tokens", {
        code: "NO_SWAPPABLE_ROUTES",
        skippedTokens,
      }),
      400,
    );
  }

  // Enforce route cap again after quoting (defensive)
  const cappedRoutes = routes.slice(0, routeMaxCap);

  const totalEstimatedOut = cappedRoutes.reduce(
    (sum, route) => sum + BigInt(route.estimatedOut),
    0n,
  );
  const prices = await fetchTokenPrices([tokenOut], chain);
  const outputPrice = prices[tokenOut.toLowerCase()] || (tokenOut.toLowerCase() === chain.usdc.toLowerCase() ? 1 : 0);
  const totalEstimatedOutUSD =
    Number(formatUnits(totalEstimatedOut, outputDecimals)) * outputPrice;
  const feeBps = getFeeBps(chain);
  const protocolFeeAmount = (totalEstimatedOut * BigInt(feeBps)) / 10_000n;
  const netEstimatedOut = totalEstimatedOut - protocolFeeAmount;
  const minAmountOut = getRouterMinAmountOut(cappedRoutes, executionLane);
  const feeAmountUSD = (totalEstimatedOutUSD * feeBps) / 10_000;
  const netEstimatedOutUSD = totalEstimatedOutUSD - feeAmountUSD;
  const deadline = Math.floor(Date.now() / 1000) + 1800;
  const permit2Nonce = BigInt(`0x${randomBytes(16).toString("hex")}`).toString();

  // Worst KNOWN route impact — routes without a reference price don't count toward the gate
  // (they are surfaced as "unknown" instead).
  const maxPriceImpactBps = cappedRoutes.reduce(
    (max, route) => (route.priceImpactKnown ? Math.max(max, route.priceImpactBps) : max),
    0,
  );
  const impactGateBps = getMaxImpactBps();
  const requiresImpactConfirmation = impactGateBps > 0 && maxPriceImpactBps >= impactGateBps;

  // BASKET-level impact — the honest dollar figure for the whole quote. Sums expected market
  // value vs quoted output over the routes that HAVE a reliable reference price. (The UI used
  // to derive dollars by applying the WORST single token's percentage to the WHOLE basket,
  // which turned one $0.50 illiquid token into a fake "$17 lost" banner.)
  let basketExpectedUSD = 0;
  let basketActualUSD = 0;
  for (const route of cappedRoutes) {
    const ctx = marketContexts.get(route.tokenIn.toLowerCase());
    if (!ctx) continue;
    const actual = Number(formatUnits(BigInt(route.estimatedOut), outputDecimals)) * outputPrice;
    if (!Number.isFinite(actual)) continue;
    basketExpectedUSD += ctx.expectedInUSD;
    basketActualUSD += actual;
  }
  const basketImpactUSD =
    basketExpectedUSD > 0
      ? Math.round(Math.max(0, basketExpectedUSD - basketActualUSD) * 100) / 100
      : undefined;
  const basketImpactBps =
    basketExpectedUSD > 0
      ? Math.max(0, Math.min(10_000, Math.round((1 - basketActualUSD / basketExpectedUSD) * 10_000)))
      : undefined;

  // WETH → ETH unwrap summary. Deliberately NOT folded into the router totals: the totals feed
  // fee math and sweep-volume recording, and a 1:1 unwrap is neither swap volume nor fee-bearing.
  // The UI adds it to the displayed receive amounts and executes it as a direct WETH.withdraw().
  const wethUnwrap =
    wethUnwrapAmount > 0n
      ? {
          amount: wethUnwrapAmount.toString(),
          valueUSD:
            Math.round(Number(formatUnits(wethUnwrapAmount, 18)) * outputPrice * 100) / 100,
        }
      : undefined;

  const gasEstimate = await computeSweepGasEstimate(chain, cappedRoutes.length);
  // Basket value the gas is compared against (net of fee): the UI warns when gas is a large
  // fraction of it. On Base gas is ~0 so the ratio is negligible and nothing changes.
  const basketValueForGas = Math.max(0.01, Math.round(netEstimatedOutUSD * 100) / 100);
  const gasToBasketRatio =
    gasEstimate.usd > 0 ? Math.round((gasEstimate.usd / basketValueForGas) * 1000) / 1000 : 0;

  return c.json({
    chainId: chain.chainId,
    routes: cappedRoutes,
    ...(wethUnwrap ? { wethUnwrap } : {}),
    skippedTokens,
    totalEstimatedOut: totalEstimatedOut.toString(),
    minAmountOut: minAmountOut.toString(),
    protocolFeeAmount: protocolFeeAmount.toString(),
    netEstimatedOut: netEstimatedOut.toString(),
    totalEstimatedOutUSD: Math.round(totalEstimatedOutUSD * 100) / 100,
    feeAmountUSD: Math.round(feeAmountUSD * 10000) / 10000,
    netEstimatedOutUSD: Math.round(netEstimatedOutUSD * 100) / 100,
    maxPriceImpactBps,
    requiresImpactConfirmation,
    ...(basketImpactUSD !== undefined ? { basketImpactUSD, basketImpactBps } : {}),
    feeBps,
    gasEstimateETH: gasEstimate.eth,
    gasEstimateUSD: gasEstimate.usd,
    gasToBasketRatio,
    permit2Nonce,
    deadline,
    executionLane,
    routeMaxCap,
  });
});

dustsweepRoutes.post("/build-tx", async (c) => {
  const body = await c.req.json<{
    routes?: DustSweepRoute[];
    tokenOut?: string;
    receiver?: string;
    deadline?: number;
    permit2Nonce?: string;
    userAddress?: string;
    signature?: string;
    chainId?: number;
  }>();

  const resolved = resolveSweepChain(c, body.chainId);
  if (!resolved.ok) return resolved.response;
  const chain = resolved.chain;

  // Ethereum is V3-only (owned modern lane); Base honors DUST_SWEEP_EXECUTION_LANE.
  const executionLane: DustSweepExecutionLane =
    chain.chainId === BASE_CHAIN_ID ? getExecutionLane() : "owned_v2";
  const routeMaxCap = Math.min(getRouteMaxCap(executionLane), chain.routeMaxCap);
  const routerAddress =
    chain.chainId === BASE_CHAIN_ID
      ? getRouterAddressForLane(executionLane)
      : getChainRouterV3Address(chain) ?? ZERO_ADDRESS;
  // owned_v2 auth mode. Defaults to "allowance" (approve + sweepWithAllowance, no
  // signature) so Coinbase/Base smart wallets can bundle approvals + sweep into a
  // single atomic wallet_sendCalls. Only an explicit "permit2" opts into the
  // signature-based flow; any other/typo'd value safely falls back to allowance.
  const v2AuthMode =
    process.env.DUST_SWEEP_V2_AUTH_MODE?.toLowerCase() === "permit2"
      ? "permit2"
      : "allowance";

  if (!body.routes?.length || !body.tokenOut || !body.receiver || !body.deadline || !body.userAddress) {
    return c.json(errorJson("routes, tokenOut, receiver, deadline, and userAddress are required"), 400);
  }
  if (body.routes.length > routeMaxCap) {
    return c.json(errorJson(`Maximum ${routeMaxCap} tokens per sweep (${executionLane} lane)`), 400);
  }
  if (!isAddress(body.tokenOut) || !isAddress(body.receiver) || !isAddress(body.userAddress)) {
    return c.json(errorJson("Invalid tokenOut, receiver, or userAddress"), 400);
  }
  if (Number(body.deadline) <= Math.floor(Date.now() / 1000)) {
    return c.json(errorJson("Deadline expired. Refresh quote and try again.", { code: "DEADLINE_EXPIRED" }), 409);
  }
  if (executionLane === "owned_v2" && v2AuthMode === "permit2" && !body.permit2Nonce) {
    return c.json(errorJson("permit2Nonce is required for owned_v2 Permit2 mode"), 400);
  }
  if (executionLane === "basket_aggregator") {
    return c.json(errorJson("basket_aggregator build is not wired yet. Use assembled aggregator transactions as-is."), 501);
  }
  if (!isAddress(routerAddress) || routerAddress === "0x0000000000000000000000000000000000000000") {
    return c.json(errorJson(`DustSweep ${executionLane} router address is not configured`), 500);
  }

  let routes: DustSweepRoute[];
  try {
    routes = body.routes.map((route) => ({
      ...route,
      tokenIn: normalizeAddress(route.tokenIn),
      amountIn: BigInt(route.amountIn).toString(),
      amountOutMin: BigInt(route.amountOutMin).toString(),
      dexData: route.dexData,
    }));
  } catch {
    return c.json(errorJson("Invalid route payload"), 400);
  }

  if (
    routes.some(
      (route) =>
        BigInt(route.amountIn) <= 0n ||
        BigInt(route.amountOutMin) <= 0n ||
        !route.dexData ||
        !String(route.dexData).startsWith("0x"),
    )
  ) {
    return c.json(errorJson("Invalid route payload"), 400);
  }
  if (routes.some((route) => isNativeTokenAddress(route.tokenIn))) {
    return c.json(
      errorJson("Native ETH must be wrapped to WETH before sweeping.", {
        code: "NATIVE_INPUT_UNSUPPORTED",
      }),
      400,
    );
  }

  const userAddress = normalizeAddress(body.userAddress);
  const staleBalances = await findStaleRouteBalances(userAddress, routes, chain.chainId);
  if (staleBalances.length > 0) {
    return c.json(
      errorJson("Token balance changed. Refresh balances and try again.", {
        code: "STALE_TOKEN_BALANCE",
        staleBalances,
      }),
      409,
    );
  }
  if (routes.length > routeMaxCap) {
    return c.json(
      errorJson(`Maximum ${routeMaxCap} tokens per sweep (${executionLane} lane)`, {
        code: "ROUTE_CAP_EXCEEDED",
      }),
      400,
    );
  }

  const buildTokenOut = normalizeAddress(body.tokenOut);
  const buildReceiver = normalizeAddress(body.receiver);
  const actualTokenOut = isNativeTokenAddress(buildTokenOut) ? chain.weth : buildTokenOut;

  if (routes.some((route) => route.tokenIn.toLowerCase() === actualTokenOut.toLowerCase())) {
    return c.json(
      errorJson("Selected input includes the output token. Remove it and refresh the quote.", {
        code: "OUTPUT_INPUT_MATCH",
      }),
      400,
    );
  }

  // Pre-flight transfer probe (V3 allowance lane only): drop tokens whose pull
  // would revert the atomic sweep so one restricted dust token can't fail the
  // whole 25-50 token batch. Scoped to the allowance lane — permit2 binds amounts
  // in a signature (can't drop post-sign) and owned_v1 is legacy.
  const skippedUntransferable: { token: Address; reason: "CANT_TRANSFER"; message?: string }[] = [];
  if (
    PREFLIGHT_TRANSFER_PROBE_ENABLED &&
    executionLane === "owned_v2" &&
    v2AuthMode !== "permit2"
  ) {
    const untransferable = await findUntransferableRoutes(userAddress, routes, routerAddress, chain.chainId);
    if (untransferable.length > 0) {
      const dropSet = new Set(untransferable.map((token) => token.toLowerCase()));
      for (const token of untransferable) {
        skippedUntransferable.push({
          token,
          reason: "CANT_TRANSFER",
          message:
            "This token can't be transferred to the sweep router (transfer tax, max-tx limit, or blocked transfers).",
        });
      }
      routes = routes.filter((route) => !dropSet.has(route.tokenIn.toLowerCase()));
      if (routes.length === 0) {
        return c.json(
          errorJson(
            "None of the selected tokens can be swept — their transfers are restricted (tax, max-tx limit, or blocked).",
            { code: "ALL_ROUTES_UNTRANSFERABLE", skippedTokens: skippedUntransferable },
          ),
          422,
        );
      }
    }
  }

  if (executionLane === "owned_v1") {
    const routerApprovals = await findMissingTokenApprovals(userAddress, routes, routerAddress);
    if (routerApprovals.length > 0) {
      return c.json(
        errorJson("Router approval required before sweep.", {
          code: "ROUTER_APPROVAL_REQUIRED",
          approvals: routerApprovals,
        }),
        409,
      );
    }

    let calldata: Hex;
    try {
      calldata = buildV1Calldata({
        routes,
        tokenOut: buildTokenOut,
        receiver: buildReceiver,
        deadline: body.deadline,
      });
    } catch (error) {
      return c.json(errorJson((error as Error).message || "Failed to build V1 calldata"), 400);
    }

    return c.json({
      requiresSignature: false,
      signatureMode: "none",
      approvalSpender: routerAddress,
      routerAddress,
      contractAddress: routerAddress,
      calldata,
      value: "0",
      callMode: "sweepDustMultiHop",
      executionLane,
      routeMaxCap,
    });
  }

  // Ethereum uses the V3 router exclusively; on Base, V3 activation is env-gated.
  const chainV3Active = chain.chainId === BASE_CHAIN_ID ? isV3Active() : true;

  let v2Routes: DustSweepV2Route[];
  try {
    v2Routes = routes.map((route) => buildV2Route(route, actualTokenOut, routerAddress, body.deadline!, chain));
    // Passthrough legs (WETH -> ETH) have target/spender == the token, not an allowlisted DEX —
    // the contract skips the allowlist for them, so the off-chain + on-chain checks must too.
    const swapRoutes = v2Routes.filter((_, i) => routes[i]!.dex !== DEX.PASSTHROUGH);
    for (const route of swapRoutes) assertConfiguredV2Route(route, chain);
    await assertOnchainV2RouterAllowlist(routerAddress, swapRoutes, chain.chainId);
  } catch (error) {
    return c.json(errorJson((error as Error).message || "Failed to build V2 route"), 400);
  }

  const minAmountOut = getRouterMinAmountOut(routes, executionLane, chainV3Active);
  const value = v2Routes.reduce((sum, route) => sum + route.value, 0n);
  if (v2AuthMode !== "permit2") {
    const routerApprovals = await findMissingTokenApprovals(userAddress, routes, routerAddress, chain.chainId);
    const v3Active = chainV3Active;
    const calldata = v3Active
      ? encodeV3SweepCalldata({
          mode: V3_SWEEP_MODE.Allowance,
          v2Routes,
          outputToken: buildTokenOut,
          recipient: buildReceiver,
          minAmountOut,
          deadline: body.deadline!,
          feeBpsOverride: getV3FeeBps(chain),
        })
      : encodeV2AllowanceSweepCalldata({
          v2Routes,
          tokenOut: buildTokenOut,
          receiver: buildReceiver,
          minAmountOut,
          deadline: body.deadline,
        });

    return c.json({
      requiresSignature: false,
      signatureMode: "none",
      approvalSpender: routerAddress,
      approvalRequirements: routerApprovals,
      routerAddress,
      contractAddress: routerAddress,
      routeMaxCap,
      routes: v2Routes.map((route) => ({
        tokenIn: route.tokenIn,
        amountIn: route.amountIn.toString(),
        target: route.target,
        spender: route.spender,
        value: route.value.toString(),
        data: route.data,
      })),
      skippedTokens: skippedUntransferable,
      minAmountOut: minAmountOut.toString(),
      calldata,
      // V3's sweep() is non-payable (ERC-20 inputs only); V2 summed route.value (always 0 here).
      value: v3Active ? "0" : value.toString(),
      callMode: v3Active ? "sweepV3Allowance" : "sweepWithAllowance",
      executionLane,
    });
  }

  const permit2Approvals = await findMissingPermit2Approvals(userAddress, routes, chain.chainId);
  const routeHash = hashV2Routes(v2Routes);
  const permit2Signature = body.signature && isHex(body.signature) ? (body.signature as Hex) : "0x";

  if (chainV3Active) {
    const feeBpsOverride = getV3FeeBps(chain);
    const v3Witness: DustSweepV3Witness = {
      routeHash,
      outputToken: buildTokenOut,
      recipient: buildReceiver,
      minAmountOut: minAmountOut.toString(),
      deadline: String(body.deadline),
      feeBps: feeBpsOverride,
    };
    const v3TypedData = buildV3WitnessTypedData({
      routes: v2Routes,
      spender: routerAddress,
      nonce: String(body.permit2Nonce),
      deadline: body.deadline!,
      witness: v3Witness,
      chainId: chain.chainId,
    });
    const v3Calldata = encodeV3SweepCalldata({
      mode: V3_SWEEP_MODE.Permit2Signature,
      v2Routes,
      outputToken: buildTokenOut,
      recipient: buildReceiver,
      minAmountOut,
      deadline: body.deadline!,
      feeBpsOverride,
      nonce: String(body.permit2Nonce),
      signature: permit2Signature,
    });

    return c.json({
      requiresSignature: true,
      signatureMode: "permit2_witness",
      approvalSpender: PERMIT2_ADDRESS,
      approvalRequirements: permit2Approvals,
      routerAddress,
      contractAddress: routerAddress,
      routeMaxCap,
      typedData: v3TypedData,
      permit2: v3TypedData,
      permit: {
        permitted: v2Routes.map((route) => ({
          token: route.tokenIn,
          amount: route.amountIn.toString(),
        })),
        nonce: String(body.permit2Nonce),
        deadline: String(body.deadline),
      },
      witness: v3Witness,
      routes: v2Routes.map((route) => ({
        tokenIn: route.tokenIn,
        amountIn: route.amountIn.toString(),
        target: route.target,
        spender: route.spender,
        value: route.value.toString(),
        data: route.data,
      })),
      minAmountOut: minAmountOut.toString(),
      feeBpsOverride,
      sweepMode: V3_SWEEP_MODE.Permit2Signature,
      calldata: v3Calldata,
      value: "0",
      callMode: "sweepV3Permit2",
      executionLane,
    });
  }

  const witness: Permit2Witness = {
    routeHash,
    outputToken: buildTokenOut,
    receiver: buildReceiver,
    minAmountOut: minAmountOut.toString(),
    deadline: String(body.deadline),
  };
  const witnessHash = hashDustSweepWitness(witness);
  const typedData = buildPermit2WitnessTypedData({
    routes: v2Routes,
    spender: routerAddress,
    nonce: String(body.permit2Nonce),
    deadline: body.deadline,
    witness,
    chainId: chain.chainId,
  });
  const signature = body.signature && isHex(body.signature) ? body.signature as Hex : "0x";
  const calldata = encodeV2SweepCalldata({
    v2Routes,
    tokenOut: buildTokenOut,
    receiver: buildReceiver,
    minAmountOut,
    deadline: body.deadline,
    nonce: String(body.permit2Nonce),
    signature,
  });

  return c.json({
    requiresSignature: true,
    signatureMode: "permit2_witness",
    approvalSpender: PERMIT2_ADDRESS,
    approvalRequirements: permit2Approvals,
    routerAddress,
    contractAddress: routerAddress,
    routeMaxCap,
    typedData,
    permit2: typedData,
    permit: {
      permitted: v2Routes.map((route) => ({
        token: route.tokenIn,
        amount: route.amountIn.toString(),
      })),
      nonce: String(body.permit2Nonce),
      deadline: String(body.deadline),
    },
    witness,
    witnessHash,
    routes: v2Routes.map((route) => ({
      tokenIn: route.tokenIn,
      amountIn: route.amountIn.toString(),
      target: route.target,
      spender: route.spender,
      value: route.value.toString(),
      data: route.data,
    })),
    minAmountOut: minAmountOut.toString(),
    calldata,
    value: value.toString(),
    callMode: "sweepWithPermit2",
    executionLane,
  });
});

dustsweepRoutes.post("/record-sweep", async (c) => {
  const body = await c.req.json<{
    txHash?: string;
    userAddress?: string;
    tokensSwapped?: number;
    valueUSD?: number;
    chainId?: number;
  }>();

  const resolved = resolveSweepChain(c, body.chainId);
  if (!resolved.ok) return resolved.response;
  const chain = resolved.chain;
  // SWEEP-ONLY multichain scope: sweeps on every enabled chain are RECORDED (chain-keyed rows),
  // but points/quests/rewards remain Base-only for now. This isolates the rewards economy while
  // still tracking ETH volume in the DB.
  const rewardsEligible = chain.chainId === BASE_CHAIN_ID;

  if (!body.txHash || !body.userAddress || body.tokensSwapped == null) {
    return c.json(errorJson("txHash, userAddress, and tokensSwapped are required"), 400);
  }
  if (!isAddress(body.userAddress)) {
    return c.json(errorJson("Invalid userAddress"), 400);
  }

  const userAddress = normalizeAddress(body.userAddress);
  const tokensSwapped = Math.max(0, Number(body.tokensSwapped || 0));
  const valueUSD = Math.max(0, Number(body.valueUSD || 0));

  let sweepCount = 0;
  try {
    await postgresDb.from("sweeps").upsert(
      {
        user_address: userAddress.toLowerCase(),
        tx_hash: body.txHash.toLowerCase(),
        tokens_swapped: tokensSwapped,
        value_usd: valueUSD,
        chain_id: chain.chainId,
      },
      { onConflict: "tx_hash" },
    );

    // Per-chain sweep count — Base quests only ever count Base sweeps (finding 4).
    const { count } = await postgresDb
      .from("sweeps")
      .select("id", { count: "exact", head: true })
      .eq("user_address", userAddress.toLowerCase())
      .eq("chain_id", chain.chainId);
    sweepCount = count || 0;
  } catch {
    // Sweep history table may not be migrated locally yet. Points still record below.
  }

  let pointsAwarded = 0;
  if (rewardsEligible) {
    try {
      pointsAwarded = await pointsEngine.recordSweep(
        userAddress,
        body.txHash,
        tokensSwapped,
        valueUSD,
      );
    } catch (error) {
      console.error("[dustsweep/record-sweep] points error:", error);
    }
  }

  // Advance admin-created sweep quests now that the sweep row is persisted (Base only).
  let completedQuests: Array<{
    questId: string;
    slug: string;
    awardedPoints: number;
  }> = [];
  if (rewardsEligible) {
    try {
      const questSync = await questEngine.syncRecordedSweepProgress(userAddress);
      completedQuests = questSync.completedQuests;
    } catch (error) {
      console.error("[dustsweep/record-sweep] quest error:", error);
    }
  }

  return c.json({
    success: true,
    chainId: chain.chainId,
    rewardsEligible,
    completedQuests,
    // Quest progress is a Base-only concept for now; non-Base sweeps report no progress.
    questProgress: rewardsEligible
      ? {
          FIRST_SWEEP: sweepCount === 1 || tokensSwapped > 0,
          SWEEP_10_TOKENS: tokensSwapped >= 10,
          SWEEP_50_TOKENS: tokensSwapped >= 50,
          SWEEP_100_USD: valueUSD >= 100,
          SWEEP_5_TIMES: sweepCount >= 5,
          pointsAwarded,
        }
      : { pointsAwarded: 0 },
  });
});

// ── Routeability DB Cache Persistence ───────────────────────────────────────

async function getDbRouteability(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  chainId: number = BASE_CHAIN_ID,
) {
  try {
    // Bucket amount to normalize cache keys (e.g. 1.23 ETH and 1.24 ETH are same bucket)
    const amountBucket = amountIn.toString().slice(0, 3);
    const { data } = await postgresDb
      .from("dustsweep_routeability_cache")
      .select("*")
      .eq("chain_id", chainId)
      .eq("token_in", tokenIn.toLowerCase())
      .eq("token_out", tokenOut.toLowerCase())
      .eq("amount_bucket", amountBucket)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();

    return data;
  } catch (err) {
    console.error("[dustsweep/cache] DB read error:", err);
    return null;
  }
}

async function setDbRouteability(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  status: "OK" | "NO_ROUTE",
  ttlMs: number,
  payload?: any,
  chainId: number = BASE_CHAIN_ID,
) {
  try {
    const amountBucket = amountIn.toString().slice(0, 3);
    await postgresDb.from("dustsweep_routeability_cache").upsert({
      chain_id: chainId,
      token_in: tokenIn.toLowerCase(),
      token_out: tokenOut.toLowerCase(),
      amount_bucket: amountBucket,
      status,
      payload,
      expires_at: new Date(Date.now() + ttlMs).toISOString(),
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[dustsweep/cache] DB write error:", err);
  }
}

export { dustsweepRoutes };
