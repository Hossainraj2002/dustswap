// Compare actual viem actions through the new pools with the direct HTTP transport used
// before the public-RPC change. No database, scheduler, wallet signing, or network is used.
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
require("ts-node").register({
  project: path.join(__dirname, "../tsconfig.json"), transpileOnly: true,
  compilerOptions: { module: "CommonJS", moduleResolution: "Node" },
});
const { createPublicClient, http, erc20Abi, encodeAbiParameters } = require("viem");
const { getPublicClientForSwapChain, SUPPORTED_SWAP_CHAINS } = require("../src/config/swapChains.ts");

const TX_HASH = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"cd".repeat(32)}`;
const ADDRESS = `0x${"11".repeat(20)}`;
const TOKEN = `0x${"22".repeat(20)}`;
const ZERO_HASH = `0x${"00".repeat(32)}`;
const BLOOM = `0x${"00".repeat(256)}`;
const originalFetch = global.fetch;
const originalEnv = { ...process.env };

test.beforeEach(() => {
  for (const name of Object.keys(process.env)) if (/RPC|ALCHEMY|BLOCKSCOUT/.test(name)) delete process.env[name];
});
test.afterEach(() => {
  global.fetch = originalFetch;
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
  Object.assign(process.env, originalEnv);
});

function fixtures(chainId) {
  const transaction = {
    hash: TX_HASH, blockHash: BLOCK_HASH, blockNumber: "0x100", from: ADDRESS, to: TOKEN,
    gas: "0x186a0", gasPrice: "0x3b9aca00", maxFeePerGas: "0x77359400", maxPriorityFeePerGas: "0x3b9aca00",
    input: "0x", nonce: "0x2", transactionIndex: "0x0", type: "0x2", value: "0x0",
    chainId: `0x${chainId.toString(16)}`, accessList: [], v: "0x1", yParity: "0x1", r: ZERO_HASH, s: ZERO_HASH,
  };
  const receipt = {
    transactionHash: TX_HASH, transactionIndex: "0x0", blockHash: BLOCK_HASH, blockNumber: "0x100",
    from: ADDRESS, to: TOKEN, contractAddress: null, cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00",
    gasUsed: "0x5208", logs: [], logsBloom: BLOOM, status: "0x1", type: "0x2",
    ...(chainId === 324 ? { l2ToL1Logs: [], l1BatchNumber: "0x10", l1BatchTxIndex: "0x0" } : {}),
  };
  const block = {
    number: "0x100", hash: BLOCK_HASH, parentHash: ZERO_HASH, nonce: "0x0000000000000000",
    sha3Uncles: ZERO_HASH, logsBloom: BLOOM, transactionsRoot: ZERO_HASH, stateRoot: ZERO_HASH,
    receiptsRoot: ZERO_HASH, miner: ADDRESS, difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x",
    size: "0x100", gasLimit: "0x1c9c380", gasUsed: "0x5208", timestamp: "0x67000000",
    baseFeePerGas: "0x3b9aca00", mixHash: ZERO_HASH, transactions: [TX_HASH], uncles: [], withdrawals: [],
  };
  return { transaction, receipt, block };
}

for (const config of SUPPORTED_SWAP_CHAINS) {
  test(`${config.label}: receipts, transactions, contracts, gas, fees and nonce preserve prior viem behavior`, async () => {
    const fixture = fixtures(config.id);
    const calls = [];
    global.fetch = async (url, init) => {
      const request = JSON.parse(init.body);
      calls.push({ url: String(url), method: request.method, params: request.params });
      assert.ok(!String(url).includes("alchemy"));
      const results = {
        eth_chainId: `0x${config.id.toString(16)}`,
        eth_getTransactionByHash: fixture.transaction,
        eth_getTransactionReceipt: fixture.receipt,
        eth_getBlockByNumber: fixture.block,
        eth_call: encodeAbiParameters([{ type: "uint8" }], [18]),
        eth_estimateGas: "0x5208",
        eth_gasPrice: "0x3b9aca00",
        eth_maxPriorityFeePerGas: "0x3b9aca00",
        eth_getTransactionCount: "0x2",
      };
      assert.ok(request.method in results, `unexpected request: ${request.method}`);
      return Response.json({ jsonrpc: "2.0", id: request.id, result: results[request.method] });
    };
    const current = getPublicClientForSwapChain(config.id);
    const previous = createPublicClient({ chain: config.chain, transport: http("https://previous-http.example", { retryCount: 0 }) });
    const actions = [
      (client) => client.getChainId(),
      (client) => client.getTransaction({ hash: TX_HASH }),
      (client) => client.getTransactionReceipt({ hash: TX_HASH }),
      (client) => client.getBlock({ blockNumber: 256n }),
      (client) => client.readContract({ address: TOKEN, abi: erc20Abi, functionName: "decimals" }),
      (client) => client.estimateGas({ account: ADDRESS, to: TOKEN, data: "0x" }),
      (client) => client.estimateFeesPerGas(),
      (client) => client.getTransactionCount({ address: ADDRESS, blockTag: "pending" }),
    ];
    for (const action of actions) assert.deepEqual(await action(current), await action(previous));
    const receipt = await current.getTransactionReceipt({ hash: TX_HASH });
    assert.equal(receipt.status, "success");
    assert.equal(receipt.blockNumber, 256n);
    assert.equal(receipt.gasUsed, 21_000n);
    assert.ok(calls.some((call) => call.method === "eth_getTransactionCount" && call.params[1] === "pending"));

    // A valid null is still a pending/not-found transaction to viem, just as it was with HTTP.
    global.fetch = async (_url, init) => Response.json({ jsonrpc: "2.0", id: JSON.parse(init.body).id, result: null });
    for (const client of [current, previous]) {
      await assert.rejects(client.getTransactionReceipt({ hash: TX_HASH }), { name: "TransactionReceiptNotFoundError" });
      await assert.rejects(client.getTransaction({ hash: TX_HASH }), { name: "TransactionNotFoundError" });
    }
  });
}
