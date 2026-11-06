import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { chainRpcTransport, chainSettings } from "../../lib/chain";

interface LogEntry {
  msg: string;
  rps_limit?: number;
  error?: { status?: number };
}

interface NativeRpc {
  request(body: { method: "eth_blockNumber" }): Promise<string>;
}

// Exercise Ponder's installed adaptive provider scheduler, not a test recreation of it.
const runtime = pathToFileURL(resolve(realpathSync("node_modules/ponder"), "dist/esm/rpc/index.js")).href;
const { createRpc } = await import(/* @vite-ignore */ runtime) as {
  createRpc(options: Record<string, unknown>): NativeRpc;
};
const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Ponder's native RPC backoff", () => {
  it.each(["http", "rpc"])("backs off public %s capacity errors when Alchemy is inactive, then recovers", async (kind) => {
    process.env.MEMEFUN_CHAIN = "base";
    process.env.MEMEFUN_RPC_URLS = "https://base-mainnet.g.alchemy.com/v2/inactive-fixture";
    process.env.MEMEFUN_INDEXER_RPC_RPS = "30";
    const chain = chainSettings();
    const started = performance.now();
    const realNow = Date.now;
    let clockOffset = 0;
    let publicHealthy = false;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
    const requests: Array<{ paid: boolean; time: number }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const paid = String(url).includes("alchemy");
      requests.push({ paid, time: performance.now() - started });
      if (paid) return Response.json({ error: { code: -32600, message: "App is inactive. Please create a new app." } });
      if (publicHealthy) return Response.json({ result: "0x123" });
      return kind === "http" ? new Response("Public capacity reached", { status: 429 })
        : Response.json({ error: { code: -32011, message: "Public request limit reached" } });
    }));

    const warnings: LogEntry[] = [];
    const debug: LogEntry[] = [];
    const shutdownHooks: Array<() => void | Promise<void>> = [];
    const errors = vi.fn();
    const logger = {
      child() { return this; },
      trace() {},
      debug(entry: LogEntry) { debug.push(entry); },
      warn(entry: LogEntry) { warnings.push(entry); },
    };
    const rpc = createRpc({
      common: {
        logger,
        metrics: { ponder_rpc_request_error_total: { inc: errors }, ponder_rpc_request_duration: { observe() {} } },
        shutdown: { add(callback: () => void | Promise<void>) { shutdownHooks.push(callback); } },
      },
      chain: { id: chain.id, name: "memefun", viemChain: chain.viemChain, pollingInterval: 1_000, rpc: chainRpcTransport(chain) },
    });
    // Historical sync, prefetch and indexing clients all use this shared native Rpc entry.
    const work = Array.from({ length: 8 }, () => rpc.request({ method: "eth_blockNumber" }));
    let outageRequests: typeof requests = [];
    let outageWarnings: LogEntry[] = [];
    let outageDeactivations: LogEntry[] = [];
    try {
      await new Promise(resolve => setTimeout(resolve, 2_100));
      outageRequests = [...requests];
      outageWarnings = warnings.filter(entry => entry.msg === "Received JSON-RPC error");
      outageDeactivations = debug.filter(entry => entry.msg === "JSON-RPC provider rate limited");
      publicHealthy = true;
      // Advance only the cooldown clock. Ponder's real setTimeout/backoff still runs.
      clockOffset = 31_000;
      expect(await Promise.all(work)).toEqual(Array(8).fill("0x123"));
    } finally {
      for (const shutdown of shutdownHooks) await shutdown();
    }

    expect(outageRequests.filter(request => request.paid)).toHaveLength(1);
    expect(outageRequests.filter(request => !request.paid)).toHaveLength(chain.rpcUrls.filter(url => !url.includes("alchemy")).length);
    expect(outageWarnings.length).toBeGreaterThan(1);
    expect(outageWarnings.length).toBeLessThan(60);
    expect(outageWarnings.every(entry => entry.error?.status === 429)).toBe(true);
    // This message is emitted only after the real Ponder bucket is deactivated and its
    // adaptive RPS is reduced. Merely returning a 429-shaped error is insufficient.
    expect(outageDeactivations.length).toBeGreaterThan(1);
    expect(outageDeactivations.every(entry => entry.rps_limit! < 20)).toBe(true);
    expect(errors).toHaveBeenCalled();
    expect(requests.filter(request => request.paid)).toHaveLength(1);
  });
});
