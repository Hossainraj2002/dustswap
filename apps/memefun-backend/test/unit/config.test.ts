import { afterEach, describe, expect, it, vi } from "vitest";

import { chainRpcTransport, chainSettings } from "../../lib/chain";
import { parseDeployment } from "../../lib/deployment";
import { envBool, envInt, envList } from "../../lib/env";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("chainSettings", () => {
  it("defaults to the local chain", () => {
    delete process.env.MEMEFUN_CHAIN;
    delete process.env.MEMEFUN_RPC_URLS;
    expect(chainSettings()).toMatchObject({ key: "local", id: 31337, rpcUrls: ["http://127.0.0.1:8545"] });
  });

  it("uses public defaults with configured Alchemy URLs reserved for fallback", () => {
    process.env.MEMEFUN_CHAIN = "base";
    delete process.env.MEMEFUN_RPC_URLS;
    expect(chainSettings().rpcUrls).toEqual(["https://mainnet.base.org", "https://base-mainnet.public.blastapi.io", "https://base-pokt.nodies.app", "https://base.gateway.tenderly.co"]);
    process.env.MEMEFUN_RPC_URLS = "https://mainnet.base.org";
    expect(chainSettings().rpcUrls).toEqual(["https://mainnet.base.org", "https://base-mainnet.public.blastapi.io", "https://base-pokt.nodies.app", "https://base.gateway.tenderly.co"]);
    process.env.MEMEFUN_RPC_URLS = "https://base-mainnet.g.alchemy.com/v2/key-a, https://base-mainnet.g.alchemy.com/v2/key-b";
    expect(chainSettings()).toMatchObject({ id: 8453, rpcUrls: ["https://mainnet.base.org", "https://base-mainnet.public.blastapi.io", "https://base-pokt.nodies.app", "https://base.gateway.tenderly.co", "https://base-mainnet.g.alchemy.com/v2/key-a", "https://base-mainnet.g.alchemy.com/v2/key-b"] });
    process.env.MEMEFUN_CHAIN = "base-sepolia";
    delete process.env.MEMEFUN_RPC_URLS;
    expect(chainSettings().rpcUrls).toEqual(["https://sepolia.base.org"]);
  });

  it("keeps custom non-Alchemy endpoints ahead of defaults and preserves local overrides", () => {
    process.env.MEMEFUN_CHAIN = "base";
    process.env.MEMEFUN_RPC_URLS = "https://base-mainnet.alchemyapi.io/v2/key-a, https://rpc.example.com, https://rpc.example.com";
    expect(chainSettings().rpcUrls).toEqual(["https://rpc.example.com", "https://mainnet.base.org", "https://base-mainnet.public.blastapi.io", "https://base-pokt.nodies.app", "https://base.gateway.tenderly.co", "https://base-mainnet.alchemyapi.io/v2/key-a"]);
    process.env.MEMEFUN_CHAIN = "local";
    process.env.MEMEFUN_RPC_URLS = "http://localhost:9545";
    expect(chainSettings().rpcUrls).toEqual(["http://localhost:9545"]);
  });

  it("does not load balance Ponder reads onto Alchemy while public RPC succeeds", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    process.env.MEMEFUN_RPC_URLS = "https://base-mainnet.g.alchemy.com/v2/key-a";
    const fetch = vi.fn(async (_input: string | URL | Request) => Response.json({ jsonrpc: "2.0", id: 1, result: "0x2105" }));
    vi.stubGlobal("fetch", fetch);
    const chain = chainSettings();
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain });
    await transport.request({ method: "eth_chainId" });
    await transport.request({ method: "eth_chainId" });
    expect(fetch.mock.calls.map((args) => String(args[0]))).toEqual(["https://mainnet.base.org/", "https://mainnet.base.org/"]);
  });

  it("shares a persistent rate budget across parallel Ponder requests", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    process.env.MEMEFUN_RPC_URLS = "https://base-mainnet.g.alchemy.com/v2/overdue-key";
    process.env.MEMEFUN_INDEXER_RPC_RPS = "5";
    const starts: number[] = [];
    let active = 0;
    let maximumActive = 0;
    const fetch = vi.fn(async (_url: string | URL | Request) => {
      starts.push(Math.floor(Date.now() / 1_000));
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active -= 1;
      return Response.json({ result: "0x2105" });
    });
    vi.stubGlobal("fetch", fetch);
    const chain = chainSettings();
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain });
    const results = await Promise.all(Array.from({ length: 12 }, () => transport.request({ method: "eth_chainId" })));
    expect(results).toEqual(Array(12).fill("0x2105"));
    const buckets = new Map<number, number>();
    for (const second of starts) buckets.set(second, (buckets.get(second) ?? 0) + 1);
    expect(Math.max(...buckets.values())).toBeLessThanOrEqual(5);
    expect(buckets.size).toBeGreaterThanOrEqual(3);
    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(fetch.mock.calls.every(([url]) => !String(url).includes("alchemy"))).toBe(true);
  });

  it("validates the historical indexing budget without throttling a local dev chain", () => {
    process.env.MEMEFUN_CHAIN = "base";
    process.env.MEMEFUN_INDEXER_RPC_RPS = "0";
    expect(() => chainRpcTransport(chainSettings())).toThrow("MEMEFUN_INDEXER_RPC_RPS");
    process.env.MEMEFUN_CHAIN = "local";
    expect(() => chainRpcTransport(chainSettings())).not.toThrow();
  });

  it("reaches Alchemy when public RPCs cannot serve an indexing method", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    process.env.MEMEFUN_RPC_URLS = "https://base-mainnet.g.alchemy.com/v2/key-a";
    const fetch = vi.fn(async (input: string | URL | Request) => String(input).includes("alchemy")
      ? Response.json({ jsonrpc: "2.0", id: 1, result: [] })
      : Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not supported" } }));
    vi.stubGlobal("fetch", fetch);
    const chain = chainSettings();
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain });
    expect(await transport.request({ method: "eth_getLogs", params: [{}] })).toEqual([]);
    expect(fetch.mock.calls.map((args) => String(args[0]))).toEqual(chain.rpcUrls.map((url) => new URL(url).toString()));
  });

  it("preserves public log range limits so Ponder can split requests without Alchemy", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    process.env.MEMEFUN_RPC_URLS = "https://base-mainnet.g.alchemy.com/v2/overdue-key";
    const message = "eth_getLogs is limited to a 10,000 blocks range";
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ fromBlock: string; toBlock: string }] };
      return BigInt(body.params[0].toBlock) - BigInt(body.params[0].fromBlock) >= 10_000n
        ? Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message } })
        : Response.json({ jsonrpc: "2.0", id: 1, result: [] });
    });
    vi.stubGlobal("fetch", fetch);
    const chain = chainSettings();
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain });
    await expect(transport.request({ method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0x4e20" }] })).rejects.toMatchObject({ details: message });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await transport.request({ method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0x1388" }] })).toEqual([]);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(["https://mainnet.base.org/", "https://mainnet.base.org/"]);
  });

  it("fails over when a public node cannot serve archive state", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    process.env.MEMEFUN_RPC_URLS = "https://base-mainnet.g.alchemy.com/v2/key";
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code: -32000, message: "requested block range is unavailable: missing trie node" } }))
      .mockResolvedValueOnce(Response.json({ result: [] }));
    vi.stubGlobal("fetch", fetch);
    const chain = chainSettings();
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain });
    expect(await transport.request({ method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0x1" }] })).toEqual([]);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(["https://mainnet.base.org/", "https://base-mainnet.public.blastapi.io/"]);
  });

  it("rejects unknown chains", () => {
    process.env.MEMEFUN_CHAIN = "mainnet";
    expect(() => chainSettings()).toThrow("MEMEFUN_CHAIN must be one of");
  });
});

describe("parseDeployment", () => {
  const record = {
    chainId: 84532,
    deployedAtBlock: 10,
    poolManager: "0x05e73354cfdd6745c338b50bcfdfa3aa6fa03408",
    config: "0x0000000000000000000000000000000000000002",
    feeVault: "0x0000000000000000000000000000000000000003",
    factory: "0x0000000000000000000000000000000000000004",
    router: "0x0000000000000000000000000000000000000005",
    hook: "0x0000000000000000000000000000000000000006",
    buybackBurnVault: "0x0000000000000000000000000000000000000007",
    floorVault: "0x0000000000000000000000000000000000000008",
    holderRewardDistributor: "0x0000000000000000000000000000000000000009",
    ethUsdFeed: "0x000000000000000000000000000000000000000a",
    usdc: "0x000000000000000000000000000000000000000b",
    owner: "0x000000000000000000000000000000000000000c",
    treasury: "0x000000000000000000000000000000000000000d",
    priceKeeper: "0x0000000000000000000000000000000000000000",
    rewardsPublisher: "0x0000000000000000000000000000000000000000",
  };

  it("checksums addresses and checks the chain", () => {
    const d = parseDeployment(record, 84532);
    expect(d.poolManager).toBe("0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408");
    expect(() => parseDeployment(record, 8453)).toThrow("expected 8453");
  });

  it("refuses a record with a bad address", () => {
    expect(() => parseDeployment({ ...record, hook: "0x1234" })).toThrow();
  });
});

describe("env helpers", () => {
  it("parse lists, booleans and bounded integers", () => {
    process.env.T_LIST = " a, b  c ,";
    process.env.T_BOOL = "yes";
    process.env.T_INT = "42";
    expect(envList("T_LIST")).toEqual(["a", "b", "c"]);
    expect(envBool("T_BOOL", false)).toBe(true);
    expect(envBool("T_MISSING", true)).toBe(true);
    expect(envInt("T_INT", 0, { max: 100 })).toBe(42);
    expect(() => envInt("T_INT", 0, { max: 10 })).toThrow("at most 10");
    process.env.T_BOOL = "maybe";
    expect(() => envBool("T_BOOL", false)).toThrow();
  });
});
