import { randomBytes } from "crypto";
import { Hono } from "hono";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  formatUnits,
  getAddress,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { supabase } from "../services/supabase";
import { pointsEngine } from "../services/pointsEngine";
import { runtimeCache } from "../utils/runtimeCache";
import { baseRpcRequest } from "../utils/baseRpc";

const dustsweepRoutes = new Hono();

const BASE_CHAIN_ID = 8453;
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as Address;
const PERMIT2_ADDRESS = (process.env.NEXT_PUBLIC_PERMIT2_ADDRESS ||
  process.env.PERMIT2_ADDRESS ||
  "0x000000000022D473030F116dDEE9F6B43aC78BA3") as Address;
const DUST_SWEEP_ROUTER_ADDRESS = (process.env.DUST_SWEEP_ROUTER_ADDRESS ||
  process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER ||
  process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER_ADDRESS ||
  "0x0000000000000000000000000000000000000000") as Address;
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
const MIN_VALUE_USD = Number(process.env.DUST_SWEEP_MIN_VALUE_USD || "0.01");
const MIN_WL_LIQUIDITY_USD = Number(process.env.DUST_SWEEP_WHITELIST_MIN_LIQUIDITY_USD || "1000");
const DEX = {
  UNISWAP_V3: 0,
  UNISWAP_V4: 1,
  AERODROME: 2,
  PANCAKESWAP_V3: 3,
  BASESWAP: 4,
  GENERIC: 5,
} as const;

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

const DUST_SWEEP_ROUTER_ABI = [
  {
    name: "sweep",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "routes",
            type: "tuple[]",
            components: [
              { name: "tokenIn", type: "address" },
              { name: "amountIn", type: "uint256" },
              { name: "amountOutMin", type: "uint256" },
              { name: "dex", type: "uint8" },
              { name: "dexData", type: "bytes" },
            ],
          },
          { name: "tokenOut", type: "address" },
          { name: "receiver", type: "address" },
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
      },
    ],
    outputs: [{ name: "netOut", type: "uint256" }],
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

type TokenWhitelistRow = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logo_uri?: string | null;
  liquidity_usd?: string | number | null;
  source?: string | null;
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

type QuoteCandidate = Omit<DustSweepRoute, "priceImpactBps"> & {
  amountOut: bigint;
  priceImpactBps?: number;
};

function getFeeBps() {
  const parsed = Number(process.env.DUST_SWEEP_FEE_BPS || "200");
  return Number.isFinite(parsed) ? parsed : 200;
}

function errorJson(message: string) {
  return { success: false, error: message };
}

function normalizeAddress(value: string) {
  return getAddress(value);
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
  return baseRpcRequest<T>(method, params);
}

async function loadWhitelist() {
  const map = new Map<string, TokenWhitelistRow>();

  try {
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
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

  return map;
}

async function fetchTokenPrices(addresses: Address[]) {
  const prices: Record<string, number> = {
    [USDC_ADDRESS.toLowerCase()]: 1,
  };

  if (addresses.length === 0) return prices;

  try {
    const url = new URL("https://api.coingecko.com/api/v3/simple/token_price/base");
    url.searchParams.set("contract_addresses", addresses.map((address) => address.toLowerCase()).join(","));
    url.searchParams.set("vs_currencies", "usd");
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (response.ok) {
      const data = (await response.json()) as Record<string, { usd?: number }>;
      for (const [address, value] of Object.entries(data)) {
        if (value.usd && value.usd > 0) {
          prices[address.toLowerCase()] = value.usd;
        }
      }
    }
  } catch {
    // Prices are display-only; quoting can still proceed.
  }

  return prices;
}

async function getCachedTokenResult(address: Address) {
  try {
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const { data, error } = await supabase
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
    await supabase.from("dustsweep_token_cache").upsert(
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

async function callContract(to: Address, data: Hex) {
  return baseRpcRequest<Hex>("eth_call", [{ to, data }, "latest"]);
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

  for (const [feeA, feeB] of TWO_HOP_FEE_PAIRS) {
    if (!args.feeTiers.includes(feeA) || !args.feeTiers.includes(feeB)) continue;
    try {
      const path = encodeV3Path(args.tokenIn, feeA, WETH_ADDRESS, feeB, args.tokenOut);
      const amountOut = await tryQuoteV3Path(args.quoter, path, args.amountIn);
      if (!amountOut) continue;
      candidates.push({
        tokenIn: args.tokenIn,
        amountIn: args.amountIn.toString(),
        amountOutMin: "0",
        estimatedOut: amountOut.toString(),
        dex: args.dex,
        dexName: `${args.dexName} via WETH`,
        dexData: encodeV3DexData(feeA, path),
        poolFee: feeA,
        amountOut,
      });
    } catch {
      // Try the next path.
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
  const twoHopRoutes = [false, true].map((stable) => [
    { from: tokenIn, to: WETH_ADDRESS, stable: false, factory: AERODROME_FACTORY_ADDRESS },
    { from: WETH_ADDRESS, to: tokenOut, stable, factory: AERODROME_FACTORY_ADDRESS },
  ]);

  for (const routes of [...directRoutes, ...twoHopRoutes]) {
    if (
      routes.length > 1 &&
      (tokenIn.toLowerCase() === WETH_ADDRESS.toLowerCase() ||
        tokenOut.toLowerCase() === WETH_ADDRESS.toLowerCase())
    ) {
      continue;
    }
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
  if (!aggregatorsEnabled() || !isAddress(DUST_SWEEP_ROUTER_ADDRESS)) return null;

  try {
    const url = new URL("https://api.0x.org/swap/allowance-holder/quote");
    url.searchParams.set("chainId", String(BASE_CHAIN_ID));
    url.searchParams.set("sellToken", tokenIn);
    url.searchParams.set("buyToken", tokenOut);
    url.searchParams.set("sellAmount", amountIn.toString());
    url.searchParams.set("taker", DUST_SWEEP_ROUTER_ADDRESS);
    url.searchParams.set("recipient", DUST_SWEEP_ROUTER_ADDRESS);
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

async function getBestQuote(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  slippageBps: number,
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
      getAerodromeQuoteCandidates(tokenIn, tokenOut, amountIn),
      getBaseSwapQuoteCandidates(tokenIn, tokenOut, amountIn),
      get0xQuoteCandidate(tokenIn, tokenOut, amountIn, slippageBps).then((quote) =>
        quote ? [quote] : [],
      ),
    ])
  ).flat();

  return candidates.sort((a, b) => (a.amountOut > b.amountOut ? -1 : a.amountOut < b.amountOut ? 1 : 0))[0] || null;
}

function buildPermit2TypedData(routes: DustSweepRoute[], spender: Address, nonce: string, deadline: number) {
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
      PermitBatchTransferFrom: [
        { name: "permitted", type: "TokenPermissions[]" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    message: {
      permitted: routes.map((route) => ({
        token: route.tokenIn,
        amount: route.amountIn,
      })),
      spender,
      nonce,
      deadline: String(deadline),
    },
  };
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function syncWhitelistFromGeckoTerminal(args: {
  maxPages: number;
  maxTokens: number;
  minLiquidityUSD: number;
  replaceActive?: boolean;
  delayMs?: number;
}) {
  const allowedDexIds = getAllowedGeckoDexIds();
  const byAddress = new Map<string, TokenWhitelistRow>();

  for (let page = 1; page <= args.maxPages; page++) {
    const url = new URL("https://api.geckoterminal.com/api/v2/networks/base/pools");
    url.searchParams.set("page", String(page));
    url.searchParams.set("include", "base_token,quote_token,dex");

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`GeckoTerminal sync failed with ${response.status}`);
    }

    const payload = (await response.json()) as {
      data?: GeckoPool[];
      included?: GeckoToken[];
    };
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

    if (args.delayMs && page < args.maxPages) {
      await sleep(args.delayMs);
    }
  }

  const rows = Array.from(byAddress.values())
    .sort((a, b) => Number(b.liquidity_usd || 0) - Number(a.liquidity_usd || 0))
    .slice(0, args.maxTokens);

  if (args.replaceActive) {
    const { error } = await supabase
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

    const { error } = await supabase.from("tokens").upsert(chunk, {
      onConflict: "address",
    });
    if (error) throw new Error(error.message);
  }

  return { tokensConsidered: byAddress.size, tokensUpserted: rows.length };
}

dustsweepRoutes.post("/admin/sync-whitelist", async (c) => {
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
    const result = await syncWhitelistFromGeckoTerminal({
      maxPages: Math.max(1, Math.min(250, Number(body.maxPages || 200))),
      maxTokens: Math.max(1, Math.min(5000, Number(body.maxTokens || 4000))),
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

dustsweepRoutes.get("/tokens/:address", async (c) => {
  const rawAddress = c.req.param("address");
  if (!rawAddress || !isAddress(rawAddress)) {
    return c.json(errorJson("A valid wallet address is required"), 400);
  }

  const userAddress = normalizeAddress(rawAddress);
  const runtimeKey = `dustsweep:tokens:${userAddress.toLowerCase()}`;

  try {
    const result = await runtimeCache.getOrSet(runtimeKey, 60_000, async () => {
      const cached = await getCachedTokenResult(userAddress);
      if (cached) return cached;

      const whitelist = await loadWhitelist();
      const balances = await alchemyRpc<{
        tokenBalances?: AlchemyBalance[];
      }>("alchemy_getTokenBalances", [userAddress, "erc20"]);
      const nonZero = (balances.tokenBalances || []).filter((balance) => {
        try {
          return BigInt(balance.tokenBalance || "0") > 0n;
        } catch {
          return false;
        }
      });

      const whitelistedBalances = nonZero.filter(
        (balance) =>
          isAddress(balance.contractAddress) &&
          whitelist.has(balance.contractAddress.toLowerCase()),
      );
      const prices = await fetchTokenPrices(
        whitelistedBalances
          .map((balance) => balance.contractAddress)
          .filter((address): address is Address => isAddress(address)),
      );

      const swappable = [];
      const unavailable = [];

      for (const balance of whitelistedBalances.slice(0, 80)) {
        if (!isAddress(balance.contractAddress)) continue;

        const tokenAddress = normalizeAddress(balance.contractAddress);
        const whitelistRow = whitelist.get(tokenAddress.toLowerCase());
        if (!whitelistRow) {
          continue;
        }

        const decimals = Number(whitelistRow.decimals ?? 18);
        const symbol = String(whitelistRow.symbol ?? "TOKEN");
        const name = String(whitelistRow.name ?? symbol);
        const logoURI = whitelistRow.logo_uri ?? undefined;
        const rawBalance = BigInt(balance.tokenBalance).toString();
        const balanceFormatted = formatUnits(BigInt(rawBalance), decimals);
        const priceUSD = prices[tokenAddress.toLowerCase()] || 0;
        const valueUSD = Number(balanceFormatted) * priceUSD;
        const liquidityUSD = Number(whitelistRow?.liquidity_usd || 0);

        const baseToken = {
          address: tokenAddress,
          symbol,
          name,
          decimals,
          logoURI,
          balance: rawBalance,
          balanceFormatted,
          valueUSD: Math.round(valueUSD * 10000) / 10000,
        };

        if (valueUSD > 0 && valueUSD < MIN_VALUE_USD) {
          unavailable.push({ ...baseToken, reason: "BELOW_THRESHOLD" as const });
          continue;
        }

        if (liquidityUSD <= 0 && tokenAddress.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
          unavailable.push({ ...baseToken, reason: "NO_LIQUIDITY" as const });
          continue;
        }

        swappable.push({
          ...baseToken,
          bestDex: bestDexFromSource(whitelistRow.source),
          liquidityUSD,
        });
      }

      swappable.sort((a, b) => b.valueUSD - a.valueUSD);
      unavailable.sort((a, b) => b.valueUSD - a.valueUSD);

      const payload = { swappable, unavailable };
      await setCachedTokenResult(userAddress, payload);
      return payload;
    });

    return c.json(result);
  } catch (error) {
    console.error("[dustsweep/tokens] Error:", error);
    return c.json(errorJson((error as Error).message || "Failed to load tokens"), 500);
  }
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
  if (body.tokenIns.length > 50) {
    return c.json(errorJson("Maximum 50 tokens per sweep"), 400);
  }
  if (!isAddress(body.tokenOut) || !isAddress(body.userAddress)) {
    return c.json(errorJson("Invalid tokenOut or userAddress"), 400);
  }

  const tokenOut = normalizeAddress(body.tokenOut);
  const slippageBps = Math.max(1, Math.min(3000, Number(body.slippageBps || 50)));
  const outputDecimals = tokenOut.toLowerCase() === USDC_ADDRESS.toLowerCase() ? 6 : 18;
  const routes: DustSweepRoute[] = [];
  const whitelist = await loadWhitelist();

  for (let i = 0; i < body.tokenIns.length; i++) {
    const rawTokenIn = body.tokenIns[i];
    if (!isAddress(rawTokenIn)) continue;
    const tokenIn = normalizeAddress(rawTokenIn);
    if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) continue;
    if (!whitelist.has(tokenIn.toLowerCase())) continue;

    let amountIn: bigint;
    try {
      amountIn = BigInt(body.amounts[i] || "0");
    } catch {
      continue;
    }
    if (amountIn <= 0n) continue;

    const best = await getBestQuote(tokenIn, tokenOut, amountIn, slippageBps);
    if (!best) continue;

    const amountOutMin = (best.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
    routes.push({
      tokenIn,
      amountIn: amountIn.toString(),
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
    return c.json(errorJson("No swappable route found for the selected tokens"), 400);
  }

  const totalEstimatedOut = routes.reduce(
    (sum, route) => sum + BigInt(route.estimatedOut),
    0n,
  );
  const prices = await fetchTokenPrices([tokenOut]);
  const outputPrice = prices[tokenOut.toLowerCase()] || (tokenOut.toLowerCase() === USDC_ADDRESS.toLowerCase() ? 1 : 0);
  const totalEstimatedOutUSD =
    Number(formatUnits(totalEstimatedOut, outputDecimals)) * outputPrice;
  const feeBps = getFeeBps();
  const feeAmountUSD = (totalEstimatedOutUSD * feeBps) / 10_000;
  const deadline = Math.floor(Date.now() / 1000) + 1800;
  const permit2Nonce = BigInt(`0x${randomBytes(16).toString("hex")}`).toString();

  return c.json({
    routes,
    totalEstimatedOut: totalEstimatedOut.toString(),
    totalEstimatedOutUSD: Math.round(totalEstimatedOutUSD * 100) / 100,
    feeAmountUSD: Math.round(feeAmountUSD * 10000) / 10000,
    feeBps,
    gasEstimateETH: (0.0000015 + routes.length * 0.0000007).toFixed(8),
    gasEstimateUSD: Math.round((0.004 + routes.length * 0.0015) * 100) / 100,
    permit2Nonce,
    deadline,
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
  }>();

  if (!body.routes?.length || !body.tokenOut || !body.receiver || !body.deadline || !body.permit2Nonce) {
    return c.json(errorJson("routes, tokenOut, receiver, deadline, and permit2Nonce are required"), 400);
  }
  if (!isAddress(body.tokenOut) || !isAddress(body.receiver)) {
    return c.json(errorJson("Invalid tokenOut or receiver"), 400);
  }
  if (!isAddress(DUST_SWEEP_ROUTER_ADDRESS)) {
    return c.json(errorJson("DustSweep router address is not configured"), 500);
  }

  const routes = body.routes.map((route) => ({
    ...route,
    tokenIn: normalizeAddress(route.tokenIn),
  }));
  const sweepRoutes = routes.map((route) => ({
    tokenIn: route.tokenIn,
    amountIn: BigInt(route.amountIn),
    amountOutMin: BigInt(route.amountOutMin),
    dex: route.dex ?? 0,
    dexData: route.dexData,
  }));
  const tokenOut = normalizeAddress(body.tokenOut);
  const receiver = normalizeAddress(body.receiver);
  const permit = {
    permitted: routes.map((route) => ({
      token: route.tokenIn,
      amount: BigInt(route.amountIn),
    })),
    nonce: BigInt(body.permit2Nonce),
    deadline: BigInt(body.deadline),
  };
  const calldata = encodeFunctionData({
    abi: DUST_SWEEP_ROUTER_ABI,
    functionName: "sweep",
    args: [
      {
        routes: sweepRoutes,
        tokenOut,
        receiver,
        deadline: BigInt(body.deadline),
        permit,
        signature: "0x",
      },
    ],
  });

  return c.json({
    permit2: buildPermit2TypedData(
      routes,
      normalizeAddress(DUST_SWEEP_ROUTER_ADDRESS),
      String(body.permit2Nonce),
      body.deadline,
    ),
    contractAddress: normalizeAddress(DUST_SWEEP_ROUTER_ADDRESS),
    calldata,
    callMode: "permit2-sweep",
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
    await supabase.from("sweeps").upsert(
      {
        user_address: userAddress.toLowerCase(),
        tx_hash: body.txHash.toLowerCase(),
        tokens_swapped: tokensSwapped,
        value_usd: valueUSD,
        chain_id: BASE_CHAIN_ID,
      },
      { onConflict: "tx_hash" },
    );

    const { count } = await supabase
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

export { dustsweepRoutes };
