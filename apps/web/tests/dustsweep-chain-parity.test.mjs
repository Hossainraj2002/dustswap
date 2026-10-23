import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { concatHex } from "viem";
import {
  buildWalletSendCallsPayload,
  requestWalletSendCalls,
} from "../src/lib/dustsweep-wallet-rpc.ts";

const sourceText = readFileSync(new URL("../src/hooks/useDustSweep.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("useDustSweep.ts", sourceText, ts.ScriptTarget.Latest, true);
const ACCOUNT = "0x0000000000000000000000000000000000000001";
const TOKEN = "0x4200000000000000000000000000000000000006";
const ROUTER = "0x0000000000000000000000000000000000000002";
const HASH = `0x${"ab".repeat(32)}`;
const SUFFIX = "0x80218021";
const CHAIN = { base: { id: 8453 }, optimism: { id: 10 } };
const calls = [
  { to: TOKEN, data: `0x095ea7b3${"00".repeat(64)}`, value: 0n },
  { to: ROUTER, data: "0x12345678", dataSuffix: SUFFIX, value: 0n },
];

function findNode(predicate) {
  let match;
  function visit(node) {
    if (predicate(node)) match = node;
    if (!match) ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(match, "Actual hook binding must exist");
  return match;
}

const helpers = [
  "isTxHash", "getLatestCallsStatusTxHash", "getSendCallsResultTxHash",
  "resolveSendCallsId", "hasFailedCallsReceipt", "getCallsStatusState", "chunkWalletCalls",
  "toRpcQuantity", "appendDataSuffix", "normalizeWalletSendCall",
  "mergeUnavailableTokens", "safeBigInt", "sumRouteField", "recomputeQuoteForRoutes",
].map((name) => findNode((node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(source)).join("\n");
const skipReasons = findNode((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "DEFINITIVE_SKIP_REASONS");

// Evaluate the actual hook callback AND its dependency array. This reproduces
// React's useCallback identity behavior without replacing the wallet callback
// with a test implementation or adding a browser-renderer dependency.
function createRenderer(name) {
  const declaration = findNode((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === name);
  const js = ts.transpileModule(`${helpers}\nconst ${skipReasons.getText(source)};\nconst callback = ${declaration.initializer.getText(source)}; callback;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  let previous;
  const useCallback = (callback, dependencies) => {
    if (!previous || dependencies.some((dependency, index) => !Object.is(dependency, previous.dependencies[index]))) {
      previous = { callback, dependencies };
    }
    return previous.callback;
  };
  return (context) => vm.runInNewContext(js, {
    useCallback,
    concatHex,
    DATA_SUFFIX: SUFFIX,
    buildWalletSendCallsPayload,
    requestWalletSendCalls,
    buildSendCallsCapabilities: () => undefined,
    console: { info() {}, warn() {} },
    ...context,
  });
}

function context(walletClient, chain, request) {
  return {
    address: ACCOUNT,
    walletClient,
    sweepChainId: chain.id,
    sweepChain: { chain, weth: TOKEN, paymasterEligible: chain.id === 8453 },
    getWalletRequestCandidates: () => [request],
  };
}

test("OKX keeps approvals and sweep in one atomic request on the newly selected chain", async () => {
  const requests = [];
  const request = async (args) => { requests.push(args); return { transactionHash: HASH }; };
  const walletClient = {};
  const render = createRenderer("sendAtomicWalletCalls");
  const cleanCalls = calls.map(({ to, data, value }) => ({ to, data, value }));
  const args = {
    account: ACCOUNT,
    calls: cleanCalls,
    walletKey: "okx",
    usePaymasterCapabilities: false,
    appendDataSuffixes: false,
  };

  await render(context(walletClient, CHAIN.base, request))(args);
  await render(context(walletClient, CHAIN.optimism, request))(args);

  assert.equal(requests.length, 2, "One wallet prompt per sweep");
  for (const [index, chainId] of ["0x2105", "0xa"].entries()) {
    const rpc = requests[index];
    assert.equal(rpc.method, "wallet_sendCalls");
    const payload = rpc.params[0];
    assert.equal(payload.chainId, chainId);
    assert.equal(payload.atomicRequired, true);
    assert.equal("capabilities" in payload, false);
    assert.equal(payload.calls.length, 2);
    assert.equal(payload.calls[0].data, calls[0].data, "ERC20 approval calldata stays clean");
    assert.equal(payload.calls[1].data, calls[1].data, "OKX sweep calldata stays clean for its decoder");
    assert.equal(payload.calls[1].to, ROUTER, "Exactly one consuming sweep follows the approval");
  }
});

test("viem atomic batching uses Optimism after switching with the same wallet client", async () => {
  const requests = [];
  const walletClient = {
    sendCalls: async (args) => { requests.push(args); return { transactionHash: HASH }; },
    waitForCallsStatus: async () => { throw new Error("Immediate transaction hash needs no status polling"); },
  };
  const render = createRenderer("sendAtomicWalletCalls");
  const args = { account: ACCOUNT, calls, walletKey: "base_account", usePaymasterCapabilities: false };
  await render(context(walletClient, CHAIN.base))(args);
  await render(context(walletClient, CHAIN.optimism))(args);

  assert.deepEqual(requests.map((request) => request.chain.id), [8453, 10]);
  assert.equal(requests[1].forceAtomic, true);
  assert.equal(requests[1].calls.length, 2);
  assert.equal(requests[1].calls[1].data, concatHex([calls[1].data, SUFFIX]));
  assert.equal("capabilities" in requests[1], false, "Optimism does not offer the Base paymaster");
});

test("TokenPocket batch and raw transaction callbacks both follow a Base to Optimism selection", async () => {
  const requests = [];
  const request = async (args) => {
    requests.push(args);
    return args.method === "eth_sendTransaction" ? HASH : { transactionHash: HASH };
  };
  const walletClient = {};
  const renderBatch = createRenderer("sendTokenPocketWalletSendCalls");
  const renderRaw = createRenderer("sendTokenPocketRawTransaction");
  const rpcCalls = calls.map(({ to, data }) => ({ to, data, value: "0x0" }));
  for (const chain of [CHAIN.base, CHAIN.optimism]) {
    const bindings = context(walletClient, chain, request);
    await renderBatch(bindings)(rpcCalls, true);
    await renderRaw(bindings)({ to: ROUTER, data: "0x12345678" });
  }

  assert.deepEqual(requests.map((request) => request.params[0].chainId), ["0x2105", "0x2105", "0xa", "0xa"]);
  assert.equal(requests[2].params[0].atomicRequired, true);
  assert.equal(requests[2].params[0].calls.length, 2);
  assert.equal(requests[3].params[0].data, concatHex(["0x12345678", SUFFIX]));
});

test("a wallet bundle with separate approval and sweep receipts resolves the sweep transaction", async () => {
  const approvalHash = `0x${"cd".repeat(32)}`;
  const requests = [];
  const request = async (args) => {
    requests.push(args);
    if (args.method === "wallet_sendCalls") return { id: "op-bundle" };
    assert.equal(args.method, "wallet_getCallsStatus");
    assert.equal(args.params[0], "op-bundle");
    return { status: 200, receipts: [
      { transactionHash: approvalHash, status: "0x1" },
      { transactionHash: HASH, status: "0x1" },
    ] };
  };
  const callback = createRenderer("sendTokenPocketWalletSendCalls")(context({}, CHAIN.optimism, request));
  const hash = await callback(calls.map(({ to, data }) => ({ to, data, value: "0x0" })), false);
  assert.equal(hash, HASH, "Receipt parsing must wait for the consuming sweep, not the first approval");
  assert.equal(requests[0].params[0].chainId, "0xa");
  assert.equal(requests[0].params[0].calls.at(-1).to, ROUTER);
});

test("OKX fallback chunks retain healthy routes and never approve initial or newly dropped tokens", async () => {
  const droppedBefore = "0x0000000000000000000000000000000000000003";
  const droppedNow = "0x0000000000000000000000000000000000000004";
  const healthyLast = "0x0000000000000000000000000000000000000005";
  const effectiveRoutes = [TOKEN, droppedNow, healthyLast].map((tokenIn) => ({ tokenIn, amountIn: "100" }));
  const droppedAddresses = new Set([droppedBefore]);
  const buildRequests = [];
  const approvalRequests = [];
  const batches = [];
  const confirmed = [];
  let unavailable = [];
  let failed = [];
  const lastHash = `0x${"ef".repeat(32)}`;
  const callback = createRenderer("sendOkxChunkedCombinedBatches")({
    requiresPermitSignature: false, effectiveRoutes,
    quote: { routes: [{ tokenIn: droppedBefore }, ...effectiveRoutes] },
    droppedAddresses,
    selectedTokens: [droppedBefore, droppedNow, TOKEN, healthyLast].map((address) => ({ address, symbol: "T" })),
    OKX_COMBINED_CHUNK_SIZE: 2,
    setExecutionNotice() {}, setSweepStep() {}, currentStep: "idle",
    setUnavailableTokens: (value) => { unavailable = value(unavailable); },
    setQuoteFailedTokenAddresses: (value) => { failed = value(failed); },
    fetchChunkBuildTx: async (routes) => {
      buildRequests.push(routes.map((route) => route.tokenIn));
      return { routerAddress: ROUTER, calldata: "0x12345678", skippedTokens: routes.some((route) => route.tokenIn === droppedNow) ? [{ token: droppedNow }] : [] };
    },
    approvalSpender: ROUTER,
    getTokenApprovalRequirements: async (routes) => { approvalRequests.push(routes.map((route) => route.tokenIn)); return routes; },
    buildApprovalCalls: (routes) => routes.map((route) => ({ to: route.tokenIn, data: "0x095ea7b3", value: 0n })),
    wethUnwrapCall: undefined, wethUnwrapDone: false,
    address: ACCOUNT, usePaymasterCapabilities: false, walletProfile: { walletKey: "okx" },
    sendAtomicWalletCalls: async (batch) => { batches.push(batch); return batches.length === 1 ? HASH : lastHash; },
    confirmSweepResult: async (...args) => confirmed.push(args),
  });
  assert.equal(await callback(), lastHash);
  assert.deepEqual(buildRequests, [[TOKEN, droppedNow], [healthyLast]]);
  assert.deepEqual(approvalRequests, [[TOKEN], [healthyLast]]);
  assert.equal(batches.length, 2);
  assert.ok(batches.every((batch) => batch.calls.length === 2 && batch.calls.at(-1).to === ROUTER));
  assert.deepEqual(confirmed.map(([hash]) => hash), [HASH, lastHash]);
  assert.deepEqual([...droppedAddresses], [droppedBefore, droppedNow], "Completion skipped counts retain both preflight exclusions");
  assert.equal(unavailable[0].address, droppedNow);
  assert.equal(unavailable[0].reason, "CANT_TRANSFER");
  assert.deepEqual(Array.from(failed), [droppedNow]);
});

test("quotes use the selected chain even when native output and WETH addresses are shared", async () => {
  const requests = [];
  const quotes = [];
  const selectedTokens = [{ address: TOKEN, balance: "1" }];
  const tokenOut = { address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" };
  const quoteRequestSeqRef = { current: 0 };
  const carriedRoutesRef = { current: new Map() };
  const lastQuoteMetaRef = { current: null };
  const bindings = {
    address: ACCOUNT,
    selectedTokens,
    tokenOut,
    slippageBps: 100,
    removeFailedTokens: false,
    quoteRequestSeqRef,
    carriedRoutesRef,
    lastQuoteMetaRef,
    safeBigInt: (value) => BigInt(value || "0"),
    normalizeQuotePayload: (payload) => payload,
    setIsQuoting() {}, setQuoteError() {}, setQuoteFailedTokenAddresses() {}, setUnavailableTokens() {},
    setQuote: (quote) => quotes.push(quote),
    fetch: async (_url, args) => {
      const body = JSON.parse(args.body);
      requests.push(body);
      return {
        ok: true,
        json: async () => ({
          chainId: body.chainId,
          routes: [{ tokenIn: TOKEN, amountIn: "1" }],
          totalEstimatedOut: "1",
          totalEstimatedOutUSD: 1,
        }),
      };
    },
  };
  const render = createRenderer("refreshQuote");
  for (const chain of [CHAIN.base, CHAIN.optimism]) {
    await render({ ...bindings, sweepChainId: chain.id, sweepChain: { weth: TOKEN } })();
  }
  assert.deepEqual(requests.map((request) => request.chainId), [8453, 10]);
  assert.deepEqual(quotes.map((quote) => quote.chainId), [8453, 10]);
});

test("the picker includes discovery-hidden balances and prioritizes current quote failure reasons", () => {
  const belowThreshold = { address: TOKEN, reason: "BELOW_THRESHOLD" };
  const unknownPrice = { address: ROUTER, reason: "UNKNOWN_PRICE" };
  const riskFiltered = { address: ACCOUNT, reason: "SPAM_OR_DENYLISTED" };
  const quoteFailure = { address: TOKEN.toUpperCase(), reason: "BALANCE_CHANGED" };
  const discovery = [belowThreshold, unknownPrice, riskFiltered];
  const quoteFailures = [quoteFailure];
  const result = createRenderer("pickerUnavailableTokens")({
    useMemo: (selector) => selector(),
    balances: { unavailableTokens: discovery },
    unavailableTokens: quoteFailures,
  });

  assert.equal(result.length, 3, "An address appears only once");
  assert.equal(result.find((token) => token.address.toLowerCase() === TOKEN).reason, "BALANCE_CHANGED");
  assert.equal(result.find((token) => token.address === ROUTER).reason, "UNKNOWN_PRICE");
  assert.equal(result.find((token) => token.address === ACCOUNT).reason, "SPAM_OR_DENYLISTED");
  assert.deepEqual(discovery, [belowThreshold, unknownPrice, riskFiltered]);
  assert.deepEqual(quoteFailures, [quoteFailure], "Selected-route failures stay separate from discovery filters");
});

test("an explicit live-balance failure removes its carried route while healthy routes survive", async () => {
  const staleRoute = { tokenIn: TOKEN, amountIn: "1", estimatedOut: "50", amountOutMin: "49" };
  const healthyRoute = { tokenIn: ROUTER, amountIn: "2", estimatedOut: "10", amountOutMin: "9" };
  const carriedRoutesRef = { current: new Map([[TOKEN, staleRoute]]) };
  const quotes = [];
  let unavailable = [];
  await createRenderer("refreshQuote")({
    address: ACCOUNT,
    selectedTokens: [{ address: TOKEN, balance: "1" }, { address: ROUTER, balance: "2" }],
    tokenOut: { address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" },
    sweepChainId: 10,
    sweepChain: { weth: TOKEN },
    slippageBps: 100,
    removeFailedTokens: false,
    quoteRequestSeqRef: { current: 0 },
    carriedRoutesRef,
    lastQuoteMetaRef: { current: { routes: [staleRoute], totalEstimatedOut: "50", totalEstimatedOutUSD: 50 } },
    normalizeQuotePayload: (payload) => payload,
    setIsQuoting() {}, setQuoteError() {}, setQuoteFailedTokenAddresses() {},
    setUnavailableTokens: (value) => { unavailable = typeof value === "function" ? value(unavailable) : value; },
    setQuote: (quote) => quotes.push(quote),
    fetch: async () => ({
      ok: true,
      json: async () => ({
        chainId: 10,
        routes: [healthyRoute],
        skippedTokens: [{ token: TOKEN, reason: "BALANCE_CHANGED" }],
        totalEstimatedOut: "10",
        totalEstimatedOutUSD: 10,
      }),
    }),
  })();

  assert.equal(carriedRoutesRef.current.has(TOKEN), false);
  assert.equal(quotes.at(-1).routes.length, 1);
  assert.equal(quotes.at(-1).routes[0].tokenIn, ROUTER);
  assert.equal(unavailable[0].reason, "BALANCE_CHANGED");
});
