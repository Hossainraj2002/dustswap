// Offline integration coverage: real chain registries and HTTP build handlers,
// deterministic RPC replies, and independently decoded on-chain calldata.
// Run: node --test tests/optimism-integration.test.cjs
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const Module = require("node:module");

require("ts-node").register({
  project: path.join(__dirname, "../tsconfig.json"),
  transpileOnly: true,
  compilerOptions: { module: "CommonJS", moduleResolution: "Node" },
});
const { encodeAbiParameters, encodeFunctionResult, decodeAbiParameters, decodeFunctionData, parseAbi, erc20Abi } = require("viem");

const USER = "0x1111111111111111111111111111111111111111";
const ROUTER = "0x2222222222222222222222222222222222222222";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const DAI = "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1";
const OP = "0x4200000000000000000000000000000000000042";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const UNI_V3 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const UNI_V2 = "0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2";
const VELO = "0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858";
const BASE_UNI_V3 = "0x2626664c2603336E57B271c5C0b26F421741e481";
const AMOUNT = "10000000000000000";
const MIN_OUT = "25000000";
const rpcCalls = [];
let onchainAllowed = true;
let balance = BigInt(AMOUNT);
const recordedPoints = [];
const failedVenues = new Set();
let campaignIntakes = 0;
let nativeQuoteOverride = null;
let fetchQuoteOverride = null;
let discoveryBalances = [];
let discoveryAlchemyCalls = 0;
let discoveryAlchemyError = null;
let discoveryAlchemyOverride = null;
const routeabilityRows = [];
const routeabilityWrites = [];
let whitelistRows = [];
const tokenDecimals = new Map();

// Never read real .env files or use configured production services in this suite.
for (const key of Object.keys(process.env)) {
  if (/^(DUST_SWEEP_|NEXT_PUBLIC_DUST_SWEEP_|ALCHEMY_|BLOCKSCOUT_)/.test(key)) delete process.env[key];
}
process.env.DUST_SWEEP_ROUTER_V3_ADDRESS_10 = ROUTER;
process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER_V3_ADDRESS_10 = ROUTER;
process.env.DUST_SWEEP_FEE_BPS_10 = "200";
process.env.DUST_SWEEP_MULTICALL_BATCHING = "false";
process.env.DUST_SWEEP_PREFLIGHT_TRANSFER_PROBE = "false";
process.env.DUST_SWEEP_ENABLE_KYBER_10 = "false";
process.env.DUST_SWEEP_ENABLE_LIFI_10 = "false";
process.env.DUST_SWEEP_NATIVE_QUOTE_BUDGET_MS_10 = "500";
process.env.DUST_SWEEP_AGG_MIN_INTERVAL_MS_KYBER = "0";
process.env.DUST_SWEEP_AGG_MIN_INTERVAL_MS_LIFI = "0";
process.env.DUST_SWEEP_BLOCKSCOUT_BALANCE_MAX_RETRIES = "0";
process.env.DUST_SWEEP_BLOCKSCOUT_BALANCE_MAX_PAGES = "1";
process.env.DUST_SWEEP_BLOCKSCOUT_BALANCE_TIMEOUT_MS = "2000";
// The API's advisory market lookup is isolated too; no real HTTP traffic occurs.
global.fetch = async (url, options) => {
  if (fetchQuoteOverride) {
    const overridden = await fetchQuoteOverride(url, options);
    if (overridden !== undefined) return overridden;
  }
  const value = String(url);
  if (value.includes("ETHUSDT")) return Response.json({ price: "3000" });
  if (value.includes("ids=ethereum")) return Response.json({ ethereum: { usd: 3000 } });
  return new Response("{}", { status: 503 });
};

const backend = require("../src/config/sweepChains.ts");
const sources = require("../src/config/dustsweepV3Sources.ts");
const rpc = require("../src/utils/chainRpc.ts");
const frontend = require("../../web/src/config/sweepChainConfig.ts");
const solidly = require("../src/lib/dustsweepSolidly.ts");
const { RpcDeterministicError } = require("../src/utils/baseRpc.ts");
const governor = require("../src/lib/aggregatorGovernor.ts");
const sweepAbi = parseAbi([
  "function sweep(uint8 mode, (address tokenIn, uint256 amountIn, address target, address spender, uint256 value, bytes data)[] routes, (address outputToken, address recipient, uint256 minAmountOut, uint256 deadline, uint16 feeBpsOverride) params, ((address token, uint256 amount)[] permitted, uint256 nonce, uint256 deadline) permit, bytes signature)",
]);
const v3Abi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) returns (uint256)",
  "function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params) returns (uint256)",
]);
const v2Abi = parseAbi([
  "function getAmountsOut(uint256 amountIn,address[] path) view returns (uint256[])",
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[])",
]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256,uint160,uint32,uint256)",
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256,uint160[],uint32[],uint256)",
]);

function encodedV3Quote(call, amountOut) {
  const { functionName } = decodeFunctionData({ abi: quoterAbi, data: call.data });
  return encodeFunctionResult({ abi: quoterAbi, functionName, result: functionName === "quoteExactInputSingle" ? [amountOut, 1n, 0, 100000n] : [amountOut, [1n], [0], 100000n] });
}

async function fixtureRpc(chainId, method, params) {
  rpcCalls.push({ chainId, method, params });
  assert.equal(chainId, 10, "an Optimism build must never read a different chain");
  if (method === "eth_gasPrice") return "0xf4240";
  assert.equal(method, "eth_call");
  const call = params[0];
  const selector = call.data.slice(0, 10);
  if (failedVenues.has(call.to.toLowerCase())) throw new Error("Offline missing pool / venue unavailable");
  if (selector === "0x70a08231") return encodeAbiParameters([{ type: "uint256" }], [balance]);
  if (selector === "0xdd62ed3e") return encodeAbiParameters([{ type: "uint256" }], [0n]);
  if (selector === "0x313ce567") return encodeAbiParameters([{ type: "uint8" }], [tokenDecimals.get(call.to.toLowerCase()) ?? 18]);
  if (selector === "0x95d89b41") return encodeAbiParameters([{ type: "string" }], ["WETH"]);
  if (selector === "0x06fdde03") return encodeAbiParameters([{ type: "string" }], ["Wrapped Ether"]);
  if (nativeQuoteOverride) {
    const overridden = await nativeQuoteOverride(call);
    if (overridden !== undefined) return overridden;
  }
  if (call.to.toLowerCase() === "0x61ffe014ba17989e743c5f6cb21bf9697530b21e") {
    return encodedV3Quote(call, 30000000n);
  }
  if (call.to.toLowerCase() === UNI_V2.toLowerCase()) {
    return encodeAbiParameters([{ type: "uint256[]" }], [[BigInt(AMOUNT), 29000000n]]);
  }
  if (call.to.toLowerCase() === VELO.toLowerCase()) {
    return encodeAbiParameters([{ type: "uint256[]" }], [[BigInt(AMOUNT), 31000000n]]);
  }
  if (call.to.toLowerCase() === ROUTER.toLowerCase()) {
    return encodeAbiParameters([{ type: "bool" }], [onchainAllowed]);
  }
  throw new Error(`Unexpected offline RPC fixture: ${call.to} ${selector}`);
}

const originalLoad = Module._load;
function emptyDbQuery(table, filters = {}) {
  return new Proxy({}, {
    get(_target, property) {
      if (property === "then") return (resolve) => resolve({ data: table === "dustsweep_routeability_cache" ? routeabilityRows.find((row) => Object.entries(filters).every(([key, value]) => row[key] === value) && Date.parse(row.expires_at) > Date.now()) ?? null : table === "tokens" ? whitelistRows : null, error: null });
      if (property === "eq") return (key, value) => emptyDbQuery(table, { ...filters, [key]: value });
      if (property === "upsert") return (row) => {
        if (table === "dustsweep_routeability_cache") {
          routeabilityWrites.push(row);
          const prior = routeabilityRows.findIndex((candidate) => ["chain_id", "token_in", "token_out", "amount_bucket"].every((key) => candidate[key] === row[key]));
          if (prior >= 0) routeabilityRows[prior] = row;
          else routeabilityRows.push(row);
        }
        return emptyDbQuery(table, filters);
      };
      return () => emptyDbQuery(table, filters);
    },
  });
}
Module._load = function (request, parent, ...rest) {
  if (parent?.filename.endsWith(`${path.sep}routes${path.sep}dustsweep.ts`)) {
    if (request === "../utils/chainRpc") return { ...rpc, chainRpcRequest: fixtureRpc, chainAlchemyRpcRequest: async (chainId, method, params) => {
      assert.equal(chainId, 10); assert.equal(method, "alchemy_getTokenBalances");
      discoveryAlchemyCalls += 1;
      if (discoveryAlchemyError) throw discoveryAlchemyError;
      if (discoveryAlchemyOverride) return discoveryAlchemyOverride(params);
      const options = params[2];
      const start = Number(options.pageKey ?? 0);
      const end = start + options.maxCount;
      return { tokenBalances: discoveryBalances.slice(start, end), ...(end < discoveryBalances.length ? { pageKey: String(end) } : {}) };
    } };
    if (request === "../utils/maintenance") return { isMaintenanceBlocking: async () => false };
    if (request === "../services/postgres") return { postgresDb: { from: emptyDbQuery } };
    if (request === "../services/pointsEngine") return { pointsEngine: { recordSweep: async (...args) => { recordedPoints.push(args); return 17; } } };
    if (request === "../services/questEngine") return { questEngine: { syncRecordedSweepProgress: async () => ({ completedQuests: [] }) } };
    if (request === "../services/sweepCampaign") return { sweepCampaignService: { enqueueCandidate: async () => { campaignIntakes += 1; } } };
  }
  return originalLoad.call(this, request, parent, ...rest);
};
const { dustsweepRoutes } = require("../src/routes/dustsweep.ts");
Module._load = originalLoad;

function v3Route() {
  return {
    tokenIn: WETH, amountIn: AMOUNT, amountOutMin: MIN_OUT,
    estimatedOut: "26000000", dex: 0, dexName: "Uniswap V3", priceImpactBps: 0,
    dexData: encodeAbiParameters([
      { type: "tuple", components: [{ name: "fee", type: "uint24" }, { name: "isMultiHop", type: "bool" }, { name: "path", type: "bytes" }] },
    ], [{ fee: 500, isMultiHop: false, path: "0x" }]),
  };
}

async function build(route = v3Route(), overrides = {}) {
  const response = await dustsweepRoutes.request("/build-tx", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chainId: 10, routes: [route], tokenOut: USDC, receiver: USER,
      deadline: Math.floor(Date.now() / 1000) + 1800, userAddress: USER,
      ...overrides,
    }),
  });
  return { status: response.status, body: await response.json() };
}

async function quote(overrides = {}) {
  const response = await dustsweepRoutes.request("/quote", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chainId: 10, tokenIns: [WETH], amounts: [AMOUNT], tokenOut: USDC, userAddress: USER, slippageBps: 50, ...overrides }),
  });
  return { status: response.status, body: await response.json() };
}

function packedV3Path(tokens, fees) {
  return `0x${tokens.map((token, index) => token.slice(2) + (index < fees.length ? fees[index].toString(16).padStart(6, "0") : "")).join("")}`;
}

function v3MultiRoute(tokens, fees = [500, 3000]) {
  return { ...v3Route(), tokenIn: tokens[0], dexData: encodeAbiParameters([
    { type: "tuple", components: [{ name: "fee", type: "uint24" }, { name: "isMultiHop", type: "bool" }, { name: "path", type: "bytes" }] },
  ], [{ fee: fees[0], isMultiHop: true, path: packedV3Path(tokens, fees) }]) };
}

function kyberSuccess(url, options, amountOut = "29000000") {
  if (!String(url).includes("aggregator-api.kyberswap.com")) return undefined;
  const target = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
  if (String(url).endsWith("/route/build")) {
    const body = JSON.parse(options.body);
    assert.equal(body.sender, ROUTER);
    assert.equal(body.recipient, ROUTER);
    return Response.json({ code: 0, data: { routerAddress: target, amountOut, data: "0x12345678", transactionValue: "0" } });
  }
  return Response.json({ code: 0, data: { routerAddress: target, routeSummary: { amountOut } } });
}

function lifiSuccess(url, _options, amountOut = "28000000") {
  if (!String(url).includes("li.quest")) return undefined;
  const params = new URL(url).searchParams;
  assert.equal(params.get("fromChain"), "10");
  assert.equal(params.get("toChain"), "10");
  assert.equal(params.get("fromAddress"), ROUTER);
  assert.equal(params.get("toAddress"), ROUTER);
  const target = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
  return Response.json({ action: { fromChainId: 10, toChainId: 10 }, estimate: { toAmount: amountOut, approvalAddress: target }, transactionRequest: { to: target, data: "0x12345678", value: "0", chainId: 10 } });
}

const missAllNativePools = () => { throw new RpcDeterministicError("execution reverted: missing pool"); };

function decodedV3Route(route) {
  return decodeAbiParameters([{ type: "tuple", components: [{ name: "fee", type: "uint24" }, { name: "isMultiHop", type: "bool" }, { name: "path", type: "bytes" }] }], route.dexData)[0];
}

test("Optimism stays disabled until both deployment flags are set", () => {
  assert.deepEqual(backend.getEnabledSweepChainIds(), [8453]);
  assert.deepEqual(frontend.getEnabledSweepChainIds(), [8453]);
  process.env.DUST_SWEEP_ENABLED_CHAIN_IDS = "8453,1,56,4663,42161,10";
  process.env.NEXT_PUBLIC_DUST_SWEEP_ENABLED_CHAINS = "8453,1,56,4663,42161,10";
  assert.equal(backend.isSweepChainEnabled(10), true);
  assert.equal(frontend.getEnabledSweepChains().some((chain) => chain.id === 10), true);
});

test("UI, backend and RPC agree on Optimism assets, route cap and router", () => {
  const api = backend.getSweepChainConfig(10);
  const ui = frontend.getSweepChain(10);
  assert.equal(api.slug, "optimism");
  assert.equal(ui.chain.id, 10);
  assert.equal(ui.chain.nativeCurrency.symbol, "ETH");
  assert.equal(api.weth.toLowerCase(), WETH.toLowerCase());
  assert.equal(ui.weth.toLowerCase(), api.weth.toLowerCase());
  assert.equal(ui.usdc.toLowerCase(), USDC.toLowerCase());
  assert.equal(api.usdc.toLowerCase(), ui.usdc.toLowerCase());
  assert.equal(api.usdcDecimals, 6);
  assert.equal(api.supportsLegacyLanes, false);
  assert.equal(api.supportsWethPassthrough, true);
  assert.equal(api.routeMaxCap, frontend.getSweepSelectLimit(10));
  assert.equal(ui.outputTokens[0].address.toLowerCase(), NATIVE.toLowerCase());
  assert.equal(ui.outputTokens.find((token) => token.address.toLowerCase() === USDC.toLowerCase()).decimals, 6);
  assert.equal(ui.paymasterEligible, false);
  assert.equal(backend.getChainRouterV3Address(api), frontend.getSweepRouterV3(10));
  assert.equal(rpc.getChainRpcSettings(10).chain.id, 10);
  assert.equal(rpc.getChainRpcSettings(10).alchemyHost, "opt-mainnet.g.alchemy.com");
  assert.equal(sources.getDustSweepV3AllowlistForChain(10).targets.some((address) => address.toLowerCase() === BASE_UNI_V3.toLowerCase()), false);
});

test("Uniswap V3 build pins OP router, exact approval and sweep recipient", async () => {
  process.env.DUST_SWEEP_V2_AUTH_MODE = "allowance";
  rpcCalls.length = 0;
  const { status, body } = await build();
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.routerAddress, ROUTER);
  assert.equal(body.callMode, "sweepV3Allowance");
  assert.equal(body.requiresSignature, false);
  assert.equal(body.approvalRequirements[0].required, AMOUNT);
  assert.equal(body.approvalRequirements[0].spender, ROUTER);
  assert.equal(body.routes[0].target.toLowerCase(), UNI_V3.toLowerCase());
  assert.equal(body.routes[0].spender.toLowerCase(), UNI_V3.toLowerCase());
  assert.equal(body.value, "0");
  const decoded = decodeFunctionData({ abi: sweepAbi, data: body.calldata });
  assert.equal(decoded.functionName, "sweep");
  assert.equal(decoded.args[2].recipient, USER);
  assert.equal(decoded.args[2].feeBpsOverride, 200);
  const swap = decodeFunctionData({ abi: v3Abi, data: body.routes[0].data }).args[0];
  assert.equal(swap.recipient, ROUTER, "swap output must return to sweep router for settlement");
  assert.equal(swap.tokenOut.toLowerCase(), USDC.toLowerCase());
  assert.equal(swap.amountIn, BigInt(AMOUNT));
  assert.equal(swap.amountOutMinimum, BigInt(MIN_OUT));
  assert.ok(rpcCalls.length >= 4);
});

test("Uniswap V2 builds OP calldata and refuses a foreign chain target", async () => {
  const route = { ...v3Route(), dex: 10, dexName: "Uniswap V2" };
  route.dexData = encodeAbiParameters([{ type: "address" }, { type: "address[]" }], [UNI_V2, [WETH, USDC]]);
  const { status, body } = await build(route);
  assert.equal(status, 200, JSON.stringify(body));
  const decoded = decodeFunctionData({ abi: v2Abi, data: body.routes[0].data });
  assert.equal(body.routes[0].target.toLowerCase(), UNI_V2.toLowerCase());
  assert.equal(decoded.args[3], ROUTER);
  assert.equal(decoded.args[0], BigInt(AMOUNT));
  route.dexData = encodeAbiParameters([{ type: "address" }, { type: "address[]" }], [BASE_UNI_V3, [WETH, USDC]]);
  const rejected = await build(route);
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /allowlist/i);
});

test("native ETH output uses WETH passthrough with no external swap", async () => {
  const route = { ...v3Route(), dex: 11, amountOutMin: AMOUNT, estimatedOut: AMOUNT, dexData: "0x" };
  const { status, body } = await build(route, { tokenOut: NATIVE });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.routes[0].target.toLowerCase(), WETH.toLowerCase());
  assert.equal(body.routes[0].data, "0x");
  const decoded = decodeFunctionData({ abi: sweepAbi, data: body.calldata });
  assert.equal(decoded.args[2].outputToken.toLowerCase(), NATIVE.toLowerCase());
  assert.equal(decoded.args[2].minAmountOut, BigInt(AMOUNT));
});

test("Velodrome rebuilds chain-specific calldata and rejects foreign factory/path data", async () => {
  const config = backend.getSweepChainConfig(10);
  const source = config.nativeSources.find((item) => item.kind === "solidly");
  assert.ok(source, "Optimism must quote its native Velodrome V2 venue");
  const hops = [{ from: WETH, to: USDC, stable: false, factory: source.factory }];
  const route = {
    ...v3Route(), dex: solidly.SOLIDLY_DEX_ID, dexName: "Velodrome V2",
    dexData: solidly.encodeSolidlyDexData(source.router, hops),
  };
  const { status, body } = await build(route);
  assert.equal(status, 200, JSON.stringify(body));
  const decoded = decodeFunctionData({ abi: solidly.SOLIDLY_ROUTER_ABI, data: body.routes[0].data });
  assert.equal(body.routes[0].target.toLowerCase(), source.router.toLowerCase());
  assert.equal(decoded.args[3], ROUTER);
  assert.equal(decoded.args[2][0].factory.toLowerCase(), source.factory.toLowerCase());
  assert.equal(decoded.args[1], BigInt(MIN_OUT));
  for (const invalidHops of [
    [{ ...hops[0], factory: BASE_UNI_V3 }],
    [{ ...hops[0], from: USER }],
    [{ ...hops[0], to: USER }],
    [{ ...hops[0], to: USER }, { ...hops[0], from: WETH }],
    [],
  ]) {
    route.dexData = solidly.encodeSolidlyDexData(source.router, invalidHops);
    const rejected = await build(route);
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.match(rejected.body.error, /Solidly/i);
  }
  route.dexData = solidly.encodeSolidlyDexData(BASE_UNI_V3, hops);
  const rejected = await build(route);
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /configured on this chain/i);
});

test("native quote compares OP venues and its winning Velodrome route builds successfully", async () => {
  const response = await dustsweepRoutes.request("/quote", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chainId: 10, tokenIns: [WETH], amounts: [AMOUNT], tokenOut: USDC, userAddress: USER, slippageBps: 50 }),
  });
  const quote = await response.json();
  assert.equal(response.status, 200, JSON.stringify(quote));
  assert.equal(quote.routes.length, 1);
  assert.equal(quote.routes[0].dex, solidly.SOLIDLY_DEX_ID);
  assert.equal(quote.routes[0].estimatedOut, "31000000");
  assert.equal(quote.routes[0].amountOutMin, "30845000");
  const built = await build(quote.routes[0], { deadline: quote.deadline, permit2Nonce: quote.permit2Nonce });
  assert.equal(built.status, 200, JSON.stringify(built.body));
  assert.equal(built.body.routes[0].target.toLowerCase(), VELO.toLowerCase());
});

test("Permit2 witness binds Optimism domain, exact amount, recipient and fee", async () => {
  process.env.DUST_SWEEP_V2_AUTH_MODE = "permit2";
  try {
    const { status, body } = await build(v3Route(), { permit2Nonce: "42" });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.requiresSignature, true);
    assert.equal(body.typedData.domain.chainId, 10);
    assert.equal(body.typedData.domain.verifyingContract.toLowerCase(), PERMIT2.toLowerCase());
    assert.equal(body.typedData.message.spender, ROUTER);
    assert.equal(body.witness.recipient, USER);
    assert.equal(body.witness.feeBps, 200);
    assert.equal(body.permit.permitted[0].amount, AMOUNT);
    const decoded = decodeFunctionData({ abi: sweepAbi, data: body.calldata });
    assert.equal(decoded.args[3].nonce, 42n);
    assert.equal(decoded.args[3].permitted[0].amount, BigInt(AMOUNT));
  } finally { process.env.DUST_SWEEP_V2_AUTH_MODE = "allowance"; }
});

test("build fails closed for missing on-chain allowlist or changed balances", async () => {
  onchainAllowed = false;
  try {
    const rejected = await build();
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /not configured on-chain/i);
  } finally { onchainAllowed = true; }
  balance = 0n;
  try {
    const rejected = await build();
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, "STALE_TOKEN_BALANCE");
  } finally { balance = BigInt(AMOUNT); }
});

test("valid two-hop paths build for every Optimism native venue", async () => {
  const v3 = await build(v3MultiRoute([WETH, DAI, USDC]));
  assert.equal(v3.status, 200, JSON.stringify(v3.body));
  const v3Swap = decodeFunctionData({ abi: v3Abi, data: v3.body.routes[0].data });
  assert.equal(v3Swap.functionName, "exactInput");
  assert.equal(v3Swap.args[0].path.toLowerCase(), packedV3Path([WETH, DAI, USDC], [500, 3000]).toLowerCase());
  assert.equal(v3Swap.args[0].recipient, ROUTER);

  const v2Route = { ...v3Route(), dex: 10, dexData: encodeAbiParameters([{ type: "address" }, { type: "address[]" }], [UNI_V2, [WETH, DAI, USDC]]) };
  const v2 = await build(v2Route);
  assert.equal(v2.status, 200, JSON.stringify(v2.body));
  assert.deepEqual(decodeFunctionData({ abi: v2Abi, data: v2.body.routes[0].data }).args[2].map((address) => address.toLowerCase()), [WETH, DAI, USDC].map((address) => address.toLowerCase()));

  const source = backend.getSweepChainConfig(10).nativeSources.find((item) => item.kind === "solidly");
  const hops = [{ from: WETH, to: DAI, stable: false, factory: source.factory }, { from: DAI, to: USDC, stable: true, factory: source.factory }];
  const velo = await build({ ...v3Route(), dex: solidly.SOLIDLY_DEX_ID, dexData: solidly.encodeSolidlyDexData(source.router, hops) });
  assert.equal(velo.status, 200, JSON.stringify(velo.body));
  const veloSwap = decodeFunctionData({ abi: solidly.SOLIDLY_ROUTER_ABI, data: velo.body.routes[0].data });
  assert.equal(veloSwap.args[2].length, 2);
  assert.equal(veloSwap.args[2][1].stable, true);
  assert.equal(veloSwap.args[3], ROUTER);
});

test("native paths reject wrong endpoints, duplicate tokens and unsupported V3 fees", async () => {
  for (const route of [
    v3MultiRoute([WETH, DAI, OP]),
    v3MultiRoute([WETH, WETH, USDC]),
    v3MultiRoute([WETH, DAI, USDC], [500, 123]),
    { ...v3Route(), dex: 10, dexData: encodeAbiParameters([{ type: "address" }, { type: "address[]" }], [UNI_V2, [WETH, OP]]) },
    { ...v3Route(), dex: 10, dexData: encodeAbiParameters([{ type: "address" }, { type: "address[]" }], [UNI_V2, [WETH, WETH, USDC]]) },
  ]) {
    const rejected = await build(route);
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.match(rejected.body.error, /path|fee tier/i);
  }
});

test("a multi-token quote becomes one sweep call with exact per-token approvals", async () => {
  const quoted = await quote({ tokenIns: [WETH, DAI, OP], amounts: [AMOUNT, AMOUNT, AMOUNT] });
  assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
  assert.equal(quoted.body.routes.length, 3);
  const built = await build(quoted.body.routes[0], { routes: quoted.body.routes, deadline: quoted.body.deadline });
  assert.equal(built.status, 200, JSON.stringify(built.body));
  assert.equal(built.body.approvalRequirements.length, 3);
  for (const approval of built.body.approvalRequirements) {
    assert.equal(approval.required, AMOUNT);
    assert.equal(approval.spender, ROUTER);
  }
  const decoded = decodeFunctionData({ abi: sweepAbi, data: built.body.calldata });
  assert.equal(decoded.functionName, "sweep");
  assert.equal(decoded.args[1].length, 3);
  assert.equal(decoded.args[2].recipient, USER);
  // The V3 contract refunds an individual failed DEX leg; its aggregate floor
  // must permit the other legs to settle instead of requiring the entire basket.
  assert.equal(decoded.args[2].minAmountOut, BigInt(quoted.body.routes[0].amountOutMin));
  assert.equal(built.body.value, "0");
});

test("a failing Velodrome venue preserves a healthy Uniswap quote", async () => {
  failedVenues.add(VELO.toLowerCase());
  try {
    // A fresh token avoids an earlier quote's route cache in this fixture.
    const quoted = await quote({ tokenIns: ["0x3333333333333333333333333333333333333333"] });
    assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
    assert.equal(quoted.body.routes.length, 1);
    assert.equal(quoted.body.routes[0].dex, 0);
    assert.equal(quoted.body.routes[0].estimatedOut, "30000000");
  } finally { failedVenues.clear(); }
});

test("native ETH batch combines WETH passthrough and a swap in one Permit2 witness", async () => {
  process.env.DUST_SWEEP_V2_AUTH_MODE = "permit2";
  try {
    const passthrough = { ...v3Route(), dex: 11, amountOutMin: AMOUNT, estimatedOut: AMOUNT, dexData: "0x" };
    const swap = { ...v3Route(), tokenIn: DAI, amountOutMin: "1000" };
    const built = await build(passthrough, { routes: [passthrough, swap], tokenOut: NATIVE, permit2Nonce: "0" });
    assert.equal(built.status, 200, JSON.stringify(built.body));
    assert.equal(built.body.permit.permitted.length, 2);
    assert.equal(built.body.approvalRequirements.length, 2);
    assert.ok(built.body.approvalRequirements.every((approval) => approval.spender.toLowerCase() === PERMIT2.toLowerCase()));
    const decoded = decodeFunctionData({ abi: sweepAbi, data: built.body.calldata });
    assert.equal(decoded.args[1].length, 2);
    assert.equal(decoded.args[1][0].data, "0x");
    assert.equal(decoded.args[2].outputToken.toLowerCase(), NATIVE.toLowerCase());
    assert.equal(decoded.args[3].nonce, 0n);
    const inner = decodeFunctionData({ abi: v3Abi, data: built.body.routes[1].data }).args[0];
    assert.equal(inner.tokenOut.toLowerCase(), WETH.toLowerCase());
    assert.equal(inner.recipient, ROUTER);
  } finally { process.env.DUST_SWEEP_V2_AUTH_MODE = "allowance"; }
});

test("duplicate inputs and forged passthrough legs fail before transaction assembly", async () => {
  const duplicateQuote = await quote({ tokenIns: [WETH, WETH.toLowerCase()], amounts: [AMOUNT, AMOUNT] });
  assert.equal(duplicateQuote.status, 400);
  assert.equal(duplicateQuote.body.code, "DUPLICATE_INPUT_TOKEN");
  const duplicateBuild = await build(v3Route(), { routes: [v3Route(), { ...v3Route(), tokenIn: WETH.toLowerCase() }] });
  assert.equal(duplicateBuild.status, 400);
  assert.equal(duplicateBuild.body.code, "DUPLICATE_INPUT_TOKEN");
  for (const [route, output] of [
    [{ ...v3Route(), dex: 11 }, USDC],
    [{ ...v3Route(), dex: 11, tokenIn: DAI }, NATIVE],
    [{ ...v3Route(), dex: 11, amountOutMin: (BigInt(AMOUNT) + 1n).toString() }, NATIVE],
  ]) {
    const rejected = await build(route, { tokenOut: output });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.code, "INVALID_PASSTHROUGH");
  }
});

test("slippage and fee normalization stay consistent between quote and calldata", async () => {
  const invalid = await quote({ slippageBps: "not-a-number" });
  assert.equal(invalid.status, 400);
  const fractional = await quote({ slippageBps: 50.5 });
  assert.equal(fractional.status, 200, JSON.stringify(fractional.body));
  assert.equal(fractional.body.routes[0].amountOutMin, "30841900");
  process.env.DUST_SWEEP_FEE_BPS_10 = "700.8";
  try {
    const quoted = await quote();
    assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
    assert.equal(quoted.body.feeBps, 300);
    assert.equal(quoted.body.protocolFeeAmount, "930000");
    const built = await build(quoted.body.routes[0]);
    assert.equal(built.status, 200, JSON.stringify(built.body));
    assert.equal(decodeFunctionData({ abi: sweepAbi, data: built.body.calldata }).args[2].feeBpsOverride, quoted.body.feeBps);
  } finally { process.env.DUST_SWEEP_FEE_BPS_10 = "200"; }
});

test("invalid deadline, receiver and Permit2 nonce produce client errors", async () => {
  for (const overrides of [{ deadline: 1.5 }, { receiver: "0x0000000000000000000000000000000000000000" }]) {
    assert.equal((await build(v3Route(), overrides)).status, 400);
  }
  assert.equal((await build(v3Route(), { deadline: 1 })).status, 409);
  process.env.DUST_SWEEP_V2_AUTH_MODE = "permit2";
  try {
    for (const permit2Nonce of ["-1", "bad", (1n << 256n).toString()]) {
      const rejected = await build(v3Route(), { permit2Nonce });
      assert.equal(rejected.status, 400);
      assert.match(rejected.body.error, /nonce/i);
    }
  } finally { process.env.DUST_SWEEP_V2_AUTH_MODE = "allowance"; }
});

test("aggregator build honors provider flags and the global kill switch", async () => {
  const target = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
  const route = { ...v3Route(), dex: 5, dexData: encodeAbiParameters([
    { type: "tuple", components: [{ name: "target", type: "address" }, { name: "spender", type: "address" }, { name: "data", type: "bytes" }] },
  ], [{ target, spender: target, data: "0x12345678" }]) };
  assert.equal((await build(route)).status, 400, "disabled Kyber must reject a previously quoted route");
  process.env.DUST_SWEEP_ENABLE_KYBER_10 = "true";
  try {
    const enabled = await build(route);
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    assert.equal(enabled.body.routes[0].target.toLowerCase(), target.toLowerCase());
    process.env.DUST_SWEEP_ENABLE_AGGREGATORS = "false";
    assert.equal((await build(route)).status, 400);
  } finally {
    delete process.env.DUST_SWEEP_ENABLE_AGGREGATORS;
    process.env.DUST_SWEEP_ENABLE_KYBER_10 = "false";
  }
});

test("recording forwards Optimism chain context to points and honors rewards opt-out", async () => {
  const request = async () => {
    const response = await dustsweepRoutes.request("/record-sweep", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chainId: 10, userAddress: USER, txHash: `0x${"ab".repeat(32)}`, tokensSwapped: 3, valueUSD: 90 }) });
    return { status: response.status, body: await response.json() };
  };
  recordedPoints.length = 0;
  const recorded = await request();
  assert.equal(recorded.status, 200);
  assert.equal(recorded.body.chainId, 10);
  assert.equal(recorded.body.questProgress.pointsAwarded, 17);
  assert.equal(recordedPoints.length, 1);
  assert.equal(recordedPoints[0][4], 10);
  assert.equal(campaignIntakes, 0, "receipt verifier for the Base campaign cannot verify an Optimism sweep");
  process.env.DUST_SWEEP_MULTICHAIN_REWARDS = "false";
  try {
    const disabled = await request();
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.rewardsEligible, false);
    assert.equal(recordedPoints.length, 1);
  } finally { delete process.env.DUST_SWEEP_MULTICHAIN_REWARDS; }
});

test("Optimism V3 compares all fee-pair hops even when a direct pool quotes", async () => {
  const token = "0x4444444444444444444444444444444444444444";
  const bestPath = packedV3Path([token, WETH, USDC], [100, 10000]);
  nativeQuoteOverride = (call) => {
    if (call.to.toLowerCase() !== "0x61ffe014ba17989e743c5f6cb21bf9697530b21e") return undefined;
    const decoded = decodeFunctionData({ abi: quoterAbi, data: call.data });
    return encodedV3Quote(call, decoded.functionName === "quoteExactInputSingle" ? 1000000n : decoded.args[0].toLowerCase() === bestPath.toLowerCase() ? 40000000n : 0n);
  };
  try {
    const quoted = await quote({ tokenIns: [token] });
    assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
    assert.equal(quoted.body.routes[0].estimatedOut, "40000000");
    assert.equal(decodedV3Route(quoted.body.routes[0]).path.toLowerCase(), bestPath.toLowerCase());
    const built = await build(quoted.body.routes[0]);
    assert.equal(built.status, 200, JSON.stringify(built.body));
  } finally { nativeQuoteOverride = null; }
});

test("WETH input can use a more liquid V3 route through USDC", async () => {
  nativeQuoteOverride = (call) => {
    if (call.to.toLowerCase() !== "0x61ffe014ba17989e743c5f6cb21bf9697530b21e") return undefined;
    const decoded = decodeFunctionData({ abi: quoterAbi, data: call.data });
    return encodedV3Quote(call, decoded.functionName === "quoteExactInputSingle" ? 1000000n : 40000000n);
  };
  try {
    const quoted = await quote({ tokenOut: OP });
    assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
    assert.equal(quoted.body.routes[0].dex, 0);
    const route = decodedV3Route(quoted.body.routes[0]);
    assert.equal(route.isMultiHop, true);
    assert.equal(route.path.slice(48, 88).toLowerCase(), USDC.slice(2).toLowerCase());
    assert.equal((await build(quoted.body.routes[0], { tokenOut: OP })).status, 200);
  } finally { nativeQuoteOverride = null; }
});

test("slow fee and venue probes cannot discard an already healthy native quote", async () => {
  const token = "0x4545454545454545454545454545454545454545";
  const requestedFees = new Set();
  nativeQuoteOverride = (call) => {
    if (call.to.toLowerCase() === VELO.toLowerCase()) return new Promise(() => {});
    if (call.to.toLowerCase() !== "0x61ffe014ba17989e743c5f6cb21bf9697530b21e") return undefined;
    const decoded = decodeFunctionData({ abi: quoterAbi, data: call.data });
    if (decoded.functionName === "quoteExactInputSingle") {
      requestedFees.add(decoded.args[0].fee);
      if (decoded.args[0].fee === 500) return new Promise(() => {});
    }
    return encodedV3Quote(call, 30000000n);
  };
  try {
    const quoted = await quote({ tokenIns: [token] });
    assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
    assert.equal(quoted.body.routes.length, 1);
    assert.equal(quoted.body.routes[0].estimatedOut, "30000000");
    assert.deepEqual([...requestedFees].sort((a, b) => a - b), [100, 500, 3000, 10000]);
  } finally { nativeQuoteOverride = null; }
});

test("discovery prioritizes real native liquidity after spam and unreadable balances", async () => {
  const tokens = ["0x7777777777777777777777777777777777777777", "0x8888888888888888888888888888888888888888", "0x9999999999999999999999999999999999999999"];
  const probedTokens = new Set();
  discoveryBalances = [
    ...Array.from({ length: 65 }, (_, index) => ({ contractAddress: `0x${(1000 + index).toString(16).padStart(40, "0")}`, tokenBalance: AMOUNT, metadata: { symbol: "SPAM", name: "Claim now reward.xyz", decimals: 18 } })),
    ...Array.from({ length: 65 }, (_, index) => {
      const address = `0x${(2000 + index).toString(16).padStart(40, "0")}`;
      const fallback = `${address.slice(0, 6)}...${address.slice(-4)}`;
      return { contractAddress: address, tokenBalance: AMOUNT, metadata: { symbol: fallback, name: fallback, decimals: 18 } };
    }),
    ...tokens.map((contractAddress, index) => ({ contractAddress, tokenBalance: AMOUNT, metadata: { symbol: `REAL${index}`, name: `Real Token ${index}`, decimals: 18 } })),
  ];
  nativeQuoteOverride = (call) => {
    if (call.to.toLowerCase() === UNI_V2.toLowerCase()) {
      const decoded = decodeFunctionData({ abi: v2Abi, data: call.data });
      probedTokens.add(decoded.args[1][0].toLowerCase());
      if (decoded.args[1][0].toLowerCase() === tokens[1].toLowerCase()) return encodeAbiParameters([{ type: "uint256[]" }], [[BigInt(AMOUNT), 10000000000000000n]]);
    } else if (call.to.toLowerCase() === VELO.toLowerCase()) {
      const decoded = decodeFunctionData({ abi: solidly.SOLIDLY_ROUTER_ABI, data: call.data });
      probedTokens.add(decoded.args[1][0].from.toLowerCase());
      if (decoded.args[1][0].from.toLowerCase() === tokens[0].toLowerCase()) return encodeAbiParameters([{ type: "uint256[]" }], [[BigInt(AMOUNT), 20000000000000000n]]);
    } else if (call.to.toLowerCase() === "0x61ffe014ba17989e743c5f6cb21bf9697530b21e") {
      const decoded = decodeFunctionData({ abi: quoterAbi, data: call.data });
      const tokenIn = decoded.functionName === "quoteExactInputSingle" ? decoded.args[0].tokenIn : decoded.args[0].slice(0, 42);
      probedTokens.add(tokenIn.toLowerCase());
      if (tokenIn.toLowerCase() === tokens[2].toLowerCase() && decoded.functionName === "quoteExactInput") return encodedV3Quote(call, 15000000000000000n);
    }
    throw new RpcDeterministicError("execution reverted: missing pool");
  };
  try {
    const response = await dustsweepRoutes.request(`/tokens?address=${USER}&chainId=10&refresh=1`);
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.discovery.onchainPriced, 3);
    assert.equal(result.discovery.onchainProbed, 60);
    assert.equal(result.discovery.alchemyPageCount, 2);
    assert.deepEqual(result.swappable.map((token) => token.address.toLowerCase()).sort(), tokens.map((token) => token.toLowerCase()).sort());
    assert.ok(result.swappable.every((token) => token.priceSource === "onchain" && token.priceUSD > 0));
    assert.deepEqual(new Set(result.swappable.map((token) => token.bestDex)), new Set(["UNISWAP_V2", "VELODROME_V2", "UNISWAP_V3"]));
    assert.equal(probedTokens.size, 60);
    assert.ok(tokens.every((token) => probedTokens.has(token.toLowerCase())), "readable real assets come before the unreadable flood within the budget");
    assert.ok(Array.from({ length: 65 }, (_, index) => `0x${(1000 + index).toString(16).padStart(40, "0")}`).every((token) => !probedTokens.has(token)), "obvious spam cannot consume the 60-token price probe budget");
  } finally { discoveryBalances = []; nativeQuoteOverride = null; }
});

test("poor native liquidity is rescued by executable aggregator quotes", async () => {
  nativeQuoteOverride = (call) => call.to.toLowerCase() === "0x61ffe014ba17989e743c5f6cb21bf9697530b21e" ? encodedV3Quote(call, 1000000n) : encodeAbiParameters([{ type: "uint256[]" }], [[BigInt(AMOUNT), 1000000n]]);
  fetchQuoteOverride = (url, options) => kyberSuccess(url, options);
  process.env.DUST_SWEEP_ENABLE_KYBER_10 = "true";
  try {
    const quoted = await quote();
    assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
    assert.equal(quoted.body.routes[0].dexName, "KyberSwap Aggregator");
    assert.equal(quoted.body.routes[0].estimatedOut, "29000000");
    assert.equal(quoted.body.routes[0].priceImpactBps, 333);
  } finally { nativeQuoteOverride = null; fetchQuoteOverride = null; process.env.DUST_SWEEP_ENABLE_KYBER_10 = "false"; }
});

test("an unavailable Kyber provider cannot prevent LI.FI fallback", async () => {
  nativeQuoteOverride = missAllNativePools;
  fetchQuoteOverride = (url, options) => {
    if (String(url).includes("kyberswap")) throw new DOMException("request timed out", "TimeoutError");
    return lifiSuccess(url, options);
  };
  process.env.DUST_SWEEP_ENABLE_KYBER_10 = "true";
  process.env.DUST_SWEEP_ENABLE_LIFI_10 = "true";
  try {
    const quoted = await quote({ tokenIns: ["0x5656565656565656565656565656565656565656"] });
    assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
    assert.equal(quoted.body.routes[0].dexName, "LI.FI Aggregator");
  } finally { nativeQuoteOverride = null; fetchQuoteOverride = null; process.env.DUST_SWEEP_ENABLE_KYBER_10 = "false"; process.env.DUST_SWEEP_ENABLE_LIFI_10 = "false"; }
});

test("provider outages never poison governor or routeability negative caches", async () => {
  nativeQuoteOverride = missAllNativePools;
  process.env.DUST_SWEEP_ENABLE_KYBER_10 = "true";
  try {
    for (const [index, failure] of [
      () => new Response("unavailable", { status: 503 }),
      () => new Response("forbidden", { status: 403 }),
      () => { throw new DOMException("request timed out", "TimeoutError"); },
      () => new Response("not-json", { status: 200 }),
    ].entries()) {
      const token = `0x${(6000 + index).toString(16).padStart(40, "0")}`;
      fetchQuoteOverride = (url) => String(url).includes("kyberswap") ? failure() : undefined;
      const first = await quote({ tokenIns: [token] });
      assert.equal(first.status, 400, JSON.stringify(first.body));
      assert.equal(first.body.code, "NO_SWAPPABLE_ROUTES");
      assert.equal(first.body.skippedTokens[0].reason, "QUOTE_FAILED");
      assert.equal(routeabilityWrites.some((row) => row.token_in === token && row.status === "NO_ROUTE"), false);
      fetchQuoteOverride = kyberSuccess;
      const recovered = await quote({ tokenIns: [token] });
      assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
      assert.equal(recovered.body.routes.length, 1, "same amount must retry immediately after provider recovery");
    }
  } finally { nativeQuoteOverride = null; fetchQuoteOverride = null; process.env.DUST_SWEEP_ENABLE_KYBER_10 = "false"; }
});

test("transient native RPC failures remain immediately retryable", async () => {
  const token = "0x6868686868686868686868686868686868686868";
  nativeQuoteOverride = () => { throw new Error("RPC transport unavailable"); };
  try {
    const failed = await quote({ tokenIns: [token] });
    assert.equal(failed.status, 400, JSON.stringify(failed.body));
    assert.equal(failed.body.skippedTokens[0].reason, "QUOTE_FAILED");
    assert.equal(routeabilityWrites.some((row) => row.token_in === token && row.status === "NO_ROUTE"), false);
    nativeQuoteOverride = null;
    const recovered = await quote({ tokenIns: [token] });
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(recovered.body.routes.length, 1);
  } finally { nativeQuoteOverride = null; }
});

test("changing the Optimism executor builds fresh aggregator recipient calldata", async () => {
  const alternateRouter = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
  const recipients = [];
  const target = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
  nativeQuoteOverride = missAllNativePools;
  process.env.DUST_SWEEP_ENABLE_KYBER_10 = "true";
  fetchQuoteOverride = (url, options) => {
    if (!String(url).includes("kyberswap")) return undefined;
    if (String(url).endsWith("/route/build")) {
      const body = JSON.parse(options.body);
      assert.equal(body.sender, body.recipient);
      recipients.push(body.recipient.toLowerCase());
      return Response.json({ code: 0, data: { routerAddress: target, amountOut: "29000000", data: `0x12345678${body.recipient.slice(2)}`, transactionValue: "0" } });
    }
    return Response.json({ code: 0, data: { routerAddress: target, routeSummary: { amountOut: "29000000" } } });
  };
  try {
    const request = { tokenIns: ["0x6969696969696969696969696969696969696969"] };
    const original = await quote(request);
    assert.equal(original.status, 200, JSON.stringify(original.body));
    process.env.DUST_SWEEP_ROUTER_V3_ADDRESS_10 = alternateRouter;
    const changed = await quote(request);
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.deepEqual(recipients, [ROUTER.toLowerCase(), alternateRouter.toLowerCase()]);
    assert.notEqual(original.body.routes[0].dexData, changed.body.routes[0].dexData);
  } finally {
    process.env.DUST_SWEEP_ROUTER_V3_ADDRESS_10 = ROUTER;
    process.env.DUST_SWEEP_ENABLE_KYBER_10 = "false";
    nativeQuoteOverride = null; fetchQuoteOverride = null;
  }
});

test("definitive no-route caches are exact-amount scoped on Optimism", async () => {
  const token = "0x6767676767676767676767676767676767676767";
  let providerRequests = 0;
  nativeQuoteOverride = missAllNativePools;
  process.env.DUST_SWEEP_ENABLE_KYBER_10 = "true";
  fetchQuoteOverride = (url) => {
    if (!String(url).includes("kyberswap")) return undefined;
    providerRequests += 1;
    return Response.json({ code: 4000, message: "No route found" });
  };
  try {
    const noRoute = await quote({ tokenIns: [token], amounts: ["1000"] });
    assert.equal(noRoute.status, 400, JSON.stringify(noRoute.body));
    assert.equal(noRoute.body.code, "NO_SWAPPABLE_ROUTES");
    assert.equal(noRoute.body.skippedTokens[0].reason, "NO_LIQUIDITY");
    assert.ok(routeabilityWrites.some((row) => row.token_in === token && row.amount_bucket === "v2:1000" && row.status === "NO_ROUTE"));
    fetchQuoteOverride = (url, options) => { if (String(url).includes("kyberswap")) providerRequests += 1; return kyberSuccess(url, options); };
    const cached = await quote({ tokenIns: [token], amounts: ["1000"] });
    assert.equal(cached.status, 400, JSON.stringify(cached.body));
    assert.equal(cached.body.code, "NO_SWAPPABLE_ROUTES");
    assert.equal(providerRequests, 1, "a real no-route answer remains short cached for the same amount");
    const changed = await quote({ tokenIns: [token], amounts: ["100000"] });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.routes.length, 1, "different exponent with the same leading digits must re-quote");
  } finally { nativeQuoteOverride = null; fetchQuoteOverride = null; process.env.DUST_SWEEP_ENABLE_KYBER_10 = "false"; }
});

test("governor shares retryable rate-limit outcome with all deduped callers", async () => {
  let fetches = 0;
  let skipped = 0;
  const failure = async () => { fetches += 1; await Promise.resolve(); governor.reportAggregatorHttpStatus("zerox", 429, 999); return null; };
  const calls = await Promise.all([
    governor.governAggregatorCall("zerox", "rate-limited", failure, () => { skipped += 1; }, 999),
    governor.governAggregatorCall("zerox", "rate-limited", failure, () => { skipped += 1; }, 999),
  ]);
  assert.deepEqual(calls, [null, null]);
  assert.equal(fetches, 1);
  assert.equal(skipped, 2);
});

test("governor drops queued work after real wait cap or caller deadline", async () => {
  const actualNow = Date.now;
  let now = actualNow();
  Date.now = () => now;
  try {
    for (const [chainId, waitMs, deadlineMs] of [[997, 9000, undefined], [998, 2000, 1000]]) {
      let release;
      let obsoleteFetches = 0;
      let skipped = 0;
      const first = governor.governAggregatorCall("lifi", "slow-first", () => new Promise((resolve) => { release = resolve; }), undefined, chainId);
      await new Promise((resolve) => setImmediate(resolve));
      const second = governor.governAggregatorCall("lifi", "queued-second", async () => { obsoleteFetches += 1; return "unexpected"; }, () => { skipped += 1; }, chainId, deadlineMs === undefined ? undefined : now + deadlineMs);
      now += waitMs;
      release("first-result");
      assert.equal(await first, "first-result");
      assert.equal(await second, null);
      assert.equal(obsoleteFetches, 0);
      assert.equal(skipped, 1);
      // A skipped request did not cache a negative, and deadline is scheduling policy,
      // not a different payload key. The same key may retry with a future deadline.
      const retried = await governor.governAggregatorCall("lifi", "queued-second", async () => "fresh-result", undefined, chainId, now + 5000);
      assert.equal(retried, "fresh-result");
    }
  } finally { Date.now = actualNow; }
});

test("unverified whitelist decimals cannot inflate an on-chain discovery price", async () => {
  const token = "0x7070707070707070707070707070707070707070";
  const actualNow = Date.now;
  const advancedNow = actualNow() + 300001;
  Date.now = () => advancedNow; // expire the earlier whitelist hint cache without waiting
  whitelistRows = [{ address: token, symbol: "SIX", name: "Six Decimal Token", decimals: 18, liquidity_usd: 0, source: "dexscreener:uniswap" }];
  discoveryBalances = [{ contractAddress: token, tokenBalance: "1000000" }];
  tokenDecimals.set(token, 6);
  nativeQuoteOverride = (call) => {
    if (call.to.toLowerCase() === "0x61ffe014ba17989e743c5f6cb21bf9697530b21e") return encodedV3Quote(call, 10000000000000000n);
    throw new RpcDeterministicError("execution reverted: missing pool");
  };
  try {
    const response = await dustsweepRoutes.request(`/tokens?address=${USER}&chainId=10&refresh=1`);
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.discovery.onchainPriced, 1);
    const asset = result.swappable.find((row) => row.address.toLowerCase() === token);
    assert.ok(asset, JSON.stringify(result));
    assert.equal(asset.decimals, 6);
    assert.equal(asset.balanceFormatted, "1");
    assert.equal(asset.priceUSD, 30, "0.01 ETH at $3000 prices one token at $30");
    assert.equal(asset.valueUSD, 30, "stale DB18 must not inflate actual6 unit value by 1e12");
  } finally {
    Date.now = actualNow; whitelistRows = []; discoveryBalances = [];
    tokenDecimals.delete(token); nativeQuoteOverride = null;
  }
});

test("positive subcent OP execution gas remains visible and warns for a smaller basket", async () => {
  nativeQuoteOverride = (call) => call.to.toLowerCase() === "0x61ffe014ba17989e743c5f6cb21bf9697530b21e"
    ? encodedV3Quote(call, 500n)
    : encodeAbiParameters([{ type: "uint256[]" }], [[BigInt(AMOUNT), 500n]]);
  try {
    const quoted = await quote({ tokenIns: ["0x7171717171717171717171717171717171717171"] });
    assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
    assert.equal(quoted.body.netEstimatedOut, "490"); // $0.00049 in six-decimal USDC
    assert.equal(quoted.body.gasEstimateETH, "0.00000030"); // 300k units * 1e6 wei
    assert.ok(Math.abs(quoted.body.gasEstimateUSD - 0.0009) < 1e-12);
    assert.ok(quoted.body.gasEstimateUSD > 0 && quoted.body.gasEstimateUSD < 0.01);
    assert.ok(Math.abs(quoted.body.gasToBasketRatio - (0.0009 / 0.00049)) < 0.00001);
    assert.ok(quoted.body.gasToBasketRatio > 1, "execution gas exceeds the actual net basket value");
  } finally { nativeQuoteOverride = null; }
});

test("public wallet discovery succeeds without touching an overdue Alchemy key", async () => {
  const before = discoveryAlchemyCalls;
  discoveryAlchemyError = new Error("Alchemy account overdue");
  fetchQuoteOverride = (url) => {
    if (String(url).includes("optimism.blockscout.com") && String(url).includes("token-balances")) {
      return Response.json([{ token: { address_hash: WETH, type: "ERC-20", symbol: "WETH", name: "Wrapped Ether", decimals: "18" }, value: AMOUNT }]);
    }
  };
  try {
    const response = await dustsweepRoutes.request("/tokens?address=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&chainId=10&refresh=1");
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.discovery.source, "blockscout");
    assert.equal(result.discovery.erc20BalanceCount, 1);
    assert.equal(discoveryAlchemyCalls, before);
  } finally { fetchQuoteOverride = null; discoveryAlchemyError = null; }
});

test("an empty public wallet is a complete result and does not invoke Alchemy", async () => {
  const before = discoveryAlchemyCalls;
  fetchQuoteOverride = (url) => String(url).includes("token-balances") ? Response.json([]) : undefined;
  try {
    const response = await dustsweepRoutes.request("/tokens?address=0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&chainId=10&refresh=1");
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.discovery.source, "blockscout");
    assert.equal(result.discovery.erc20BalanceCount, 0);
    assert.equal(discoveryAlchemyCalls, before);
  } finally { fetchQuoteOverride = null; }
});

test("malformed public discovery responses fall back to Alchemy instead of hiding balances", async () => {
  const before = discoveryAlchemyCalls;
  fetchQuoteOverride = (url) => String(url).includes("optimism.blockscout.com") ? Response.json({}) : undefined;
  try {
    const response = await dustsweepRoutes.request("/tokens?address=0xcccccccccccccccccccccccccccccccccccccccc&chainId=10&refresh=1");
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.discovery.source, "alchemy");
    assert.match(result.discovery.providerError, /blockscout/);
    assert.equal(discoveryAlchemyCalls, before + 1);
  } finally { fetchQuoteOverride = null; }
});

test("a capped public token scan uses Alchemy to preserve complete wallet discovery", async () => {
  const before = discoveryAlchemyCalls;
  fetchQuoteOverride = (url) => {
    const value = String(url);
    if (!value.includes("optimism.blockscout.com")) return undefined;
    if (value.includes("/tokens?")) return Response.json({ items: [], next_page_params: { token_contract_address_hash: WETH } });
    return new Response("unavailable", { status: 503 });
  };
  try {
    const response = await dustsweepRoutes.request("/tokens?address=0xabababababababababababababababababababab&chainId=10&refresh=1");
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.discovery.source, "alchemy");
    assert.equal(result.discovery.truncated, false);
    assert.match(result.discovery.providerError, /truncated/);
    assert.equal(discoveryAlchemyCalls, before + 1);
  } finally { fetchQuoteOverride = null; }
});

test("a hanging public indexer times out before invoking the Alchemy fallback", async () => {
  const before = discoveryAlchemyCalls;
  let startedPublicRequests = 0;
  fetchQuoteOverride = (url, options) => {
    if (!String(url).includes("optimism.blockscout.com")) return undefined;
    startedPublicRequests += 1;
    return new Promise((_resolve, reject) => {
      if (options.signal.aborted) reject(options.signal.reason);
      else options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  };
  const started = performance.now();
  // Real fetch sockets keep Node alive; this abort-only fixture needs an equivalent handle
  // because AbortSignal.timeout intentionally uses an unreferenced timer.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const response = await dustsweepRoutes.request("/tokens?address=0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd&chainId=10&refresh=1");
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.discovery.source, "alchemy");
    assert.equal(discoveryAlchemyCalls, before + 1);
    assert.equal(startedPublicRequests, 2, "deadline must stop pagination from starting after both snapshots time out");
    assert.ok(performance.now() - started < 4000, "one shared timeout bounds the whole public discovery attempt");
  } finally { clearInterval(keepAlive); fetchQuoteOverride = null; }
});

test("a completed public snapshot cancels the losing provider request", async () => {
  let cancelled = false;
  fetchQuoteOverride = (url, options) => {
    const value = String(url);
    if (!value.includes("optimism.blockscout.com")) return undefined;
    if (value.includes("token-balances")) return Response.json([]);
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        cancelled = true;
        reject(options.signal.reason);
      }, { once: true });
    });
  };
  try {
    const response = await dustsweepRoutes.request("/tokens?address=0x1212121212121212121212121212121212121212&chainId=10&refresh=1");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).discovery.source, "blockscout");
    assert.equal(cancelled, true, "the losing request must not keep using public capacity after discovery succeeds");
  } finally { fetchQuoteOverride = null; }
});

test("a snapshot carrying a pagination cursor cannot hide the remaining tokens", async () => {
  const before = discoveryAlchemyCalls;
  fetchQuoteOverride = (url) => {
    const value = String(url);
    if (!value.includes("optimism.blockscout.com")) return undefined;
    if (value.includes("token-balances")) return Response.json({ items: [], next_page_params: { cursor: "more" } });
    if (value.includes("/tokens?")) return Response.json({ items: [{ token: { address_hash: WETH, type: "ERC-20", symbol: "WETH", name: "Wrapped Ether", decimals: "18" }, value: AMOUNT }], next_page_params: null });
    return new Response("unavailable", { status: 503 });
  };
  try {
    const response = await dustsweepRoutes.request("/tokens?address=0x1313131313131313131313131313131313131313&chainId=10&refresh=1");
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.discovery.source, "blockscout");
    assert.equal(result.discovery.erc20BalanceCount, 1);
    assert.equal(result.discovery.truncated, false);
    assert.equal(discoveryAlchemyCalls, before);
  } finally { fetchQuoteOverride = null; }
});

test("a repeated Alchemy pagination cursor reports an incomplete scan", async () => {
  discoveryAlchemyOverride = () => ({ tokenBalances: [], pageKey: "stuck-cursor" });
  try {
    const response = await dustsweepRoutes.request("/tokens?address=0x1414141414141414141414141414141414141414&chainId=10&refresh=1");
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.discovery.source, "alchemy");
    assert.equal(result.discovery.truncated, true);
  } finally { discoveryAlchemyOverride = null; }
});

test("cycling Alchemy cursors stop without an unbounded discovery loop", async () => {
  let pages = 0;
  discoveryAlchemyOverride = (params) => {
    pages += 1;
    if (pages > 3) throw new Error("Discovery did not stop at a repeated cursor");
    return { tokenBalances: [], pageKey: params[2].pageKey === "one" ? "two" : "one" };
  };
  try {
    const response = await dustsweepRoutes.request("/tokens?address=0x1616161616161616161616161616161616161616&chainId=10&refresh=1");
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.discovery.truncated, true);
    assert.equal(pages, 3);
  } finally { discoveryAlchemyOverride = null; }
});

test("a malformed Alchemy result cannot become a successful empty wallet", async () => {
  const actualNow = Date.now;
  // Let this failure's cooldown expire before later cases without waiting in the suite.
  Date.now = () => actualNow() - 180_000;
  discoveryAlchemyOverride = () => ({});
  try {
    const response = await dustsweepRoutes.request("/tokens?address=0x1515151515151515151515151515151515151515&chainId=10&refresh=1");
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "BALANCE_DISCOVERY_UNAVAILABLE");
  } finally { Date.now = actualNow; discoveryAlchemyOverride = null; }
});

test("unavailable discovery reports failure and cools off the overdue Alchemy fallback", async () => {
  const before = discoveryAlchemyCalls;
  discoveryAlchemyError = new Error("Alchemy account overdue");
  try {
    for (const address of ["0xdddddddddddddddddddddddddddddddddddddddd", "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"]) {
      const response = await dustsweepRoutes.request(`/tokens?address=${address}&chainId=10&refresh=1`);
      const result = await response.json();
      assert.equal(response.status, 503, JSON.stringify(result));
      assert.ok(result.code, JSON.stringify(result));
    }
    assert.equal(discoveryAlchemyCalls, before + 1);
    // Public recovery still works immediately while the Alchemy breaker is open.
    fetchQuoteOverride = (url) => String(url).includes("token-balances") ? Response.json([]) : undefined;
    const response = await dustsweepRoutes.request("/tokens?address=0xffffffffffffffffffffffffffffffffffffffff&chainId=10&refresh=1");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).discovery.source, "blockscout");
    assert.equal(discoveryAlchemyCalls, before + 1);
  } finally { discoveryAlchemyError = null; fetchQuoteOverride = null; }
});

test("Optimism flag removal immediately rejects builds", async () => {
  process.env.DUST_SWEEP_ENABLED_CHAIN_IDS = "8453";
  const rejected = await build();
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.code, "CHAIN_NOT_ENABLED");
});
