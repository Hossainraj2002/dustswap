// Read-only post-deployment API smoke. No .env loading, keys, signing or broadcasting.
// The only mock is database access; RPC, prices and quote providers use public endpoints.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const assert = require("node:assert/strict");
const apiRoot = path.resolve(__dirname, "../../apps/api");
for (const key of Object.keys(process.env)) {
  if (/^(DUST_SWEEP_|ALCHEMY_|BLOCKSCOUT_|OPTIMISM_RPC_|NEXT_PUBLIC_|DATABASE_|DATABASE$|MAINTENANCE_|PRIVATE_KEY|DEPLOYER_)/.test(key) || /(?:API_KEYS?|SECRET|MNEMONIC|PRIVATE_KEY)$/.test(key)) delete process.env[key];
}
Object.assign(process.env, {
  NODE_ENV: "test", DUST_SWEEP_ENABLED_CHAIN_IDS: "10",
  DUST_SWEEP_ROUTER_V3_ADDRESS_10: "0x54c177426033d50686ba7d36b690d1a2d7e34625",
  DUST_SWEEP_FEE_BPS_10: "200", DUST_SWEEP_ENABLE_AGGREGATORS: "true",
  DUST_SWEEP_ENABLE_KYBER_10: "true", DUST_SWEEP_ENABLE_LIFI_10: "true",
  // This holder is a liquidity pool, not a wallet being approved. Test build metadata only.
  DUST_SWEEP_PREFLIGHT_TRANSFER_PROBE: "false",
});
require(require.resolve("ts-node", { paths: [apiRoot] })).register({
  project: path.join(apiRoot, "tsconfig.json"), transpileOnly: true,
  compilerOptions: { module: "CommonJS", moduleResolution: "Node" },
});
const { parseAbi, encodeFunctionData, decodeFunctionResult, decodeFunctionData, erc20Abi } = require(require.resolve("viem", { paths: [apiRoot] }));
const report = { timestamp: new Date().toISOString(), chainId: 10, router: process.env.DUST_SWEEP_ROUTER_V3_ADDRESS_10,
  scope: "Real Hono /quote and /build-tx with public live RPC/price/quote endpoints; database-only mock; public liquidity-pool balance holder; no signing or broadcast; transfer probe process-disabled; no production activation", results: [], interceptedDatabaseWrites: 0 };
const reportPath = path.join(__dirname, "api-runtime-report.json");
const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2));
const timeout = setTimeout(() => { report.error = "Harness exceeded 120 seconds"; save(); process.exit(1); }, 120000);
timeout.unref();
const emptyQuery = () => new Proxy({}, { get(_target, property) {
  if (property === "then") return (resolve) => resolve({ data: null, error: null, count: 0 });
  if (["upsert", "insert", "update", "delete"].includes(property)) return () => { report.interceptedDatabaseWrites += 1; return emptyQuery(); };
  return () => emptyQuery();
} });
const postgresPath = path.join(apiRoot, "src/services/postgres.ts");
const dbPath = path.join(apiRoot, "src/lib/db.ts");
const originalLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  let resolved;
  try { resolved = Module._resolveFilename(request, parent); } catch {}
  if (resolved === postgresPath) return { postgresDb: { from: emptyQuery } };
  if (resolved === dbPath) return { dbQuery: async () => ({ rows: [], rowCount: 0 }) };
  return originalLoad.call(this, request, parent, ...rest);
};
const { dustsweepRoutes } = require(path.join(apiRoot, "src/routes/dustsweep.ts"));
Module._load = originalLoad;
const { chainRpcRequest } = require(path.join(apiRoot, "src/utils/chainRpc.ts"));
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const sweepAbi = parseAbi(["function sweep(uint8 mode,(address tokenIn,uint256 amountIn,address target,address spender,uint256 value,bytes data)[] routes,(address outputToken,address recipient,uint256 minAmountOut,uint256 deadline,uint16 feeBpsOverride) params,((address token,uint256 amount)[] permitted,uint256 nonce,uint256 deadline) permit,bytes signature) returns (uint256,uint256,uint256)"]);
async function read(to, abi, functionName, args = []) {
  const data = encodeFunctionData({ abi, functionName, args });
  const raw = await chainRpcRequest(10, "eth_call", [{ to, data }, "latest"], { timeoutMs: 8000 });
  return decodeFunctionResult({ abi, functionName, data: raw });
}
async function post(endpoint, body) {
  const response = await dustsweepRoutes.request(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function runCase(name, holder, tokenIns, amounts, output, mode) {
  process.env.DUST_SWEEP_V2_AUTH_MODE = mode;
  const started = Date.now();
  const quoted = await post("/quote", { chainId: 10, tokenIns, amounts, tokenOut: output, userAddress: holder, slippageBps: 100 });
  const result = { name, elapsedMs: 0, quote: quoted };
  report.results.push(result); save();
  assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
  assert.equal(quoted.body.feeBps, 200);
  assert.ok(quoted.body.routes.length > 0);
  const built = await post("/build-tx", { chainId: 10, routes: quoted.body.routes, tokenOut: output, receiver: holder, userAddress: holder,
    deadline: quoted.body.deadline, permit2Nonce: quoted.body.permit2Nonce });
  result.build = built;
  assert.equal(built.status, 200, JSON.stringify(built.body));
  assert.equal(built.body.routerAddress.toLowerCase(), report.router.toLowerCase());
  assert.equal(built.body.value, "0");
  const decoded = decodeFunctionData({ abi: sweepAbi, data: built.body.calldata });
  assert.equal(decoded.functionName, "sweep");
  assert.equal(decoded.args[1].length, quoted.body.routes.length);
  assert.equal(decoded.args[2].outputToken.toLowerCase(), output.toLowerCase());
  assert.equal(decoded.args[2].recipient.toLowerCase(), holder.toLowerCase());
  assert.equal(decoded.args[2].feeBpsOverride, 200);
  if (mode === "permit2") {
    assert.equal(built.body.typedData.domain.chainId, 10);
    assert.equal(built.body.typedData.domain.verifyingContract.toLowerCase(), PERMIT2.toLowerCase());
    assert.equal(built.body.typedData.message.spender.toLowerCase(), report.router.toLowerCase());
    assert.equal(built.body.witness.feeBps, 200);
    assert.equal(decoded.args[0], 0);
  } else assert.equal(decoded.args[0], 1);
  result.elapsedMs = Date.now() - started;
  result.passed = true; save();
  console.log(JSON.stringify({ name, passed: true, routes: built.body.routes.length, venues: quoted.body.routes.map((route) => route.dexName), elapsedMs: result.elapsedMs }));
}
(async () => {
  const chainId = await chainRpcRequest(10, "eth_chainId", [], { timeoutMs: 8000 });
  assert.equal(BigInt(chainId), 10n);
  report.blockNumber = Number(BigInt(await chainRpcRequest(10, "eth_blockNumber", [], { timeoutMs: 8000 })));
  const holder = await read(FACTORY, factoryAbi, "getPool", [WETH, USDC, 500]);
  assert.notEqual(holder.toLowerCase(), "0x0000000000000000000000000000000000000000");
  report.balanceHolder = holder;
  const [wethBalance, usdcBalance] = await Promise.all([read(WETH, erc20Abi, "balanceOf", [holder]), read(USDC, erc20Abi, "balanceOf", [holder])]);
  report.holderBalances = { WETH: wethBalance.toString(), USDC: usdcBalance.toString() };
  const wethAmount = (wethBalance > 1000000000000000n ? 1000000000000000n : wethBalance / 100n).toString();
  const usdcAmount = (usdcBalance > 1000000n ? 1000000n : usdcBalance / 100n).toString();
  assert.ok(BigInt(wethAmount) > 0n && BigInt(usdcAmount) > 0n); save();
  console.log(JSON.stringify({ blockNumber: report.blockNumber, balanceHolder: holder, wethAmount, usdcAmount }));
  await runCase("WETH to native USDC allowance", holder, [WETH], [wethAmount], USDC, "allowance");
  await runCase("USDC to WETH allowance", holder, [USDC], [usdcAmount], WETH, "allowance");
  await runCase("USDC plus WETH to native ETH allowance", holder, [USDC, WETH], [usdcAmount, wethAmount], NATIVE, "allowance");
  await runCase("USDC plus WETH to native ETH Permit2 metadata", holder, [USDC, WETH], [usdcAmount, wethAmount], NATIVE, "permit2");
  report.passed = true; save(); clearTimeout(timeout); console.log("Public API smoke passed; no transaction submitted.");
})().catch((error) => { report.error = error.message; report.passed = false; save(); clearTimeout(timeout); console.error(error.message); process.exitCode = 1; });
