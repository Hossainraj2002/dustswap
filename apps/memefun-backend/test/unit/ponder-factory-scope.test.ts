import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

type Hex = `0x${string}`;
type Interval = [number, number];
interface Factory {
  id: string;
  type: "log";
  chainId: number;
  sourceId: string;
  address: Hex;
  eventSelector: Hex;
  childAddressLocation: "topic1";
  fromBlock: number;
}
interface Filter {
  type: "log";
  chainId: number;
  sourceId: string;
  address: Factory;
  topic0: Hex;
  fromBlock: number;
}
interface LogQuery {
  address?: Hex | Hex[];
  topics?: Array<Hex | Hex[] | null>;
  fromBlock: Hex;
  toBlock: Hex;
}
interface Log {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: Hex;
  logIndex: Hex;
  removed: boolean;
}
interface Rpc {
  request(request: { method: "eth_getLogs"; params: [LogQuery] }): Promise<Log[]>;
}
interface IntervalWithFilter { filter: Filter; interval: Interval }
interface ChildInsert { factory: Factory; childAddresses: Map<Hex, number>; chainId: number }
interface HistoricalSync {
  syncBlockRangeData(options: {
    interval: Interval;
    requiredIntervals: IntervalWithFilter[];
    requiredFactoryIntervals: Array<{ factory: Factory; interval: Interval }>;
    syncStore: { insertChildAddresses(input: ChildInsert): Promise<void> };
  }): Promise<Log[]>;
  syncBlockData(options: { interval: Interval; requiredIntervals: IntervalWithFilter[]; logs: Log[]; syncStore: Record<string, unknown> }): Promise<unknown>;
}

// Exercise the installed, lockfile-patched Ponder runtime without a socket or database.
const runtimeRoot = resolve(realpathSync("node_modules/ponder"), "dist/esm");
const loadRuntime = (path: string) => import(/* @vite-ignore */ pathToFileURL(resolve(runtimeRoot, path)).href);
const { mergeLogFiltersToRequests, isAddressMatched } = await loadRuntime("runtime/filter.js") as {
  mergeLogFiltersToRequests(filters: IntervalWithFilter[], children: Map<string, Map<Hex, number>>, threshold: number): Array<{ method: "eth_getLogs"; params: [LogQuery] }>;
  isAddressMatched(options: { address: Hex; blockNumber: number; childAddresses: Map<Hex, number> }): boolean;
};
const { eth_getLogs } = await loadRuntime("rpc/actions.js") as {
  eth_getLogs(rpc: Rpc, params: [LogQuery]): Promise<Log[]>;
};
const { createHistoricalSync } = await loadRuntime("sync-historical/index.js") as {
  createHistoricalSync(options: Record<string, unknown>): HistoricalSync;
};

const hex = (number: number): Hex => `0x${number.toString(16)}`;
const address = (number: number): Hex => `0x${number.toString(16).padStart(40, "0")}`;
const word = (number: number): Hex => `0x${number.toString(16).padStart(64, "0")}`;
const addressTopic = (value: Hex): Hex => `0x${value.slice(2).padStart(64, "0")}`;
const TRANSFER: Hex = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const LAUNCHED: Hex = `0x${"ab".repeat(32)}`;
const RANGE: Interval = [1_000, 1_025];

function fixture(chainId = 8453, count = 1_995) {
  const factory: Factory = { id: "memefun-factory", type: "log", chainId, sourceId: "Coin", address: address(8_000), eventSelector: LAUNCHED, childAddressLocation: "topic1", fromBlock: 900 };
  const filter: Filter = { type: "log", chainId, sourceId: "Coin", address: factory, topic0: TRANSFER, fromBlock: 900 };
  const children = new Map(Array.from({ length: count }, (_, i) => [address(i + 1), 900] as const));
  const childAddresses = new Map([[factory.id, children]]);
  return { factory, filter, children, childAddresses };
}

function log(token: Hex, block: number, index: number, topics: Hex[] = [TRANSFER, word(0), word(42)]): Log {
  return { address: token, blockNumber: hex(block), blockHash: word(block), transactionHash: word(block + 10_000), transactionIndex: "0x0", logIndex: hex(index), data: word(10), topics, removed: false };
}

function rpcFixture(logs: Log[]) {
  const calls: LogQuery[] = [];
  const rpc: Rpc = { request: vi.fn(async ({ method, params: [query] }) => {
    expect(method).toBe("eth_getLogs");
    calls.push(query);
    const addresses = query.address === undefined ? undefined : new Set(Array.isArray(query.address) ? query.address : [query.address]);
    return logs.filter(entry => (!addresses || addresses.has(entry.address))
      && Number(entry.blockNumber) >= Number(query.fromBlock) && Number(entry.blockNumber) <= Number(query.toBlock)
      && (query.topics?.[0] === undefined || query.topics[0] === entry.topics[0]));
  }) };
  return { rpc, calls };
}

const sorted = (logs: Log[]) => [...logs].sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex));

describe("Ponder Base factory log scope", () => {
  it("retains all 1,995 Base child addresses and uses the native 50-address RPC chunks", async () => {
    const { filter, childAddresses, children } = fixture();
    const requests = mergeLogFiltersToRequests([{ filter, interval: RANGE }], childAddresses, 1_000);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.params[0].address).toEqual([...children.keys()]);
    const { rpc, calls } = rpcFixture([]);
    for (const request of requests) await eth_getLogs(rpc, request.params);
    expect(calls).toHaveLength(40);
    expect(calls.every(query => Array.isArray(query.address) && query.address.length > 0 && query.address.length <= 50)).toBe(true);
    expect(calls.flatMap(query => query.address as Hex[])).toEqual([...children.keys()]);
    expect(calls.every(query => query.fromBlock === hex(RANGE[0]) && query.toBlock === hex(RANGE[1]))).toBe(true);
  });

  it("returns the same MemeFun events as a broad query followed by native factory filtering", async () => {
    const { filter, children, childAddresses } = fixture();
    const own = [log(address(1), 1_001, 0), log(address(1_995), 1_004, 3)];
    const unrelated = log(address(9_000), 1_002, 1);
    const { rpc, calls } = rpcFixture([own[0]!, unrelated, own[1]!]);
    const broad = await eth_getLogs(rpc, [{ topics: [TRANSFER], fromBlock: hex(RANGE[0]), toBlock: hex(RANGE[1]) }]);
    const expected = broad.filter(entry => isAddressMatched({ address: entry.address, blockNumber: Number(entry.blockNumber), childAddresses: children }));
    calls.length = 0;
    const scoped: Log[] = [];
    for (const request of mergeLogFiltersToRequests([{ filter, interval: RANGE }], childAddresses, 1_000)) scoped.push(...await eth_getLogs(rpc, request.params));
    expect(sorted(scoped)).toEqual(sorted(expected));
    expect(sorted(scoped)).toEqual(own);
    expect(scoped).not.toContainEqual(unrelated);
    expect(calls.every(query => query.address !== undefined)).toBe(true);
  });

  it.each([10_000, 10_001])("keeps Base queries scoped after the factory grows to %i children", async (count) => {
    const { filter, childAddresses, children } = fixture(8453, count);
    const requests = mergeLogFiltersToRequests([{ filter, interval: RANGE }], childAddresses, 1_000);
    expect(requests[0]!.params[0].address).toEqual([...children.keys()]);
    const { rpc, calls } = rpcFixture([]);
    for (const request of requests) await eth_getLogs(rpc, request.params);
    expect(calls).toHaveLength(Math.ceil(count / 50));
    expect(calls.every(query => Array.isArray(query.address) && query.address.length > 0 && query.address.length <= 50)).toBe(true);
    expect(calls.flatMap(query => query.address as Hex[])).toEqual([...children.keys()]);
  });

  it("discovers a new child before transfer queries and includes its same-block mint before Launched", async () => {
    const { factory, filter, children, childAddresses } = fixture();
    const newChild = address(3_000);
    const mint = log(newChild, 1_010, 1);
    const launched = log(factory.address, 1_010, 2, [LAUNCHED, addressTopic(newChild)]);
    const outsider = log(address(9_000), 1_010, 3);
    const existing = log(address(1), 1_011, 0);
    const { rpc, calls } = rpcFixture([mint, launched, outsider, existing]);
    const insertChildAddresses = vi.fn(async (_input: ChildInsert) => undefined);
    const logger = { debug: vi.fn(), warn: vi.fn(), child() { return this; } };
    const sync = createHistoricalSync({ common: { logger, options: { factoryAddressCountThreshold: 1_000 } }, chain: { id: 8453, name: "memefun" }, rpc, childAddresses });
    const result = await sync.syncBlockRangeData({ interval: RANGE, requiredIntervals: [{ filter, interval: RANGE }], requiredFactoryIntervals: [{ factory, interval: RANGE }], syncStore: { insertChildAddresses } });
    expect(calls[0]).toMatchObject({ address: factory.address, topics: [LAUNCHED] });
    expect(children.get(newChild)).toBe(1_010);
    expect(insertChildAddresses).toHaveBeenCalledWith(expect.objectContaining({ factory, chainId: 8453, childAddresses: new Map([[newChild, 1_010]]) }), expect.anything());
    const transferCalls = calls.filter(query => query.topics?.[0] === TRANSFER);
    expect(transferCalls).toHaveLength(40);
    expect(transferCalls.every(query => Array.isArray(query.address) && query.address.length <= 50)).toBe(true);
    expect(transferCalls.flatMap(query => query.address as Hex[])).toContain(newChild);
    expect(sorted(result)).toEqual([mint, existing]);
    expect(result).not.toContainEqual(outsider);
    expect(Number(mint.logIndex)).toBeLessThan(Number(launched.logIndex));
  });

  it("avoids fetching full blocks for unrelated Base transfers that the old broad query returned", async () => {
    const { filter, childAddresses } = fixture();
    const unrelated = [log(address(9_000), 1_001, 0), log(address(9_001), 1_002, 0), log(address(9_002), 1_003, 0)];
    const { rpc } = rpcFixture(unrelated);
    const scoped: Log[] = [];
    for (const request of mergeLogFiltersToRequests([{ filter, interval: RANGE }], childAddresses, 1_000)) scoped.push(...await eth_getLogs(rpc, request.params));
    expect(scoped).toEqual([]);

    const syncBlocks = async (logs: Log[]) => {
      const request = vi.fn(async ({ method, params: [number, full] }: { method: string; params: [Hex, boolean] }) => {
        expect(method).toBe("eth_getBlockByNumber");
        expect(full).toBe(true);
        return { number, timestamp: hex(1_800_000_000 + Math.floor(Number(number) / 5)), hash: word(Number(number)), parentHash: word(Number(number) - 1), logsBloom: `0x${"01".repeat(256)}`, transactions: [] };
      });
      const insertLogs = vi.fn(async (_input: { logs: Log[] }) => undefined);
      const syncStore = { insertBlocks: vi.fn(async () => undefined), insertTransactions: vi.fn(async () => undefined), insertTransactionReceipts: vi.fn(async () => undefined), insertTraces: vi.fn(async () => undefined), insertLogs };
      const logger = { debug: vi.fn(), warn: vi.fn(), child() { return this; } };
      const sync = createHistoricalSync({ common: { logger }, chain: { id: 8453, name: "memefun", finalityBlockCount: 300 }, rpc: { request }, childAddresses });
      await sync.syncBlockData({ interval: RANGE, requiredIntervals: [{ filter, interval: RANGE }], logs, syncStore });
      return { request, storedLogs: insertLogs.mock.calls.flatMap(([input]) => input.logs) };
    };
    const broad = await syncBlocks(unrelated);
    const narrow = await syncBlocks(scoped);
    expect(broad.request).toHaveBeenCalledTimes(3);
    expect(narrow.request).not.toHaveBeenCalled();
    expect(broad.storedLogs).toEqual([]);
    expect(narrow.storedLogs).toEqual([]);
  });

  it.each([10, 84532, 31337])("preserves the existing 1,000-address threshold for chain %i", (chainId) => {
    const { filter, childAddresses } = fixture(chainId);
    const requests = mergeLogFiltersToRequests([{ filter, interval: RANGE }], childAddresses, 1_000);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.params[0].address).toBeUndefined();
  });
});
