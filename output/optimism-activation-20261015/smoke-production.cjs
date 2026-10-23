// Public production read-only smoke. No .env loading, mocks, keys, signing or broadcasts.
// Run only after the new Railway deployment is healthy:
//   node output/optimism-activation-20261015/smoke-production.cjs
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const apiRoot = path.resolve(__dirname, '../../apps/api');
const { parseAbi, encodeFunctionData, decodeFunctionResult, decodeFunctionData, erc20Abi, keccak256 } =
  require(require.resolve('viem', { paths: [apiRoot] }));

const API = 'https://dustswap-production.up.railway.app';
const RPC = 'https://mainnet.optimism.io';
const OWNER = '0xF113b1dBd848F44684f8543CcDf63C90f9535F57';
const ROUTER = '0x54C177426033d50686bA7D36B690d1a2d7E34625';
const COLLECTOR = '0xE09495e955794708D4bC28045C46891cAf643733';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const routerReadAbi = parseAbi(['function owner() view returns(address)', 'function feeCollector() view returns(address)', 'function feeBps() view returns(uint16)']);
const sweepAbi = parseAbi(['function sweep(uint8 mode,(address tokenIn,uint256 amountIn,address target,address spender,uint256 value,bytes data)[] routes,(address outputToken,address recipient,uint256 minAmountOut,uint256 deadline,uint16 feeBpsOverride) params,((address token,uint256 amount)[] permitted,uint256 nonce,uint256 deadline) permit,bytes signature) returns(uint256,uint256,uint256)']);
const startedAt = new Date().toISOString();
const reportPath = path.join(__dirname, `production-smoke-${startedAt.replace(/[:.]/g, '-')}.json`);
const report = {
  startedAt, api: API, chainId: 10, expectedRouter: ROUTER, expectedCollector: COLLECTOR,
  scope: 'Actual public production HTTP health/discovery/quote/build endpoints and public RPC reads. Production auth mode is preserved. Liquidity pool is a balance holder for metadata checks, not a wallet execution claim. No private keys, signing, transactions, reward recording or admin endpoints.',
  checks: [], cases: [],
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const log = (event, fields = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
const save = () => { report.updatedAt = new Date().toISOString(); fs.writeFileSync(reportPath, JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n'); };
const safeMessage = value => String(value || '').replace(/https?:\/\/\S+/g, '[url omitted]').replace(/0x[0-9a-fA-F]{64,}/g, '[hex omitted]').slice(0, 400);
let requestId = 0;

async function request(url, options = {}, timeoutMs = 60_000) {
  assert(timeoutMs <= 60_000);
  const start = Date.now();
  log('request-start', { method: options.method || 'GET', path: new URL(url).pathname });
  const response = await fetch(url, {
    ...options, signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { message: 'Non-JSON response' }; }
  const result = { status: response.status, body, elapsedMs: Date.now() - start };
  log('request-finished', { path: new URL(url).pathname, status: result.status, elapsedMs: result.elapsedMs });
  return result;
}

async function rpc(method, params) {
  const response = await request(RPC, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }) }, 15_000);
  assert.equal(response.status, 200, `Public RPC HTTP ${response.status}`);
  assert(!response.body.error, safeMessage(response.body.error?.message));
  assert(response.body.result !== undefined, 'RPC result missing');
  return response.body.result;
}

async function read(to, abi, functionName, args = []) {
  const data = encodeFunctionData({ abi, functionName, args });
  return decodeFunctionResult({ abi, functionName, data: await rpc('eth_call', [{ to, data }, 'latest']) });
}

async function apiPost(endpoint, body) {
  await pause(600);
  return request(API + endpoint, { method: 'POST', body: JSON.stringify(body) });
}

function responseError(response) {
  return { httpStatus: response.status, code: response.body?.code, message: safeMessage(response.body?.error || response.body?.message), elapsedMs: response.elapsedMs };
}

function quoteSummary(response) {
  const b = response.body;
  return { httpStatus: response.status, elapsedMs: response.elapsedMs, chainId: b.chainId, feeBps: b.feeBps,
    routeMaxCap: b.routeMaxCap, executionLane: b.executionLane, deadline: b.deadline, permit2Nonce: b.permit2Nonce,
    totalEstimatedOut: b.totalEstimatedOut, netEstimatedOut: b.netEstimatedOut, minAmountOut: b.minAmountOut,
    gasEstimateETH: b.gasEstimateETH, gasEstimateUSD: b.gasEstimateUSD,
    routes: (b.routes || []).map(r => ({ tokenIn: r.tokenIn, amountIn: r.amountIn, amountOutMin: r.amountOutMin, dex: r.dex, dexName: r.dexName })),
    skippedTokens: (b.skippedTokens || []).map(r => ({ token: r.token, reason: r.reason })),
    ...(response.status !== 200 ? { error: responseError(response) } : {}) };
}

async function runCase(name, holder, tokenIns, amounts, output) {
  const result = { name, tokenIns, amounts, output, passed: false };
  report.cases.push(result); save(); log('case-start', { name });
  try {
    const quoted = await apiPost('/api/dustsweep/quote', { chainId: 10, tokenIns, amounts, tokenOut: output, userAddress: holder, slippageBps: 100 });
    result.quote = quoteSummary(quoted); save();
    assert.equal(quoted.status, 200, `Quote HTTP ${quoted.status}: ${safeMessage(quoted.body.code || quoted.body.error || quoted.body.message)}`);
    assert.equal(quoted.body.chainId, 10);
    assert.equal(quoted.body.feeBps, 200);
    assert.equal(quoted.body.routeMaxCap, 10);
    assert.equal(quoted.body.routes.length, tokenIns.length, 'Every representative input should receive a route');
    for (const [i, token] of tokenIns.entries()) {
      const route = quoted.body.routes.find(r => same(r.tokenIn, token));
      assert(route && BigInt(route.amountIn) === BigInt(amounts[i]), 'Quote input or amount mismatch');
    }
    const built = await apiPost('/api/dustsweep/build-tx', {
      chainId: 10, routes: quoted.body.routes, tokenOut: output, receiver: holder, userAddress: holder,
      deadline: quoted.body.deadline, permit2Nonce: quoted.body.permit2Nonce,
    });
    result.build = { ...responseError(built), routerAddress: built.body.routerAddress, contractAddress: built.body.contractAddress,
      requiresSignature: built.body.requiresSignature, signatureMode: built.body.signatureMode, callMode: built.body.callMode,
      routeCount: built.body.routes?.length, minAmountOut: built.body.minAmountOut,
      skippedTokens: (built.body.skippedTokens || []).map(r => ({ token: r.token, reason: r.reason })) };
    save();
    assert.equal(built.status, 200, `Build HTTP ${built.status}: ${safeMessage(built.body.code || built.body.error || built.body.message)}`);
    assert(same(built.body.routerAddress, ROUTER));
    assert(same(built.body.contractAddress, ROUTER));
    assert.equal(built.body.value, '0');
    const decoded = decodeFunctionData({ abi: sweepAbi, data: built.body.calldata });
    const [mode, routes, params, permit, signature] = decoded.args;
    assert.equal(decoded.functionName, 'sweep');
    assert.equal(routes.length, quoted.body.routes.length, 'Build may not silently drop a representative input');
    assert(same(params.outputToken, output));
    assert(same(params.recipient, holder));
    assert.equal(params.feeBpsOverride, 200);
    assert.equal(params.deadline, BigInt(quoted.body.deadline));
    assert.equal(params.minAmountOut, BigInt(built.body.minAmountOut));
    assert(params.minAmountOut > 0n);
    for (const route of routes) {
      assert.equal(route.value, 0n);
      const original = quoted.body.routes.find(r => same(r.tokenIn, route.tokenIn));
      assert(original && BigInt(original.amountIn) === route.amountIn);
    }
    const authMode = built.body.requiresSignature ? 'permit2' : 'allowance';
    if (authMode === 'permit2') {
      assert.equal(mode, 0);
      assert.equal(built.body.signatureMode, 'permit2_witness');
      assert.equal(Number(built.body.typedData.domain.chainId), 10);
      assert(same(built.body.typedData.domain.verifyingContract, PERMIT2));
      assert(same(built.body.typedData.message.spender, ROUTER));
      assert.equal(Number(built.body.witness.feeBps), 200);
      assert.equal(permit.nonce, BigInt(quoted.body.permit2Nonce));
      assert.equal(signature, '0x', 'Smoke never supplies a signature');
    } else {
      assert.equal(mode, 1);
      assert.equal(built.body.signatureMode, 'none');
    }
    if (report.productionAuthMode) assert.equal(authMode, report.productionAuthMode, 'Production auth mode changed between cases');
    report.productionAuthMode = authMode;
    result.build.decoded = { mode, outputToken: params.outputToken, recipient: params.recipient, feeBpsOverride: params.feeBpsOverride,
      minAmountOut: params.minAmountOut.toString(), deadline: params.deadline.toString(),
      routes: routes.map(r => ({ tokenIn: r.tokenIn, amountIn: r.amountIn.toString(), target: r.target, spender: r.spender, value: r.value.toString() })) };
    result.build.calldataBytes = (built.body.calldata.length - 2) / 2;
    result.build.calldataHash = keccak256(built.body.calldata);
    result.passed = true;
    log('case-passed', { name, authMode, routes: routes.length, venues: result.quote.routes.map(r => r.dexName) });
  } catch (error) {
    result.error = safeMessage(error.message);
    log('case-failed', { name, error: result.error });
  }
  save();
}

(async () => {
  save(); log('smoke-start', { api: API, reportPath });
  const health = await request(API + '/health');
  report.checks.push({ name: 'production health', httpStatus: health.status, status: health.body.status, service: health.body.service, elapsedMs: health.elapsedMs }); save();
  assert.equal(health.status, 200); assert.equal(health.body.status, 'ok');
  const discovered = await request(API + `/api/dustsweep/tokens?address=${OWNER}&chainId=10`);
  report.checks.push({ name: 'OP owner discovery', httpStatus: discovered.status, chainId: discovered.body.chainId,
    source: discovered.body.discovery?.source, erc20BalanceCount: discovered.body.discovery?.erc20BalanceCount,
    truncated: discovered.body.discovery?.truncated, stale: discovered.body.stale,
    swappableCount: discovered.body.swappable?.length, unavailableCount: discovered.body.unavailable?.length,
    hiddenCount: discovered.body.hidden?.length, suspiciousCount: discovered.body.suspicious?.length,
    providerWarning: safeMessage(discovered.body.discovery?.providerError), elapsedMs: discovered.elapsedMs,
    ...(discovered.status !== 200 ? { error: responseError(discovered) } : {}) }); save();
  assert.equal(discovered.status, 200, `OP discovery HTTP ${discovered.status}: ${safeMessage(discovered.body.code || discovered.body.error || discovered.body.message)}`);
  assert.equal(discovered.body.chainId, 10); assert(Array.isArray(discovered.body.swappable));
  // Empty request exits before RPC/discovery. Validation success proves Base was not disabled.
  const baseGate = await apiPost('/api/dustsweep/quote', { chainId: 8453, tokenIns: [], amounts: [], tokenOut: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', userAddress: OWNER });
  report.checks.push({ name: 'Base lightweight enabled-gate check', ...responseError(baseGate), expectedValidationFailure: true }); save();
  assert.equal(baseGate.status, 400); assert.notEqual(baseGate.body.code, 'CHAIN_NOT_ENABLED');
  assert.equal(BigInt(await rpc('eth_chainId', [])), 10n);
  report.rpcBlock = Number(BigInt(await rpc('eth_blockNumber', [])));
  assert(same(await read(ROUTER, routerReadAbi, 'owner'), OWNER));
  assert(same(await read(ROUTER, routerReadAbi, 'feeCollector'), COLLECTOR));
  assert.equal(await read(ROUTER, routerReadAbi, 'feeBps'), 200);
  const holder = await read(FACTORY, factoryAbi, 'getPool', [WETH, USDC, 500]);
  assert(!same(holder, '0x0000000000000000000000000000000000000000'));
  const wethBalance = await read(WETH, erc20Abi, 'balanceOf', [holder]);
  const usdcBalance = await read(USDC, erc20Abi, 'balanceOf', [holder]);
  const wethAmount = (wethBalance > 1000000000000000n ? 1000000000000000n : wethBalance / 100n).toString();
  const usdcAmount = (usdcBalance > 1000000n ? 1000000n : usdcBalance / 100n).toString();
  assert(BigInt(wethAmount) > 0n && BigInt(usdcAmount) > 0n);
  report.publicBalanceHolder = { address: holder, WETH: wethBalance.toString(), USDC: usdcBalance.toString(), requestedWethAmount: wethAmount, requestedUsdcAmount: usdcAmount }; save();
  log('public-holder-ready', { address: holder, wethAmount, usdcAmount });
  await runCase('WETH to native USDC', holder, [WETH], [wethAmount], USDC);
  await runCase('Native USDC to WETH', holder, [USDC], [usdcAmount], WETH);
  await runCase('Native USDC plus WETH to native ETH', holder, [USDC, WETH], [usdcAmount, wethAmount], NATIVE);
  await runCase('WETH passthrough to native ETH', holder, [WETH], [wethAmount], NATIVE);
  report.passed = report.cases.length === 4 && report.cases.every(item => item.passed);
  save(); log('smoke-finished', { passed: report.passed, passedCases: report.cases.filter(item => item.passed).length, totalCases: report.cases.length, reportPath });
  if (!report.passed) process.exitCode = 1;
})().catch(error => {
  report.passed = false; report.error = safeMessage(error.message); save();
  log('smoke-failed', { error: report.error, reportPath }); process.exitCode = 1;
});
