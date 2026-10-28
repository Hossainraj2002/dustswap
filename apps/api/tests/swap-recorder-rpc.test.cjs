const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

require("ts-node").register({
  project: path.join(__dirname, "../tsconfig.json"), transpileOnly: true,
  compilerOptions: { module: "CommonJS", moduleResolution: "Node" },
});

// Compile the actual service resolver and its hash helpers without starting database or
// points services. The RPC dispatcher, clients, and viem transport remain real.
const source = ts.createSourceFile("swapRecorder.ts", readFileSync(path.join(__dirname, "../src/services/swapRecorder.ts"), "utf8"), ts.ScriptTarget.Latest, true);
const names = new Set(["resolveUserOperationTransactionHash", "isTxHash", "normalizeTxHash"]);
const functions = source.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
assert.equal(functions.length, names.size);
const compiled = ts.transpileModule(functions.map((node) => node.getText(source)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const USER_OP = `0x${"ab".repeat(32)}`;
const TX = `0x${"CD".repeat(32)}`;
const originalFetch = global.fetch;
const originalEnv = { ...process.env };
let rpc;
let resolve;

test.beforeEach(() => {
  for (const name of Object.keys(process.env)) if (/RPC|ALCHEMY|BLOCKSCOUT/.test(name)) delete process.env[name];
  for (const filename of ["../src/utils/baseRpc.ts", "../src/utils/chainRpc.ts"]) delete require.cache[require.resolve(filename)];
  rpc = require("../src/utils/chainRpc.ts");
  const context = { ...rpc };
  vm.runInNewContext(`${compiled}\nthis.resolve = resolveUserOperationTransactionHash;`, context);
  resolve = context.resolve;
  global.fetch = async () => { throw new Error("Unexpected request"); };
});
test.afterEach(() => {
  global.fetch = originalFetch;
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
  Object.assign(process.env, originalEnv);
});

test("smart-wallet receipts retain the dedicated Alchemy lane when generic paid RPC is disabled", async () => {
  for (const [id, name] of [[8453, "BASE"], [10, "OPTIMISM"]]) {
    process.env[`ALCHEMY_${name}_RPC_KEYS`] = "bundler-only";
    process.env[`ALCHEMY_${name}_RPC_DEDICATED_ONLY`] = "true";
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push(String(url));
      assert.ok(String(url).includes(".g.alchemy.com/"));
      const request = JSON.parse(init.body);
      assert.equal(request.method, "eth_getUserOperationReceipt");
      assert.deepEqual(request.params, [USER_OP]);
      return Response.json({ result: { receipt: { transactionHash: TX } } });
    };
    assert.equal(await resolve(rpc.createChainPublicClient(id), USER_OP), TX.toLowerCase());
    assert.equal(calls.length, 1, "ordinary public nodes must not intercept a bundler receipt");
  }
});

test("chains without a dedicated bundler endpoint retain their existing provider client", async () => {
  let calls = 0;
  const client = { chain: { id: 137 }, request: async ({ method, params }) => {
    calls += 1;
    assert.equal(method, "eth_getUserOperationReceipt");
    assert.equal(params[0], USER_OP);
    return { transactionHash: TX };
  } };
  assert.equal(await resolve(client, USER_OP), TX.toLowerCase());
  assert.equal(calls, 1);
});

test("an unavailable or pending bundler receipt remains an unresolved transaction", async () => {
  process.env.ALCHEMY_BASE_RPC_KEYS = "overdue";
  process.env.ALCHEMY_BASE_RPC_DEDICATED_ONLY = "true";
  const client = rpc.createChainPublicClient(8453);
  global.fetch = async () => new Response("Account overdue", { status: 402 });
  assert.equal(await resolve(client, USER_OP), null);
  global.fetch = async () => Response.json({ result: null });
  assert.equal(await resolve(client, USER_OP), null);
});
