import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWalletSendCallsPayload,
  canSubmitOkxBatchWithoutUpgrade,
  orderWalletRequestCandidates,
  requestWalletSendCalls,
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

function buildFiftyCallPayload() {
  const approvals = Array.from({ length: 49 }, () => ({
    to: TOKEN,
    data: withBuilderSuffix(callData("0x095ea7b3")),
    value: 0n,
  }));
  const sweep = {
    to: ROUTER,
    data: withBuilderSuffix(callData("0x12345678", 1)),
    value: 0n,
  };

  return buildWalletSendCallsPayload({
    account: ACCOUNT,
    chainId: 8453,
    calls: [...approvals, sweep],
    atomicRequired: true,
  });
}

test("builds one populated OKX approval+sweep batch without unsupported capabilities", () => {
  const payload = buildFiftyCallPayload();

  assert.equal(payload.version, "2.0.0");
  assert.equal(payload.atomicRequired, true);
  assert.equal(payload.chainId, "0x2105");
  assert.equal(payload.calls.length, 50);
  assert.equal("capabilities" in payload, false);
  assert.equal(payload.calls[0].data.endsWith(BUILDER_SUFFIX.slice(2)), true);
  assert.equal(payload.calls[49].data.endsWith(BUILDER_SUFFIX.slice(2)), true);
  assert.equal(payload.calls.every((call) => call.data.length >= 10), true);
});

test("prefers exactly one injected OKX request and never reaches fallback candidates", async () => {
  let clientCalls = 0;
  let firstInjectedCalls = 0;
  let secondInjectedCalls = 0;
  const client = async () => {
    clientCalls += 1;
  };
  const firstInjected = async () => {
    firstInjectedCalls += 1;
    throw new Error("OKX prompt failed after opening");
  };
  const secondInjected = async () => {
    secondInjectedCalls += 1;
  };
  const candidates = orderWalletRequestCandidates(
    [client],
    [firstInjected, secondInjected],
    { preferInjected: true, limit: 1 },
  );

  assert.equal(candidates.length, 1);
  await assert.rejects(
    () => requestWalletSendCalls(candidates[0], buildFiftyCallPayload()),
    /prompt failed/,
  );
  assert.equal(firstInjectedCalls, 1);
  assert.equal(secondInjectedCalls, 0);
  assert.equal(clientCalls, 0);
});

test("uses one connected-client fallback when OKX is not injected", async () => {
  let clientCalls = 0;
  const client = async () => {
    clientCalls += 1;
    return { id: "0xabc" };
  };
  const candidates = orderWalletRequestCandidates([client], [], {
    preferInjected: true,
    limit: 1,
  });

  assert.equal(candidates.length, 1);
  await requestWalletSendCalls(candidates[0], buildFiftyCallPayload());
  assert.equal(clientCalls, 1);
});

test("does not trigger an OKX upgrade transaction for atomic-ready accounts", () => {
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
    true,
  );
  assert.equal(
    canSubmitOkxBatchWithoutUpgrade({
      atomicStatus: "unknown",
      hasOwnDelegation: true,
    }),
    true,
  );
  assert.equal(
    canSubmitOkxBatchWithoutUpgrade({
      atomicStatus: "unsupported",
      hasOwnDelegation: true,
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
