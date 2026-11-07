import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpRequestError, custom } from "viem";
import { base } from "viem/chains";

interface NativeBucket {
  hostname: string;
  rpsLimit: number;
  rps: Array<{ count: number; timestamp: number }>;
  consecutiveSuccessfulRequests: number;
  isActive: boolean;
}

interface LogEntry {
  msg: string;
  rps_limit?: number;
}

interface NativeRpc {
  request(body: { method: "eth_blockNumber" }): Promise<string>;
}

const runtime = pathToFileURL(resolve(realpathSync("node_modules/ponder"), "dist/esm/rpc/index.js")).href;
const { createRpc } = await import(/* @vite-ignore */ runtime) as {
  createRpc(options: Record<string, unknown>): NativeRpc;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function fixture(limit: number) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-07T03:00:00Z"));
  let limited = false;
  const starts: number[] = [];
  const debug: LogEntry[] = [];
  const shutdownHooks: Array<() => void | Promise<void>> = [];
  const logger = {
    child() { return this; },
    trace() {},
    debug(entry: LogEntry) { debug.push(entry); },
    warn() {},
  };
  const rpc = createRpc({
    common: {
      logger,
      metrics: { ponder_rpc_request_error_total: { inc() {} }, ponder_rpc_request_duration: { observe() {} } },
      shutdown: { add(callback: () => void | Promise<void>) { shutdownHooks.push(callback); } },
    },
    chain: {
      id: base.id, name: "memefun", viemChain: base, pollingInterval: 1_000,
      rpc: custom({ request: async () => {
        starts.push(Math.floor(Date.now() / 1_000));
        if (limited) throw new HttpRequestError({ status: 429, details: "Public capacity reached", url: "https://rpc.test" });
        return "0x123";
      } }, { retryCount: 0 }),
    },
  });

  // Reproduce the observed production bucket without replaying hundreds of increases and
  // decreases. Capture only the actual native custom-transport bucket during preflight;
  // restore Array.filter immediately. Every subsequent limit/queue/timer decision is Ponder's.
  let bucket: NativeBucket | undefined;
  const nativeFilter = Array.prototype.filter;
  const capture = vi.spyOn(Array.prototype, "filter").mockImplementation(function (
    this: unknown[], ...args: Parameters<typeof nativeFilter>
  ) {
    const candidate = this[0];
    if (typeof candidate === "object" && candidate !== null && "hostname" in candidate
      && candidate.hostname === "custom_transport" && "rpsLimit" in candidate && "rps" in candidate) {
      bucket = candidate as NativeBucket;
    }
    return Reflect.apply(nativeFilter, this, args) as unknown[];
  });
  try {
    const preflight = rpc.request({ method: "eth_blockNumber" });
    await vi.advanceTimersByTimeAsync(1);
    expect(await preflight).toBe("0x123");
  } finally {
    capture.mockRestore();
  }
  if (!bucket) throw new Error("Native Ponder bucket was not observed during preflight.");
  bucket.rpsLimit = limit;
  bucket.rps = [];
  bucket.consecutiveSuccessfulRequests = 0;
  starts.length = 0;

  return {
    rpc, bucket, starts, debug,
    setLimited(value: boolean) { limited = value; },
    async close() {
      for (const shutdown of shutdownHooks) await shutdown();
    },
  };
}

describe("Ponder's native fractional RPC recovery", () => {
  it("recovers the observed 8.900945648619519 limit using its actual permitted eight requests per second", async () => {
    const current = await fixture(8.900945648619519);
    try {
      const work = Promise.all(Array.from({ length: 88 }, () => current.rpc.request({ method: "eth_blockNumber" })));
      await vi.advanceTimersByTimeAsync(12_000);
      expect(await work).toEqual(Array(88).fill("0x123"));
      expect(current.bucket.rpsLimit).toBeGreaterThan(8.900945648619519);
      expect(current.debug.some(entry => entry.msg === "Increased JSON-RPC provider RPS limit")).toBe(true);
      const firstSecond = current.starts[0]!;
      for (let second = firstSecond; second < firstSecond + 9; second++) {
        expect(current.starts.filter(start => start === second)).toHaveLength(8);
      }
    } finally {
      await current.close();
    }
  });

  it("retains the native integer-20 admission and recovery behavior", async () => {
    const current = await fixture(20);
    try {
      const work = Promise.all(Array.from({ length: 220 }, () => current.rpc.request({ method: "eth_blockNumber" })));
      await vi.advanceTimersByTimeAsync(12_000);
      expect(await work).toEqual(Array(220).fill("0x123"));
      const firstSecond = current.starts[0]!;
      for (let second = firstSecond; second < firstSecond + 9; second++) {
        expect(current.starts.filter(start => start === second)).toHaveLength(20);
      }
      expect(current.debug.find(entry => entry.msg === "Increased JSON-RPC provider RPS limit")?.rps_limit).toBe(21);
    } finally {
      await current.close();
    }
  });

  it.each([1.9, 2.9])("recovers a low fractional limit of %s without exceeding its admitted integer rate", async (limit) => {
    const current = await fixture(limit);
    try {
      const count = Math.floor(limit) * 10 + 1;
      const work = Promise.all(Array.from({ length: count }, () => current.rpc.request({ method: "eth_blockNumber" })));
      await vi.advanceTimersByTimeAsync(18_000);
      expect(await work).toEqual(Array(count).fill("0x123"));
      expect(current.bucket.rpsLimit).toBeGreaterThan(limit);
      const firstSecond = current.starts[0]!;
      expect(current.starts.filter(start => start === firstSecond)).toHaveLength(Math.floor(limit));
    } finally {
      await current.close();
    }
  });

  it("still lowers the adaptive limit on an actual 429 and waits before retrying", async () => {
    const limit = 8.900945648619519;
    const current = await fixture(limit);
    try {
      current.setLimited(true);
      const work = current.rpc.request({ method: "eth_blockNumber" });
      await vi.advanceTimersByTimeAsync(1);
      expect(current.bucket.rpsLimit).toBeCloseTo(limit * 0.95);
      expect(current.bucket.isActive).toBe(false);
      expect(current.debug.some(entry => entry.msg === "JSON-RPC provider rate limited")).toBe(true);
      current.setLimited(false);
      await vi.advanceTimersByTimeAsync(500);
      expect(await work).toBe("0x123");
      expect(current.bucket.rpsLimit).toBeLessThan(limit);
      expect(current.debug.some(entry => entry.msg === "Increased JSON-RPC provider RPS limit")).toBe(false);
    } finally {
      await current.close();
    }
  });
});
