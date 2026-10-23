import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import * as results from "../src/lib/dustsweep-results.ts";

const USER = "0x0000000000000000000000000000000000000001";
const ROUTER = "0x0000000000000000000000000000000000000002";
const TOKEN_A = "0x0000000000000000000000000000000000000003";
const TOKEN_B = "0x0000000000000000000000000000000000000004";
const OUTPUT = "0x0000000000000000000000000000000000000005";
const OTHER = "0x0000000000000000000000000000000000000006";
const HASH = `0x${"ab".repeat(32)}`;
const SCOPE = { routerAddress: ROUTER, userAddress: USER, recipient: USER, outputToken: OUTPUT, transactionHash: HASH };

function log(eventName, args, overrides = {}) {
  const event = results.SWEEP_RECEIPT_EVENTS.find((event) => event.name === eventName && event.inputs.every((input) => input.name in args));
  assert.ok(event, "Fixture must use an actual router event");
  const indexed = Object.fromEntries(event.inputs.filter((input) => input.indexed).map((input) => [input.name, args[input.name]]));
  const dataInputs = event.inputs.filter((input) => !input.indexed);
  return {
    address: ROUTER,
    transactionHash: HASH,
    topics: encodeEventTopics({ abi: [event], eventName, args: indexed }),
    data: encodeAbiParameters(dataInputs, dataInputs.map((input) => args[input.name])),
    ...overrides,
  };
}
function executed(tokenIn) {
  return log("RouteExecuted", { tokenIn, target: OTHER, spender: OTHER, amountIn: 100n });
}
function settled(overrides = {}) {
  return log("DustSwept", {
    user: USER, recipient: USER, outputToken: OUTPUT, routeCount: 2n,
    grossAmountOut: 1000n, feeAmount: 20n, netAmountOut: 980n,
    ...overrides,
  });
}

test("partial V3 sweep reports actual output and successful/skipped/refunded inputs", () => {
  const receipt = results.parseSweepReceiptLogs([
    executed(TOKEN_A),
    log("RouteSkipped", { tokenIn: TOKEN_B, amountIn: 100n, reason: "0x1234" }),
    log("InputRefunded", { token: TOKEN_B, to: USER, amount: 100n }),
    settled(),
  ], SCOPE);
  assert.equal(receipt.netAmountOut, 980n);
  assert.equal(receipt.grossAmountOut, 1000n);
  assert.equal(receipt.feeAmount, 20n);
  assert.equal(receipt.executedRouteCount, 1, "DustSwept.routeCount includes both attempts");
  assert.equal(receipt.skippedRouteCount, 1);
  assert.deepEqual(receipt.executedTokens, [TOKEN_A]);
  assert.deepEqual(receipt.refundedTokens, [TOKEN_B]);
  const quote = { totalEstimatedOut: "3000", totalEstimatedOutUSD: 30 };
  assert.equal(results.estimateReceiptOutputUsd(quote, receipt.netAmountOut), 9.8);
  assert.notEqual(receipt.netAmountOut.toString(), "2940", "The full quoted basket must not become the received amount");
});

test("a refund on an executed route is independent from a skipped route or failed refund", () => {
  const receipt = results.parseSweepReceiptLogs([
    executed(TOKEN_A),
    log("InputRefunded", { token: TOKEN_A, to: USER, amount: 5n }),
    log("RouteSkipped", { tokenIn: TOKEN_B, amountIn: 100n, reason: "0x" }),
    log("RefundFailed", { token: TOKEN_B, to: USER, amount: 100n }),
    settled(),
  ], SCOPE);
  assert.equal(receipt.executedRouteCount, 1);
  assert.equal(receipt.skippedRouteCount, 1);
  assert.deepEqual(receipt.refundedTokens, [TOKEN_A]);
  assert.deepEqual(receipt.refundFailedTokens, [TOKEN_B]);
});

test("receipt parsing rejects foreign router, transaction and settlement identity lookalikes", () => {
  const wrongScope = [
    { ...executed(TOKEN_B), address: OTHER },
    { ...settled({ netAmountOut: 999999n }), address: OTHER },
    { ...settled(), transactionHash: `0x${"cd".repeat(32)}` },
    executed(TOKEN_B), settled({ recipient: OTHER }),
    executed(TOKEN_B), settled({ user: OTHER }),
    executed(TOKEN_B), settled({ outputToken: OTHER }),
  ];
  assert.equal(results.parseSweepReceiptLogs(wrongScope, SCOPE), null);
  const receipt = results.parseSweepReceiptLogs([...wrongScope, executed(TOKEN_A), settled({ routeCount: 1n })], SCOPE);
  assert.equal(receipt.netAmountOut, 980n);
  assert.equal(receipt.executedRouteCount, 1, "Unrelated settlement segments cannot leak route counts");
  assert.deepEqual(receipt.executedTokens, [TOKEN_A]);
});

test("a malformed recognized settlement cannot leak earlier routes into a later sweep", () => {
  const receipt = results.parseSweepReceiptLogs([
    executed(TOKEN_A),
    { ...settled({ routeCount: 1n }), data: "0x" },
    executed(TOKEN_B),
    settled({ routeCount: 1n }),
  ], SCOPE);
  assert.equal(receipt, null, "Incomplete settlement evidence must not become a full output or inflated executed count");
});

test("multiple sweep chunks sum actual receipts once, and incomplete evidence stays unknown", () => {
  const first = results.parseSweepReceiptLogs([executed(TOKEN_A), settled({ routeCount: 1n })], SCOPE);
  const second = results.parseSweepReceiptLogs([executed(TOKEN_B), settled({ routeCount: 1n, grossAmountOut: 500n, feeAmount: 10n, netAmountOut: 490n })], SCOPE);
  const combined = results.combineSweepReceiptResults([first, second]);
  assert.equal(combined.netAmountOut, 1470n);
  assert.equal(combined.feeAmount, 30n);
  assert.equal(combined.executedRouteCount, 2);
  assert.deepEqual(combined.executedTokens, [TOKEN_A, TOKEN_B]);
  assert.equal(results.combineSweepReceiptResults([first, null]), null, "Do not present a partial amount as the full received total");
});

test("legacy Base V1 native and V2 atomic events retain actual amount and count semantics", () => {
  const native = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
  const v1 = results.parseSweepReceiptLogs([log("DustSwept", {
    sender: USER, recipient: USER, tokenOut: "0x0000000000000000000000000000000000000000",
    totalOutput: 500n, feeAmount: 5n, orderCount: 2n,
  })], { ...SCOPE, outputToken: native });
  assert.equal(v1.netAmountOut, 495n);
  assert.equal(v1.executedRouteCount, 2);
  assert.equal(v1.executedTokens, null, "V1 has no per-input events and succeeds atomically");
  const v2 = results.parseSweepReceiptLogs([executed(TOKEN_A), executed(TOKEN_B), log("DustSweepExecuted", {
    user: USER, receiver: USER, outputToken: OUTPUT,
    routeCount: 2n, grossAmountOut: 500n, feeAmount: 10n, netAmountOut: 490n,
  })], SCOPE);
  assert.equal(v2.netAmountOut, 490n);
  assert.equal(v2.executedRouteCount, 2);
  assert.deepEqual(v2.executedTokens, [TOKEN_A, TOKEN_B]);
});

test("minimum receive nets the one aggregate floor, with exact wallet unwrap handled separately", () => {
  const quote = { routes: [{ amountOutMin: "4000000" }, { amountOutMin: "5000000" }], minAmountOut: "2410114", feeBps: 200 };
  assert.equal(results.getSweepMinimumReceiveRaw(quote), "2361912");
  assert.equal(results.getSweepMinimumReceiveRaw({ ...quote, wethUnwrap: { amount: "500" } }), "2362412");
  assert.equal(results.getSweepMinimumReceiveRaw({ ...quote, routes: [], wethUnwrap: { amount: "500" } }), "500");
  assert.equal(results.getSweepMinimumReceiveRaw({ ...quote, minAmountOut: undefined }), null, "Never invent a guarantee from the sum of leg quotes");
});

test("the actual details component renders the canonical net floor rather than summed quote floors", () => {
  const source = readFileSync(new URL("../src/components/sweep/SweepDetails.tsx", import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  const realRequire = createRequire(import.meta.url);
  vm.runInNewContext(js, { exports, require: (name) => name === "@/lib/dustsweep-results" ? results : realRequire(name) });
  const html = renderToStaticMarkup(React.createElement(exports.SweepDetails, {
    quote: { routes: [{ amountOutMin: "4000000" }, { amountOutMin: "5000000" }], minAmountOut: "2410114", feeBps: 200, gasEstimateUSD: 0.01 },
    tokenOut: { symbol: "USDC", decimals: 6 }, slippageBps: 50,
  }));
  assert.ok(html.includes("2.361912 USDC"), html);
  assert.equal(html.includes("8.82 USDC"), false);
});

test("the actual success modal shows receipt output, independent partial-result notices and unknown fallback", () => {
  const source = readFileSync(new URL("../src/components/sweep/SweepSuccessModal.tsx", import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  const realRequire = createRequire(import.meta.url);
  vm.runInNewContext(js, { exports, require: (name) => {
    if (name === "@/components/sweep/TokenLogo") return { TokenLogo: () => null };
    if (name === "@/lib/explorer") return { getExplorerTxUrl: () => `https://optimistic.etherscan.io/tx/${HASH}` };
    return realRequire(name);
  } });
  const summary = {
    txHash: HASH, chainId: 10, tokenOut: { address: OUTPUT, symbol: "USDC", decimals: 2 },
    tokenOutAmount: "980", tokenOutValueUSD: 9.8, routeCount: 1, skippedRouteCount: 1,
    refundedTokenCount: 1, refundFailedTokenCount: 1, completedAt: 0,
    inputs: [{ address: TOKEN_A, symbol: "A", balanceFormatted: "100", valueUSD: 100 }],
  };
  const render = (value) => renderToStaticMarkup(React.createElement(exports.SweepSuccessModal, { summary: value, onClose() {} }));
  const html = render(summary);
  assert.ok(html.includes("1 token converted through Dustswap"), html);
  assert.ok(html.includes("1 token was skipped"), html);
  assert.ok(html.includes("Refunds sent for 1 token"), html);
  assert.ok(html.includes("1 refund could not complete"), html);
  assert.ok(html.includes(">9.8</p>"), html);
  assert.equal(html.includes(">100</"), false, "Input balances are submitted metadata, not displayed as spent quantities");
  const unknown = render({ ...summary, tokenOutAmount: null, tokenOutValueUSD: null, inputs: [], routeCount: 0 });
  assert.ok(unknown.includes("Transaction confirmed"), unknown);
  assert.ok(unknown.includes("View the received amount on the explorer"), unknown);
  assert.equal(unknown.includes("Received"), false);
  assert.equal(unknown.includes(">9.8</p>"), false);
});
