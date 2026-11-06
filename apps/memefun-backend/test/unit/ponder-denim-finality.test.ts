import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

interface Header {
  number: `0x${string}`;
  timestamp: `0x${string}`;
  hash: `0x${string}`;
  parentHash: `0x${string}`;
  logsBloom: `0x${string}`;
  transactions?: unknown[];
}

interface SyncEvent {
  type: "block" | "finalize" | "reorg";
  block: Header;
  reorgedBlocks?: Header[];
}

interface RealtimeSync {
  sync(block: Header): AsyncGenerator<SyncEvent>;
  unfinalizedBlocks: Header[];
}

// Load the executed ESM files from the installed, lockfile-patched package, rather than a
// test copy of its algorithm. These synthetic headers never open a network or database.
const runtimeRoot = resolve(realpathSync("node_modules/ponder"), "dist/esm");
const loadRuntime = (path: string) => import(/* @vite-ignore */ pathToFileURL(resolve(runtimeRoot, path)).href);
const { getFinalityBlockCount } = await loadRuntime("utils/finality.js") as {
  getFinalityBlockCount(options: { chain?: { id: number } }): number;
};
const { createRealtimeSync } = await loadRuntime("sync-realtime/index.js") as {
  createRealtimeSync(options: Record<string, unknown>): RealtimeSync;
};

const hex = (number: number) => `0x${number.toString(16)}` as const;
const hash = (number: number) => `0x${number.toString(16).padStart(64, "0")}` as const;
const block = (number: number): Header => ({
  number: hex(number),
  // Denim retains whole-second timestamps; five consecutive blocks share a timestamp.
  timestamp: hex(1_800_000_000 + Math.floor(number / 5)),
  hash: hash(number),
  parentHash: hash(Math.max(number - 1, 0)),
  logsBloom: `0x${"01".repeat(256)}`,
});

function fixture() {
  const warnings = vi.fn();
  const logger = { debug: vi.fn(), trace: vi.fn(), warn: warnings, child() { return this; } };
  const request = vi.fn(async () => { throw new Error("Unexpected RPC request in synthetic reorg test."); });
  const sync = createRealtimeSync({
    common: { logger, shutdown: { isKilled: false } },
    chain: { id: 8453, name: "memefun", pollingInterval: 1_000, finalityBlockCount: getFinalityBlockCount({ chain: { id: 8453 } }) },
    rpc: { request },
    eventCallbacks: [],
    syncProgress: { finalized: block(0) },
    childAddresses: new Map(),
  });
  return { sync, request, warnings };
}

async function ingest(sync: RealtimeSync, from: number, to: number) {
  const events: SyncEvent[] = [];
  for (let number = from; number <= to; number++) {
    for await (const event of sync.sync(block(number))) events.push(event);
  }
  return events;
}

describe("Ponder Base Denim reorg retention", () => {
  it("restores Base mainnet's previous 60-second window and preserves other chains", () => {
    expect(getFinalityBlockCount({ chain: { id: 8453 } })).toBe(300);
    for (const [id, count] of [[84532, 30], [10, 30], [31337, 30], [1, 65], [137, 200], [42161, 240]]) {
      expect(getFinalityBlockCount({ chain: { id: id! } })).toBe(count);
    }
    expect(getFinalityBlockCount({})).toBe(30);
  });

  it("executes the real finalization boundary with 200ms blocks and retains a full minute", async () => {
    const { sync, request } = fixture();
    const before = await ingest(sync, 1, 599);
    expect(before.filter(event => event.type === "finalize")).toHaveLength(0);
    const boundary = await ingest(sync, 600, 600);
    const finalized = boundary.find(event => event.type === "finalize")!;
    expect(Number(finalized.block.number)).toBe(300);
    expect(Number(block(600).timestamp) - Number(finalized.block.timestamp)).toBe(60);
    expect(sync.unfinalizedBlocks).toHaveLength(300);
    expect(Number(sync.unfinalizedBlocks[0]!.number)).toBe(301);
    expect(request).not.toHaveBeenCalled();
  });

  it("recovers a 201-block reorg within the restored window", async () => {
    const { sync, request, warnings } = fixture();
    await ingest(sync, 1, 600);
    const fork = { ...block(400), hash: hash(10_400) };
    const events: SyncEvent[] = [];
    for await (const event of sync.sync(fork)) events.push(event);
    const reorg = events.find(event => event.type === "reorg")!;
    expect(Number(reorg.block.number)).toBe(399);
    expect(reorg.reorgedBlocks).toHaveLength(201);
    expect(Number(block(600).timestamp) - Number(reorg.block.timestamp)).toBe(41);
    expect(warnings).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("still rejects a reorg beyond its retained history", async () => {
    const { sync, warnings, request } = fixture();
    await ingest(sync, 1, 600);
    const events: SyncEvent[] = [];
    for await (const event of sync.sync({ ...block(300), hash: hash(10_300) })) events.push(event);
    expect(events.some(event => event.type === "reorg")).toBe(false);
    expect(warnings.mock.calls.some(([entry]) => entry.msg === "Encountered unrecoverable reorg")).toBe(true);
    expect(sync.unfinalizedBlocks).toHaveLength(300);
    expect(request).not.toHaveBeenCalled();
  });
});
