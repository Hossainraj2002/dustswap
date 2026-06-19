import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWalletSendCallsPayload,
  canSubmitOkxBatchWithoutUpgrade,
  orderWalletRequestCandidates,
  requestWalletSendCalls,
  shouldSplitOkxApprovalAndSweep,
} from "../src/lib/dustsweep-wallet-rpc.ts";

const ACCOUNT = "0x0fd79f3ceae7dda5cfc15b35188e67efac542573";
const TOKEN = "0x4200000000000000000000000000000000000006";
const ROUTER = "0x06e6baa61a5da1e4469fca5dea3eb68324255e20";
const BUILDER_SUFFIX = "0x80218021802180218021802180218021";

function callData(selector, wordCount = 2) {
  return `${selector}${"00".repeat(wordCount * 32)}`;
}

function withBuilderSuffix(data) {
  return `${data}${BUILDER_SUFFIX.slice(2)}`;
}

function buildApprovalBatchPayload() {
  const approvals = Array.from({ length: 49 }, () => ({
    to: TOKEN,
    data: withBuilderSuffix(callData("0x095ea7b3")),
    value: 0n,
  }));

  return buildWalletSendCallsPayload({
    account: ACCOUNT,
    chainId: 8453,
    calls: approvals,
    atomicRequired: true,
  });
}

test("builds one populated OKX approval batch without unsupported capabilities", () => {
  const payload = buildApprovalBatchPayload();

  assert.equal(payload.version, "2.0.0");
  assert.equal(payload.atomicRequired, true);
  assert.equal(payload.chainId, "0x2105");
  assert.equal(payload.calls.length, 49);
  assert.equal("capabilities" in payload, false);
  assert.equal(payload.calls[0].data.endsWith(BUILDER_SUFFIX.slice(2)), true);
  assert.equal(payload.calls[48].data.endsWith(BUILDER_SUFFIX.slice(2)), true);
  assert.equal(payload.calls.every((call) => call.data.length >= 10), true);
});

test("uses exactly one connected OKX request and never reaches fallback candidates", async () => {
  let clientCalls = 0;
  let firstInjectedCalls = 0;
  let secondInjectedCalls = 0;
  const client = async () => {
    clientCalls += 1;
    throw new Error("OKX prompt failed after opening");
  };
  const firstInjected = async () => {
    firstInjectedCalls += 1;
  };
  const secondInjected = async () => {
    secondInjectedCalls += 1;
  };
  const candidates = orderWalletRequestCandidates(
    [client],
    [firstInjected, secondInjected],
    { limit: 1 },
  );

  assert.equal(candidates.length, 1);
  await assert.rejects(
    () => requestWalletSendCalls(candidates[0], buildApprovalBatchPayload()),
    /prompt failed/,
  );
  assert.equal(clientCalls, 1);
  assert.equal(firstInjectedCalls, 0);
  assert.equal(secondInjectedCalls, 0);
});

test("uses one injected fallback when the connected client is unavailable", async () => {
  let injectedCalls = 0;
  const injected = async () => {
    injectedCalls += 1;
    return { id: "0xabc" };
  };
  const candidates = orderWalletRequestCandidates([], [injected], {
    limit: 1,
  });

  assert.equal(candidates.length, 1);
  await requestWalletSendCalls(candidates[0], buildApprovalBatchPayload());
  assert.equal(injectedCalls, 1);
});

test("only batches OKX when the account already holds OKX's own 7702 delegate", () => {
  // No proven OKX delegation: never batch, regardless of the capability probe.
  // OKX advertises `supported`/`ready` even pre-upgrade, and batching then forces
  // the set-code authorization OKX's security hard-blocks as a risky signature.
  assert.equal(
    canSubmitOkxBatchWithoutUpgrade({
      atomicStatus: "ready",
      hasOwnDelegation: false,
    }),
    false,
  );
  assert.equal(
    canSubmitOkxBatchWithoutUpgrade({
      atomicStatus: "supported",
      hasOwnDelegation: false,
    }),
    false,
  );
  // Proven own delegation: batch even when the probe is flaky/unknown.
  assert.equal(
    canSubmitOkxBatchWithoutUpgrade({
      atomicStatus: "unknown",
      hasOwnDelegation: true,
    }),
    true,
  );
  assert.equal(
    canSubmitOkxBatchWithoutUpgrade({
      atomicStatus: "supported",
      hasOwnDelegation: true,
    }),
    true,
  );
  // An explicit `unsupported` capability stays authoritative.
  assert.equal(
    canSubmitOkxBatchWithoutUpgrade({
      atomicStatus: "unsupported",
      hasOwnDelegation: true,
    }),
    false,
  );
});

test("never force-splits the OKX approval batch from the sweep", () => {
  // OKX is only batched on a proven own delegate, where approvals + sweep go out
  // as one atomic wallet_sendCalls. Forcing a standalone approval batch triggered
  // a second "risky signature type" prompt, so the split is always disabled.
  assert.equal(
    shouldSplitOkxApprovalAndSweep({
      isOkx: true,
      approvalCallCount: 47,
    }),
    false,
  );
  assert.equal(
    shouldSplitOkxApprovalAndSweep({
      isOkx: true,
      approvalCallCount: 0,
    }),
    false,
  );
  assert.equal(
    shouldSplitOkxApprovalAndSweep({
      isOkx: false,
      approvalCallCount: 47,
    }),
    false,
  );
});

test("rejects an empty contract call before requesting the wallet", () => {
  assert.throws(
    () =>
      buildWalletSendCallsPayload({
        account: ACCOUNT,
        chainId: 8453,
        calls: [{ to: ROUTER, data: "0x", value: 0n }],
        atomicRequired: true,
      }),
    /empty or invalid calldata/,
  );
});
