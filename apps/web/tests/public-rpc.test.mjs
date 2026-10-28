import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createConfig, http as realHttp } from "wagmi";
import * as chains from "wagmi/chains";

const source = readFileSync(new URL("../src/config/web3.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const robinhood = { id: 4663, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } };
const ALCHEMY = "https://base-mainnet.g.alchemy.com/v2/overdue-key";
const PUBLIC = "https://public.example/rpc";

// Evaluate the actual configuration and fetch implementation with isolated environment,
// fetch, and transport construction. No live wallet or paid RPC is needed by these tests.
function loadWeb3({ env = {}, fetch = async () => Response.json({ result: "0x1" }), random = 0, timers = {}, realTransport = false } = {}) {
  const math = Object.create(Math);
  math.random = () => random;
  const context = {
    exports: {},
    require(name) {
      if (name === "wagmi") return { http: realTransport
        ? (url, options) => realHttp(url, { ...options, ...(realTransport === "batch" ? { batch: true } : {}) })
        : (url, options) => ({ url, ...options }) };
      if (name === "wagmi/chains") return chains;
      if (name === "./robinhoodChain") return { robinhood };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    process: { env }, fetch, URL, setTimeout, clearTimeout, AbortController, Math: math, console, ...timers,
  };
  vm.runInNewContext(compiled, context);
  const api = context.exports;
  api.rpcFetch = (chain = chains.base) => api.getWagmiTransports([chain])[chain.id].fetchFn;
  return api;
}

function realWagmiClient(api) {
  return createConfig({
    chains: [chains.base],
    transports: api.getWagmiTransports([chains.base]),
    ssr: true,
  }).getClient({ chainId: chains.base.id });
}

test("every supported chain retains a public default without environment configuration", () => {
  const api = loadWeb3();
  for (const chain of api.INITIAL_WAGMI_CHAINS) {
    const urls = api.getRpcUrlsForChain(chain.id);
    assert.ok(urls.length > 0, `${chain.id} has a public RPC`);
    assert.equal(urls.some((url) => url.includes("alchemy")), false);
    assert.equal(api.getRpcUrlForChain(chain.id), urls[0]);
  }
});

test("Alchemy keys and explicitly configured Alchemy URLs cannot replace public defaults", () => {
  const api = loadWeb3({ env: {
    NEXT_PUBLIC_ALCHEMY_BASE_RPC_KEYS: "overdue-key,new-key",
    NEXT_PUBLIC_BASE_RPC_URL: ALCHEMY,
    NEXT_PUBLIC_ALCHEMY_ETHEREUM_RPC_KEYS: "ethereum-key",
    NEXT_PUBLIC_ARBITRUM_RPC_URL: "https://arb-mainnet.g.alchemy.com/v2/overdue-key",
    NEXT_PUBLIC_OPTIMISM_RPC_URL: "https://opt-mainnet.g.alchemy.com/v2/overdue-key",
    NEXT_PUBLIC_POLYGON_RPC_URL: "https://polygon-mainnet.g.alchemy.com/v2/overdue-key",
    NEXT_PUBLIC_BSC_RPC_URL: "https://bnb-mainnet.g.alchemy.com/v2/overdue-key",
    NEXT_PUBLIC_AVALANCHE_RPC_URL: "https://avax-mainnet.g.alchemy.com/v2/overdue-key",
    NEXT_PUBLIC_ROBINHOOD_RPC_URL: "https://robinhood-mainnet.g.alchemy.com/v2/overdue-key",
  } });
  for (const chain of api.INITIAL_WAGMI_CHAINS) {
    const urls = Array.from(api.getRpcUrlsForChain(chain.id));
    assert.equal(urls[0].includes("alchemy"), false, `${chain.id} starts with a public RPC`);
    const firstAlchemy = urls.findIndex((url) => url.includes("alchemy"));
    assert.ok(firstAlchemy > 0, `${chain.id} keeps its Alchemy fallback`);
    assert.ok(urls.slice(firstAlchemy).every((url) => url.includes("alchemy")));
    assert.equal(new Set(urls).size, urls.length);
  }
});

test("normal rotation only sends requests to healthy public RPCs", async () => {
  const requests = [];
  const api = loadWeb3({
    env: {
      NEXT_PUBLIC_BASE_RPC_URLS: `${ALCHEMY},${PUBLIC},https://second-public.example/rpc`,
      NEXT_PUBLIC_BASE_RPC_ROTATION_CALLS: "1",
    },
    random: 0.999,
    fetch: async (url) => { requests.push(url); return Response.json({ result: "0x1" }); },
  });
  const fetch = api.rpcFetch();
  for (let i = 0; i < 12; i++) await fetch(PUBLIC, { method: "POST", body: "{}" });
  assert.equal(requests.length, 12);
  assert.equal(requests.includes(ALCHEMY), false);
  assert.deepEqual(new Set(requests), new Set(api.getRpcUrlsForChain(chains.base.id).filter((url) => !url.includes("alchemy"))));
});

test("Alchemy is reached only after public failures, and the next request starts public again", async () => {
  const requests = [];
  let publicHealthy = false;
  const api = loadWeb3({
    env: { NEXT_PUBLIC_BASE_RPC_URLS: `${ALCHEMY},${PUBLIC}` },
    fetch: async (url, init) => {
      requests.push({ url, body: init.body });
      return url === ALCHEMY || publicHealthy
        ? Response.json({ result: "0x1" })
        : new Response("rate limited", { status: 429 });
    },
  });
  const fetch = api.rpcFetch();
  const body = JSON.stringify({ id: 1, jsonrpc: "2.0", method: "eth_blockNumber", params: [] });
  const response = await fetch(PUBLIC, { method: "POST", body });
  assert.deepEqual(await response.json(), { result: "0x1" });
  assert.deepEqual(requests.map((request) => request.url), Array.from(api.getRpcUrlsForChain(chains.base.id)));
  assert.ok(requests.every((request) => request.body === body));
  publicHealthy = true;
  requests.length = 0;
  await fetch(PUBLIC, { method: "POST", body });
  assert.deepEqual(requests.map((request) => request.url), [PUBLIC]);
});

test("network failures and HTTP 200 provider errors fail over without consuming the response", async () => {
  for (const failure of [
    () => { throw new Error("network unavailable"); },
    () => Response.json({ error: { code: -32005, message: "request limit exceeded" } }),
    () => Response.json({ error: { code: -32601, message: "method not found" } }),
    () => Response.json([{ id: 1, error: { code: -32000, message: "rate limit exceeded" } }]),
    () => new Response("unauthorized", { status: 401 }),
    () => new Response("billing overdue", { status: 402 }),
    () => Response.json({}),
    () => Response.json(null),
    () => Response.json([]),
    () => Response.json([{}]),
    () => Response.json({ error: "invalid RPC error envelope" }),
  ]) {
    const requests = [];
    const api = loadWeb3({
      env: { NEXT_PUBLIC_BASE_RPC_URL: PUBLIC, NEXT_PUBLIC_ALCHEMY_API_KEY: "overdue-key" },
      fetch: async (url) => {
        requests.push(url);
        return url === PUBLIC ? failure() : Response.json({ result: "0x2" });
      },
    });
    const response = await api.rpcFetch()(PUBLIC, { method: "POST", body: "{}" });
    assert.deepEqual(await response.json(), { result: "0x2" });
    assert.deepEqual(requests, [PUBLIC, api.getRpcUrlsForChain(chains.base.id)[1]]);
    assert.equal(requests.includes(ALCHEMY), false);
  }
});

test("an overdue Alchemy key falls through HTTP 402 to a newly configured fallback key", async () => {
  const requests = [];
  const freshAlchemy = "https://base-mainnet.g.alchemy.com/v2/new-key";
  const api = loadWeb3({
    env: { NEXT_PUBLIC_ALCHEMY_BASE_RPC_KEYS: "overdue-key,new-key" },
    fetch: async (url) => {
      requests.push(url);
      if (url === freshAlchemy) return Response.json({ result: "0x4" });
      if (url === ALCHEMY) return new Response("billing overdue", { status: 402 });
      return new Response("public temporarily unavailable", { status: 503 });
    },
  });
  const response = await api.rpcFetch()(PUBLIC, { method: "POST", body: "{}" });
  assert.deepEqual(await response.json(), { result: "0x4" });
  assert.deepEqual(requests, Array.from(api.getRpcUrlsForChain(chains.base.id)));
  assert.deepEqual(requests.slice(-2), [ALCHEMY, freshAlchemy]);
});

test("a legitimate null RPC result stays authoritative without failover", async () => {
  const requests = [];
  const api = loadWeb3({
    env: { NEXT_PUBLIC_BASE_RPC_URL: PUBLIC, NEXT_PUBLIC_ALCHEMY_API_KEY: "overdue-key" },
    fetch: async (url) => { requests.push(url); return Response.json({ result: null }); },
  });
  const response = await api.rpcFetch()(PUBLIC, { method: "POST", body: "{}" });
  assert.deepEqual(await response.json(), { result: null });
  assert.deepEqual(requests, [PUBLIC]);
});

test("deterministic contract reverts return immediately without replaying against Alchemy", async () => {
  const requests = [];
  const error = { code: 3, message: "execution reverted: insufficient credits" };
  const api = loadWeb3({
    env: { NEXT_PUBLIC_BASE_RPC_URL: PUBLIC, NEXT_PUBLIC_ALCHEMY_API_KEY: "overdue-key" },
    fetch: async (url) => { requests.push(url); return Response.json({ error }); },
  });
  const response = await api.rpcFetch()(PUBLIC, { method: "POST", body: "{}" });
  assert.deepEqual(await response.json(), { error });
  assert.deepEqual(requests, [PUBLIC]);
});

test("a hanging public endpoint times out and leaves enough transport budget for fallback", async () => {
  const requests = [];
  const api = loadWeb3({
    env: { NEXT_PUBLIC_BASE_RPC_URL: PUBLIC, NEXT_PUBLIC_ALCHEMY_API_KEY: "overdue-key" },
    timers: { setTimeout: (callback) => setTimeout(callback, 1) },
    fetch: async (url, init) => {
      requests.push(url);
      if (url !== PUBLIC) return Response.json({ result: "0x2" });
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    },
  });
  const transport = api.getWagmiTransports([chains.base])[chains.base.id];
  const response = await transport.fetchFn(PUBLIC, { method: "POST", body: "{}" });
  assert.deepEqual(await response.json(), { result: "0x2" });
  assert.deepEqual(requests, [PUBLIC, api.getRpcUrlsForChain(chains.base.id)[1]]);
  assert.ok(transport.timeout > api.getRpcUrlsForChain(chains.base.id).length * 3_000);
});

test("caller cancellation aborts immediately without falling through the RPC pool", async () => {
  const requests = [];
  const caller = new AbortController();
  const api = loadWeb3({
    env: { NEXT_PUBLIC_BASE_RPC_URL: PUBLIC, NEXT_PUBLIC_ALCHEMY_API_KEY: "overdue-key" },
    fetch: async (url, init) => {
      requests.push(url);
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("caller cancelled")), { once: true });
        caller.abort();
      });
    },
  });
  await assert.rejects(api.rpcFetch()(PUBLIC, { method: "POST", body: "{}", signal: caller.signal }), /caller cancelled/);
  assert.deepEqual(requests, [PUBLIC]);
});

test("a public endpoint that sends headers then hangs its response body also fails over", async () => {
  const requests = [];
  const api = loadWeb3({
    env: { NEXT_PUBLIC_BASE_RPC_URL: PUBLIC },
    timers: { setTimeout: (callback) => setTimeout(callback, 1) },
    fetch: async (url, init) => {
      requests.push(url);
      if (url !== PUBLIC) return Response.json({ result: "0x3" });
      return new Response(new ReadableStream({
        start(stream) {
          init.signal.addEventListener("abort", () => stream.error(init.signal.reason), { once: true });
        },
      }), { headers: { "Content-Type": "application/json" } });
    },
  });
  const response = await api.rpcFetch()(PUBLIC, { method: "POST", body: "{}" });
  assert.deepEqual(await response.json(), { result: "0x3" });
  assert.deepEqual(requests, [PUBLIC, api.getRpcUrlsForChain(chains.base.id)[1]]);
});

test("actual wagmi/viem transport ignores malformed configured URLs before constructing Request", async () => {
  const requests = [];
  const api = loadWeb3({
    realTransport: true,
    env: { NEXT_PUBLIC_BASE_RPC_URLS: `not-a-url,ftp://rpc.example,${PUBLIC}` },
    fetch: async (url, init) => {
      requests.push(url);
      const request = JSON.parse(init.body);
      return Response.json({ id: request.id, jsonrpc: "2.0", result: "0x42" });
    },
  });
  const result = await realWagmiClient(api).request({ method: "eth_blockNumber" }, { retryCount: 0 });
  assert.equal(result, "0x42");
  assert.deepEqual(requests, [PUBLIC]);
  assert.equal(api.getRpcUrlForChain(chains.base.id), PUBLIC, "Wallet add-chain also receives a valid public URL");
});

test("actual wagmi/viem transport advances past numeric transient provider errors", async () => {
  for (const code of [429, -32603, -32002, -32004]) {
    const requests = [];
    const api = loadWeb3({
      realTransport: true,
      env: { NEXT_PUBLIC_BASE_RPC_URL: PUBLIC },
      fetch: async (url, init) => {
        requests.push(url);
        const request = JSON.parse(init.body);
        return Response.json({ id: request.id, jsonrpc: "2.0", ...(url === PUBLIC
          ? { error: { code, message: "provider failed" } }
          : { result: "0x43" }) });
      },
    });
    assert.equal(await realWagmiClient(api).request({ method: "eth_blockNumber" }, { retryCount: 0 }), "0x43");
    assert.deepEqual(requests, [PUBLIC, api.getRpcUrlsForChain(chains.base.id)[1]]);
  }
});

test("actual wagmi/viem transport recovers from a timed-out public body and preserves null results", async () => {
  const requests = [];
  const api = loadWeb3({
    realTransport: true,
    env: { NEXT_PUBLIC_BASE_RPC_URL: PUBLIC, NEXT_PUBLIC_ALCHEMY_API_KEY: "overdue-key" },
    timers: { setTimeout: (callback) => setTimeout(callback, 1) },
    fetch: async (url, init) => {
      requests.push(url);
      const request = JSON.parse(init.body);
      if (url !== PUBLIC) return Response.json({ id: request.id, jsonrpc: "2.0", result: null });
      return new Response(new ReadableStream({
        start(stream) {
          init.signal.addEventListener("abort", () => stream.error(init.signal.reason), { once: true });
        },
      }), { headers: { "Content-Type": "application/json" } });
    },
  });
  const client = realWagmiClient(api);
  assert.equal(await client.request({ method: "eth_getTransactionReceipt", params: [`0x${"11".repeat(32)}`] }, { retryCount: 0 }), null);
  assert.deepEqual(requests, [PUBLIC, api.getRpcUrlsForChain(chains.base.id)[1]]);
  assert.equal(client.transport.timeout, api.getRpcUrlsForChain(chains.base.id).length * 3_000 + 1_000);
});

test("actual wagmi/viem caller cancellation skips both fallback and library retries", async () => {
  const requests = [];
  const caller = new AbortController();
  const api = loadWeb3({
    realTransport: true,
    env: { NEXT_PUBLIC_BASE_RPC_URL: PUBLIC },
    fetch: async (url, init) => {
      requests.push(url);
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        caller.abort(new Error("user cancelled RPC"));
      });
    },
  });
  await assert.rejects(realWagmiClient(api).request({ method: "eth_blockNumber" }, { signal: caller.signal }), /user cancelled RPC/);
  assert.deepEqual(requests, [PUBLIC]);
});

test("actual viem HTTP batching preserves request IDs and result order through provider failover", async () => {
  const requests = [];
  const api = loadWeb3({
    realTransport: "batch",
    env: { NEXT_PUBLIC_BASE_RPC_URL: PUBLIC },
    fetch: async (url, init) => {
      const batch = JSON.parse(init.body);
      requests.push({ url, batch });
      if (url === PUBLIC) return Response.json({ error: { code: 429, message: "provider failed" } });
      return Response.json(batch.map((request) => ({
        id: request.id, jsonrpc: "2.0", result: request.method === "eth_blockNumber" ? "0x44" : "0x55",
      })).reverse());
    },
  });
  const client = realWagmiClient(api);
  const result = await Promise.all([
    client.request({ method: "eth_blockNumber" }, { retryCount: 0 }),
    client.request({ method: "eth_getBalance", params: ["0x0000000000000000000000000000000000000001", "latest"] }, { retryCount: 0 }),
  ]);
  assert.deepEqual(result, ["0x44", "0x55"]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].batch, requests[1].batch);
  assert.equal(requests[0].batch.length, 2);
  assert.equal(new Set(requests[0].batch.map((request) => request.id)).size, 2);
});

test("singular RPC environment variables accept trimmed comma lists without leaking Alchemy into wallet defaults", () => {
  const api = loadWeb3({ env: {
    NEXT_PUBLIC_ETHEREUM_RPC_URL: " https://eth-mainnet.g.alchemy.com/v2/old , https://ethereum-public.example/rpc ",
    NEXT_PUBLIC_BSC_RPC_URL: "invalid, https://bsc-public.example/rpc , https://bnb-mainnet.g.alchemy.com/v2/old",
  } });
  assert.equal(api.getRpcUrlForChain(chains.mainnet.id), "https://ethereum-public.example/rpc");
  assert.equal(api.getRpcUrlForChain(chains.bsc.id), "https://bsc-public.example/rpc");
});
