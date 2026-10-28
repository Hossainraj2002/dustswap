// Offline request-level regressions: public availability must never consume Alchemy quota.
// Run: node --test tests/public-rpc-fallback.test.cjs
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

require("ts-node").register({
  project: path.join(__dirname, "../tsconfig.json"),
  transpileOnly: true,
  compilerOptions: { module: "CommonJS", moduleResolution: "Node" },
});

const originalEnv = { ...process.env };
const originalFetch = global.fetch;
let baseRpc;
let chainRpc;
let swapChains;
const chainEnvs = [
  [8453, "BASE", "base-mainnet"],
  [1, "ETHEREUM", "eth-mainnet"],
  [56, "BSC", "bnb-mainnet"],
  [10, "OPTIMISM", "opt-mainnet"],
  [42161, "ARBITRUM", "arb-mainnet"],
  [4663, "ROBINHOOD", "robinhood-mainnet"],
];

function resetModules() {
  for (const filename of ["../src/config/swapChains.ts", "../src/utils/chainRpc.ts", "../src/utils/baseRpc.ts"]) {
    delete require.cache[require.resolve(filename)];
  }
  baseRpc = require("../src/utils/baseRpc.ts");
  chainRpc = require("../src/utils/chainRpc.ts");
  swapChains = require("../src/config/swapChains.ts");
}

test.beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (/RPC|ALCHEMY|BLOCKSCOUT/.test(key)) delete process.env[key];
  }
  resetModules();
  global.fetch = async () => { throw new Error("Unexpected offline network request"); };
});

test.afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  global.fetch = originalFetch;
});

test("healthy public nodes handle every request despite overdue keys and legacy paid-first settings", async () => {
  const calls = [];
  for (const [id, name, host] of chainEnvs) {
    process.env[`ALCHEMY_${name}_RPC_KEYS`] = "overdue-one,overdue-two";
    process.env[`ALCHEMY_${name}_RPC_DEDICATED_ONLY`] = "first";
    process.env[`${name}_RPC_PUBLIC_FALLBACK`] = "0";
    process.env[`${name}_RPC_URLS`] = `https://${host}.g.alchemy.com/v2/from-generic-env`;
    process.env[`${name}_RPC_ROTATION_CALLS`] = "1";
    const endpoints = chainRpc.getChainRpcEndpoints(id);
    assert.equal(endpoints[0].label, "public");
    assert.ok(endpoints.some((endpoint) => endpoint.url.endsWith("/from-generic-env") && endpoint.label === "alchemy-backstop"));
  }
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), method: JSON.parse(init.body).method });
    assert.equal(baseRpc.isAlchemyRpcUrl(String(url)), false);
    return Response.json({ result: "0x1" });
  };
  for (const [id] of chainEnvs) {
    const publicUrls = chainRpc.getChainRpcEndpoints(id).filter((endpoint) => endpoint.label === "public").map((endpoint) => endpoint.url);
    const start = calls.length;
    for (let i = 0; i < 12; i++) assert.equal(await chainRpc.chainRpcRequest(id, "eth_gasPrice"), "0x1");
    assert.deepEqual(new Set(calls.slice(start).map((call) => call.url)), new Set(publicUrls));
  }
  assert.equal(calls.length, 72);
});

test("a rate-limited public primary retries another public operator before Alchemy", async () => {
  process.env.ALCHEMY_BASE_RPC_KEYS = "overdue";
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return calls.length === 1 ? new Response("rate limited", { status: 429 }) : Response.json({ result: "0xbeef" });
  };
  assert.equal(await baseRpc.baseRpcRequest("eth_call", [{}, "latest"]), "0xbeef");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => !baseRpc.isAlchemyRpcUrl(url)));
});

test("Alchemy is reached only after all public and custom nodes fail", async () => {
  for (const [id, name, host] of chainEnvs) {
    process.env[`ALCHEMY_${name}_RPC_KEYS`] = "fallback";
    process.env[`${name}_RPC_URLS`] = `https://${host}.g.alchemy.com/v2/generic,https://custom.example/${id}`;
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      return baseRpc.isAlchemyRpcUrl(String(url)) ? Response.json({ result: "0x42" }) : new Response("unavailable", { status: 503 });
    };
    assert.equal(await chainRpc.chainRpcRequest(id, "eth_getBalance", ["0x0000000000000000000000000000000000000000", "latest"]), "0x42");
    assert.equal(baseRpc.isAlchemyRpcUrl(calls.at(-1)), true);
    assert.ok(calls.slice(0, -1).every((url) => !baseRpc.isAlchemyRpcUrl(url)));
    assert.ok(calls.includes(`https://custom.example/${id}`));
    const publicCount = chainRpc.getChainRpcEndpoints(id).filter((endpoint) => endpoint.label === "public").length;
    assert.equal(calls.length, publicCount + 2);
  }
});

test("legacy false also means Alchemy fallback and true still excludes it", () => {
  for (const [id, name, host] of chainEnvs) {
    process.env[`ALCHEMY_${name}_RPC_KEYS`] = "fallback";
    process.env[`${name}_RPC_URL`] = `https://${host}.g.alchemy.com/v2/generic`;
    process.env[`ALCHEMY_${name}_RPC_DEDICATED_ONLY`] = "false";
    assert.equal(chainRpc.getChainRpcEndpoints(id).at(-1).label, "alchemy-backstop");
    process.env[`ALCHEMY_${name}_RPC_DEDICATED_ONLY`] = "true";
    assert.ok(chainRpc.getChainRpcEndpoints(id).every((endpoint) => !baseRpc.isAlchemyRpcUrl(endpoint.url)));
    assert.ok(chainRpc.getChainAlchemyRpcEndpoints(id).some((endpoint) => endpoint.url.endsWith("/fallback")));
  }
});

test("public method and state capability errors fail over instead of breaking contract reads", async () => {
  for (const id of [8453, 10]) {
    for (const error of [
      { code: -32601, message: "method not found" },
      { code: -32000, message: "historical state unavailable" },
    ]) {
      const calls = [];
      global.fetch = async (url) => {
        calls.push(String(url));
        return Response.json(calls.length === 1 ? { error } : { result: "0x1" });
      };
      assert.equal(await chainRpc.chainRpcRequest(id, "eth_call", [{}, "latest"]), "0x1");
      assert.equal(calls.length, 2);
      assert.ok(calls.every((url) => !baseRpc.isAlchemyRpcUrl(url)));
    }
  }
});

test("contract reverts stop immediately without retrying paid endpoints", async () => {
  for (const id of [8453, 10]) {
    let count = 0;
    global.fetch = async () => {
      count += 1;
      return Response.json({ error: { code: -32000, message: "execution reverted: no pool" } });
    };
    await assert.rejects(chainRpc.chainRpcRequest(id, "eth_call", [{}, "latest"]), baseRpc.RpcDeterministicError);
    assert.equal(count, 1);
  }
});

test("malformed successful HTTP replies fail over but a valid null result is preserved", async () => {
  for (const id of [8453, 10]) {
    let count = 0;
    global.fetch = async () => {
      count += 1;
      return Response.json(count === 1 ? {} : { result: null });
    };
    assert.equal(await chainRpc.chainRpcRequest(id, "eth_getTransactionReceipt", ["0x123"]), null);
    assert.equal(count, 2);
  }
});

test("verification configuration cannot promote an Alchemy URL above public nodes", async () => {
  process.env.BASE_VERIFICATION_RPC_URLS = "https://base-mainnet.g.alchemy.com/v2/overdue";
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return Response.json({ result: "0x42" });
  };
  for (let i = 0; i < 8; i++) assert.equal(await baseRpc.baseVerificationRequest("eth_blockNumber"), "0x42");
  assert.ok(calls.every((url) => !baseRpc.isAlchemyRpcUrl(url)));
  assert.equal(baseRpc.getVerificationRpcEndpoints().at(-1).url, process.env.BASE_VERIFICATION_RPC_URLS);
});

test("caller cancellation prevents any further failover", async () => {
  for (const id of [8453, 10]) {
    const controller = new AbortController();
    let count = 0;
    global.fetch = async () => {
      count += 1;
      controller.abort();
      return new Response("unavailable", { status: 503 });
    };
    await assert.rejects(chainRpc.chainRpcRequest(id, "eth_call", [{}, "latest"], { signal: controller.signal }));
    assert.equal(count, 1);
  }
});

test("Alchemy-specific methods retain the dedicated keyed lane", async () => {
  for (const [id, name] of chainEnvs) {
    process.env[`ALCHEMY_${name}_RPC_KEYS`] = "dedicated";
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push(String(url));
      assert.equal(JSON.parse(init.body).method, "alchemy_getTokenBalances");
      return Response.json({ result: { tokenBalances: [] } });
    };
    assert.deepEqual(await chainRpc.chainAlchemyRpcRequest(id, "alchemy_getTokenBalances", ["0x123", "erc20"], { hedgeCount: 1 }), { tokenBalances: [] });
    assert.equal(calls.length, 1);
    assert.ok(baseRpc.isAlchemyRpcUrl(calls[0]));
  }
});

test("swap clients use public nodes first on every supported network", async () => {
  for (const config of swapChains.SUPPORTED_SWAP_CHAINS) {
    process.env[config.rpcEnv] = "https://polygon-mainnet.g.alchemy.com/v2/overdue";
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      assert.equal(baseRpc.isAlchemyRpcUrl(String(url)), false);
      return Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" });
    };
    const client = swapChains.getPublicClientForSwapChain(config.id);
    assert.equal(await client.request({ method: "eth_blockNumber" }), "0x1");
    assert.equal(calls.length, 1);
  }
});

test("swap-only chains try non-Alchemy custom alternatives before a generic Alchemy URL", async () => {
  process.env.POLYGON_RPC_URLS = "https://polygon-mainnet.g.alchemy.com/v2/fallback,https://polygon-custom.example";
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return baseRpc.isAlchemyRpcUrl(String(url))
      ? Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" })
      : new Response("unavailable", { status: 503 });
  };
  const client = swapChains.getPublicClientForSwapChain(137);
  assert.equal(await client.request({ method: "eth_blockNumber" }), "0x1");
  assert.equal(calls.at(-2), "https://polygon-custom.example/");
  assert.equal(calls.at(-1), "https://polygon-mainnet.g.alchemy.com/v2/fallback");
});

test("invalid signed transactions stop on the public rejection without consuming Alchemy", async () => {
  for (const [id, name] of chainEnvs) {
    process.env[`ALCHEMY_${name}_RPC_KEYS`] = "overdue";
    for (const message of ["nonce too low", "insufficient funds for gas * price + value", "replacement transaction underpriced", "already known"]) {
      let calls = 0;
      global.fetch = async () => {
        calls += 1;
        return calls === 1
          ? Response.json({ error: { code: -32000, message } })
          : new Response("Alchemy account overdue", { status: 401 });
      };
      await assert.rejects(
        chainRpc.chainRpcRequest(id, "eth_sendRawTransaction", ["0xdeadbeef"]),
        (error) => error instanceof baseRpc.RpcDeterministicError && error.message === message,
      );
      assert.equal(calls, 1);
    }
  }
});

test("a transport retry broadcasts exactly the same signed transaction", async () => {
  const signed = "0x02deadbeef";
  for (const id of [8453, 10]) {
    const calls = [];
    global.fetch = async (_url, init) => {
      const payload = JSON.parse(init.body);
      calls.push(payload);
      return calls.length === 1 ? new Response("unavailable", { status: 503 }) : Response.json({ result: "0xabc" });
    };
    assert.equal(await chainRpc.chainRpcRequest(id, "eth_sendRawTransaction", [signed]), "0xabc");
    assert.deepEqual(calls.map(({ method, params }) => ({ method, params })), [
      { method: "eth_sendRawTransaction", params: [signed] },
      { method: "eth_sendRawTransaction", params: [signed] },
    ]);
  }
});

test("viem clients preserve custom contract revert data across the shared transport", async () => {
  const { encodeErrorResult, parseAbi } = require("viem");
  const abi = parseAbi(["function quote() view returns (uint256)", "error QuoteUnavailable(uint256 amount)"]);
  const data = encodeErrorResult({ abi, errorName: "QuoteUnavailable", args: [42n] });
  for (const id of [8453, 10]) {
    for (const code of [3, -32000]) {
      global.fetch = async () => Response.json({ error: { code, message: "execution reverted", data } });
      const client = chainRpc.createChainPublicClient(id);
      await assert.rejects(client.readContract({ address: "0x1111111111111111111111111111111111111111", abi, functionName: "quote" }), (error) => {
        const reverted = error.walk((cause) => cause.name === "ContractFunctionRevertedError");
        assert.equal(reverted?.data?.errorName, "QuoteUnavailable");
        assert.deepEqual(reverted?.data?.args, [42n]);
        return true;
      });
    }
  }
});

test("verification and dedicated Base readers reject malformed success responses", async () => {
  process.env.ALCHEMY_BASE_RPC_KEYS = "one,two";
  for (const request of [
    () => baseRpc.baseVerificationRequest("eth_getTransactionReceipt", ["0x123"]),
    () => baseRpc.alchemyRpcRequest("alchemy_getTokenBalances", ["0x123", "erc20"], { hedgeCount: 1 }),
  ]) {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return Response.json(calls === 1 ? {} : { result: null });
    };
    assert.equal(await request(), null);
    assert.equal(calls, 2);
  }
});

test("dedicated methods retain Alchemy URLs supplied through generic RPC environment aliases", async () => {
  for (const [id, name, host] of chainEnvs) {
    process.env[`ALCHEMY_${name}_RPC_DEDICATED_ONLY`] = "true";
    const url = `https://${host}.g.alchemy.com/v2/from-generic-env`;
    process.env[`${name}_RPC_URL`] = url;
    assert.ok(chainRpc.getChainAlchemyRpcEndpoints(id).some((endpoint) => endpoint.url === url));
    const calls = [];
    global.fetch = async (requestUrl) => {
      calls.push(String(requestUrl));
      return Response.json({ result: null });
    };
    assert.equal(await chainRpc.chainAlchemyRpcRequest(id, "eth_getUserOperationReceipt", ["0x123"], { hedgeCount: 1 }), null);
    assert.deepEqual(calls, [url]);
  }
});
