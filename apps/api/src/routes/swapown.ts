import { Hono } from "hono";
import {
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  toHex,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import {
  getPublicClientForSwapChain,
  getSwapChainConfig,
  getSupportedSwapChainIds,
} from "../config/swapChains";
import {
  getActiveSwapOwnSources,
  getSwapOwnFeeBps,
  getSwapOwnRouterAddress,
  getSwapOwnSourceReadiness,
  type SwapOwnSource,
} from "../config/swapownSources";
import { isMaintenanceBlocking, maintenanceUnavailable } from "../utils/maintenance";

const swapownRoutes = new Hono();

swapownRoutes.use("*", async (c, next) => {
  if (await isMaintenanceBlocking(c)) {
    return maintenanceUnavailable(c);
  }
  return next();
});

const BPS_DENOMINATOR = 10_000n;
const DEFAULT_SLIPPAGE_BPS = 50;
const MAX_SLIPPAGE_BPS = 3_000;
const DEFAULT_DEADLINE_SECONDS = 20 * 60;
const MAX_INPUTS = 6;
const MAX_OUTPUTS = 6;
const NATIVE_SENTINELS = new Set([
  "0x0000000000000000000000000000000000000000",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
]);

const V2_ROUTER_ABI = [
  {
    name: "getAmountsOut",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
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

const V3_QUOTER_ABI = [
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
          { name: "fee", type: "uint24" },
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

const V3_SWAP_ROUTER_ABI = [
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
] as const;

const DUSTSWAP_AGGREGATOR_ABI = [
  {
    name: "swap",
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
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "tokenOut", type: "address" },
          { name: "minAmountOut", type: "uint256" },
          { name: "receiver", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "referralCode", type: "bytes32" },
        ],
      },
    ],
    outputs: [
      { name: "grossAmountOut", type: "uint256" },
      { name: "feeAmount", type: "uint256" },
      { name: "netAmountOut", type: "uint256" },
    ],
  },
  {
    name: "swapBasket",
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
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "outputs",
            type: "tuple[]",
            components: [
              { name: "token", type: "address" },
              { name: "minAmountOut", type: "uint256" },
            ],
          },
          { name: "receiver", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "referralCode", type: "bytes32" },
        ],
      },
    ],
    outputs: [
      { name: "grossAmountsOut", type: "uint256[]" },
      { name: "netAmountsOut", type: "uint256[]" },
    ],
  },
] as const;

type QuoteInput = {
  token: string;
  amount: string;
  symbol?: string;
  decimals?: number;
};

type QuoteOutput = {
  token: string;
  symbol?: string;
  decimals?: number;
  shareBps?: number;
};

type BuiltRoute = {
  sourceId: string;
  sourceName: string;
  sourceType: string;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: string;
  quotedAmountOut: string;
  amountOutMin: string;
  target: Address;
  spender: Address;
  value: string;
  data: Hex;
};

function okJson<T extends Record<string, unknown>>(data: T) {
  return { success: true, ...data };
}

function errorJson(error: string, extra?: Record<string, unknown>) {
  return { success: false, error, ...(extra || {}) };
}

function normalizeAddress(value: string) {
  return getAddress(value) as Address;
}

function isNativeSentinel(value: string) {
  return NATIVE_SENTINELS.has(value.toLowerCase());
}

function parsePositiveBigInt(value: unknown, label: string) {
  try {
    const parsed = BigInt(String(value || "0"));
    if (parsed <= 0n) {
      throw new Error(`${label} must be greater than zero`);
    }
    return parsed;
  } catch {
    throw new Error(`${label} must be a positive integer string`);
  }
}

function clampSlippage(value: unknown) {
  const parsed = Number(value ?? DEFAULT_SLIPPAGE_BPS);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SLIPPAGE_BPS;
  }
  return Math.max(0, Math.min(MAX_SLIPPAGE_BPS, Math.floor(parsed)));
}

function toReferralCode(value: unknown): Hex {
  const text = String(value || "").trim();
  if (!text) return zeroHash;
  if (isHex(text) && text.length === 66) return text as Hex;
  return keccak256(toHex(text));
}

function minOutFromSlippage(amountOut: bigint, slippageBps: number) {
  return (amountOut * (BPS_DENOMINATOR - BigInt(slippageBps))) / BPS_DENOMINATOR;
}

function feeFor(amountOut: bigint, feeBps: number) {
  return (amountOut * BigInt(feeBps)) / BPS_DENOMINATOR;
}

function parseInputs(raw: unknown) {
  const inputs = Array.isArray(raw) ? (raw as QuoteInput[]) : [];
  if (inputs.length === 0 || inputs.length > MAX_INPUTS) {
    throw new Error(`Provide 1-${MAX_INPUTS} input tokens`);
  }

  return inputs.map((input) => {
    if (!input?.token || !isAddress(input.token) || isNativeSentinel(input.token)) {
      throw new Error("Only ERC-20 inputs are supported on /swapown. Use WETH for native gas tokens.");
    }
    return {
      token: normalizeAddress(input.token),
      amount: parsePositiveBigInt(input.amount, "amount"),
      symbol: input.symbol || "",
      decimals: Number.isFinite(input.decimals) ? Number(input.decimals) : undefined,
    };
  });
}

function parseOutputs(raw: unknown) {
  const outputs = Array.isArray(raw) ? (raw as QuoteOutput[]) : [];
  if (outputs.length === 0 || outputs.length > MAX_OUTPUTS) {
    throw new Error(`Provide 1-${MAX_OUTPUTS} output tokens`);
  }

  const seen = new Set<string>();
  const parsed = outputs.map((output) => {
    if (!output?.token || !isAddress(output.token) || isNativeSentinel(output.token)) {
      throw new Error("Only ERC-20 outputs are supported on /swapown. Use WETH for native gas tokens.");
    }
    const token = normalizeAddress(output.token);
    const key = token.toLowerCase();
    if (seen.has(key)) {
      throw new Error("Duplicate output token");
    }
    seen.add(key);
    return {
      token,
      shareBps: Number(output.shareBps || 0),
      symbol: output.symbol || "",
      decimals: Number.isFinite(output.decimals) ? Number(output.decimals) : undefined,
    };
  });

  const explicitShareTotal = parsed.reduce((sum, output) => sum + output.shareBps, 0);
  if (explicitShareTotal <= 0) {
    const baseShare = Math.floor(10_000 / parsed.length);
    let assigned = 0;
    return parsed.map((output, index) => {
      const shareBps = index === parsed.length - 1 ? 10_000 - assigned : baseShare;
      assigned += shareBps;
      return { ...output, shareBps };
    });
  }

  if (explicitShareTotal !== 10_000) {
    throw new Error("Output shares must add up to 10000 bps");
  }

  return parsed;
}

function splitAmount(amount: bigint, shares: number[]) {
  let remaining = amount;
  return shares.map((share, index) => {
    if (index === shares.length - 1) {
      const final = remaining;
      remaining = 0n;
      return final;
    }
    const part = (amount * BigInt(share)) / BPS_DENOMINATOR;
    remaining -= part;
    return part;
  });
}

async function callContract(chainId: number, to: Address, data: Hex) {
  const client = getPublicClientForSwapChain(chainId);
  if (!client) throw new Error(`Unsupported chain: ${chainId}`);
  const result = await client.call({ to, data });
  if (!result.data || result.data === "0x") {
    throw new Error("Empty contract response");
  }
  return result.data;
}

async function quoteV2(chainId: number, source: SwapOwnSource, tokenIn: Address, tokenOut: Address, amountIn: bigint) {
  const data = encodeFunctionData({
    abi: V2_ROUTER_ABI,
    functionName: "getAmountsOut",
    args: [amountIn, [tokenIn, tokenOut]],
  });
  const result = await callContract(chainId, source.router, data);
  const amounts = decodeFunctionResult({
    abi: V2_ROUTER_ABI,
    functionName: "getAmountsOut",
    data: result,
  }) as readonly bigint[];
  return amounts[amounts.length - 1] || 0n;
}

async function quoteV3(chainId: number, source: SwapOwnSource, tokenIn: Address, tokenOut: Address, amountIn: bigint) {
  if (!source.quoter || !source.fee) {
    return 0n;
  }
  const data = encodeFunctionData({
    abi: V3_QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn,
        tokenOut,
        amountIn,
        fee: source.fee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  const result = await callContract(chainId, source.quoter, data);
  const [amountOut] = decodeFunctionResult({
    abi: V3_QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    data: result,
  });
  return amountOut;
}

function buildRouteData(args: {
  source: SwapOwnSource;
  routerAddress: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOutMin: bigint;
  deadline: number;
}) {
  if (args.source.type === "v2") {
    return encodeFunctionData({
      abi: V2_ROUTER_ABI,
      functionName: "swapExactTokensForTokens",
      args: [
        args.amountIn,
        args.amountOutMin,
        [args.tokenIn, args.tokenOut],
        args.routerAddress,
        BigInt(args.deadline),
      ],
    });
  }

  return encodeFunctionData({
    abi: V3_SWAP_ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: args.tokenIn,
        tokenOut: args.tokenOut,
        fee: args.source.fee || 3000,
        recipient: args.routerAddress,
        amountIn: args.amountIn,
        amountOutMinimum: args.amountOutMin,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
}

async function findBestRoute(args: {
  chainId: number;
  routerAddress: Address;
  sources: SwapOwnSource[];
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  slippageBps: number;
  deadline: number;
}) {
  const candidates = await Promise.allSettled(
    args.sources.map(async (source) => {
      const quotedAmountOut =
        source.type === "v2"
          ? await quoteV2(args.chainId, source, args.tokenIn, args.tokenOut, args.amountIn)
          : await quoteV3(args.chainId, source, args.tokenIn, args.tokenOut, args.amountIn);

      if (quotedAmountOut <= 0n) {
        throw new Error("No output");
      }

      const amountOutMin = minOutFromSlippage(quotedAmountOut, args.slippageBps);
      return {
        source,
        quotedAmountOut,
        amountOutMin,
      };
    })
  );
  const best = candidates
    .filter((candidate): candidate is PromiseFulfilledResult<{
      source: SwapOwnSource;
      quotedAmountOut: bigint;
      amountOutMin: bigint;
    }> => candidate.status === "fulfilled")
    .map((candidate) => candidate.value)
    .sort((left, right) =>
      left.quotedAmountOut > right.quotedAmountOut ? -1 : left.quotedAmountOut < right.quotedAmountOut ? 1 : 0
    )[0];

  if (!best) {
    throw new Error(`No direct DustSwap route found for ${args.tokenIn} -> ${args.tokenOut}`);
  }

  return {
    sourceId: best.source.id,
    sourceName: best.source.name,
    sourceType: best.source.type,
    tokenIn: args.tokenIn,
    tokenOut: args.tokenOut,
    amountIn: args.amountIn.toString(),
    quotedAmountOut: best.quotedAmountOut.toString(),
    amountOutMin: best.amountOutMin.toString(),
    target: best.source.router,
    spender: best.source.spender || best.source.router,
    value: "0",
    data: buildRouteData({
      source: best.source,
      routerAddress: args.routerAddress,
      tokenIn: args.tokenIn,
      tokenOut: args.tokenOut,
      amountIn: args.amountIn,
      amountOutMin: best.amountOutMin,
      deadline: args.deadline,
    }),
  } satisfies BuiltRoute;
}

function summarizeOutputs(routes: BuiltRoute[], feeBps: number) {
  const byToken = new Map<string, {
    token: Address;
    grossAmountOut: bigint;
    minAmountOut: bigint;
    feeAmount: bigint;
    netAmountOut: bigint;
  }>();

  for (const route of routes) {
    const key = route.tokenOut.toLowerCase();
    const existing = byToken.get(key) || {
      token: route.tokenOut,
      grossAmountOut: 0n,
      minAmountOut: 0n,
      feeAmount: 0n,
      netAmountOut: 0n,
    };
    existing.grossAmountOut += BigInt(route.quotedAmountOut);
    existing.minAmountOut += BigInt(route.amountOutMin);
    existing.feeAmount = feeFor(existing.grossAmountOut, feeBps);
    existing.netAmountOut = existing.grossAmountOut - existing.feeAmount;
    byToken.set(key, existing);
  }

  return Array.from(byToken.values()).map((output) => ({
    token: output.token,
    grossAmountOut: output.grossAmountOut.toString(),
    minAmountOut: output.minAmountOut.toString(),
    feeAmount: output.feeAmount.toString(),
    netAmountOut: output.netAmountOut.toString(),
  }));
}

function routeCallsFromBuilt(routes: BuiltRoute[]) {
  return routes.map((route) => ({
    tokenIn: route.tokenIn,
    amountIn: BigInt(route.amountIn),
    target: route.target,
    spender: route.spender,
    value: BigInt(route.value || "0"),
    data: route.data,
  }));
}

function validateBuiltRoutes(routes: unknown): BuiltRoute[] {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error("routes are required");
  }

  return routes.map((route) => {
    const item = route as Partial<BuiltRoute>;
    if (
      !item.sourceId ||
      !item.sourceName ||
      !item.sourceType ||
      !item.tokenIn ||
      !item.tokenOut ||
      !item.amountIn ||
      !item.amountOutMin ||
      !item.quotedAmountOut ||
      !item.target ||
      !item.spender ||
      !item.data ||
      !isAddress(item.tokenIn) ||
      !isAddress(item.tokenOut) ||
      !isAddress(item.target) ||
      !isAddress(item.spender) ||
      !isHex(item.data)
    ) {
      throw new Error("Malformed route data");
    }

    return {
      sourceId: String(item.sourceId),
      sourceName: String(item.sourceName),
      sourceType: String(item.sourceType),
      tokenIn: normalizeAddress(item.tokenIn),
      tokenOut: normalizeAddress(item.tokenOut),
      amountIn: parsePositiveBigInt(item.amountIn, "route amountIn").toString(),
      quotedAmountOut: parsePositiveBigInt(item.quotedAmountOut, "route quotedAmountOut").toString(),
      amountOutMin: parsePositiveBigInt(item.amountOutMin, "route amountOutMin").toString(),
      target: normalizeAddress(item.target),
      spender: normalizeAddress(item.spender),
      value: String(item.value || "0"),
      data: item.data as Hex,
    };
  });
}

function assertRoutesAreConfigured(chainId: number, routes: BuiltRoute[]) {
  const allowed = new Set(
    getActiveSwapOwnSources(chainId).map((source) =>
      `${source.id}:${source.router.toLowerCase()}:${(source.spender || source.router).toLowerCase()}`
    )
  );

  for (const route of routes) {
    const key = `${route.sourceId}:${route.target.toLowerCase()}:${route.spender.toLowerCase()}`;
    if (!allowed.has(key)) {
      throw new Error(`Route source ${route.sourceId} is not an active direct DustSwap source`);
    }
  }
}

swapownRoutes.get("/sources", (c) => {
  const chainIds = getSupportedSwapChainIds().filter((chainId) =>
    [8453, 1, 56, 137, 42161, 43114].includes(chainId)
  );
  const requestedChainId = c.req.query("chainId");
  const selectedChainIds = requestedChainId ? [Number(requestedChainId)] : chainIds;

  return c.json(okJson({
    aggregatorName: "DustSwap",
    logoURI: "/logo.png",
    chains: selectedChainIds.map((chainId) => ({
      ...getSwapOwnSourceReadiness(chainId),
      routerAddress: getSwapOwnRouterAddress(chainId),
    })),
  }));
});

swapownRoutes.post("/quote", async (c) => {
  try {
    const body = await c.req.json<{
      chainId?: number | string;
      takerAddress?: string;
      inputs?: QuoteInput[];
      outputs?: QuoteOutput[];
      slippageBps?: number;
      referralCode?: string;
    }>();

    const chainId = Number(body.chainId);
    const chainConfig = getSwapChainConfig(chainId);
    if (!chainConfig) {
      return c.json(errorJson("Unsupported /swapown chain"), 400);
    }

    if (!body.takerAddress || !isAddress(body.takerAddress)) {
      return c.json(errorJson("A valid takerAddress is required"), 400);
    }

    const routerAddress = getSwapOwnRouterAddress(chainId);
    if (!routerAddress) {
      return c.json(errorJson("DustSwap aggregator router is not configured for this chain"), 501);
    }

    const inputs = parseInputs(body.inputs);
    const outputs = parseOutputs(body.outputs);
    const slippageBps = clampSlippage(body.slippageBps);
    const deadline = Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SECONDS;
    const sources = getActiveSwapOwnSources(chainId);
    if (sources.length === 0) {
      return c.json(errorJson("No active direct DustSwap sources are configured for this chain"), 501);
    }

    const routes: BuiltRoute[] = [];
    for (const input of inputs) {
      const splits = splitAmount(input.amount, outputs.map((output) => output.shareBps));
      for (let i = 0; i < outputs.length; i += 1) {
        const amountIn = splits[i];
        if (amountIn <= 0n) continue;
        routes.push(
          await findBestRoute({
            chainId,
            routerAddress,
            sources,
            tokenIn: input.token,
            tokenOut: outputs[i].token,
            amountIn,
            slippageBps,
            deadline,
          })
        );
      }
    }

    const feeBps = getSwapOwnFeeBps();
    const outputSummaries = summarizeOutputs(routes, feeBps);
    const readiness = getSwapOwnSourceReadiness(chainId);

    return c.json(okJson({
      quoteId: keccak256(toHex(JSON.stringify({
        chainId,
        taker: body.takerAddress.toLowerCase(),
        routes: routes.map((route) => [route.sourceId, route.tokenIn, route.tokenOut, route.amountIn, route.quotedAmountOut]),
        deadline,
      }))),
      aggregatorName: "DustSwap",
      logoURI: "/logo.png",
      source: "dustswap_aggregator",
      chainId,
      chainKey: chainConfig.key,
      chainLabel: chainConfig.label,
      routerAddress,
      feeBps,
      slippageBps,
      deadline,
      expiresAt: new Date(deadline * 1000).toISOString(),
      referralCode: toReferralCode(body.referralCode),
      productionReady: readiness.productionReady,
      sourceReadiness: readiness,
      inputs: inputs.map((input) => ({
        token: input.token,
        amount: input.amount.toString(),
        symbol: input.symbol,
        decimals: input.decimals,
      })),
      outputs: outputs.map((output) => ({
        token: output.token,
        shareBps: output.shareBps,
        symbol: output.symbol,
        decimals: output.decimals,
      })),
      outputSummaries,
      routes,
    }));
  } catch (error) {
    return c.json(errorJson((error as Error).message || "Failed to build DustSwap quote"), 400);
  }
});

swapownRoutes.post("/build-tx", async (c) => {
  try {
    const body = await c.req.json<{
      chainId?: number | string;
      receiver?: string;
      routes?: BuiltRoute[];
      outputSummaries?: Array<{ token: string; minAmountOut: string }>;
      deadline?: number;
      referralCode?: string;
    }>();

    const chainId = Number(body.chainId);
    if (!getSwapChainConfig(chainId)) {
      return c.json(errorJson("Unsupported /swapown chain"), 400);
    }

    if (!body.receiver || !isAddress(body.receiver)) {
      return c.json(errorJson("A valid receiver is required"), 400);
    }

    const routerAddress = getSwapOwnRouterAddress(chainId);
    if (!routerAddress) {
      return c.json(errorJson("DustSwap aggregator router is not configured for this chain"), 501);
    }

    const deadline = Number(body.deadline || 0);
    if (!Number.isFinite(deadline) || deadline <= Math.floor(Date.now() / 1000)) {
      return c.json(errorJson("Quote deadline expired. Refresh quote and try again."), 409);
    }

    const routes = validateBuiltRoutes(body.routes);
    assertRoutesAreConfigured(chainId, routes);
    const outputSummaries = summarizeOutputs(routes, getSwapOwnFeeBps());
    const outputs = outputSummaries.map((output) => ({
      token: normalizeAddress(output.token),
      minAmountOut: BigInt(output.minAmountOut),
    }));
    const referralCode = toReferralCode(body.referralCode);
    const routeCalls = routeCallsFromBuilt(routes);
    const totalValue = routeCalls.reduce((sum, route) => sum + route.value, 0n);
    const uniqueInputs = Array.from(new Set(routes.map((route) => route.tokenIn.toLowerCase())));
    const singleOutput = outputs.length === 1;
    const singleInput = uniqueInputs.length === 1;

    const calldata = singleInput && singleOutput
      ? encodeFunctionData({
          abi: DUSTSWAP_AGGREGATOR_ABI,
          functionName: "swap",
          args: [
            routeCalls,
            {
              tokenIn: routes[0].tokenIn,
              amountIn: routes.reduce((sum, route) => sum + BigInt(route.amountIn), 0n),
              tokenOut: outputs[0].token,
              minAmountOut: outputs[0].minAmountOut,
              receiver: normalizeAddress(body.receiver),
              deadline: BigInt(deadline),
              referralCode,
            },
          ],
        })
      : encodeFunctionData({
          abi: DUSTSWAP_AGGREGATOR_ABI,
          functionName: "swapBasket",
          args: [
            routeCalls,
            {
              outputs,
              receiver: normalizeAddress(body.receiver),
              deadline: BigInt(deadline),
              referralCode,
            },
          ],
        });

    return c.json(okJson({
      aggregatorName: "DustSwap",
      logoURI: "/logo.png",
      source: "dustswap_aggregator",
      chainId,
      routerAddress,
      contractAddress: routerAddress,
      to: routerAddress,
      value: totalValue.toString(),
      calldata,
      data: calldata,
      functionName: singleInput && singleOutput ? "swap" : "swapBasket",
      approvalSpender: routerAddress,
      approvalRequirements: Array.from(
        routes.reduce((items, route) => {
          const key = route.tokenIn.toLowerCase();
          const current = items.get(key) || { token: route.tokenIn, amount: 0n };
          current.amount += BigInt(route.amountIn);
          items.set(key, current);
          return items;
        }, new Map<string, { token: Address; amount: bigint }>())
      ).map(([, item]) => ({
        token: item.token,
        spender: routerAddress,
        amount: item.amount.toString(),
      })),
      outputSummaries,
      routes,
      deadline,
    }));
  } catch (error) {
    return c.json(errorJson((error as Error).message || "Failed to build DustSwap transaction"), 400);
  }
});

swapownRoutes.get("/allowance", async (c) => {
  try {
    const chainId = Number(c.req.query("chainId"));
    const owner = c.req.query("owner");
    const token = c.req.query("token");
    const spender = c.req.query("spender") || getSwapOwnRouterAddress(chainId);

    if (!getSwapChainConfig(chainId) || !owner || !token || !spender || !isAddress(owner) || !isAddress(token) || !isAddress(spender)) {
      return c.json(errorJson("chainId, owner, token, and spender are required"), 400);
    }

    const client = getPublicClientForSwapChain(chainId);
    if (!client) return c.json(errorJson("Unsupported chain"), 400);
    const allowance = await client.readContract({
      address: token as Address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner as Address, spender as Address],
    });

    return c.json(okJson({ allowance: allowance.toString() }));
  } catch (error) {
    return c.json(errorJson((error as Error).message || "Failed to read allowance"), 400);
  }
});

export { swapownRoutes };
