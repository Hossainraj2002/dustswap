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
import { runtimeCache } from "../utils/runtimeCache";
import { baseRpcRequest, alchemyRpcRequest, RpcDeterministicError, RpcTransportError } from "../utils/baseRpc";
import { isMaintenanceBlocking, maintenanceUnavailable } from "../utils/maintenance";

const dustsweepRoutes = new Hono();

dustsweepRoutes.use("*", async (c, next) => {
  if (await isMaintenanceBlocking(c)) {
    return maintenanceUnavailable(c);
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
const UNISWAP_V3_SWAP_ROUTER_ADDRESS = (process.env.UNISWAP_V3_SWAP_ROUTER_ADDRESS ||
  "0x2626664c2603336E57B271c5C0b26F421741e481") as Address;
const UNISWAP_UNIVERSAL_ROUTER_ADDRESS = (process.env.UNISWAP_UNIVERSAL_ROUTER_ADDRESS ||
  "0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7") as Address;
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
const DISCOVERY_MARKET_HINT_CONCURRENCY = boundedEnvNumber("DUST_SWEEP_MARKET_HINT_CONCURRENCY", 4, 1, 8);
const DISCOVERY_MARKET_HINT_TIMEOUT_MS = boundedEnvNumber("DUST_SWEEP_MARKET_HINT_TIMEOUT_MS", 3_500, 1_000, 8_000);
const DISCOVERY_METADATA_CONCURRENCY = boundedEnvNumber("DUST_SWEEP_METADATA_CONCURRENCY", 10, 1, 24);
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
const NATIVE_ETH_LOGO_URI = "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png";
const DEX = {
  UNISWAP_V3: 0,
  UNISWAP_V4: 1,
  AERODROME: 2,
  PANCAKESWAP_V3: 3,
  BASESWAP: 4,
  GENERIC: 5,
} as const;

type DustSweepExecutionLane = "owned_v1" | "owned_v2" | "basket_aggregator";

function getExecutionLane(): DustSweepExecutionLane {
  const raw = String(process.env.DUST_SWEEP_EXECUTION_LANE || "owned_v1").toLowerCase();
  if (raw === "owned_v2") return "owned_v2";
  if (raw === "basket_aggregator") return "basket_aggregator";
  return "owned_v1";
}

function getRouteMaxCap(executionLane: DustSweepExecutionLane) {
  return executionLane === "owned_v1" ? 10 : 50;
}

function getRouterAddressForLane(executionLane: DustSweepExecutionLane) {
  if (executionLane === "owned_v2") return DUST_SWEEP_ROUTER_V2_ADDRESS;
  return DUST_SWEEP_ROUTER_V1_ADDRESS;
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

function getAllowedV2Targets() {
  const targets = parseAddressSet(process.env.DUST_SWEEP_ALLOWED_TARGETS, [
    UNISWAP_V3_SWAP_ROUTER_ADDRESS,
    UNISWAP_UNIVERSAL_ROUTER_ADDRESS,
    PANCAKE_V3_SWAP_ROUTER_ADDRESS,
    AERODROME_ROUTER_ADDRESS,
    BASESWAP_ROUTER_ADDRESS,
  ]);
  for (const address of getAllowedAggregatorAddresses()) targets.add(address);
  return targets;
}

function getAllowedV2Spenders() {
  const spenders = parseAddressSet(process.env.DUST_SWEEP_ALLOWED_SPENDERS, [
    UNISWAP_V3_SWAP_ROUTER_ADDRESS,
    PERMIT2_ADDRESS,
    PANCAKE_V3_SWAP_ROUTER_ADDRESS,
    AERODROME_ROUTER_ADDRESS,
    BASESWAP_ROUTER_ADDRESS,
  ]);
  for (const address of getAllowedAggregatorAddresses()) spenders.add(address);
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

type AlchemyBalance = {
  contractAddress: string;
  tokenBalance: string;
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
  reason: "NO_LIQUIDITY" | "NOT_WHITELISTED" | "BELOW_THRESHOLD" | "BALANCE_CHANGED" | "QUOTE_FAILED" | "NATIVE_WRAP_REQUIRED";
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

type PriceConfidence = "HIGH" | "MEDIUM" | "LOW" | "NONE";

type TokenMarketHint = {
  priceUSD: number;
  liquidityUSD: number;
  bestDex: string;
  source: "canonical" | "coingecko" | "dexscreener" | "none";
  confidence: PriceConfidence;
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
};

const erc20MetadataCache = new Map<string, { value: Erc20Metadata; expiresAt: number }>();
let whitelistCache: { value: Map<string, TokenWhitelistRow>; expiresAt: number } | null = null;
let ethUsdCache: { price: number; expiresAt: number } | null = null;

function getFeeBps() {
  const parsed = Number(process.env.DUST_SWEEP_FEE_BPS || "200");
  return Number.isFinite(parsed) ? parsed : 200;
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

async function alchemyRpc<T>(method: string, params: unknown[]): Promise<T> {
  return alchemyRpcRequest<T>(method, params, { timeoutMs: DISCOVERY_ALCHEMY_TIMEOUT_MS });
}

function reachedDiscoveryLimit(count: number, limit: number | null) {
  return limit !== null && count >= limit;
}

function discoveryLimitedBalances<T>(balances: T[]) {
  return DISCOVERY_MAX_ERC20_BALANCES === null
    ? balances
    : balances.slice(0, DISCOVERY_MAX_ERC20_BALANCES);
}

async function fetchAlchemyTokenBalances(holder: Address): Promise<AlchemyTokenBalanceDiscovery> {
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
      return { tokenBalances, pageCount, scannedBalanceCount, truncated: false };
    }

    if (
      reachedDiscoveryLimit(tokenBalances.length, targetNonZeroBalances) ||
      reachedDiscoveryLimit(pageCount, DISCOVERY_ALCHEMY_MAX_PAGES)
    ) {
      return { tokenBalances, pageCount, scannedBalanceCount, truncated: true };
    }

    pageKey = nextPageKey;
  }

  return { tokenBalances, pageCount, scannedBalanceCount, truncated: Boolean(pageKey) };
}

async function loadWhitelist() {
  if (whitelistCache && whitelistCache.expiresAt > Date.now()) {
    return whitelistCache.value;
  }

  const map = new Map<string, TokenWhitelistRow>();

  try {
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await postgresDb
        .from("tokens")
        .select("address,symbol,name,decimals,logo_uri,liquidity_usd,source")
        .eq("chain_id", BASE_CHAIN_ID)
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

  for (const token of DEFAULT_TOKEN_WHITELIST) {
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

  whitelistCache = {
    value: map,
    expiresAt: Date.now() + WHITELIST_CACHE_TTL_MS,
  };

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

async function fetchTokenPricesDexScreener(addresses: Address[]): Promise<Record<string, number>> {
  const prices: Record<string, number> = {};
  // DexScreener accepts up to 30 addresses per call — free, no auth, fast
  const BATCH = 30;
  for (let i = 0; i < addresses.length; i += BATCH) {
    const batch = addresses.slice(i, i + BATCH);
    try {
      const response = await fetch(
        `https://api.dexscreener.com/tokens/v1/base/${batch.join(",")}`,
        {
          headers: {
            Accept: "application/json",
            "User-Agent": "DustSwap/1.0 (+https://app.dustswap.wtf)",
          },
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!response.ok) continue;
      const pairs = (await response.json()) as Array<{
        priceUsd?: string;
        baseToken?: { address?: string };
        quoteToken?: { address?: string };
        liquidity?: { usd?: number };
      }>;
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

async function fetchTokenPrices(addresses: Address[]) {
  const marketHints = await fetchTokenMarketHints(addresses);
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
    hints[key] = hint;
  }
}

function isNativeTokenAddress(address: string) {
  return address.toLowerCase() === NATIVE_TOKEN_SENTINEL.toLowerCase();
}

function isOutputAssetAddress(address: string) {
  const key = address.toLowerCase();
  return key === USDC_ADDRESS.toLowerCase() || key === WETH_ADDRESS.toLowerCase();
}

async function fetchTokenMarketHintsDexScreener(addresses: Address[]): Promise<Record<string, TokenMarketHint>> {
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
          `https://api.dexscreener.com/tokens/v1/base/${batch.join(",")}`,
          {
            headers: {
              Accept: "application/json",
              "User-Agent": "DustSwap/1.0 (+https://app.dustswap.wtf)",
            },
            signal: AbortSignal.timeout(DISCOVERY_MARKET_HINT_TIMEOUT_MS),
          },
        );
        if (!response.ok) return nextHints;

        const pairs = (await response.json()) as Array<{
          priceUsd?: string;
          dexId?: string;
          baseToken?: { address?: string };
          liquidity?: { usd?: number };
        }>;

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

async function fetchTokenMarketHints(addresses: Address[]): Promise<Record<string, TokenMarketHint>> {
  const hints: Record<string, TokenMarketHint> = {};
  const uniqueAddresses = Array.from(new Set(addresses.map((address) => address.toLowerCase())))
    .filter((address): address is Address => isAddress(address));

  if (uniqueAddresses.length === 0) return hints;

  for (const stable of [USDC_ADDRESS, USDBC_ADDRESS, USDT_ADDRESS, DAI_ADDRESS]) {
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
        address.toLowerCase() === WETH_ADDRESS.toLowerCase() ||
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
    hints[WETH_ADDRESS.toLowerCase()] = ethHint;
    hints[NATIVE_TOKEN_SENTINEL.toLowerCase()] = ethHint;
  }

  const externalNeeded = uniqueAddresses.filter(
    (address) => !isNativeTokenAddress(address) && (hints[address.toLowerCase()]?.priceUSD || 0) === 0,
  );

  const [dexHints, coingeckoPrices] = await Promise.all([
    fetchTokenMarketHintsDexScreener(externalNeeded),
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

async function getCachedTokenResult(address: Address) {
  try {
    const cutoff = new Date(Date.now() - DISCOVERY_DB_CACHE_TTL_MS).toISOString();
    const { data, error } = await postgresDb
      .from("dustsweep_token_cache")
      .select("payload,updated_at")
      .eq("address", address.toLowerCase())
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

async function setCachedTokenResult(address: Address, payload: unknown) {
  try {
    await postgresDb.from("dustsweep_token_cache").upsert(
      {
        address: address.toLowerCase(),
        payload,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "address" },
    );
  } catch {
    // Optional cache table.
  }
}

async function readNativeBalance(holder: Address) {
  const result = await baseRpcRequest<Hex>("eth_getBalance", [holder, "latest"], {
    timeoutMs: 5_000,
  });
  return BigInt(result);
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

async function callContract(to: Address, data: Hex, signal?: AbortSignal) {
  // 5s timeout per RPC call so one slow node doesn't block the quote pipeline
  return baseRpcRequest<Hex>("eth_call", [{ to, data }, "latest"], {
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
) {
  const data = encodeFunctionData({
    abi: QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
  });
  const result = await callContract(quoter, data);
  if (!result || result === "0x") return null;
  const decoded = decodeFunctionResult({
    abi: QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    data: result,
  });
  const amountOut = decoded[0];
  return amountOut > 0n ? amountOut : null;
}

async function tryQuoteV3Path(quoter: Address, path: Hex, amountIn: bigint) {
  const data = encodeFunctionData({
    abi: QUOTER_ABI,
    functionName: "quoteExactInput",
    args: [path, amountIn],
  });
  const result = await callContract(quoter, data);
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
}): Promise<QuoteCandidate[]> {
  const candidates: QuoteCandidate[] = [];

  for (const fee of args.feeTiers) {
    try {
      const amountOut = await tryQuoteV3Single(
        args.quoter,
        args.tokenIn,
        args.tokenOut,
        args.amountIn,
        fee,
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

  if (candidates.length > 0 || args.tokenIn.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
    return candidates;
  }

  // Two-hop: try WETH and USDC as intermediate tokens
  const intermediates: Array<{ mid: Address; label: string }> = [];
  if (args.tokenIn.toLowerCase() !== WETH_ADDRESS.toLowerCase() && args.tokenOut.toLowerCase() !== WETH_ADDRESS.toLowerCase()) {
    intermediates.push({ mid: WETH_ADDRESS, label: "WETH" });
  }
  if (args.tokenIn.toLowerCase() !== USDC_ADDRESS.toLowerCase() && args.tokenOut.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
    intermediates.push({ mid: USDC_ADDRESS, label: "USDC" });
  }

  for (const { mid, label } of intermediates) {
    for (const [feeA, feeB] of TWO_HOP_FEE_PAIRS) {
      if (!args.feeTiers.includes(feeA) || !args.feeTiers.includes(feeB)) continue;
      try {
        const path = encodeV3Path(args.tokenIn, feeA, mid, feeB, args.tokenOut);
        const amountOut = await tryQuoteV3Path(args.quoter, path, args.amountIn);
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

function getAllowedAggregatorAddresses() {
  return new Set(
    String(process.env.DUST_SWEEP_ALLOWED_AGGREGATOR_TARGETS || "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => isAddress(item))
      .map((item) => normalizeAddress(item).toLowerCase()),
  );
}

async function get0xQuoteCandidate(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  slippageBps: number,
): Promise<QuoteCandidate | null> {
  const taker = getRouterAddressForLane(getExecutionLane());
  if (!aggregatorsEnabled() || !isAddress(taker)) return null;

  try {
    const url = new URL("https://api.0x.org/swap/allowance-holder/quote");
    url.searchParams.set("chainId", String(BASE_CHAIN_ID));
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
    const allowedAggregatorAddresses = getAllowedAggregatorAddresses();
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
      priceImpactBps: 0,
    };
  } catch {
    return null;
  }
}

// ── Uniswap V4 Quoting ──────────────────────────────────────────────────────
const UNISWAP_V4_QUOTER_ADDRESS = (process.env.UNISWAP_V4_QUOTER_ADDRESS ||
  "0x0d5e0f971ed27fbff6c2837bf31316121532048d") as Address;

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
          { name: "sqrtPriceLimitX96", type: "uint160" },
          { name: "hookData", type: "bytes" },
        ],
        name: "params",
        type: "tuple",
      },
    ],
    name: "quoteExactInputSingle",
    outputs: [
      { name: "deltaAmounts", type: "int128[]" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
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
      sqrtPriceLimitX96: 0n,
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
    // deltaAmounts: [amount0, amount1] — the output is the negative delta
    const deltas = decoded[0];
    // If zeroForOne, output is deltaAmounts[1] (negative = received)
    // If !zeroForOne, output is deltaAmounts[0] (negative = received)
    const outputDelta = zeroForOne ? deltas[1] : deltas[0];
    const amountOut = outputDelta < 0n ? -outputDelta : 0n;
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

async function getBestQuote(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  slippageBps: number,
  executionLane: DustSweepExecutionLane,
) {
  const candidates = (
    await Promise.all([
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
      getBaseSwapQuoteCandidates(tokenIn, tokenOut, amountIn),
      get0xQuoteCandidate(tokenIn, tokenOut, amountIn, slippageBps).then((quote) =>
        quote ? [quote] : [],
      ),
    ])
  )
    .flat()
    .filter((candidate) => isCandidateExecutableInLane(candidate, executionLane));

  return candidates.sort((a, b) => (a.amountOut > b.amountOut ? -1 : a.amountOut < b.amountOut ? 1 : 0))[0] || null;
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
}) {
  return {
    domain: {
      name: "Permit2",
      chainId: BASE_CHAIN_ID,
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

function assertConfiguredV2Route(route: DustSweepV2Route) {
  const allowedTargets = getAllowedV2Targets();
  const allowedSpenders = getAllowedV2Spenders();

  if (!allowedTargets.has(route.target.toLowerCase())) {
    throw new Error(`V2 target ${route.target} is not configured in DUST_SWEEP_ALLOWED_TARGETS`);
  }

  if (!allowedSpenders.has(route.spender.toLowerCase())) {
    throw new Error(`V2 spender ${route.spender} is not configured in DUST_SWEEP_ALLOWED_SPENDERS`);
  }
}

async function readV2AllowedTarget(routerAddress: Address, target: Address) {
  const data = encodeFunctionData({
    abi: DUST_SWEEP_ROUTER_V2_ABI,
    functionName: "allowedTargets",
    args: [target],
  });
  const result = await callContract(routerAddress, data);
  const allowed = decodeFunctionResult({
    abi: DUST_SWEEP_ROUTER_V2_ABI,
    functionName: "allowedTargets",
    data: result,
  });
  return allowed;
}

async function readV2AllowedSpender(routerAddress: Address, spender: Address) {
  const data = encodeFunctionData({
    abi: DUST_SWEEP_ROUTER_V2_ABI,
    functionName: "allowedSpenders",
    args: [spender],
  });
  const result = await callContract(routerAddress, data);
  const allowed = decodeFunctionResult({
    abi: DUST_SWEEP_ROUTER_V2_ABI,
    functionName: "allowedSpenders",
    data: result,
  });
  return allowed;
}

async function assertOnchainV2RouterAllowlist(routerAddress: Address, routes: DustSweepV2Route[]) {
  const targets = Array.from(new Set(routes.map((route) => route.target.toLowerCase() as Lowercase<Address>)));
  const spenders = Array.from(new Set(routes.map((route) => route.spender.toLowerCase() as Lowercase<Address>)));

  const [targetChecks, spenderChecks] = await Promise.all([
    Promise.all(
      targets.map(async (target) => ({
        address: target,
        allowed: await readV2AllowedTarget(routerAddress, getAddress(target)),
      })),
    ),
    Promise.all(
      spenders.map(async (spender) => ({
        address: spender,
        allowed: await readV2AllowedSpender(routerAddress, getAddress(spender)),
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
          { name: "minHopPriceX36", type: "uint256" },
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
        minHopPriceX36: 0n,
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

function buildV2Route(route: DustSweepRoute, tokenOut: Address, receiver: Address, deadline: number): DustSweepV2Route {
  const amountIn = BigInt(route.amountIn);
  const amountOutMin = BigInt(route.amountOutMin);

  if (route.tokenIn.toLowerCase() === NATIVE_TOKEN_SENTINEL.toLowerCase()) {
    throw new Error("Native ETH must be wrapped to WETH before using owned_v2.");
  }

  if (route.dex === DEX.UNISWAP_V3 || route.dex === DEX.PANCAKESWAP_V3) {
    const target = route.dex === DEX.UNISWAP_V3
      ? UNISWAP_V3_SWAP_ROUTER_ADDRESS
      : PANCAKE_V3_SWAP_ROUTER_ADDRESS;
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
      target: UNISWAP_UNIVERSAL_ROUTER_ADDRESS,
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

  try {
    const response = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) throw new Error("ETH price unavailable");
    const payload = (await response.json()) as { data?: { amount?: string } };
    const price = Number(payload.data?.amount || 0);
    if (Number.isFinite(price) && price > 0) {
      ethUsdCache = { price, expiresAt: Date.now() + 60_000 };
      return price;
    }
  } catch {
    // Fallback below.
  }
  const fallback = Number(process.env.DEFAULT_ETH_PRICE_USD || "3500");
  ethUsdCache = { price: fallback, expiresAt: Date.now() + 15_000 };
  return fallback;
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

async function readErc20Balance(token: Address, holder: Address) {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder],
  });
  const result = await callContract(token, data);
  return decodeFunctionResult({
    abi: erc20Abi,
    functionName: "balanceOf",
    data: result,
  }) as bigint;
}

async function readErc20Allowance(token: Address, owner: Address, spender: Address) {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
  const result = await callContract(token, data);
  return decodeFunctionResult({
    abi: erc20Abi,
    functionName: "allowance",
    data: result,
  }) as bigint;
}

async function findStaleRouteBalances(userAddress: Address, routes: DustSweepRoute[]) {
  const stale: Array<{
    token: Address;
    required: string;
    balance: string;
  }> = [];

  for (const route of routes) {
    const amountIn = BigInt(route.amountIn || "0");
    if (amountIn <= 0n) continue;

    const balance = await readErc20Balance(route.tokenIn, userAddress);
    if (balance < amountIn) {
      stale.push({
        token: route.tokenIn,
        required: amountIn.toString(),
        balance: balance.toString(),
      });
    }
  }

  return stale;
}

async function findMissingPermit2Approvals(userAddress: Address, routes: DustSweepRoute[]) {
  return findMissingTokenApprovals(userAddress, routes, PERMIT2_ADDRESS);
}

async function findMissingTokenApprovals(userAddress: Address, routes: DustSweepRoute[], spender: Address) {
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

  for (const item of requiredByToken.values()) {
    const allowance = await readErc20Allowance(item.token, userAddress, spender);
    if (allowance < item.amount) {
      approvals.push({
        token: item.token,
        required: item.amount.toString(),
        allowance: allowance.toString(),
        spender,
      });
    }
  }

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
  const { error } = await postgresDb.from("tokens").upsert(payload, {
    onConflict: "address",
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
      onConflict: "address",
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
      onConflict: "address",
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

  const requestedChainId = Number(c.req.query("chainId") || BASE_CHAIN_ID);
  if (requestedChainId !== BASE_CHAIN_ID) {
    return c.json(errorJson("DustSweep discovery is Base-only for this release"), 400);
  }

  const userAddress = normalizeAddress(rawAddress);
  const runtimeKey = `dustsweep:tokens:${BASE_CHAIN_ID}:${userAddress.toLowerCase()}`;

  try {
    const result = await runtimeCache.getOrSet(runtimeKey, DISCOVERY_RUNTIME_CACHE_TTL_MS, async () => {
      const startedAt = Date.now();
      const cached = await getCachedTokenResult(userAddress);
      if (cached) return cached;

      // ── Wallet-first discovery: fetch ALL balances, not just whitelisted ──
      // Whitelist is used as metadata/liquidity HINTS, not a visibility gate.
      const [whitelist, erc20Discovery, nativeBalance] = await Promise.all([
        loadWhitelist(),
        fetchAlchemyTokenBalances(userAddress).catch((error) => {
          console.warn("[dustsweep/tokens] Alchemy balance discovery failed", {
            message: error instanceof Error ? error.message : String(error),
          });
          return {
            tokenBalances: [],
            pageCount: 0,
            scannedBalanceCount: 0,
            truncated: false,
          } satisfies AlchemyTokenBalanceDiscovery;
        }),
        readNativeBalance(userAddress).catch(() => 0n),
      ]);

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
      const marketAddresses = nativeBalance > 0n
        ? [...allAddresses, NATIVE_TOKEN_SENTINEL]
        : allAddresses;
      const marketHints = await fetchTokenMarketHints(marketAddresses);
      const metadataByAddress = await loadDiscoveryMetadata(nonZero, whitelist, marketHints);

      const swappable: DiscoveryTokenResult[] = [];
      const unavailable: DiscoveryTokenResult[] = [];
      const hidden: DiscoveryTokenResult[] = [];
      const suspicious: DiscoveryTokenResult[] = [];
      const excludedOutputAssets: DiscoveryTokenResult[] = [];

      if (nativeBalance > 0n) {
        const nativeMarket = marketHints[NATIVE_TOKEN_SENTINEL.toLowerCase()] || emptyMarketHint();
        const balanceFormatted = formatUnits(nativeBalance, 18);
        const valueUSD = Number(balanceFormatted) * nativeMarket.priceUSD;
        const nativeToken: DiscoveryTokenResult = {
          address: NATIVE_TOKEN_SENTINEL,
          symbol: "ETH",
          name: "Ethereum",
          decimals: 18,
          logoURI: NATIVE_ETH_LOGO_URI,
          balance: nativeBalance.toString(),
          balanceFormatted,
          valueUSD: roundUsd(valueUSD),
          bestDex: nativeMarket.bestDex,
          liquidityUSD: nativeMarket.liquidityUSD,
          status: "NATIVE_WRAP_REQUIRED",
          isNative: true,
          wrapRequired: true,
          sourceType: "native",
          priceUSD: nativeMarket.priceUSD,
          priceSource: nativeMarket.source,
          priceConfidence: nativeMarket.confidence,
          riskScore: 0,
          riskReasons: [],
          reason: "NATIVE_WRAP_REQUIRED",
        };

        if (nativeToken.valueUSD >= MIN_VALUE_USD) {
          unavailable.push(nativeToken);
        } else if (nativeToken.valueUSD > 0) {
          hidden.push({
            ...nativeToken,
            status: "HIDDEN",
            reason: "BELOW_THRESHOLD",
          });
        }
      }

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
            hasMetadata = true;
          }
        }

        const rawBalance = BigInt(balance.tokenBalance).toString();
        const balanceFormatted = formatUnits(BigInt(rawBalance), decimals);
        const market = marketHints[key] || emptyMarketHint();
        const priceUSD = market.priceUSD;
        liquidityUSD = Math.max(liquidityUSD, market.liquidityUSD);
        bestDex = market.bestDex !== "GENERIC" ? market.bestDex : bestDex;
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
        // Skip output tokens (USDC, WETH) — they're not dust
        if (isOutputAssetAddress(tokenAddress)) {
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

        if (baseToken.valueUSD < MIN_VALUE_USD && priceUSD > 0) {
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
        chainId: BASE_CHAIN_ID,
        refreshedAt: new Date().toISOString(),
        discovery: {
          erc20BalanceCount: nonZero.length,
          alchemyScannedBalanceCount: erc20Discovery.scannedBalanceCount,
          alchemyPageCount: erc20Discovery.pageCount,
          truncated: erc20Discovery.truncated,
          maxErc20Balances: DISCOVERY_MAX_ERC20_BALANCES,
          targetNonZeroBalances: DISCOVERY_TARGET_NONZERO_BALANCES,
          maxAlchemyPages: DISCOVERY_ALCHEMY_MAX_PAGES,
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

      await setCachedTokenResult(userAddress, payload);
      return payload;
    });

    return c.json(result);
  } catch (error) {
    console.error("[dustsweep/tokens] Error:", error);
    return c.json(errorJson((error as Error).message || "Failed to load tokens"), 500);
  }
}

dustsweepRoutes.get("/tokens", async (c) => {
  return handleDustSweepTokensRequest(c, c.req.query("address"));
});

dustsweepRoutes.get("/tokens/:address", async (c) => {
  return handleDustSweepTokensRequest(c, c.req.param("address"));
});

dustsweepRoutes.post("/quote", async (c) => {
  const body = await c.req.json<{
    tokenIns?: string[];
    amounts?: string[];
    tokenOut?: string;
    slippageBps?: number;
    userAddress?: string;
  }>();

  if (!body.tokenIns?.length || !body.amounts?.length || !body.tokenOut || !body.userAddress) {
    return c.json(errorJson("tokenIns, amounts, tokenOut, and userAddress are required"), 400);
  }
  if (body.tokenIns.length !== body.amounts.length) {
    return c.json(errorJson("tokenIns and amounts length mismatch"), 400);
  }

  // Enforce actual contract capability — V1 contract has MAX_BATCH_SIZE = 10
  const executionLane = getExecutionLane();
  const routeMaxCap = getRouteMaxCap(executionLane);

  if (body.tokenIns.length > routeMaxCap) {
    return c.json(errorJson(`Maximum ${routeMaxCap} tokens per sweep (${executionLane} lane)`), 400);
  }
  if (!isAddress(body.tokenOut) || !isAddress(body.userAddress)) {
    return c.json(errorJson("Invalid tokenOut or userAddress"), 400);
  }

  const tokenOut = normalizeAddress(body.tokenOut);
  const slippageBps = Math.max(1, Math.min(3000, Number(body.slippageBps || 50)));
  const routes: DustSweepRoute[] = [];
  const skippedTokens: QuoteSkippedToken[] = [];
  const whitelist = await loadWhitelist();
  const userAddress = normalizeAddress(body.userAddress);

  // Resolve output token decimals from whitelist, default to 6 for USDC, 18 otherwise
  const outputWhitelistRow = whitelist.get(tokenOut.toLowerCase());
  const outputDecimals = outputWhitelistRow
    ? Number(outputWhitelistRow.decimals ?? 18)
    : tokenOut.toLowerCase() === USDC_ADDRESS.toLowerCase()
      ? 6
      : 18;

  // ── Step 1: validate and parse all inputs (no whitelist gating) ─────────────
  type PendingToken = { tokenIn: Address; amountIn: bigint; index: number; bestDex?: string };
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

    pending.push({ tokenIn, amountIn, index: i, bestDex });
  }

  // ── Step 2: check live balances in parallel ─────────────────────────────────
  const balanceChecks = await Promise.all(
    pending.map(({ tokenIn, amountIn }) =>
      readErc20Balance(tokenIn, userAddress)
        .then((live) => ({ live, amountIn, ok: live >= amountIn }))
        .catch(() => ({ live: 0n, amountIn, ok: false })),
    ),
  );

  const readyToQuote: PendingToken[] = [];
  for (let i = 0; i < pending.length; i++) {
    const item = pending[i]!;
    const check = balanceChecks[i]!;
    if (!check.ok) {
      skippedTokens.push({
        token: item.tokenIn,
        reason: "BALANCE_CHANGED",
        message: "Token balance changed. Refresh balances before sweeping this token.",
      });
    } else {
      readyToQuote.push(item);
    }
  }

  // ── Step 3: routeability pre-screen with cache ─────────────────────────────
  const ROUTEABILITY_OK_TTL = 60_000;
  const ROUTEABILITY_NO_ROUTE_TTL = 30_000;

  const quoteTasks = readyToQuote.map(
    ({ tokenIn, amountIn }) =>
      async () => {
        const cacheKey = `routeability:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`;
        
        // 1. Check runtime memory cache (fastest)
        const memCached = runtimeCache.get<{ status: string; checkedAt: number }>(cacheKey);
        if (memCached && memCached.status === "NO_ROUTE") {
          return { tokenIn, amountIn, best: null, error: null, cachedNoRoute: true };
        }

        // 2. Check DB persistent cache (survives restarts)
        const dbCached = await getDbRouteability(tokenIn, tokenOut, amountIn);
        if (dbCached) {
          if (dbCached.status === "NO_ROUTE") {
            runtimeCache.set(cacheKey, { status: "NO_ROUTE", checkedAt: Date.now() }, ROUTEABILITY_NO_ROUTE_TTL);
            return { tokenIn, amountIn, best: null, error: null, cachedNoRoute: true };
          }
          // If status is OK, we still might want a fresh quote to get live price,
          // but we know a route exists. For now, we proceed to quote to be safe.
        }

        return getBestQuote(tokenIn, tokenOut, amountIn, slippageBps, executionLane)
          .then(async (best) => {
            if (best) {
              runtimeCache.set(cacheKey, { status: "OK", checkedAt: Date.now() }, ROUTEABILITY_OK_TTL);
              await setDbRouteability(tokenIn, tokenOut, amountIn, "OK", ROUTEABILITY_OK_TTL * 10, best);
            } else {
              runtimeCache.set(cacheKey, { status: "NO_ROUTE", checkedAt: Date.now() }, ROUTEABILITY_NO_ROUTE_TTL);
              await setDbRouteability(tokenIn, tokenOut, amountIn, "NO_ROUTE", ROUTEABILITY_NO_ROUTE_TTL * 10);
            }
            return { tokenIn, amountIn, best, error: null as string | null, cachedNoRoute: false };
          })
          .catch(async (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            if (error instanceof RpcDeterministicError) {
              runtimeCache.set(cacheKey, { status: "NO_ROUTE", checkedAt: Date.now() }, ROUTEABILITY_NO_ROUTE_TTL);
              await setDbRouteability(tokenIn, tokenOut, amountIn, "NO_ROUTE", ROUTEABILITY_NO_ROUTE_TTL * 10);
            }
            return {
              tokenIn,
              amountIn,
              best: null as QuoteCandidate | null,
              error: message,
              cachedNoRoute: false,
            };
          });
      },
  );

  const quoteResults = await pLimit(quoteTasks, 4);

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
    routes.push({
      tokenIn: result.tokenIn,
      amountIn: result.amountIn.toString(),
      amountOutMin: amountOutMin.toString(),
      estimatedOut: best.estimatedOut,
      dex: best.dex,
      dexName: best.dexName,
      dexData: best.dexData,
      priceImpactBps: best.priceImpactBps ?? 43,
      poolFee: best.poolFee,
    });
  }

  if (routes.length === 0) {
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
  const prices = await fetchTokenPrices([tokenOut]);
  const outputPrice = prices[tokenOut.toLowerCase()] || (tokenOut.toLowerCase() === USDC_ADDRESS.toLowerCase() ? 1 : 0);
  const totalEstimatedOutUSD =
    Number(formatUnits(totalEstimatedOut, outputDecimals)) * outputPrice;
  const feeBps = getFeeBps();
  const protocolFeeAmount = (totalEstimatedOut * BigInt(feeBps)) / 10_000n;
  const netEstimatedOut = totalEstimatedOut - protocolFeeAmount;
  const minAmountOut = cappedRoutes.reduce((sum, route) => sum + BigInt(route.amountOutMin), 0n);
  const feeAmountUSD = (totalEstimatedOutUSD * feeBps) / 10_000;
  const netEstimatedOutUSD = totalEstimatedOutUSD - feeAmountUSD;
  const deadline = Math.floor(Date.now() / 1000) + 1800;
  const permit2Nonce = BigInt(`0x${randomBytes(16).toString("hex")}`).toString();

  return c.json({
    routes: cappedRoutes,
    skippedTokens,
    totalEstimatedOut: totalEstimatedOut.toString(),
    minAmountOut: minAmountOut.toString(),
    protocolFeeAmount: protocolFeeAmount.toString(),
    netEstimatedOut: netEstimatedOut.toString(),
    totalEstimatedOutUSD: Math.round(totalEstimatedOutUSD * 100) / 100,
    feeAmountUSD: Math.round(feeAmountUSD * 10000) / 10000,
    netEstimatedOutUSD: Math.round(netEstimatedOutUSD * 100) / 100,
    feeBps,
    gasEstimateETH: (0.0000015 + cappedRoutes.length * 0.0000007).toFixed(8),
    gasEstimateUSD: Math.round((0.004 + cappedRoutes.length * 0.0015) * 100) / 100,
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
  }>();

  const executionLane = getExecutionLane();
  const routeMaxCap = getRouteMaxCap(executionLane);
  const routerAddress = getRouterAddressForLane(executionLane);
  const v2AuthMode = (process.env.DUST_SWEEP_V2_AUTH_MODE || "allowance").toLowerCase();

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
  const staleBalances = await findStaleRouteBalances(userAddress, routes);
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

  let v2Routes: DustSweepV2Route[];
  try {
    v2Routes = routes.map((route) => buildV2Route(route, buildTokenOut, routerAddress, body.deadline!));
    for (const route of v2Routes) assertConfiguredV2Route(route);
    await assertOnchainV2RouterAllowlist(routerAddress, v2Routes);
  } catch (error) {
    return c.json(errorJson((error as Error).message || "Failed to build V2 route"), 400);
  }

  const minAmountOut = routes.reduce((sum, route) => sum + BigInt(route.amountOutMin), 0n);
  const value = v2Routes.reduce((sum, route) => sum + route.value, 0n);
  if (v2AuthMode !== "permit2") {
    const routerApprovals = await findMissingTokenApprovals(userAddress, routes, routerAddress);
    const calldata = encodeV2AllowanceSweepCalldata({
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
      minAmountOut: minAmountOut.toString(),
      calldata,
      value: value.toString(),
      callMode: "sweepWithAllowance",
      executionLane,
    });
  }

  const permit2Approvals = await findMissingPermit2Approvals(userAddress, routes);
  const routeHash = hashV2Routes(v2Routes);
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
  }>();

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
        chain_id: BASE_CHAIN_ID,
      },
      { onConflict: "tx_hash" },
    );

    const { count } = await postgresDb
      .from("sweeps")
      .select("id", { count: "exact", head: true })
      .eq("user_address", userAddress.toLowerCase());
    sweepCount = count || 0;
  } catch {
    // Sweep history table may not be migrated locally yet. Points still record below.
  }

  let pointsAwarded = 0;
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

  return c.json({
    success: true,
    questProgress: {
      FIRST_SWEEP: sweepCount === 1 || tokensSwapped > 0,
      SWEEP_10_TOKENS: tokensSwapped >= 10,
      SWEEP_50_TOKENS: tokensSwapped >= 50,
      SWEEP_100_USD: valueUSD >= 100,
      SWEEP_5_TIMES: sweepCount >= 5,
      pointsAwarded,
    },
  });
});

// ── Routeability DB Cache Persistence ───────────────────────────────────────

async function getDbRouteability(tokenIn: Address, tokenOut: Address, amountIn: bigint) {
  try {
    // Bucket amount to normalize cache keys (e.g. 1.23 ETH and 1.24 ETH are same bucket)
    const amountBucket = amountIn.toString().slice(0, 3);
    const { data } = await postgresDb
      .from("dustsweep_routeability_cache")
      .select("*")
      .eq("chain_id", BASE_CHAIN_ID)
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
) {
  try {
    const amountBucket = amountIn.toString().slice(0, 3);
    await postgresDb.from("dustsweep_routeability_cache").upsert({
      chain_id: BASE_CHAIN_ID,
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
