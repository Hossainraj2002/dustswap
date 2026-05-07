import { randomBytes } from "crypto";
import { Hono } from "hono";
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  encodePacked,
  formatUnits,
  getAddress,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { supabase } from "../services/supabase";
import { pointsEngine } from "../services/pointsEngine";
import { runtimeCache } from "../utils/runtimeCache";

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
const QUOTER_ADDRESS = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as Address;
const FEE_TIERS = [500, 3000, 10000, 100] as const;
const MIN_VALUE_USD = Number(process.env.DUST_SWEEP_MIN_VALUE_USD || "0.01");

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
] as const;

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

const publicClient = createPublicClient({
  chain: base,
  transport: http(getRpcUrl(), { timeout: 20_000 }),
});

function getRpcUrl() {
  if (process.env.ALCHEMY_BASE_RPC) return process.env.ALCHEMY_BASE_RPC;
  const alchemyKey = process.env.ALCHEMY_API_KEY || process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  if (alchemyKey) return `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`;
  return process.env.BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org";
}

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
  const response = await fetch(getRpcUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  if (!response.ok) {
    throw new Error(`Alchemy RPC failed with ${response.status}`);
  }

  const payload = (await response.json()) as {
    result?: T;
    error?: { message?: string };
  };

  if (payload.error) {
    throw new Error(payload.error.message || "Alchemy RPC error");
  }

  return payload.result as T;
}

async function fetchAlchemyMetadata(tokenAddress: Address) {
  try {
    return await alchemyRpc<{
      name?: string;
      symbol?: string;
      decimals?: number;
      logo?: string;
    }>("alchemy_getTokenMetadata", [tokenAddress]);
  } catch {
    return null;
  }
}

async function loadWhitelist() {
  const map = new Map<string, TokenWhitelistRow>();

  try {
    const { data, error } = await supabase
      .from("tokens")
      .select("address,symbol,name,decimals,logo_uri,liquidity_usd,source")
      .eq("chain_id", BASE_CHAIN_ID)
      .eq("is_active", true);

    if (!error) {
      for (const row of (data || []) as TokenWhitelistRow[]) {
        if (row.address && isAddress(row.address)) {
          map.set(row.address.toLowerCase(), row);
        }
      }
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

async function tryQuoteSingle(tokenIn: Address, tokenOut: Address, amountIn: bigint, fee: number) {
  const data = encodeFunctionData({
    abi: QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
  });
  const result = await publicClient.call({ to: QUOTER_ADDRESS, data });
  if (!result.data) return null;
  const decoded = decodeFunctionResult({
    abi: QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    data: result.data,
  });
  const amountOut = decoded[0];
  return amountOut > 0n ? amountOut : null;
}

async function getBestQuote(tokenIn: Address, tokenOut: Address, amountIn: bigint) {
  let best: { amountOut: bigint; fee: number } | null = null;

  for (const fee of FEE_TIERS) {
    try {
      const out = await tryQuoteSingle(tokenIn, tokenOut, amountIn, fee);
      if (out && (!best || out > best.amountOut)) {
        best = { amountOut: out, fee };
      }
    } catch {
      // Try the next fee tier.
    }
  }

  return best;
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

      const prices = await fetchTokenPrices(
        nonZero
          .map((balance) => balance.contractAddress)
          .filter((address): address is Address => isAddress(address)),
      );

      const swappable = [];
      const unavailable = [];

      for (const balance of nonZero.slice(0, 80)) {
        if (!isAddress(balance.contractAddress)) continue;

        const tokenAddress = normalizeAddress(balance.contractAddress);
        const whitelistRow = whitelist.get(tokenAddress.toLowerCase());
        const metadata = whitelistRow
          ? null
          : await fetchAlchemyMetadata(tokenAddress);
        const decimals = Number(whitelistRow?.decimals ?? metadata?.decimals ?? 18);
        const symbol = String(whitelistRow?.symbol ?? metadata?.symbol ?? "TOKEN");
        const name = String(whitelistRow?.name ?? metadata?.name ?? symbol);
        const logoURI = whitelistRow?.logo_uri ?? metadata?.logo ?? undefined;
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

        if (!whitelistRow) {
          unavailable.push({ ...baseToken, reason: "NOT_WHITELISTED" as const });
          continue;
        }

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

  for (let i = 0; i < body.tokenIns.length; i++) {
    const rawTokenIn = body.tokenIns[i];
    if (!isAddress(rawTokenIn)) continue;
    const tokenIn = normalizeAddress(rawTokenIn);
    if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) continue;

    let amountIn: bigint;
    try {
      amountIn = BigInt(body.amounts[i] || "0");
    } catch {
      continue;
    }
    if (amountIn <= 0n) continue;

    const best = await getBestQuote(tokenIn, tokenOut, amountIn);
    if (!best) continue;

    const amountOutMin = (best.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
    routes.push({
      tokenIn,
      amountIn: amountIn.toString(),
      amountOutMin: amountOutMin.toString(),
      estimatedOut: best.amountOut.toString(),
      dex: 0,
      dexName: "Uniswap V3",
      dexData: encodePacked(["address", "uint24", "address"], [tokenIn, best.fee, tokenOut]),
      priceImpactBps: 43,
      poolFee: best.fee,
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
  const orders = routes.map((route) => ({
    tokenIn: route.tokenIn,
    amountIn: BigInt(route.amountIn),
    poolFee: route.poolFee ?? 3000,
    minAmountOut: BigInt(route.amountOutMin),
  }));
  const tokenOut = normalizeAddress(body.tokenOut);
  const receiver = normalizeAddress(body.receiver);
  const calldata = encodeFunctionData({
    abi: DUST_SWEEP_ROUTER_ABI,
    functionName: "sweepDust",
    args: [orders, tokenOut, receiver, BigInt(body.deadline)],
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
