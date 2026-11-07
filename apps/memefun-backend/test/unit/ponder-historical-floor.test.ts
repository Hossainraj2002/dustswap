import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

type Hex = `0x${string}`;
interface Query { address?: Hex[]; fromBlock: Hex; toBlock: Hex }
interface Factory { id: string; type: "log"; chainId: number; sourceId: string; address: Hex; eventSelector: Hex; childAddressLocation: "topic1"; fromBlock: number }
interface Filter { type: "log"; chainId: number; sourceId: string; address: Factory; topic0: Hex; fromBlock: number }
interface Trace { msg: string; range?: number }

const runtimeRoot = resolve(realpathSync("node_modules/ponder"), "dist/esm");
const loadRuntime = (path: string) => import(/* @vite-ignore */ pathToFileURL(resolve(runtimeRoot, path)).href);
const { getLocalSyncGenerator } = await loadRuntime("runtime/historical.js") as {
  getLocalSyncGenerator(params: Record<string, unknown>): AsyncGenerator<number>;
};
const { getFragments, getFactoryFragments } = await loadRuntime("runtime/fragments.js") as {
  getFragments(filter: Filter): Array<{ fragment: unknown }>;
  getFactoryFragments(factory: Factory): unknown[];
};
const hex = (n: number): Hex => `0x${n.toString(16)}`;
const address = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;

afterEach(() => vi.restoreAllMocks());

async function run(chainId: number, start: number, end: number, count = 1, resume?: number) {
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const addresses = Array.from({ length: count }, (_, i) => address(i + 1));
  const factory: Factory = { id: "factory", type: "log", chainId, sourceId: "Coin", address: address(10_000), eventSelector: `0x${"cd".repeat(32)}`, childAddressLocation: "topic1", fromBlock: start };
  const filter: Filter = { type: "log", chainId, sourceId: "Coin", address: factory, topic0: `0x${"ab".repeat(32)}`, fromBlock: start };
  const cachedIntervals = new Map<Filter | Factory, Array<{ fragment: unknown; intervals: number[][] }>>([
    [filter, getFragments(filter).map(({ fragment }) => ({ fragment, intervals: resume === undefined ? [] : [[start, resume]] }))],
    [factory, getFactoryFragments(factory).map(fragment => ({ fragment, intervals: [[start, Math.max(start, end)]] }))],
  ]);
  const queries: Query[] = [];
  const trace: Trace[] = [];
  const logger = { info() {}, warn() {}, debug() {}, trace(entry: Trace) { trace.push(entry); }, child() { return this; } };
  const metric = { set() {}, inc() {} };
  const progress = {
    start: { number: hex(start), timestamp: hex(start) },
    finalized: { number: hex(end), timestamp: hex(end) },
    current: (resume === undefined ? undefined : { number: hex(resume), timestamp: hex(resume) }) as { number: Hex } | undefined,
  };
  const yielded: number[] = [];
  const generator = getLocalSyncGenerator({
    common: {
      logger, options: { command: "start", factoryAddressCountThreshold: 1_000 },
      metrics: {
        ponder_sync_block: metric, ponder_sync_block_timestamp: metric,
        ponder_historical_total_blocks: metric, ponder_historical_cached_blocks: metric,
        ponder_historical_completed_blocks: metric,
      },
    },
    chain: { id: chainId, name: "memefun", disableCache: true, finalityBlockCount: 300 },
    rpc: { async request({ method, params }: { method: string; params: [Query] }) {
      expect(method).toBe("eth_getLogs");
      queries.push(params[0]);
      return [];
    } },
    eventCallbacks: [{ filter }], syncProgress: progress,
    childAddresses: new Map([[factory.id, new Map(addresses.map(value => [value, start]))]]), cachedIntervals,
    database: { syncQB: { async transaction(callback: (tx: object) => Promise<unknown>) {
      const result = await callback({});
      // Actual native duration/estimate logic sees a slow interval, without a real sleep.
      elapsed += 13_000;
      return result;
    } } },
    isCatchup: false,
  });
  for await (const endBlock of generator) yielded.push(endBlock);
  return { addresses, queries, trace, yielded, progress };
}

describe("Ponder's native Base historical interval floor", () => {
  it("amortizes 1,995-address work across a 1,000-block floor even when intervals take over ten seconds", async () => {
    const result = await run(8453, 5, 2_505, 1_995);
    expect(result.yielded).toEqual([1_005, 2_006, 2_505]);
    const estimates = result.trace.filter(entry => entry.msg === "Updated block range estimate for fetching backfill JSON-RPC data");
    expect(estimates).toHaveLength(3);
    expect(estimates.every(entry => entry.range === 1_000)).toBe(true);
    expect(result.queries.every(query => Array.isArray(query.address) && query.address.length <= 50)).toBe(true);
    expect(new Set(result.queries.flatMap(query => query.address ?? [])).size).toBe(1_995);
    // Native inner splitting still covers every block exactly once for a representative
    // address, including the final interval below the outer floor.
    const intervals = result.queries.filter(query => query.address?.includes(result.addresses[0]!))
      .map(query => [Number(query.fromBlock), Number(query.toBlock)]).sort((a, b) => a[0]! - b[0]!);
    let next = 5;
    for (const [from, to] of intervals) {
      expect(from).toBe(next);
      expect(to).toBeGreaterThanOrEqual(from!);
      next = to! + 1;
    }
    expect(next).toBe(2_506);
    expect(result.progress.current?.number).toBe(hex(2_505));
  });

  it("clamps a short Base tail to the requested finalized end", async () => {
    const result = await run(8453, 100, 137);
    expect(result.yielded).toEqual([137]);
    expect(result.queries.every(query => Number(query.fromBlock) >= 100 && Number(query.toBlock) <= 137)).toBe(true);
    expect(result.progress.current?.number).toBe(hex(137));
  });

  it("does no work when the configured start is beyond the finalized head", async () => {
    const result = await run(8453, 200, 137);
    expect(result.yielded).toEqual([]);
    expect(result.queries).toEqual([]);
    expect(result.progress.current?.number).toBe(hex(137));
  });

  it("resumes after the cached checkpoint without repeating or skipping any uncached blocks", async () => {
    const result = await run(8453, 5, 2_505, 1_995, 1_200);
    expect(result.yielded).toEqual([1_200, 2_201, 2_505]);
    const intervals = result.queries.filter(query => query.address?.includes(result.addresses[0]!))
      .map(query => [Number(query.fromBlock), Number(query.toBlock)]).sort((a, b) => a[0]! - b[0]!);
    let next = 1_201;
    for (const [from, to] of intervals) {
      expect(from).toBe(next);
      next = to! + 1;
    }
    expect(next).toBe(2_506);
    expect(result.progress.current?.number).toBe(hex(2_505));
  });

  it.each([84532, 1])("retains the 25-block initial range and floor on chain %s", async (chainId) => {
    const result = await run(chainId, 100, 170, 1);
    expect(result.yielded).toEqual([125, 151, 170]);
    const estimates = result.trace.filter(entry => entry.msg === "Updated block range estimate for fetching backfill JSON-RPC data");
    expect(estimates.every(entry => entry.range === 25)).toBe(true);
  });
});
