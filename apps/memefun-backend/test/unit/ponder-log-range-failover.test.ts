import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fallback, http, shouldThrow, type EIP1193RequestFn } from "viem";

import { chainRpcTransport, chainSettings } from "../../lib/chain";

type Hex = `0x${string}`;
type Interval = [number, number];
interface Query { address?: Hex; topics?: Hex[]; fromBlock: Hex; toBlock: Hex }
interface GetLogsRequest { method: "eth_getLogs"; params: [Query] }
interface DebugEntry { msg: string; range?: number }
interface HistoricalSync {
  syncBlockRangeData(options: Record<string, unknown>): Promise<unknown[]>;
}

const runtime = pathToFileURL(resolve(realpathSync("node_modules/ponder"), "dist/esm/sync-historical/index.js")).href;
const { createHistoricalSync } = await import(/* @vite-ignore */ runtime) as {
  createHistoricalSync(options: Record<string, unknown>): HistoricalSync;
};
const saved = { ...process.env };
const BLAST = "https://base-mainnet.public.blastapi.io";
const NODIES = "https://base-pokt.nodies.app";
const ALCHEMY = "https://base-mainnet.g.alchemy.com/v2/inactive-fixture";
const FIRST = 0x33a561e;
const MESSAGE = "You can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [0x33a561e, 0x33a5627]";
const filter = { type: "log", chainId: 8453, sourceId: "Coin", address: "0x0000000000000000000000000000000000000001", topic0: `0x${"ab".repeat(32)}`, fromBlock: FIRST };

afterEach(() => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
});

function providerFixture() {
  const calls: Array<{ url: string; blocks: number }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const { params: [query] } = JSON.parse(String(init?.body)) as GetLogsRequest;
    const blocks = Number(query.toBlock) - Number(query.fromBlock) + 1;
    const endpoint = String(url);
    calls.push({ url: endpoint, blocks });
    if (endpoint.startsWith(BLAST) && blocks > 10) {
      return Response.json({ error: { code: -32602, message: MESSAGE } });
    }
    if (endpoint.includes("alchemy")) return Response.json({ error: { code: -32600, message: "App is inactive" } });
    return Response.json({ result: [] });
  }));
  return calls;
}

function nativeSync(request: EIP1193RequestFn) {
  const debug: DebugEntry[] = [];
  const logger = { debug(entry: DebugEntry) { debug.push(entry); }, warn() {}, child() { return this; } };
  const sync = createHistoricalSync({
    common: { logger, options: { factoryAddressCountThreshold: 1_000 } },
    chain: { id: 8453, name: "memefun" },
    rpc: { request },
    childAddresses: new Map(),
  });
  return {
    debug,
    async syncRange(interval: Interval) {
      return sync.syncBlockRangeData({
        interval, requiredIntervals: [{ filter, interval }], requiredFactoryIntervals: [],
        syncStore: { async insertChildAddresses() {} },
      });
    },
  };
}

describe("Ponder's native public log-range failover", () => {
  it("keeps 26-block queries intact when another public provider can serve Blast's rejected range", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    process.env.MEMEFUN_INDEXER_RPC_RPS = "30";
    const chain = { ...chainSettings(), rpcUrls: [BLAST, NODIES, ALCHEMY] };
    const calls = providerFixture();
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain });
    const native = nativeSync(transport.request);
    expect(await native.syncRange([FIRST, FIRST + 25])).toEqual([]);
    expect(await native.syncRange([FIRST + 26, FIRST + 51])).toEqual([]);
    expect(calls.filter(call => call.url.startsWith(BLAST))).toEqual([{ url: `${BLAST}/`, blocks: 26 }]);
    expect(calls.filter(call => call.url.startsWith(NODIES))).toEqual([
      { url: `${NODIES}/`, blocks: 26 }, { url: `${NODIES}/`, blocks: 26 },
    ]);
    expect(native.debug.filter(entry => entry.msg === "Updated eth_getLogs range")).toEqual([]);
    expect(calls.some(call => call.url.includes("alchemy"))).toBe(false);
  });

  it("reproduces the previous terminal range guard pinning Ponder's shared range to nine blocks", async () => {
    const calls = providerFixture();
    // Historical control: the old guard propagated the first public range error before
    // reaching a healthy peer. The installed Ponder helper performs all splitting below.
    const oldTransport = fallback([http(BLAST, { retryCount: 0 }), http(NODIES, { retryCount: 0 })], {
      rank: false, retryCount: 0,
      shouldThrow: error => shouldThrow(error) || /this block range.{0,20}\[0x/i.test("details" in error ? String(error.details) : error.message),
    })({});
    const native = nativeSync(oldTransport.request);
    expect(await native.syncRange([FIRST, FIRST + 25])).toEqual([]);
    expect(native.debug.filter(entry => entry.msg === "Updated eth_getLogs range")).toEqual([
      expect.objectContaining({ range: 9 }),
    ]);
    expect(calls[0]).toEqual({ url: `${BLAST}/`, blocks: 26 });
    expect(calls.slice(1).every(call => call.blocks <= 10)).toBe(true);
    calls.length = 0;
    expect(await native.syncRange([FIRST + 26, FIRST + 51])).toEqual([]);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every(call => call.url.startsWith(BLAST) && call.blocks <= 10)).toBe(true);
  });

  it("uses Nodies' actual 50-block plan limit for bounded native splitting", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    const chain = { ...chainSettings(), rpcUrls: [NODIES, ALCHEMY] };
    const calls: Array<{ url: string; blocks: number }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const { params: [query] } = JSON.parse(String(init?.body)) as GetLogsRequest;
      const blocks = Number(query.toBlock) - Number(query.fromBlock) + 1;
      calls.push({ url: String(url), blocks });
      if (String(url).includes("alchemy")) return Response.json({ error: { code: -32600, message: "App is inactive" } });
      return blocks > 50
        ? Response.json({ error: { code: -32001, message: "Block range too large: maximum allowed is 50 blocks on your current plan" } })
        : Response.json({ result: [] });
    }));
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain });
    const native = nativeSync(transport.request);
    expect(await native.syncRange([FIRST, FIRST + 125])).toEqual([]);
    expect(native.debug.filter(entry => entry.msg === "Updated eth_getLogs range")).toEqual([
      expect.objectContaining({ range: 50 }),
    ]);
    expect(calls.filter(call => call.url.startsWith(NODIES)).map(call => call.blocks)).toEqual([126, 50, 50, 26]);
    calls.length = 0;
    expect(await native.syncRange([FIRST + 126, FIRST + 251])).toEqual([]);
    expect(calls).toEqual([
      { url: `${NODIES}/`, blocks: 50 }, { url: `${NODIES}/`, blocks: 50 }, { url: `${NODIES}/`, blocks: 26 },
    ]);
  });

  it("rejects a contradictory dRPC 10,000-block hint without recursive native range retries", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    const chain = { ...chainSettings(), rpcUrls: ["https://base.drpc.org", ALCHEMY] };
    const calls: Array<{ url: string; blocks: number }> = [];
    const message = "ranges over 10000 blocks are not supported on free plan";
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const { params: [query] } = JSON.parse(String(init?.body)) as GetLogsRequest;
      calls.push({ url: String(url), blocks: Number(query.toBlock) - Number(query.fromBlock) + 1 });
      return String(url).includes("alchemy")
        ? Response.json({ error: { code: -32600, message: "App is inactive" } })
        : Response.json({ error: { code: 35, message } });
    }));
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain });
    const native = nativeSync(transport.request);
    let failure: unknown;
    try { await native.syncRange([FIRST, FIRST + 999]); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ status: 503, cause: { details: message } });
    expect(JSON.stringify(failure)).not.toContain(message);
    expect(native.debug.filter(entry => entry.msg === "Updated eth_getLogs range")).toEqual([]);
    const publicCalls = calls.filter(call => call.url.includes("drpc"));
    expect(publicCalls.length).toBeGreaterThan(0);
    expect(publicCalls.length).toBeLessThanOrEqual(2);
    expect(publicCalls.every(call => call.blocks === 500)).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(4);
  });
});
